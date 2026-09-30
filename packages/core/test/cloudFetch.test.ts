import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetCloudFetchForTest, cloudFetch, proxyOf, setCloudFetch, type CloudProxy } from '../src/cloud/backend'

afterEach(() => __resetCloudFetchForTest())

describe('cloudFetch 可注入网络层（③ CORS 规避）', () => {
  it('未注入=全局 fetch 直连（默认行为零变化）', async () => {
    const f = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await cloudFetch('测试', 'https://x/y')
    expect(f).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
  it('注入后走注入实现并透传 label/url/init/proxy；TypeError 错误包装保留 CORS 提示', async () => {
    const impl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    setCloudFetch(impl)
    const proxy: CloudProxy = { mode: 'custom', url: 'socks5h://127.0.0.1:7890' }
    await expect(cloudFetch('WebDAV', 'https://dav/x', { method: 'PUT' }, proxy)).rejects.toThrow('CORS 配置')
    expect(impl).toHaveBeenCalledWith('WebDAV', 'https://dav/x', { method: 'PUT' }, proxy)
  })
  it('proxyOf：缺省直连、有值原样返回', () => {
    expect(proxyOf({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p' })).toEqual({ mode: 'none' })
    const p: CloudProxy = { mode: 'system' }
    expect(proxyOf({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', proxy: p })).toBe(p)
  })
})
