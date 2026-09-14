import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebdavBackend } from '../src/cloud/webdav'
import { createGistBackend } from '../src/cloud/gist'

const PATH = 'totp-backup.totpbackup'
const DAV = 'https://dav.example.com'
const AUTH_BASIC = `Basic ${btoa('user:pass')}`

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebDAV 后端', () => {
  it('put：PUT + Basic Auth + 字节 body，serverUrl 尾斜杠归一', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: `${DAV}/dav/`, username: 'user', password: 'pass' })
    await backend.put(PATH, new TextEncoder().encode('hello'))
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${DAV}/dav/${PATH}`)
    expect(init!.method).toBe('PUT')
    expect((init!.headers as Record<string, string>).Authorization).toBe(AUTH_BASIC)
    expect(new TextDecoder().decode(init!.body as Uint8Array)).toBe('hello')
  })

  it('get：200 返回字节，404 返回 null', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(bytes, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    expect(await backend.get(PATH)).toEqual(bytes)
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('GET')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.get(PATH)).toBeNull()
  })

  it('get：401 抛中文错误（含状态码）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    await expect(backend.get(PATH)).rejects.toThrow('WebDAV 请求失败（HTTP 401）')
  })

  it('get：网络失败抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    await expect(backend.get(PATH)).rejects.toThrow('WebDAV 网络请求失败：fetch failed')
  })

  it('delete：DELETE + Basic Auth，非 2xx 抛错', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    await backend.delete(PATH)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${DAV}/${PATH}`)
    expect(init!.method).toBe('DELETE')
    expect((init!.headers as Record<string, string>).Authorization).toBe(AUTH_BASIC)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    await expect(backend.delete(PATH)).rejects.toThrow('WebDAV 请求失败（HTTP 500）')
  })

  it('exists：200 → true，404 → false，500 → 抛错', async () => {
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    expect(await backend.exists(PATH)).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.exists(PATH)).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    await expect(backend.exists(PATH)).rejects.toThrow('WebDAV 请求失败（HTTP 500）')
  })
})

describe('Gist 后端', () => {
  const GIST_URL = `https://api.github.com/gists/gid123`
  const CRED = { backend: 'gist' as const, token: 'tok', gistId: 'gid123' }

  it('put：PATCH + Bearer token，body files[path].content 为 UTF-8 文本', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGistBackend(CRED)
    await backend.put(PATH, new TextEncoder().encode('hello'))
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(GIST_URL)
    expect(init!.method).toBe('PATCH')
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init!.body as string)).toEqual({ files: { [PATH]: { content: 'hello' } } })
  })

  it('get：files[path].content → 字节；文件缺失 → null', async () => {
    const backend = createGistBackend(CRED)
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: { [PATH]: { content: 'abc' } } })))
    expect(new TextDecoder().decode((await backend.get(PATH))!)).toBe('abc')
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: {} })))
    expect(await backend.get(PATH)).toBeNull()
  })

  it('get：truncated=true 抛「文件过大」中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: { [PATH]: { content: 'abc', truncated: true } } })))
    const backend = createGistBackend(CRED)
    await expect(backend.get(PATH)).rejects.toThrow('文件过大')
  })

  it('get：gist 不存在（404）→ null；401 抛中文错误', async () => {
    const backend = createGistBackend(CRED)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.get(PATH)).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    await expect(backend.get(PATH)).rejects.toThrow('Gist 请求失败（HTTP 401）')
  })

  it('get：网络失败抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const backend = createGistBackend(CRED)
    await expect(backend.get(PATH)).rejects.toThrow('Gist 网络请求失败：fetch failed')
  })

  it('delete：PATCH 将 content 置空串', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGistBackend(CRED)
    await backend.delete(PATH)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(GIST_URL)
    expect(init!.method).toBe('PATCH')
    expect(JSON.parse(init!.body as string)).toEqual({ files: { [PATH]: { content: '' } } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    await expect(backend.delete(PATH)).rejects.toThrow('Gist 请求失败（HTTP 403）')
  })

  it('exists：文件存在且非空 → true；缺失或空串 → false', async () => {
    const backend = createGistBackend(CRED)
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: { [PATH]: { content: 'abc' } } })))
    expect(await backend.exists(PATH)).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: { [PATH]: { content: '' } } })))
    expect(await backend.exists(PATH)).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: {} })))
    expect(await backend.exists(PATH)).toBe(false)
  })
})
