import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudHttpError, isAuthError } from '../src/cloud/backend'
import { createGDriveBackend } from '../src/cloud/gdrive'
import { createOneDriveBackend } from '../src/cloud/onedrive'
import { __resetOAuthCacheForTest } from '../src/cloud/oauthRefresh'

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

  it('put：已有 fileId + 时间戳 path（keep 源）→ 同父目录新建文件，绝不 PATCH 主文件、不回写 fileId（审查 I2）', async () => {
    let created = 0
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (init!.method === 'GET' && u.pathname === '/drive/v3/files/fid9' && u.searchParams.get('fields') === 'parents') {
        return jsonRes({ parents: ['pid1'] })
      }
      if (init!.method === 'POST' && u.origin + u.pathname === 'https://www.googleapis.com/drive/v3/files') {
        // 新建文件落主对象同一父目录，name 为时间戳 basename，mimeType 限定 envelope
        const body = JSON.parse(init!.body as string) as { name: string; mimeType?: string; parents?: string[] }
        expect(body.name).toMatch(/^vault-\d{8}-\d{6}\.totpbackup$/)
        expect(body).toEqual({ name: body.name, mimeType: 'application/json', parents: ['pid1'] })
        return jsonRes({ id: `tsfile${++created}` })
      }
      if (init!.method === 'PATCH' && /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\/tsfile\d\?uploadType=media$/.test(String(url))) {
        expect(new TextDecoder().decode(init!.body as Uint8Array)).toBe('hello')
        return new Response(null, { status: 200 })
      }
      throw new Error(`意外请求：${init!.method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCredChange = vi.fn()
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9', objectPath: 'dir/sub/totp-backup.totpbackup' }, { onCredChange })
    await backend.put('dir/sub/vault-20260101-000000.totpbackup', BYTES)
    // 第二轮 keep 上传：fileId 未被时间戳文件劫持，仍走新建——keep 语义不退化 overwrite
    await backend.put('dir/sub/vault-20260102-000000.totpbackup', BYTES)
    expect(onCredChange).not.toHaveBeenCalled() // 新 fileId 不覆盖主凭据
    expect(fetchMock.mock.calls.filter(([, i]) => i!.method === 'POST')).toHaveLength(2)
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toBe('https://www.googleapis.com/upload/drive/v3/files/fid9?uploadType=media') // 绝不 PATCH 主文件
    }
  })

  it('put：已有 fileId 且 path basename == 主对象名 → 仍直接 PATCH 主文件（overwrite 语义不变）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init!.method).toBe('PATCH')
      expect(String(url)).toBe('https://www.googleapis.com/upload/drive/v3/files/fid9?uploadType=media')
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9', objectPath: 'dir/sub/totp-backup.totpbackup' })
    await backend.put('dir/sub/totp-backup.totpbackup', BYTES)
    expect(fetchMock).toHaveBeenCalledOnce() // 无 parents GET、无 POST——主对象直传
  })

  it('put：已有 fileId + 时间戳 path 但主对象已删（parents 404）→ 抛中文错误中止，不落 root 成孤儿（审查勘误）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (init!.method === 'GET' && u.pathname === '/drive/v3/files/fid9' && u.searchParams.get('fields') === 'parents') {
        return new Response(null, { status: 404 }) // fileId 指向的文件已被删
      }
      throw new Error(`意外请求：${init!.method} ${url}`) // 任何 POST/PATCH 均为意外——绝不静默上传
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9', objectPath: 'dir/sub/totp-backup.totpbackup' })
    await expect(backend.put('dir/sub/vault-20260101-000000.totpbackup', BYTES)).rejects.toThrow('Google Drive 主文件已不存在（fileId 失效）')
    expect(fetchMock).toHaveBeenCalledOnce() // 仅 parents 探测——无 POST files.create、无 media 上传
  })

  it('put：无 fileId + 时间戳 path（首推即 keep）→ 先建立主对象并回存凭据，再同目录新建时间戳文件', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (init!.method === 'POST' && u.origin + u.pathname === 'https://www.googleapis.com/drive/v3/files') {
        const body = JSON.parse(init!.body as string) as { name: string; parents?: string[] }
        if (body.name === PATH) return jsonRes({ id: 'main1' }) // 主对象：首推自动创建（无 parents）
        expect(body).toEqual({ name: 'vault-20260101-000000.totpbackup', mimeType: 'application/json', parents: ['pidX'] })
        return jsonRes({ id: 'tsfile1' })
      }
      if (init!.method === 'PATCH' && String(url) === 'https://www.googleapis.com/upload/drive/v3/files/main1?uploadType=media') {
        return new Response(null, { status: 200 })
      }
      if (init!.method === 'GET' && u.pathname === '/drive/v3/files/main1' && u.searchParams.get('fields') === 'parents') {
        return jsonRes({ parents: ['pidX'] })
      }
      if (init!.method === 'PATCH' && String(url) === 'https://www.googleapis.com/upload/drive/v3/files/tsfile1?uploadType=media') {
        return new Response(null, { status: 200 })
      }
      throw new Error(`意外请求：${init!.method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCredChange = vi.fn()
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' }, { onCredChange })
    await backend.put('vault-20260101-000000.totpbackup', BYTES)
    // fileId 只指向主对象：仅主对象创建回存凭据
    expect(onCredChange).toHaveBeenCalledTimes(1)
    expect(onCredChange).toHaveBeenCalledWith({ backend: 'gdrive', accessToken: 'tok', fileId: 'main1' })
    expect(fetchMock).toHaveBeenCalledTimes(5) // POST main → PATCH main → GET parents → POST ts → PATCH ts
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
      const u = new URL(String(url))
      if (init!.method === 'GET' && u.pathname === '/drive/v3/files/fid9' && u.searchParams.get('fields') === 'parents') {
        return jsonRes({ parents: ['pid1'] })
      }
      if (init!.method === 'GET' && u.pathname === '/drive/v3/files') {
        // 按名查询的 name 与 put 的创建名同串（完整 path），非主对象名；q 带 parent 约束（审查 I3 删除域=列表域）
        expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(
          `name='dir/sub/vault-20260101-000000.totpbackup' and mimeType='application/json' and 'pid1' in parents and trashed=false`,
        )
        expect(u.searchParams.get('fields')).toBe('files(id,name,mimeType)')
        return jsonRes({ files: [{ id: 'tsfile1' }] })
      }
      if (init!.method === 'DELETE' && String(url) === 'https://www.googleapis.com/drive/v3/files/tsfile1') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9', objectPath: 'dir/sub/totp-backup.totpbackup' }, { onCredChange })
    await backend.delete('dir/sub/vault-20260101-000000.totpbackup')
    // parents + list + DELETE tsfile1 三次请求——绝不出现 files/fid9 的 DELETE（主 vault 对象保护）
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onCredChange).not.toHaveBeenCalled() // 异名查询不劫持主对象指针
  })

  it('delete：双 gdrive 源同名时间戳文件只删本 parent 的（审查 I3 删除域 ⊆ 列表域）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (init!.method === 'GET' && u.pathname === '/drive/v3/files/fid9' && u.searchParams.get('fields') === 'parents') {
        return jsonRes({ parents: ['pidA'] })
      }
      if (init!.method === 'GET' && u.pathname === '/drive/v3/files') {
        // q 必须含 parent 约束：同名文件在 pidA/pidB 两个目录都存在，查询只允许圈定本 parent——
        // 无约束时全 Drive 查 files[0] 可能命中另一源的文件互删
        expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(
          `name='vault-20260101-000000.totpbackup' and mimeType='application/json' and 'pidA' in parents and trashed=false`,
        )
        return jsonRes({ files: [{ id: 'tsfile-pidA' }] }) // 真实 API：pidB 下同名文件不会出现在此结果
      }
      if (init!.method === 'DELETE' && String(url) === 'https://www.googleapis.com/drive/v3/files/tsfile-pidA') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    await backend.delete('vault-20260101-000000.totpbackup')
    expect(fetchMock).toHaveBeenCalledTimes(3) // parents → list（pidA 域）→ DELETE tsfile-pidA
  })

  it('delete：异名目标按名查不到 → 静默返回（宁可不删），不发 DELETE', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url))
      // 无 fileId：parent 回落 Drive 根别名 'root'（与 listBackups 圈列域同源）
      expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(
        `name='vault-20260101-000000.totpbackup' and mimeType='application/json' and 'root' in parents and trashed=false`,
      )
      return jsonRes({ files: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
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
        // nextPageToken 是 FileList 顶层字段：必须放括号外逗号分隔，括号内子选择器遇未知字段真实 API 返 400
        expect(u.searchParams.get('fields')).toBe('files(name),nextPageToken')
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
        // fields 形状防回归（质量审查勘误）：nextPageToken 为 FileList 顶层字段，须在括号外逗号分隔——
        // 错写成 files(name,nextPageToken) 会被真实 API 以 400 Invalid field selection 拒绝
        expect(u.searchParams.get('fields')).toBe('files(name),nextPageToken')
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

  it('put：创建响应缺 id（业务字段缺失）→ 抛专用中文错误（与 HTTP 层错误文案区分）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}))) // 200 但无 id
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok' })
    await expect(backend.put(PATH, BYTES)).rejects.toThrow('files.create 响应缺少文件 id')
  })

  it('primaryParent：200 但无 parents 字段 → 回落 Drive 根别名 root（listBackups 圈列域同源）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/drive/v3/files/fid9' && u.searchParams.get('fields') === 'parents') {
        return jsonRes({}) // 200 无 parents（共享给我的文件等形态）
      }
      if (u.origin + u.pathname === 'https://www.googleapis.com/drive/v3/files') {
        expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(`'root' in parents and name contains 'vault-' and trashed=false`)
        return jsonRes({ files: [] })
      }
      throw new Error(`意外请求：${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    expect(await backend.listBackups!()).toEqual([])
  })

  it('listBackups：响应缺 files 字段 / 条目缺 name → 空结果不抛（宽松容错）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.pathname === '/drive/v3/files/fid9') return jsonRes({ parents: ['pid1'] })
      if (u.pathname === '/drive/v3/files') {
        if (u.searchParams.get('pageToken') !== null) return jsonRes({ files: [{ id: 'noname' }] }) // 条目缺 name：过滤跳过
        return jsonRes({ nextPageToken: '2' }) // 整页缺 files：空迭代不抛，token 仍续拉
      }
      throw new Error(`意外请求：${init!.method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    // 两页均无可用名（页1缺 files、页2缺 name）→ 空结果不抛
    expect(await backend.listBackups!()).toEqual([])
  })

  it('listBackups：nextPageToken 空串 → 视为无续页中止（空串续拉会打出无效请求）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/drive/v3/files/fid9') return jsonRes({ parents: ['pid1'] })
      if (u.searchParams.get('pageToken') === null) {
        return jsonRes({ files: [{ name: 'vault-20260101-000000.totpbackup' }], nextPageToken: '' }) // 空串 token
      }
      throw new Error('空串 token 不应发起续拉')
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    expect(await backend.listBackups!()).toEqual(['vault-20260101-000000.totpbackup'])
    expect(fetchMock).toHaveBeenCalledTimes(2) // parents + 1 页
  })

  it('listBackups：分页上限 10 页（服务端异常持续下发 token 时截断，不失控）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url))
      if (u.pathname === '/drive/v3/files/fid9') return jsonRes({ parents: ['pid1'] })
      if (u.pathname === '/drive/v3/files') {
        const page = Number(u.searchParams.get('pageToken') ?? 0)
        return jsonRes({ files: [{ name: `vault-2026010${page}-000000.totpbackup` }], nextPageToken: String(page + 1) })
      }
      throw new Error(`意外请求：${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    const names = await backend.listBackups!()
    expect(names).toHaveLength(10) // 恰 10 页聚合后截断
    const listCalls = fetchMock.mock.calls.filter(([u]) => new URL(String(u)).pathname === '/drive/v3/files')
    expect(listCalls).toHaveLength(10) // parents 探测 1 次 + list 恰 10 页
  })

  it('delete：异名目标 + 主对象已删（parents 404）→ 静默返回（删除域无法圈定，宁可不删不可误删）', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9', objectPath: 'dir/totp-backup.totpbackup' })
    await backend.delete('dir/vault-20260101-000000.totpbackup')
    expect(fetchMock).toHaveBeenCalledOnce() // 仅 parents 探测，无查询无 DELETE
  })

  it('delete：path 全分隔符（basename 空）→ 异名流程按名查询删除，不误伤主对象', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.pathname === '/drive/v3/files/fid9') return jsonRes({ parents: ['pid1'] })
      if (u.pathname === '/drive/v3/files') {
        expect(decodeURIComponent(u.searchParams.get('q')!)).toBe(
          `name='///' and mimeType='application/json' and 'pid1' in parents and trashed=false`,
        )
        return jsonRes({ files: [{ id: 'weird1' }] })
      }
      if (init!.method === 'DELETE' && String(url) === 'https://www.googleapis.com/drive/v3/files/weird1') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`意外请求：${init!.method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid9' })
    await backend.delete('///')
    expect(fetchMock).toHaveBeenCalledTimes(3)
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

  it('listBackups：children 响应缺 value / 条目缺 name → 空结果不抛（宽松容错，@odata.nextLink 空串同止）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u === `${GRAPH}/me/drive/root:/${PATH}:?select=parentReference`) {
        return jsonRes({ parentReference: { id: 'pid1' } })
      }
      if (u === `${GRAPH}/me/drive/items/pid1/children`) {
        return jsonRes({ '@odata.nextLink': '' }) // 缺 value + 空串 nextLink（都容忍）
      }
      throw new Error(`意外请求：${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok' })
    expect(await backend.listBackups!()).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2) // 空串 nextLink 不发起续拉
  })
})

describe('OAuth 401 自愈（spec §5⑦：cred.oauth 存在 → 刷新重试一次）', () => {
  const GDRIVE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
  const GRAPH = 'https://graph.microsoft.com/v1.0'
  const OAUTH = { clientId: 'cid-1', clientSecret: 'sec-1', refreshToken: 'rtok-1' }

  beforeEach(() => {
    __resetOAuthCacheForTest()
  })

  it('gdrive：请求 401 且带 oauth → POST token 端点刷新，重试带新 token 成功', async () => {
    let apiCalls = 0
    // Authorization 在请求时点捕获：headers 传 auth 引用（真实 fetch 调用时读取），刷新后旧记录会被同步改写
    const apiAuths: string[] = []
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u === GDRIVE_TOKEN_URL) {
        expect(init!.method).toBe('POST')
        const body = new URLSearchParams(String(init!.body))
        expect(body.get('grant_type')).toBe('refresh_token')
        expect(body.get('client_id')).toBe('cid-1')
        expect(body.get('client_secret')).toBe('sec-1')
        expect(body.get('refresh_token')).toBe('rtok-1')
        return jsonRes({ access_token: 'newtok', expires_in: 3600 })
      }
      if (u === 'https://www.googleapis.com/drive/v3/files/fid9?alt=media') {
        apiCalls++
        apiAuths.push(headersOf(init).Authorization ?? '')
        return apiCalls === 1 ? new Response(null, { status: 401 }) : new Response(BYTES, { status: 200 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'stale', fileId: 'fid9', oauth: OAUTH })
    expect(new TextDecoder().decode((await backend.get(PATH))!)).toBe('hello')
    // 首次请求带旧 token、重试带新 token；token 端点仅命中一次（会话缓存去重）
    expect(apiAuths).toEqual(['Bearer stale', 'Bearer newtok'])
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === GDRIVE_TOKEN_URL)).toHaveLength(1)
  })

  it('gdrive：重试仍 401 → 抛凭据失效语义（API 恰两次、token 恰一次，不风暴重试）', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === GDRIVE_TOKEN_URL) return jsonRes({ access_token: 'newtok', expires_in: 3600 })
      return new Response(null, { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'stale', fileId: 'fid9', oauth: OAUTH })
    const err = await backend.get(PATH).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toContain('Google Drive 请求失败（HTTP 401）')
    expect(isAuthError(err)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3) // token 1 + API 2
    const apiCalls = fetchMock.mock.calls.filter(([u]) => !String(u).includes('oauth2.googleapis.com'))
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('oauth2.googleapis.com'))
    expect(apiCalls).toHaveLength(2)
    expect(tokenCalls).toHaveLength(1)
  })

  it('gdrive：刷新失败（token 端点 400）→ 抛结构化 401 语义（isAuthError 判真），不发第二次 API', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === GDRIVE_TOKEN_URL) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      return new Response(null, { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'stale', fileId: 'fid9', oauth: OAUTH })
    const err = await backend.get(PATH).then(() => null, (e: unknown) => e)
    expect(isAuthError(err)).toBe(true)
    expect((err as Error).message).toContain('（HTTP 401）')
    expect(fetchMock).toHaveBeenCalledTimes(2) // 1 API + 1 token，重试未发生
  })

  it('gdrive：刷新失败（token 端点 5xx）→ 抛普通服务错误（isAuthError 判假，不触发凭据失效语义），不发第二次 API', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === GDRIVE_TOKEN_URL) return new Response('upstream error', { status: 502 })
      return new Response(null, { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'stale', fileId: 'fid9', oauth: OAUTH })
    const err = await backend.get(PATH).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(CloudHttpError)
    expect(isAuthError(err)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 1 API + 1 token，重试未发生
  })

  it('gdrive：无 oauth → 401 直接抛，行为与现状一致（token 端点零调用、无重试）', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'stale', fileId: 'fid9' })
    await expect(backend.get(PATH)).rejects.toThrow('Google Drive 请求失败（HTTP 401）')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('onedrive：请求 401 且带 oauth → POST login.microsoftonline.com v2.0/token 刷新，重试成功', async () => {
    let apiCalls = 0
    const apiAuths: string[] = []
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
        const body = new URLSearchParams(String(init!.body))
        expect(body.get('grant_type')).toBe('refresh_token')
        expect(body.get('client_id')).toBe('cid-1')
        expect(body.get('client_secret')).toBe('sec-1')
        expect(body.get('refresh_token')).toBe('rtok-1')
        return jsonRes({ access_token: 'ms-newtok', expires_in: 3600 })
      }
      if (u === `${GRAPH}/me/drive/root:/${PATH}:/content`) {
        apiCalls++
        apiAuths.push(headersOf(init).Authorization ?? '')
        return apiCalls === 1 ? new Response(null, { status: 401 }) : new Response(BYTES, { status: 200 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'stale', oauth: OAUTH })
    expect(new TextDecoder().decode((await backend.get(PATH))!)).toBe('hello')
    expect(apiAuths).toEqual(['Bearer stale', 'Bearer ms-newtok'])
  })

  it('gdrive：token 响应含轮转 refresh_token → onCredChange 上抛合并凭据（宿主回存 secretBag），不含旧值', async () => {
    let apiCalls = 0
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === GDRIVE_TOKEN_URL) {
        return jsonRes({ access_token: 'newtok', refresh_token: 'rtok-2', expires_in: 3600 })
      }
      apiCalls++
      return apiCalls === 1 ? new Response(null, { status: 401 }) : new Response(BYTES, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCredChange = vi.fn()
    const backend = createGDriveBackend({ backend: 'gdrive', accessToken: 'stale', fileId: 'fid9', oauth: { ...OAUTH } }, { onCredChange })
    expect(new TextDecoder().decode((await backend.get(PATH))!)).toBe('hello')
    expect(onCredChange).toHaveBeenCalledOnce()
    expect(onCredChange).toHaveBeenCalledWith({
      backend: 'gdrive', accessToken: 'stale', fileId: 'fid9',
      oauth: { clientId: 'cid-1', clientSecret: 'sec-1', refreshToken: 'rtok-2' },
    })
    expect(JSON.stringify(onCredChange.mock.calls[0]![0])).not.toContain('rtok-1')
  })

  it('onedrive：token 响应含轮转 refresh_token → onCredChange 上抛合并凭据；无回调时不抛（安全丢弃）', async () => {
    let apiCalls = 0
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
        return jsonRes({ access_token: 'ms-newtok', refresh_token: 'rtok-2', expires_in: 3600 })
      }
      apiCalls++
      return apiCalls === 1 ? new Response(null, { status: 401 }) : new Response(BYTES, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCredChange = vi.fn()
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'stale', oauth: { ...OAUTH } }, { onCredChange })
    expect(new TextDecoder().decode((await backend.get(PATH))!)).toBe('hello')
    expect(onCredChange).toHaveBeenCalledWith({ backend: 'onedrive', accessToken: 'stale', oauth: { clientId: 'cid-1', clientSecret: 'sec-1', refreshToken: 'rtok-2' } })
    // 无消费方（自动通道缺省）：刷新照常成功，轮转字段安全丢弃
    __resetOAuthCacheForTest()
    vi.stubGlobal('fetch', fetchMock)
    const bare = createOneDriveBackend({ backend: 'onedrive', accessToken: 'stale', oauth: { ...OAUTH } })
    await expect(bare.get(PATH)).resolves.not.toBeNull()
  })
})
