import { base64ToBytes, bytesToBase64, setCloudFetch, type CloudFetchImpl } from '@totp/core'
import { ext } from './extApi'

/** 页面端经 background 出网（③）：host_permissions 内 SW fetch 不受 CORS 限制。
 *  每源 proxy 参数扩展端不生效（浏览器无法 per-request 代理），UI 已置灰声明。 */
export const backgroundProxiedFetch: CloudFetchImpl = async (_label, url, init) => {
  const body = init?.body instanceof Uint8Array
    ? init.body
    : init?.body != null ? new TextEncoder().encode(String(init.body)) : null
  const res = await ext!.runtime.sendMessage({
    type: 'cloud-fetch',
    url,
    method: init?.method ?? 'GET',
    headers: (init?.headers as Record<string, string>) ?? {},
    bodyB64: body ? bytesToBase64(body) : null,
  })
  if (!res || res.error) throw new Error(res?.error ?? 'background 无响应（service worker 不可用）')
  // .buffer as ArrayBuffer：同 cloudFetchHandler（Uint8Array→BodyInit 受 TS lib 交叉污染，仓库惯用法）
  return new Response(res.bodyB64 ? (base64ToBytes(res.bodyB64).buffer as ArrayBuffer) : null, {
    status: res.status,
    statusText: res.statusText ?? '',
    headers: res.headers ?? {},
  })
}

/** 页面装配点调用（popup/options main.ts 顶部）：此后全部 provider 云请求走 background */
export function installBackgroundCloudFetch(): void {
  setCloudFetch(backgroundProxiedFetch)
}
