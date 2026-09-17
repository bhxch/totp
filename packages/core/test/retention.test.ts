import { afterEach, describe, expect, it, vi } from 'vitest'
import { enforceRemoteRetention } from '../src/backup/retention'
import { selectBackupsToKeep } from '../src/backup/policy'
import { createWebdavBackend } from '../src/cloud/webdav'
import { createS3Backend } from '../src/cloud/s3'
import { createOneDriveBackend } from '../src/cloud/onedrive'

describe('远端滚动删除', () => {
  const names = ['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup', 'vault-20260303-000000.totpbackup', 'conflict-webdav-20260101-000000.totpbackup', 'other.txt']
  it('keep=2：仅删最旧的正则匹配份，conflict/其他文件不动', async () => {
    const del = vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined)
    const deleted = await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 2)
    expect(deleted).toBe(1)
    expect(del).toHaveBeenCalledOnce()
    expect(del).toHaveBeenCalledWith('vault-20260101-000000.totpbackup')
  })
  it('keep=0/负数/非整数视作不删除；未超额定删除 0；backend 无 listBackups → 返回 -1（不支持）', async () => {
    const del = vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined)
    expect(await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 0)).toBe(0)
    expect(await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, -1)).toBe(0)
    expect(await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 1.5)).toBe(0)
    expect(await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 5)).toBe(0)
    expect(del).not.toHaveBeenCalled()
    expect(await enforceRemoteRetention({ delete: async () => {} } as never, 2)).toBe(-1)
  })
  it('删除名单与 selectBackupsToKeep 同源（超额=旧→新前 N）', () => {
    expect(selectBackupsToKeep(names, 2)).toEqual(['vault-20260101-000000.totpbackup'])
  })
  it('单个删除失败不阻断：其余照删，返回成功删除数', async () => {
    const del = vi.fn(async (name: string) => {
      if (name === 'vault-20260202-000000.totpbackup') throw new Error('HTTP 500')
    })
    const deleted = await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 1)
    expect(deleted).toBe(1)
    expect(del).toHaveBeenCalledTimes(2)
    expect(del.mock.calls.map((c) => c[0]!).sort()).toEqual(['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup'])
  })
})

/** 组合回归（T4 审查必修 3）：retention × 真实后端 × 子目录 cred——删除请求必须命中与 put/get 同域的完整路径，
 *  现有单测各自 mock list 或 delete 恰好绕开了「list 返回域 ↔ delete 目标域」的衔接层。 */
describe('组合回归：retention × fake fetch × 子目录 cred', () => {
  function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('webdav：DELETE 请求命中 dir/sub/vault-… 完整路径', async () => {
    const xml = `<multistatus xmlns="DAV:">
<response><href>/dir/sub/</href></response>
<response><href>/dir/sub/vault-20260101-000000.totpbackup</href></response>
<response><href>/dir/sub/vault-20260202-000000.totpbackup</href></response>
<response><href>/dir/sub/vault-20260303-000000.totpbackup</href></response>
</multistatus>`
    const delUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (init!.method === 'PROPFIND') return new Response(xml, { status: 207 })
      if (init!.method === 'DELETE') {
        delUrls.push(u)
        return new Response(null, { status: 204 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    }))
    const backend = createWebdavBackend({ backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'u', password: 'p', objectPath: 'dir/sub/totp-backup.totpbackup' })
    expect(await enforceRemoteRetention(backend, 1)).toBe(2)
    expect(delUrls).toEqual([
      'https://dav.example.com/dir/sub/vault-20260101-000000.totpbackup',
      'https://dav.example.com/dir/sub/vault-20260202-000000.totpbackup',
    ])
  })

  it('s3：DELETE key 为 dir/sub/vault-… 完整 key 域', async () => {
    const xml = `<ListBucketResult>
<Contents><Key>dir/sub/vault-20260101-000000.totpbackup</Key></Contents>
<Contents><Key>dir/sub/vault-20260202-000000.totpbackup</Key></Contents>
<Contents><Key>dir/sub/vault-20260303-000000.totpbackup</Key></Contents>
</ListBucketResult>`
    const delUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (init!.method === 'GET' && u.includes('list-type=2')) return new Response(xml, { status: 200 })
      if (init!.method === 'DELETE') {
        delUrls.push(u)
        return new Response(null, { status: 204 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    }))
    const backend = createS3Backend({ backend: 's3', region: 'us-east-1', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', objectPath: 'dir/sub/totp-backup.totpbackup' }, { now: () => new Date('2015-08-30T12:36:00Z') })
    expect(await enforceRemoteRetention(backend, 1)).toBe(2)
    expect(delUrls).toEqual([
      'https://b.s3.us-east-1.amazonaws.com/dir/sub/vault-20260101-000000.totpbackup',
      'https://b.s3.us-east-1.amazonaws.com/dir/sub/vault-20260202-000000.totpbackup',
    ])
  })

  it('onedrive：DELETE 命中 root:/dir/sub/vault-…: 完整 item 路径', async () => {
    const delUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith(':?select=parentReference')) return jsonRes({ parentReference: { id: 'pid1' } })
      if (u === 'https://graph.microsoft.com/v1.0/me/drive/items/pid1/children') {
        return jsonRes({ value: [{ name: 'vault-20260101-000000.totpbackup' }, { name: 'vault-20260202-000000.totpbackup' }, { name: 'vault-20260303-000000.totpbackup' }] })
      }
      if (init!.method === 'DELETE') {
        delUrls.push(u)
        return new Response(null, { status: 204 })
      }
      throw new Error(`意外请求：${init!.method} ${u}`)
    }))
    const backend = createOneDriveBackend({ backend: 'onedrive', accessToken: 'tok', objectPath: 'dir/sub/totp-backup.totpbackup' })
    expect(await enforceRemoteRetention(backend, 1)).toBe(2)
    expect(delUrls).toEqual([
      'https://graph.microsoft.com/v1.0/me/drive/root:/dir/sub/vault-20260101-000000.totpbackup:',
      'https://graph.microsoft.com/v1.0/me/drive/root:/dir/sub/vault-20260202-000000.totpbackup:',
    ])
  })
})
