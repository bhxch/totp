import { invoke } from '@tauri-apps/api/core'
import { base64ToBytes, bytesToBase64, setCloudFetch, type CloudFetchImpl } from '@totp/core'

/** ③ 桌面注入：云请求经 Rust reqwest 出网（无 CORS；每源 proxy 在 command 内生效） */
export const tauriCloudFetch: CloudFetchImpl = async (_label, url, init, proxy) => {
  const body = init?.body instanceof Uint8Array
    ? init.body
    : init?.body != null ? new TextEncoder().encode(String(init.body)) : null
  const r = await invoke<{ status: number; headers: Record<string, string>; bodyB64: string | null }>('cloud_http_fetch', {
    req: {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      bodyB64: body ? bytesToBase64(body) : null,
      proxy: proxy ?? { mode: 'none' },
      timeoutMs: null,
    },
  })
  // TS 5.7 下 Uint8Array<ArrayBufferLike> 不满足 BodyInit；base64ToBytes 恒新建全量视图
  // （byteOffset=0 覆盖整个 buffer），传底层 ArrayBuffer 语义等价
  const bytes = r.bodyB64 ? base64ToBytes(r.bodyB64) : null
  return new Response(bytes ? (bytes.buffer as ArrayBuffer) : null, { status: r.status, headers: r.headers })
}

export function installTauriCloudFetch(): void {
  setCloudFetch(tauriCloudFetch)
}
