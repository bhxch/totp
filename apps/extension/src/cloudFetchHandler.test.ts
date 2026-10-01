import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '@totp/core'
import { CLOUD_FETCH_TIMEOUT_MS, handleCloudFetch, handleCloudFetchMessage } from './cloudFetchHandler'

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

  it('超时常量与桌面端 DEFAULT_TIMEOUT_MS 对齐（云-I1）', () => {
    expect(CLOUD_FETCH_TIMEOUT_MS).toBe(60_000)
  })
  it('fetch 收到未中止的超时 signal；调用方 signal 与超时组合而非覆盖（云-I1）', async () => {
    let seen: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      seen = init!.signal
      return Promise.resolve(new Response(null, { status: 200 }))
    }))
    const caller = new AbortController().signal
    await handleCloudFetch('https://x', 'GET', {}, null, { signal: caller, timeoutMs: 60_000 })
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen!.aborted).toBe(false)
  })
  it('目标挂起：超时中止后回结构化 error，页面 promise 不永久 pending（云-I1）', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
    })))
    const r = await handleCloudFetch('https://x', 'GET', {}, null, { timeoutMs: 5 })
    expect((r as { error: string }).error).toContain('aborted')
  })
})

describe("background 'cloud-fetch' 消息来源校验（云-I3）", () => {
  const SELF_ID = 'abcdefghijklmnopabcdefghijklmnop'

  function setup() {
    const sendResponse = vi.fn()
    return { sendResponse }
  }

  it('sender.id 与自身 runtime id 不符 → 同步拒绝（返回 false，不发 fetch）', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { sendResponse } = setup()
    const keepOpen = handleCloudFetchMessage({ url: 'https://evil/x' }, { id: 'other-extension' }, sendResponse, SELF_ID)
    expect(keepOpen).toBe(false)
    expect(sendResponse).toHaveBeenCalledWith({ error: expect.stringContaining('拒绝') })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('sender.id 缺失（无 externally_connectable 的外部页面）→ 拒绝', () => {
    const { sendResponse } = setup()
    const keepOpen = handleCloudFetchMessage({ url: 'https://x' }, {}, sendResponse, SELF_ID)
    expect(keepOpen).toBe(false)
    expect(sendResponse).toHaveBeenCalledWith({ error: expect.any(String) })
  })
  it('sender 缺失/非对象（防御）→ 拒绝', () => {
    const { sendResponse } = setup()
    expect(handleCloudFetchMessage({ url: 'https://x' }, undefined, sendResponse, SELF_ID)).toBe(false)
    expect(handleCloudFetchMessage(undefined, undefined, sendResponse, SELF_ID)).toBe(false)
  })
  it('sender.id 匹配 → 放行：fetch 执行并异步回传应答（返回 true 保持通道）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 201 })))
    const { sendResponse } = setup()
    const keepOpen = handleCloudFetchMessage({ url: 'https://x', method: 'PUT' }, { id: SELF_ID }, sendResponse, SELF_ID)
    expect(keepOpen).toBe(true)
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 201 })))
  })
})
