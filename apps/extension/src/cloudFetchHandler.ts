import { base64ToBytes, bytesToBase64 } from '@totp/core'

export interface CloudFetchOk { status: number; statusText: string; headers: Record<string, string>; bodyB64: string | null }
export interface CloudFetchErr { error: string }

/** SW 内执行云请求并组应答消息（③）：错误结构化返回不抛（sendResponse 通道一次性） */
export async function handleCloudFetch(url: unknown, method: unknown, headers: unknown, bodyB64: unknown): Promise<CloudFetchOk | CloudFetchErr> {
  if (typeof url !== 'string' || url === '') return { error: 'cloud-fetch: 缺 url' }
  try {
    const init: RequestInit = { method: typeof method === 'string' ? method : 'GET', headers: (headers as Record<string, string>) ?? {} }
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
