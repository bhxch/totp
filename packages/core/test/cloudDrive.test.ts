import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGDriveBackend } from '../src/cloud/gdrive'
import { createOneDriveBackend } from '../src/cloud/onedrive'

const PATH = 'totp-backup.totpbackup'
const BYTES = new TextEncoder().encode('hello')

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function headersOf(init?: RequestInit): Record<string, string> {
  return init!.headers as Record<string, string>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Google Drive 后端', () => {
  it('put：无 fileId——先 POST 创建取 id，再 PATCH media 上传字节，并回调 onCredChange 回存凭据', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (init!.method === 'POST' && u === 'https://www.googleapis.com/drive/v3/files') {
        return jsonRes({ id: 'fid123', name: PATH })
      }
      if (init!.method === 'PATCH' && u === 'https://www.googleapis.com/upload/drive/v3/files/fid123?uploadType=media') {
        return new Response(null, { status: 200 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCredChange = vi.fn()
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' }, { onCredChange })
    await backend.put(PATH, BYTES)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [createUrl, createInit] = fetchMock.mock.calls[0]!
    expect(createUrl).toBe('https://www.googleapis.com/drive/v3/files')
    expect(createInit!.method).toBe('POST')
    expect(headersOf(createInit).Authorization).toBe('Bearer tok')
    expect(headersOf(createInit)['Content-Type']).toBe('application/json')
    // 创建文件必须声明 mimeType=application/json,使后续 files.list 查询可按 mimeType 限定
    expect(JSON.parse(createInit!.body as string)).toEqual({ name: PATH, mimeType: 'application/json' })

    const [upUrl, upInit] = fetchMock.mock.calls[1]!
    expect(upUrl).toBe('https://www.googleapis.com/upload/drive/v3/files/fid123?uploadType=media')
    expect(upInit!.method).toBe('PATCH')
    expect(headersOf(upInit)['Content-Type']).toBe('application/octet-stream')
    expect(new TextDecoder().decode(upInit!.body as Uint8Array)).toBe('hello')

    expect(onCredChange).toHaveBeenCalledOnce()
    expect(onCredChange).toHaveBeenCalledWith({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid123' })
  })

  it('put：已有 fileId——仅 PATCH media 上传，不再创建、不触发 onCredChange；第二次 put 复用内存 id', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onCredChange = vi.fn()
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' }, { onCredChange })
    await backend.put(PATH, BYTES)
    await backend.put(PATH, BYTES)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://www.googleapis.com/upload/drive/v3/files/fid9?uploadType=media')
    expect(onCredChange).not.toHaveBeenCalled()
  })

  it('put：创建文件失败（非 2xx）抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
    await expect(backend.put(PATH, BYTES)).rejects.toThrow('Google Drive 请求失败（HTTP 403）')
  })

  it('get：无 fileId——按 name 查 files.list（trashed=false + mimeType）取 id 后 alt=media 拉取字节，并回写 fileId', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.origin + u.pathname === 'https://www.googleapis.com/drive/v3/files') {
        // 查询必须同时限定 mimeType,防止同名非加密文件被误命中
        expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(`name='${PATH}' and mimeType='application/json' and trashed=false`)
        expect(u.searchParams.get('fields')).toBe('files(id,name,mimeType)')
        return jsonRes({ files: [{ id: 'fid123', name: PATH, mimeType: 'application/json' }] })
      }
      if (String(url) === 'https://www.googleapis.com/drive/v3/files/fid123?alt=media' && init!.method === 'GET') {
        return new Response(BYTES, { status: 200 })
      }
      throw new Error(`意外请求：${init!.method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCredChange = vi.fn()
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' }, { onCredChange })
    expect(new TextDecoder().decode((await backend.get(PATH))!)).toBe('hello')
    // 首次按 name 解析到 fileId 时应回写凭据,避免后续每次重复查询
    expect(onCredChange).toHaveBeenCalledWith({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid123' })
  })

  it('get：name 查询无匹配返回 null（不发起 media 请求）', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ files: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
    expect(await backend.get(PATH)).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('get：已有 fileId 直接拉 media；media 404 返回 null；401 抛中文错误', async () => {
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://www.googleapis.com/drive/v3/files/fid9?alt=media')
      return new Response(BYTES, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(new TextDecoder().decode((await backend.get(PATH))!)).toBe('hello')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.get(PATH)).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    await expect(backend.get(PATH)).rejects.toThrow('Google Drive 请求失败（HTTP 401）')
  })

  it('delete：fileId 已设且目标异名（keep-n 时间戳名）→ 按名查 id 删同名文件，绝不触碰 files/{fileId}，不回写 fileId', async () => {
    const onCredChange = vi.fn()
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (init!.method === 'GET' && u.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        // 按名查询的 name 与 put 的创建名同串（完整 path），非主对象名
        expect(decodeURIComponent(new URL(u).searchParams.get('q')!)).toBe(
          `name='dir/sub/vault-20260101-000000.totpbackup' and mimeType='application/json' and trashed=false`,
        )
        return jsonRes({ files: [{ id: 'tsfile1' }] })
      }
      if (init!.method === 'DELETE' && u === 'https://www.googleapis.com/drive/v3/files/tsfile1') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9', objectPath: 'dir/sub/totp-backup.totpbackup' }, { onCredChange })
    await backend.delete('dir/sub/vault-20260101-000000.totpbackup')
    // 仅 list + DELETE tsfile1 两次请求——绝不出现 files/fid9 的 DELETE（主 vault 对象保护）
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onCredChange).not.toHaveBeenCalled() // 异名查询不劫持主对象指针
  })

  it('delete：异名目标按名查不到 → 静默返回（宁可不删），不发 DELETE', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ files: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    await backend.delete('vault-20260101-000000.totpbackup')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('delete：无 fileId 先查询再 DELETE files/{id}；查询无匹配则不请求；已有 fileId 直接 DELETE', async () => {
    // 无 fileId：list → DELETE
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (init!.method === 'GET' && u.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        return jsonRes({ files: [{ id: 'fid123' }] })
      }
      if (init!.method === 'DELETE' && u === 'https://www.googleapis.com/drive/v3/files/fid123') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
    await backend.delete(PATH)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 查询无匹配：不发 DELETE、不抛错
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: [] })))
    await backend.delete(PATH)

    // 已有 fileId：直接 DELETE
    const directMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init!.method).toBe('DELETE')
      expect(String(url)).toBe('https://www.googleapis.com/drive/v3/files/fid9')
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', directMock)
    const withId = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    await withId.delete(PATH)
    expect(directMock).toHaveBeenCalledOnce()
  })

  it('exists：无 fileId 查询非空 → true，空 → false；有 fileId 元数据 200 → true，404 → false', async () => {
    const backend1 = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: [{ id: 'fid1' }] })))
    expect(await backend1.exists(PATH)).toBe(true)

    // 另起 backend 实例(fileId 内存独立)验证空查询路径
    const backend2 = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ files: [] })))
    expect(await backend2.exists(PATH)).toBe(false)

    const withId = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://www.googleapis.com/drive/v3/files/fid9?fields=id')
      return jsonRes({ id: 'fid9' })
    }))
    expect(await withId.exists(PATH)).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await withId.exists(PATH)).toBe(false)
  })
  it('name 含单引号：files.list q 中单引号转义为 \\’，防止破坏查询字符串', async () => {
    const trickyName = "it's-totp-backup.totpbackup"
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url))
      expect(u.origin + u.pathname).toBe('https://www.googleapis.com/drive/v3/files')
      // 单引号已转义为 \',Drive 查询解析器视为字面量
      expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(
        `name='it\\'s-totp-backup.totpbackup' and mimeType='application/json' and trashed=false`,
      )
      return jsonRes({ files: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
    expect(await backend.exists(trickyName)).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('get：网络失败抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    await expect(backend.get(PATH)).rejects.toThrow('Google Drive 网络请求失败：fetch failed')
  })

  it('listBackups：files/{fileId}?fields=parents 取父目录，再列同父 vault-*；names 过滤 BACKUP_NAME_RE', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.origin + u.pathname === 'https://www.googleapis.com/drive/v3/files/fid9' && u.searchParams.get('fields') === 'parents') {
        return jsonRes({ parents: ['pid1'] })
      }
      if (u.origin + u.pathname === 'https://www.googleapis.com/drive/v3/files') {
        expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(`'pid1' in parents and name contains 'vault-' and trashed=false`)
        expect(u.searchParams.get('fields')).toBe('files(name,nextPageToken)')
        return jsonRes({ files: [
          { name: 'vault-20260101-000000.totpbackup' },
          { name: 'vault-20260202-000000.totpbackup' },
          { name: 'vault-backup.totpbackup' },
          { name: 'conflict-gdrive-20260101-000000.totpbackup' },
          { name: 'notes.txt' },
        ] })
      }
      throw new Error(`意外请求：${init!.method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    expect(await backend.listBackups!()).toEqual(['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('listBackups：nextPageToken 分页续传聚合两页（审查 M2）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.origin + u.pathname === 'https://www.googleapis.com/drive/v3/files/fid9' && u.searchParams.get('fields') === 'parents') {
        return jsonRes({ parents: ['pid1'] })
      }
      if (u.origin + u.pathname === 'https://www.googleapis.com/drive/v3/files') {
        if (u.searchParams.get('pageToken') === null) {
          return jsonRes({ files: [{ name: 'vault-20260101-000000.totpbackup' }], nextPageToken: 'tok/2+a==' })
        }
        expect(u.searchParams.get('pageToken')).toBe('tok/2+a==')
        return jsonRes({ files: [{ name: 'vault-20260202-000000.totpbackup' }, { name: 'notes.txt' }] })
      }
      throw new Error(`意外请求：${init!.method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    // 两页聚合完整；第二页无 token 续拉终止
    expect(await backend.listBackups!()).toEqual(['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('listBackups：无 fileId 列 root；目标文件 404 → 空数组；非 2xx 抛中文错误', async () => {
    // 无 fileId：parents 未知，按 Drive 根目录别名 'root' 列
    const rootMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url))
      expect(u.origin + u.pathname).toBe('https://www.googleapis.com/drive/v3/files')
      expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(`'root' in parents and name contains 'vault-' and trashed=false`)
      return jsonRes({ files: [{ name: 'vault-20260101-000000.totpbackup' }] })
    })
    vi.stubGlobal('fetch', rootMock)
    const noId = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
    expect(await noId.listBackups!()).toEqual(['vault-20260101-000000.totpbackup'])
    expect(rootMock).toHaveBeenCalledOnce()

    // fileId 指向的文件已被删（404）→ 不知父目录，返回空（宁可不删不可误删）
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    const gone = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    expect(await gone.listBackups!()).toEqual([])

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    await expect(gone.listBackups!()).rejects.toThrow('Google Drive 请求失败（HTTP 401）')
  })
})

