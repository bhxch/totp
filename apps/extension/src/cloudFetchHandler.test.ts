import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '@totp/core'
import { handleCloudFetch } from './cloudFetchHandler'

afterEach(() => vi.unstubAllGlobals())

describe('background cloud-fetch 处理（③）', () => {
  it('GET 往返：status/headers/base64 body 正确组包', async () => {
    const body = new Uint8Array([1, 2, 3])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 207, headers: { 'x-a': 'b' } })))
    const r = await handleCloudFetch('https://x/y', 'PROPFIND', { Depth: '1' }, null)
    expect(r).toMatchObject({ status: 207, headers: { 'x-a': 'b' } })
    expect(base64ToBytes((r as { bodyB64: string }).bodyB64)).toEqual(body)
  })
  it('PUT 携带 b64 body；空 body 回 null；网络错回结构化 error 不抛', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const ok = await handleCloudFetch('https://x', 'PUT', {}, bytesToBase64(new Uint8Array([9])))
    expect(ok).toMatchObject({ status: 200, bodyB64: null })
    expect(new Uint8Array((fetchMock.mock.calls[0]![1] as RequestInit).body as ArrayBuffer)).toEqual(new Uint8Array([9]))
    const err = await handleCloudFetch('https://x', 'GET', {}, null)
    expect((err as { error: string }).error).toContain('Failed to fetch')
  })
  it('缺 url 拒绝', async () => {
    expect(await handleCloudFetch('', 'GET', {}, null)).toMatchObject({ error: expect.any(String) })
  })
})
