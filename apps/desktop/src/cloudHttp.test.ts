import { describe, expect, it, vi, beforeEach } from 'vitest'
import { bytesToBase64 } from '@totp/core'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { installTauriCloudFetch, tauriCloudFetch } from './cloudHttp'

describe('桌面 cloudFetch 注入（③）', () => {
  beforeEach(() => invoke.mockReset())

  it('请求形状（b64 body/proxy 透传/默认 GET）与 Response 重建', async () => {
    invoke.mockResolvedValue({ status: 200, headers: { 'x-a': 'b' }, bodyB64: bytesToBase64(new Uint8Array([7])) })
    const res = await tauriCloudFetch('WebDAV', 'https://dav/f', { method: 'PUT', body: new Uint8Array([7]) }, { mode: 'custom', url: 'socks5h://p' })
    expect(invoke).toHaveBeenCalledWith('cloud_http_fetch', { req: { url: 'https://dav/f', method: 'PUT', headers: {}, bodyB64: bytesToBase64(new Uint8Array([7])), proxy: { mode: 'custom', url: 'socks5h://p' }, timeoutMs: null } })
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7]))
  })
  it('Response 回显请求 url（错误行 describeUrl 依赖，真机 e2e 2026-10-06：否则恒「<url 解析失败>」）', async () => {
    invoke.mockResolvedValue({ status: 404, headers: {}, bodyB64: null })
    const res = await tauriCloudFetch('WebDAV', 'https://dav.example.com/dir/obj', { method: 'GET' }, { mode: 'none' })
    expect(res.url).toBe('https://dav.example.com/dir/obj')
  })
  it('install 后 cloudFetch 走注入实现（setCloudFetch 生效）', async () => {
    const { __resetCloudFetchForTest, cloudFetch } = await import('@totp/core')
    installTauriCloudFetch()
    invoke.mockResolvedValue({ status: 204, headers: {}, bodyB64: null })
    await cloudFetch('L', 'https://x')
    expect(invoke).toHaveBeenCalled()
    __resetCloudFetchForTest()
  })
})
