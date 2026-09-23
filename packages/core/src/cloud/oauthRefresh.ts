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

/** 单飞行 Map（审查 Minor 1）：同一凭据的并发 401（多方法各自 authFetch）只发一次刷新请求，
 *  全部等待同一 Promise；失败也会移除（下个调用可重试）。 */
const inflight = new Map<string, Promise<string>>()

/** 测试隔离：清空会话缓存与单飞行 Map（生产代码勿调）。 */
export function __resetOAuthCacheForTest(): void {
  sessionCache.clear()
  inflight.clear()
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
 * 以 refresh_token 换新 access_token：命中未过期缓存直接返回；并发同凭据调用合并为单次刷新
 * （inflight 单飞行）；否则 POST token 端点（grant_type=refresh_token + 三参数）。
 * 刷新失败语义（审查 Minor 2：区分 HTTP 状态）：token 端点 4xx（400/401/403/invalid_grant 类，
 * refresh_token 确实失效）抛 CloudHttpError(status=401)——与既有「凭据失效」结构化判定
 * （isAuthError）兼容：refresh_token 失效语义 = 凭据失效（spec §5⑦）；5xx 及其他非 4xx 为
 * token 服务端瞬时故障，抛普通 Error（无结构化 status、消息不含「（HTTP 401/403）」定界形态，
 * isAuthError 判假）→ 调用方按暂时性失败重试，不误暂停自动跟随/不亮「凭据失效」警示。
 * 调用方约定 cred.oauth 已存在；缺省时抛普通 Error（编程错误防御，不发请求）。
 *
 * refresh_token 轮转（审查 Important 2，MS /common 端点可能在响应中下发新 refresh_token 并
 * 撤销旧值——轮转撤销策略需真机实测，backlog）：响应含新 refresh_token 时并入 cred 经
 * opts.onCredChange 上抛（沿用 gdrive onCredChange「宿主回存」先例；refreshToken 敏感，仅回传
 * 宿主回存 secretBag 的通道，不上日志）。无消费方（自动通道缺省）时安全丢弃——降级为下轮
 * 401 再刷新，MS 未撤销旧值则仍可用。Google 不轮转（通常无此字段），gdrive 同通道透传无副作用。
 */
export async function refreshAccessToken<C extends GDriveCred | OneDriveCred>(
  cred: C,
  opts?: { onCredChange?: (cred: C) => void },
): Promise<string> {
  const oauth = cred.oauth
  const label = labelOf(cred.backend)
  if (!oauth) throw new Error(`${label} OAuth 刷新缺少配置（clientId/clientSecret/refreshToken）`)

  const key = await credKeyOf(oauth)
  const cached = sessionCache.get(key)
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token
  const pending = inflight.get(key)
  if (pending) return pending

  const refreshing = (async (): Promise<string> => {
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
    if (!res.ok) {
      // 审查 Minor 2：4xx = 凭据确实失效 → 保持既有 401 语义（isAuthError 判真）；5xx 及其他
      // 非 4xx = 服务端瞬时故障 → 抛普通 Error（isAuthError 判假，上层按暂时性失败重试）
      if (res.status >= 400 && res.status < 500) throw new CloudHttpError(label, 401)
      throw new Error(`${label} OAuth 刷新服务暂时不可用（HTTP ${res.status}）：请稍后重试`)
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!json.access_token) throw new CloudHttpError(label, 401)

    const expiresSec = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : DEFAULT_EXPIRES_IN_SEC
    sessionCache.set(key, { token: json.access_token, expiresAt: Date.now() + expiresSec * 1000 })
    // 轮转响应（Important 2）：新 refresh_token 并入凭据上抛回存；无 onCredChange 消费方则丢弃
    // （注释即契约：丢弃的影响=旧 token 被 MS 撤销时下轮 401 走凭据失效救济，需重新配置 OAuth）
    if (typeof json.refresh_token === 'string' && json.refresh_token && json.refresh_token !== oauth.refreshToken) {
      opts?.onCredChange?.({ ...cred, oauth: { ...oauth, refreshToken: json.refresh_token } })
    }
    return json.access_token
  })()
  inflight.set(key, refreshing)
  try {
    return await refreshing
  } finally {
    inflight.delete(key)
  }
}
