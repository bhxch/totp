import { base64ToBytes, bytesToBase64 } from '@totp/core'

export interface CloudFetchOk { status: number; statusText: string; headers: Record<string, string>; bodyB64: string | null }
export interface CloudFetchErr { error: string }

/** SW fetch 统一超时（云-I1）：与桌面端 cloud_http.rs DEFAULT_TIMEOUT_MS 同值（60s）——双端对称。
 *  目标服务器挂起时 60s 中止并回结构化 error，页面层 promise 不再永久 pending（原先只能等
 *  MV3 SW 闲置回收后才报「service worker 不可用」，排障方向错误）。 */
export const CLOUD_FETCH_TIMEOUT_MS = 60_000

/**
 * SW 内执行云请求并组应答消息（③）：错误结构化返回不抛（sendResponse 通道一次性）。
 * opts.signal（如有）与超时信号经 AbortSignal.any 组合，不覆盖调用方中止；opts.timeoutMs
 * 仅供测试注入短超时验证中止路径（生产调用方不传，恒用 CLOUD_FETCH_TIMEOUT_MS）。
 */
export async function handleCloudFetch(
  url: unknown,
  method: unknown,
  headers: unknown,
  bodyB64: unknown,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CloudFetchOk | CloudFetchErr> {
  if (typeof url !== 'string' || url === '') return { error: 'cloud-fetch: 缺 url' }
  try {
    const timeout = AbortSignal.timeout(opts?.timeoutMs ?? CLOUD_FETCH_TIMEOUT_MS)
    const init: RequestInit = {
      method: typeof method === 'string' ? method : 'GET',
      headers: (headers as Record<string, string>) ?? {},
      signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    }
    // base64ToBytes 恒为整段新建缓冲，.buffer 即精确字节（Uint8Array→BodyInit 受 TS lib 交叉污染，取 buffer 同 packages/ui 惯用法）
    if (typeof bodyB64 === 'string' && bodyB64 !== '') init.body = base64ToBytes(bodyB64).buffer as ArrayBuffer
    const res = await fetch(url, init)
    const buf = await res.arrayBuffer()
    // Headers 迭代器（entries）在 DOM.Iterable lib 外不可用，forEach 等价收集（多值同名头以最后一次为准，云响应无此形态）
    const outHeaders: Record<string, string> = {}
    res.headers.forEach((value, key) => { outHeaders[key] = value })
    return {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
      bodyB64: buf.byteLength > 0 ? bytesToBase64(new Uint8Array(buf)) : null,
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * background 'cloud-fetch' 消息入口（云-I3）：仅放行本扩展内部页面（popup/options）发起的请求。
 * sender.id 与自身 runtime id 不符（外部网页/未知来源）时同步回结构化拒绝——不抛、不保持通道。
 * manifest 未声明 externally_connectable 时外部页面 sender.id 为 undefined，天然被拒；将来新增
 * content script 也不会静默变成任意网页可驱动的出网中继。selfId 由调用方传 chrome.runtime.id
 * （保持本模块零宿主依赖，测试可直接注入）。
 */
export function handleCloudFetchMessage(
  msg: { url?: unknown; method?: unknown; headers?: unknown; bodyB64?: unknown } | undefined,
  sender: unknown,
  sendResponse: (r: CloudFetchOk | CloudFetchErr) => void,
  selfId: string,
): boolean {
  if ((sender as { id?: unknown } | null)?.id !== selfId) {
    sendResponse({ error: 'cloud-fetch: 拒绝非本扩展来源的请求' })
    return false // 同步应答已给出，无需保持通道开放
  }
  void handleCloudFetch(msg?.url, msg?.method, msg?.headers, msg?.bodyB64).then(sendResponse)
  return true // MV3：异步应答保持通道开放
}
