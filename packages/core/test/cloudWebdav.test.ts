import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebdavBackend, joinDavUrl } from '../src/cloud/webdav'
import { createGistBackend } from '../src/cloud/gist'
import { setCloudFetch, __resetCloudFetchForTest } from '../src/cloud/backend'
import type { CloudProxy } from '../src/cloud/backend'

const PATH = 'totp-backup.totpbackup'
const DAV = 'https://dav.example.com'
const AUTH_BASIC = `Basic ${btoa('user:pass')}`

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('joinDavUrl（拼接归一）', () => {
  it('serverUrl 多重尾斜杠与 path 多重前导斜杠归一为单斜杠（不产生双斜杠 URL）', () => {
    expect(joinDavUrl(`${DAV}/dav//`, '//dir/obj.totpbackup')).toBe(`${DAV}/dav/dir/obj.totpbackup`)
    expect(joinDavUrl(DAV, PATH)).toBe(`${DAV}/${PATH}`)
    expect(joinDavUrl(`${DAV}///`, '/')).toBe(`${DAV}/`)
  })
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

  it('exists：409（父目录缺失，坚果云 AncestorsNotFound）→ false 交由 push 逐级建目录自愈（2026-10-06 真机 e2e）', async () => {
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<d:error><s:exception>AncestorsNotFound</s:exception></d:error>', { status: 409 })))
    expect(await backend.exists(PATH)).toBe(false)
  })

  it('listBackups：PROPFIND 父目录 Depth:1，multistatus href 末段过滤 BACKUP_NAME_RE', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response><D:href>/dav/dir/sub/</D:href></D:response>
<D:response><D:href>/dav/dir/sub/vault-20260101-000000.totpbackup</D:href></D:response>
<D:response><D:href>/dav/dir/sub/vault-20260202-000000.totpbackup</D:href></D:response>
<D:response><D:href>/dav/dir/sub/vault-backup.totpbackup</D:href></D:response>
<D:response><D:href>/dav/dir/sub/conflict-webdav-20260101-000000.totpbackup</D:href></D:response>
<D:response><D:href>/dav/dir/sub/notes.txt</D:href></D:response>
</D:multistatus>`
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(_url).toBe(`${DAV}/dir/sub/`)
      expect(init!.method).toBe('PROPFIND')
      const headers = init!.headers as Record<string, string>
      expect(headers.Depth).toBe('1')
      expect(headers.Authorization).toBe(AUTH_BASIC)
      return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass', objectPath: 'dir/sub/totp-backup.totpbackup' })
    // 返回与 put/get/delete 同域的完整路径（dir/name）——子目录 cred 下裸名会删错层 404
    expect(await backend.listBackups!()).toEqual(['dir/sub/vault-20260101-000000.totpbackup', 'dir/sub/vault-20260202-000000.totpbackup'])
  })

  it('listBackups：根路径对象 PROPFIND 集合根；非法百分号编码 href 不中断', async () => {
    const xml = `<multistatus xmlns="DAV:">
<response><href>${DAV}/vault-20260101-000000.totpbackup</href></response>
<response><href>/100%zz.totpbackup</href></response>
<response><href>/</href></response>
</multistatus>`
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(url).toBe(`${DAV}/`)
      return new Response(xml, { status: 207 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    expect(await backend.listBackups!()).toEqual(['vault-20260101-000000.totpbackup'])
  })

  it('listBackups：非 2xx 抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    await expect(backend.listBackups!()).rejects.toThrow('WebDAV 请求失败（HTTP 401）')
  })

  it('put 前逐级 MKCOL 建父目录（spec §4.2）：405 已存在容忍，随后 PUT', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'MKCOL') {
        // 第一级成功 201，第二级已存在 405（容忍）
        return new Response(null, String(url).endsWith('/a') ? { status: 201 } : { status: 405 })
      }
      return new Response(null, { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: `${DAV}/dav/`, username: 'user', password: 'pass', objectPath: 'a/b/x.totpbackup' })
    await backend.put('a/b/x.totpbackup', new TextEncoder().encode('hi'))
    const mkcols = fetchMock.mock.calls.filter((c) => c[1]!.method === 'MKCOL').map((c) => String(c[0]))
    expect(mkcols).toEqual([`${DAV}/dav/a`, `${DAV}/dav/a/b`])
    const last = fetchMock.mock.calls.at(-1)!
    expect(last[1]!.method).toBe('PUT')
    expect(String(last[0])).toBe(`${DAV}/dav/a/b/x.totpbackup`)
  })

  it('put：MKCOL 失败（403）抛错且不发 PUT；根目录对象（无目录段）不 MKCOL', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass', objectPath: 'a/b/x.totpbackup' })
    await expect(backend.put('a/b/x.totpbackup', new Uint8Array([1]))).rejects.toThrow(/403/)
    expect(fetchMock.mock.calls.every((c) => c[1]!.method === 'MKCOL')).toBe(true)

    const rootMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', rootMock)
    const rootBackend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
    await rootBackend.put(PATH, new Uint8Array([1]))
    expect(rootMock.mock.calls.every((c) => c[1]!.method === 'PUT')).toBe(true)
  })

  it('R2-M2：建目录由 path 参数派生——非 cred 派生 path 传入时 MKCOL 覆盖其父目录', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    // cred 自带默认目录 default，但 put 传入 custom 派生 path：MKCOL 须按 path 而非 cred
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass', objectPath: 'default/x.totpbackup' })
    await backend.put('custom/sub/vault.totpbackup', new Uint8Array([1]))
    const mkcols = fetchMock.mock.calls.filter((c) => c[1]!.method === 'MKCOL').map((c) => String(c[0]))
    expect(mkcols).toEqual([`${DAV}/custom`, `${DAV}/custom/sub`])
    const last = fetchMock.mock.calls.at(-1)!
    expect(last[1]!.method).toBe('PUT')
    expect(String(last[0])).toBe(`${DAV}/custom/sub/vault.totpbackup`)
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

  it('listBackups：GET gist 后 files 键名过滤 BACKUP_NAME_RE（gist 文件名无目录层级）；content=\'\' 残留键剔除', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ public: false, files: {
      'vault-20260101-000000.totpbackup': { content: 'a' },
      'vault-20260202-000000.totpbackup': { content: 'b' },
      'vault-20251231-000000.totpbackup': { content: '' }, // delete 置空残留（gist 无法真删），不再参与滚动删除
      'vault-backup.totpbackup': { content: 'c' },
      'conflict-gist-20260101-000000.totpbackup': { content: 'd' },
      'notes.txt': { content: 'e' },
    } })))
    const backend = createGistBackend(CRED)
    expect(await backend.listBackups!()).toEqual(['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup'])
  })

  it('listBackups：gist 404 → 空数组；401 抛中文错误', async () => {
    const backend = createGistBackend(CRED)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.listBackups!()).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    await expect(backend.listBackups!()).rejects.toThrow('Gist 请求失败（HTTP 401）')
  })
})

describe('provider proxy 透传（③，云-M2：各链路直达注入层）', () => {
  afterEach(() => __resetCloudFetchForTest())

  const capture: Array<CloudProxy | undefined> = []
  const impl = async (_label: string, _url: string, _init: RequestInit | undefined, proxy?: CloudProxy): Promise<Response> => {
    capture.push(proxy)
    return new Response(null, { status: 200 })
  }
  beforeEach(() => capture.length = 0)

  it('webdav：cred.proxy 经 cloudFetch 第 4 参到达注入层（put 链）', async () => {
    setCloudFetch(impl)
    const cred = { backend: 'webdav' as const, serverUrl: 'https://dav', username: 'u', password: 'p', objectPath: 'a.totpbackup', proxy: { mode: 'custom' as const, url: 'socks5h://127.0.0.1:7890' } }
    await createWebdavBackend(cred).put('a.totpbackup', new Uint8Array([1]))
    expect(capture.length).toBeGreaterThan(0)
    expect(capture[0]).toEqual({ mode: 'custom', url: 'socks5h://127.0.0.1:7890' })
  })

  it('gist：cred.proxy 经 cloudFetch 第 4 参到达注入层（put 链）', async () => {
    setCloudFetch(impl)
    const cred = { backend: 'gist' as const, token: 'tok', gistId: 'gid123', proxy: { mode: 'system' as const } }
    await createGistBackend(cred).put(PATH, new TextEncoder().encode('hello'))
    expect(capture.length).toBeGreaterThan(0)
    expect(capture[0]).toEqual({ mode: 'system' })
  })
})
