import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGistBackend } from '../src/cloud/gist'

const PATH = 'totp-backup.totpbackup'
const BYTES = new TextEncoder().encode('hello')

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Gist 后端', () => {
  it('get：fetchGist 返回的 public=true 触发 onCredChange 回存 public 标志', async () => {
    const onCredChange = vi.fn()
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      jsonRes({ public: true, files: { [PATH]: { content: 'hi' } } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGistBackend({ backend: 'gist', token: 't', gistId: 'abc' }, { onCredChange })
    const got = await backend.get(PATH)
    expect(new TextDecoder().decode(got!)).toBe('hi')
    expect(onCredChange).toHaveBeenCalledWith({ backend: 'gist', token: 't', gistId: 'abc', public: true })
  })
  it('get：public 状态未变化 → 不触发 onCredChange', async () => {
    const onCredChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonRes({ public: false, files: { [PATH]: { content: 'hi' } } }),
    ))
    const backend = createGistBackend({ backend: 'gist', token: 't', gistId: 'abc', public: false }, { onCredChange })
    await backend.get(PATH)
    expect(onCredChange).not.toHaveBeenCalled()
  })
  it('exists + delete：通过 fetchGist 解析；truncated 文件抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonRes({ public: false, files: { [PATH]: { content: 'x', truncated: true } } }),
    ))
    const backend = createGistBackend({ backend: 'gist', token: 't', gistId: 'abc' })
    await expect(backend.get(PATH)).rejects.toThrow('Gist 文件过大（超过 1MB 被截断），无法读取完整内容')
  })
})