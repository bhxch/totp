import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { CloudBackend, CloudCred, BackupSource } from '@totp/core'
import CloudCard from '../src/components/CloudCard.vue'
import { createCloudBackend } from '../src/components/cloudPlatform'
import { settleMergeConfirm } from '../src/components/cloudSyncBridge'
import { createTestI18n } from './helpers/i18n'
import type { CloudPlatform } from '../src/components/cloudPlatform'
import type { VueStore } from '../src/store'

vi.mock('../src/components/cloudPlatform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCloudBackend: vi.fn(),
}))

const WEBDAV_CRED = { backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'u', password: 'p' } as CloudCred
const GIST_CRED = { backend: 'gist', token: 't', gistId: 'g' } as CloudCred

const SOURCE_KEEP: BackupSource = { id: 'src-1', kind: 'webdav', name: 'WebDAV', retention: { type: 'keep', n: 3 }, enabled: true, role: 'primary' }
const SOURCE_GIST: BackupSource = { id: 'src-2', kind: 'gist', name: 'Gist', retention: { type: 'keep', n: 3 }, enabled: true, role: 'replica' }
const SOURCE_OW: BackupSource = { id: 'src-3', kind: 'webdav', name: '覆盖源', retention: { type: 'overwrite' }, enabled: true, role: 'replica' }

const VALID_VAULT = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 0 })

function fakeBackend(over: Partial<CloudBackend> = {}): CloudBackend {
  return {
    id: 'webdav',
    put: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    listBackups: vi.fn(async () => [] as string[]),
    ...over,
  } as unknown as CloudBackend
}

/** 按 cred.backend 分派 backend 替身（未登记的 kind 给空 backend） */
function useBackends(byKind: Partial<Record<string, CloudBackend>>): void {
  vi.mocked(createCloudBackend).mockImplementation((cred) => byKind[(cred as CloudCred & { backend: string }).backend] ?? fakeBackend())
}

function mkPlatform(over: Partial<CloudPlatform> = {}, creds: Record<string, CloudCred> = { 'src-1': WEBDAV_CRED, 'src-2': GIST_CRED, 'src-3': WEBDAV_CRED }): CloudPlatform {
  return {
    loadSources: vi.fn(async () => [SOURCE_KEEP, SOURCE_GIST, SOURCE_OW]),
    saveSources: vi.fn(async () => {}),
    saveCred: vi.fn(async () => {}),
    removeCred: vi.fn(async () => {}),
    creds,
    readVaultJson: () => VALID_VAULT,
    persistDownloaded: vi.fn(async () => {}),
    loadSourceState: vi.fn(async () => ({ lastKnownRemoteRev: null, baseSnapshot: null })),
    saveSourceState: vi.fn(async () => {}),
    deviceId: vi.fn(async () => 'dev-test'),
    autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
    ...over,
  }
}

async function mountCard(p: CloudPlatform): Promise<VueWrapper> {
  const w = mount(CloudCard, {
    global: { plugins: [createTestI18n()] },
    props: { platform: p, sessionSecret: 'pw' },
  })
  await flushPromises()
  return w
}

/** 展开第 i 个源（备份区块在 expanded 区内） */
async function expand(w: VueWrapper, i: number): Promise<void> {
  await w.findAll('button.target-toggle')[i]!.trigger('click')
}

afterEach(() => settleMergeConfirm(false))
// 大括号体必须保留：mockClear() 返回 mock 本身，vitest v5 会把 beforeEach 回调的返回值
// 注册为测试后清理钩子并无参调用——箭头表达式写法会让 createCloudBackend 在钩子里被
// 无参调用抛 TypeError，污染每个用例
beforeEach(() => { vi.mocked(createCloudBackend).mockClear() })

describe('CloudCard 云端备份区块：列表与刷新（plan23 §1）', () => {
  it('刷新 keep 源：倒序 basename 行 + 可解析时间戳行；走 listCloudBackups（Ex 优先）', async () => {
    const ex = vi.fn(async () => ({ names: ['d/vault-20261009-210000.totpbackup', 'd/vault-20261010-090000.totpbackup'], complete: true }))
    useBackends({ webdav: fakeBackend({ listBackupsEx: ex }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    const names = w.findAll('.cloud-backup-list .bname').map((x) => x.text())
    expect(names).toEqual(['vault-20261010-090000.totpbackup', 'vault-20261009-210000.totpbackup'])
    expect(w.find('.cloud-backup-list .btime').exists()).toBe(true)
  })

  it('complete=false：显示「列表可能不完整」截断提示', async () => {
    useBackends({ webdav: fakeBackend({ listBackupsEx: vi.fn(async () => ({ names: ['vault-20261010-090000.totpbackup'], complete: false })) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('.cloud-backups').text()).toContain('列表可能不完整')
  })

  it('overwrite 源空列表：显示覆盖模式说明（非通用空态）', async () => {
    useBackends({ webdav: fakeBackend() })
    const w = await mountCard(mkPlatform())
    await expand(w, 2) // SOURCE_OW
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('.cloud-backups').text()).toContain('覆盖模式')
  })

  it('缺凭据（锁定态缓存空）：刷新报「缺少凭据」且不构造 backend', async () => {
    useBackends({})
    const w = await mountCard(mkPlatform({}, {}))
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('.cloud-backups').text()).toContain('缺少凭据')
    expect(createCloudBackend).not.toHaveBeenCalled()
  })

  it('listBackups 抛错：区块内行内报「列表获取失败」，整卡其余功能不受影响', async () => {
    useBackends({ webdav: fakeBackend({ listBackups: vi.fn(async () => { throw new Error('401 Unauthorized') }) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('.cloud-backups').text()).toContain('列表获取失败')
    expect(w.find('.cloud-backups').text()).toContain('401')
    expect(w.find('button.creds-save').attributes('disabled')).toBeUndefined()
  })
})
