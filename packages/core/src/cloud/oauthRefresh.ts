import type { GDriveCred, OneDriveCred } from './backend'
import { CloudHttpError } from './backend'
import { sha256Hex } from './syncOrchestrator'

/**
 * GDrive/OneDrive OAuth refresh_token 自动刷新（spec §5⑦）。
 * token 端点（oauth2.googleapis.com / login.microsoftonline.com）非各后端 API 域：刻意走原生
 * fetch 而不经 cloudFetch——错误文案独立成句、不附 url（防 client_secret/refresh_token 随
 * host+path 进错误提示），也不套用「CORS/自建服务」提示语境。
 */

const GDRIVE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ONEDRIVE_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

/** 过期提前量：缓存剩余寿命不足 60s 即视为过期（规避时钟偏移与「取到 token 已在路上过期」）。 */
const EXPIRY_SKEW_MS = 60_000

/** 服务端未回 expires_in 时的兜底寿命（两家常见值为 3600）。 */
const DEFAULT_EXPIRES_IN_SEC = 3600

interface CachedToken {
  token: string
  /** 绝对过期时刻（Date.now() 毫秒域）。 */
  expiresAt: number
}

/** 会话级 access token 缓存（模块级，页面生命周期内复用；仅存内存不落盘——spec §5⑦
 *  「新 access token 仅存会话内存」）。key=credKey（clientId+refreshToken 摘要）。 */
const sessionCache = new Map<string, CachedToken>()

/** 测试隔离：清空会话缓存（生产代码勿调）。 */
export function __resetOAuthCacheForTest(): void {
  sessionCache.clear()
}

function labelOf(backend: 'gdrive' | 'onedrive'): string {
  return backend === 'gdrive' ? 'Google Drive' : 'OneDrive'
}

function tokenUrlOf(backend: 'gdrive' | 'onedrive'): string {
  return backend === 'gdrive' ? GDRIVE_TOKEN_URL : ONEDRIVE_TOKEN_URL
}

/** credKey：clientId+refreshToken 的 sha256 前 16 字符（凭据明文不直接作 key，同凭据稳定同 key）。 */
async function credKeyOf(oauth: { clientId: string; refreshToken: string }): Promise<string> {
  const bytes = new TextEncoder().encode(oauth.clientId + oauth.refreshToken)
  return (await sha256Hex(bytes)).slice(0, 16)
}

/**
 * 以 refresh_token 换新 access_token：命中未过期缓存直接返回；否则 POST token 端点
 * （grant_type=refresh_token + client_id/client_secret/refresh_token）。
 * 刷新失败（HTTP 非 200 / 响应无 access_token）一律抛 CloudHttpError(status=401)——与既有
 * 「凭据失效」结构化判定（isAuthError）兼容：refresh_token 失效语义 = 凭据失效（spec §5⑦）。
 * 调用方约定 cred.oauth 已存在；缺省时抛普通 Error（编程错误防御，不发请求）。
 */
export async function refreshAccessToken(cred: GDriveCred | OneDriveCred): Promise<string> {
  const oauth = cred.oauth
  const label = labelOf(cred.backend)
  if (!oauth) throw new Error(`${label} OAuth 刷新缺少配置（clientId/clientSecret/refreshToken）`)

  const key = await credKeyOf(oauth)
  const cached = sessionCache.get(key)
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token

  let res: Response
  try {
    res = await fetch(tokenUrlOf(cred.backend), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: oauth.refreshToken,
      }),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${label} OAuth 刷新请求网络失败：${reason}`)
  }
  if (!res.ok) throw new CloudHttpError(label, 401)
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new CloudHttpError(label, 401)

  const expiresSec = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : DEFAULT_EXPIRES_IN_SEC
  sessionCache.set(key, { token: json.access_token, expiresAt: Date.now() + expiresSec * 1000 })
  return json.access_token
}