describe('OneDrive 后端', () => {
  const GRAPH = 'https://graph.microsoft.com/v1.0'
  const CONTENT_URL = `${GRAPH}/me/drive/root:/${PATH}:/content`
  const ITEM_URL = `${GRAPH}/me/drive/root:/${PATH}:`

  it('put：PUT root:/path:/content + Bearer + octet-stream 字节 body', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    await backend.put(PATH, BYTES)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(CONTENT_URL)
    expect(init!.method).toBe('PUT')
    const headers = headersOf(init)
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['Content-Type']).toBe('application/octet-stream')
    expect(new TextDecoder().decode(init!.body as Uint8Array)).toBe('hello')
  })

  it('get：200 返回字节，404 返回 null，401 抛中文错误', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(CONTENT_URL)
      return new Response(BYTES, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    expect(new TextDecoder().decode((await backend.get(PATH))!)).toBe('hello')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.get(PATH)).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    await expect(backend.get(PATH)).rejects.toThrow('OneDrive 请求失败（HTTP 401）')
  })

  it('delete：DELETE root:/path:，非 2xx 抛中文错误', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(ITEM_URL)
      expect(init!.method).toBe('DELETE')
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    await backend.delete(PATH)
    expect(fetchMock).toHaveBeenCalledOnce()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    await expect(backend.delete(PATH)).rejects.toThrow('OneDrive 请求失败（HTTP 500）')
  })

  it('exists：GET root:/path: 200 → true，404 → false', async () => {
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(ITEM_URL)
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await backend.exists(PATH)).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.exists(PATH)).toBe(false)
  })

  it('路径逐段编码：含空格子目录编码为 %20，分隔符保留', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    await backend.put('my dir/totp.totpbackup', BYTES)
    expect(fetchMock.mock.calls[0]![0]).toBe(`${GRAPH}/me/drive/root:/my%20dir/totp.totpbackup:/content`)
  })

  it('get：网络失败抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    await expect(backend.get(PATH)).rejects.toThrow('OneDrive 网络请求失败：fetch failed')
  })

  it('listBackups：按编码路径取 item parentReference，再列 children 过滤 BACKUP_NAME_RE', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u === `${GRAPH}/me/drive/root:/dir/sub/totp-backup.totpbackup:?select=parentReference`) {
        return jsonRes({ parentReference: { driveId: 'd1', id: 'pid1', path: '/drive/root:/dir/sub' } })
      }
      if (u === `${GRAPH}/me/drive/items/pid1/children`) {
        return jsonRes({ value: [
          { name: 'vault-20260101-000000.totpbackup' },
          { name: 'vault-20260202-000000.totpbackup' },
          { name: 'vault-backup.totpbackup' },
          { name: 'conflict-webdav-20260101-000000.totpbackup' },
          { name: 'notes.txt' },
        ] })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok', objectPath: 'dir/sub/totp-backup.totpbackup' })
    // 返回与 put/get/delete 同域的完整路径（dir/name）——子目录 cred 下裸名会删错层
    expect(await backend.listBackups!()).toEqual(['dir/sub/vault-20260101-000000.totpbackup', 'dir/sub/vault-20260202-000000.totpbackup'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('listBackups：@odata.nextLink 分页续传聚合两页（审查 M2）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u === `${GRAPH}/me/drive/root:/totp-backup.totpbackup:?select=parentReference`) {
        return jsonRes({ parentReference: { id: 'pid1' } })
      }
      if (u === `${GRAPH}/me/drive/items/pid1/children`) {
        return jsonRes({
          value: [{ name: 'vault-20260101-000000.totpbackup' }],
          '@odata.nextLink': `${GRAPH}/me/drive/items/pid1/children?$skiptoken=1`,
        })
      }
      if (u === `${GRAPH}/me/drive/items/pid1/children?$skiptoken=1`) {
        return jsonRes({ value: [{ name: 'vault-20260202-000000.totpbackup' }, { name: 'notes.txt' }] })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    // nextLink 续拉一页聚合完整；第二页无 nextLink 终止
    expect(await backend.listBackups!()).toEqual(['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('listBackups：item 404 → 空数组；缺 parentReference.id → 空数组；非 2xx 抛中文错误', async () => {
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.listBackups!()).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({})))
    expect(await backend.listBackups!()).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    await expect(backend.listBackups!()).rejects.toThrow('OneDrive 请求失败（HTTP 500）')
  })
})
