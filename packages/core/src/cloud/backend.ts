/**
 * 云后端统一接口与凭据类型。
 * 所有实现均为纯 fetch，零新增依赖；云端对象内容为加密 envelope 的字节。
 */

export interface CloudBackend {
  readonly id: 'webdav' | 's3' | 'gdrive' | 'onedrive' | 'gist'
  /** 凭据发生变化（如 GDrive 首推自动创建文件后回存 fileId）时回调；调用方负责持久化新凭据。 */
  onCredChange?(cred: CloudCred): void
  put(path: string, data: Uint8Array): Promise<void>
  get(path: string): Promise<Uint8Array | null>
  delete(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface WebdavCred {
  backend: 'webdav'
  serverUrl: string
  username: string
  password: string
}

export interface GistCred {
  backend: 'gist'
  token: string
  gistId: string
  /** 远端 gist 是否为 public；后端在 fetchGist 时探测并通过 onCredChange 回写，UI 据此给一次性提示。 */
  public?: boolean
}

export interface S3Cred {
  backend: 's3'
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** 自定义 endpoint（如 MinIO：http://localhost:9000），走 path-style；缺省为 AWS virtual-host style。 */
  endpoint?: string
  /** 对象 key 前缀（默认根）。 */
  prefix?: string
  /** STS 临时凭据场景：x-amz-security-token，需与 AKID/SAK 同源签发。 */
  sessionToken?: string
  /** 老 bucket（2020-03 之前创建，区域未迁移 virtual-host）强制 path-style；与 endpoint 任一为真即生效。 */
  forcePathStyle?: boolean
}

export interface GDriveCred {
  backend: 'gdrive'
  accessToken: string
  /** 目标文件 id；缺省时首推自动创建并经 onCredChange 回存。 */
  fileId?: string
}

export interface OneDriveCred {
  backend: 'onedrive'
  accessToken: string
}

/** 云后端凭据判别联合。 */
export type CloudCred = WebdavCred | GistCred | S3Cred | GDriveCred | OneDriveCred

/** fetch 网络层包装：连接失败/中断等 reject 统一转为中文错误。
 *  TypeError: Failed to fetch 与 NetworkError when attempting to fetch resource 是浏览器对
 *  CORS 拒绝/连接中断的统一表现（无具体响应）；自建 WebDAV/S3(MinIO) 等场景下绝大多数成因是
 *  服务端未配置 Access-Control-Allow-Origin/-Methods/-Headers，主动追加提示以减少误判。
 *  错误信息附 host+pathname（不含 query）便于排错，刻意不附完整 url 以免泄漏 token/query 参数。 */
export async function cloudFetch(label: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const isCorsLikely = err instanceof TypeError
      && /fetch failed|NetworkError when attempting to fetch resource/i.test(reason)
    const hint = isCorsLikely ? ' — 若为自建 WebDAV/S3(MinIO)请检查服务端 CORS 配置' : ''
    const where = describeUrl(url)
    throw new Error(`${label} 网络请求失败：${reason}${hint}（${where}）`)
  }
}

/** 安全截取 url 的 host + pathname（不含 query/fragment，避免泄漏 token 等敏感参数） */
function describeUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return '<url 解析失败>'
  }
}

/** 非 2xx 统一抛中文错误（含状态码）；404 分支由调用方按接口语义处理。 */
export function ensureHttpOk(label: string, res: Response): void {
  if (!res.ok) throw new Error(`${label} 请求失败（HTTP ${res.status}）`)
}
