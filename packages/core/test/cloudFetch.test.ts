import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudHttpError, __resetCloudFetchForTest, cloudFetch, ensureHttpOk, proxyOf, setCloudFetch, type CloudProxy } from '../src/cloud/backend'

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

describe('ensureHttpOk（spec §4.3 完整错误现场）', () => {
  it('非 2xx：抛 CloudHttpError 携带 method/url(剥 query)/bodySnippet，console.error 输出全量', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fake = {
        ok: false, status: 404,
        url: 'https://dav.example.com/a/b/x.totpbackup?token=secret',
        text: async () => 'Directory not found',
      } as unknown as Response
      const err: CloudHttpError = await ensureHttpOk('WebDAV', fake, 'PUT').then(() => { throw new Error('should throw') }, (e) => e)
      expect(err.status).toBe(404)
      expect(err.method).toBe('PUT')
      expect(err.url).toBe('dav.example.com/a/b/x.totpbackup') // query 剥离（防 token 泄漏）
      expect(err.bodySnippet).toBe('Directory not found')
      expect(err.message).toContain('WebDAV 请求失败（HTTP 404）') // 前缀形态不变（既有匹配兜底）
      expect(err.message).toContain('PUT dav.example.com/a/b/x.totpbackup')
      expect(errSpy).toHaveBeenCalledWith('[cloud]', 'WebDAV', 'PUT', 'dav.example.com/a/b/x.totpbackup', 'HTTP 404', 'Directory not found')
    } finally {
      errSpy.mockRestore()
    }
  })
  it('响应体不可读：bodySnippet 缺省仍抛错；2xx：静默通过', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const noBody = { ok: false, status: 500, url: 'https://x/y', text: async () => { throw new Error('body locked') } } as unknown as Response
      const err = await ensureHttpOk('WebDAV', noBody, 'GET').then(() => null, (e) => e)
      expect(err.status).toBe(500)
      await expect(ensureHttpOk('WebDAV', { ok: true, status: 200 } as unknown as Response)).resolves.toBeUndefined()
    } finally {
      errSpy.mockRestore()
    }
  })
})
