/**
 * 云后端统一接口与凭据类型。
 * 所有实现均为纯 fetch，零新增依赖；云端对象内容为加密 envelope 的字节。
 */

export interface CloudBackend {
  readonly id: 'webdav' | 's3' | 'gdrive' | 'onedrive' | 'gist'
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
}

/** 云后端凭据判别联合（s3/gdrive/onedrive 由后续任务扩展）。 */
export type CloudCred = WebdavCred | GistCred

/** fetch 网络层包装：连接失败/中断等 reject 统一转为中文错误。 */
export async function cloudFetch(label: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${label} 网络请求失败：${reason}`)
  }
}

/** 非 2xx 统一抛中文错误（含状态码）；404 分支由调用方按接口语义处理。 */
export function ensureHttpOk(label: string, res: Response): void {
  if (!res.ok) throw new Error(`${label} 请求失败（HTTP ${res.status}）`)
}
