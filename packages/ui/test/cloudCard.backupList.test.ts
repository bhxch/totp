import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createBackupEnvelope } from '@totp/core'
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

async function envelopeBytes(vault: string, password = 'pw'): Promise<Uint8Array> {
  return new TextEncoder().encode(JSON.stringify(await createBackupEnvelope(vault, password, 'balanced')))
}

/** 恢复链含真实 Argon2（balanced=64MiB，加解密各一次）：全量套件并行时单轮可超 1s——waitFor 给足余量 */
const CRYPTO_WAIT = { timeout: 15_000 }

describe('CloudCard 云端备份恢复（plan23 §2）', () => {
  /** 恢复按钮挂在列表行内（brief 语义修正：手动刷新是唯一列表入口，先刷新出列表行才能点恢复） */
  function listableBackend(over: Partial<CloudBackend> = {}): CloudBackend {
    return fakeBackend({ listBackupsEx: vi.fn(async () => ({ names: ['d/vault-20261010-090000.totpbackup'], complete: true })), ...over })
  }

  it('恢复：确认前完成读取/解密/校验；确认后 persistDownloaded 收明文，且不写任何基线', async () => {
    useBackends({ webdav: listableBackend({ get: vi.fn(async () => await envelopeBytes(VALID_VAULT)) }) })
    const persist = vi.fn(async () => {})
    const saveState = vi.fn(async () => {})
    const w = await mountCard(mkPlatform({ persistDownloaded: persist, saveSourceState: saveState }))
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-restore').trigger('click')
    // 恢复链含真实 Argon2（hash-wasm）+ WebCrypto subtle：完成回调经任务队列落地，单次
    // flushPromises 只推进一个宏任务轮不够——按 BackupCard 测试先例改用 vi.waitFor 等落地
    await vi.waitFor(() => expect(w.find('.backup-restore-row').exists()).toBe(true), CRYPTO_WAIT)
    expect(persist).not.toHaveBeenCalled() // 确认前不落库
    await w.find('button.backup-restore-confirm').trigger('click')
    await flushPromises()
    expect(persist).toHaveBeenCalledWith(VALID_VAULT)
    expect(saveState).not.toHaveBeenCalled() // 刻意不写 SourceSyncState 基线（spec §2）
    expect(w.find('.backup-restore-row').exists()).toBe(false)
  })

  it('get 空（已被并发删除/置空）：报「不存在或为空」，不进入确认行', async () => {
    useBackends({ webdav: listableBackend({ get: vi.fn(async () => null) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-restore').trigger('click')
    await flushPromises()
    expect(w.find('.backup-restore-row').exists()).toBe(false)
    expect(w.find('.err').exists()).toBe(true)
  })

  it('口令不匹配（他口令信封）：报错不进入确认行', async () => {
    useBackends({ webdav: listableBackend({ get: vi.fn(async () => await envelopeBytes(VALID_VAULT, 'other-pw')) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-restore').trigger('click')
    await vi.waitFor(() => expect(w.find('.err').exists()).toBe(true), CRYPTO_WAIT) // 解密链经任务队列落地
    expect(w.find('.backup-restore-row').exists()).toBe(false)
  })

  it('解密成功但内容非法（parseVaultJson 不过）：报错不进入确认行', async () => {
    useBackends({ webdav: listableBackend({ get: vi.fn(async () => await envelopeBytes('{"foo":1}')) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-restore').trigger('click')
    await vi.waitFor(() => expect(w.find('.err').exists()).toBe(true), CRYPTO_WAIT) // 解密链经任务队列落地
    expect(w.find('.backup-restore-row').exists()).toBe(false)
  })

  it('取消确认：本地存储不动、确认行收起', async () => {
    useBackends({ webdav: listableBackend({ get: vi.fn(async () => await envelopeBytes(VALID_VAULT)) }) })
    const persist = vi.fn(async () => {})
    const w = await mountCard(mkPlatform({ persistDownloaded: persist }))
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-restore').trigger('click')
    await vi.waitFor(() => expect(w.find('.backup-restore-row').exists()).toBe(true), CRYPTO_WAIT) // 解密链经任务队列落地
    await w.find('button.backup-restore-cancel').trigger('click')
    await flushPromises()
    expect(persist).not.toHaveBeenCalled()
    expect(w.find('.backup-restore-row').exists()).toBe(false)
  })
})

describe('CloudCard 云端备份删除（plan23 §3）', () => {
  it('删除：两步确认 → delete(原名) → 自动刷新该源列表；webdav 无 gist 标注', async () => {
    const list = vi.fn(async () => ['vault-20261010-090000.totpbackup'])
    const del = vi.fn(async () => {})
    useBackends({ webdav: fakeBackend({ listBackups: list, delete: del }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-delete').trigger('click')
    await flushPromises()
    expect(w.find('.backup-delete-row').exists()).toBe(true)
    expect(w.find('.backup-delete-row').text()).toContain('vault-20261010-090000.totpbackup')
    expect(w.find('.gist-delete-note').exists()).toBe(false)
    await w.find('button.backup-delete-confirm').trigger('click')
    await flushPromises()
    expect(del).toHaveBeenCalledWith('vault-20261010-090000.totpbackup')
    expect(list).toHaveBeenCalledTimes(2) // 删除成功后自动刷新（初刷 + 删后刷）
    expect(w.find('.backup-delete-row').exists()).toBe(false)
  })

  it('gist 源：确认行显示伪删标注（内容置空、骨架残留）', async () => {
    useBackends({ gist: fakeBackend({ id: 'gist', listBackups: vi.fn(async () => ['vault-20261010-090000.totpbackup']) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 1) // SOURCE_GIST
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-delete').trigger('click')
    await flushPromises()
    expect(w.find('.gist-delete-note').exists()).toBe(true)
  })

  it('取消：不调 delete、列表不刷新', async () => {
    const list = vi.fn(async () => ['vault-20261010-090000.totpbackup'])
    const del = vi.fn(async () => {})
    useBackends({ webdav: fakeBackend({ listBackups: list, delete: del }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-delete').trigger('click')
    await flushPromises()
    await w.find('button.backup-delete-cancel').trigger('click')
    await flushPromises()
    expect(del).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(1)
  })
})

describe('CloudCard 云端备份导出（plan23 §4）', () => {
  it('有 saveBackupFile 能力：导出按钮渲染，get 原字节 → saveBackupFile(basename, bytes)', async () => {
    const bytes = new TextEncoder().encode('{"envelope":1}')
    useBackends({ webdav: fakeBackend({ listBackupsEx: vi.fn(async () => ({ names: ['d/vault-20261010-090000.totpbackup'], complete: true })), get: vi.fn(async () => bytes) }) })
    const save = vi.fn(async () => true)
    const w = await mountCard(mkPlatform({ saveBackupFile: save }))
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-export').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith('vault-20261010-090000.totpbackup', bytes)
  })

  it('无 saveBackupFile 能力：不渲染导出按钮（能力检测）', async () => {
    useBackends({ webdav: fakeBackend({ listBackups: vi.fn(async () => ['vault-20261010-090000.totpbackup']) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('button.backup-export').exists()).toBe(false)
  })

  it('get 空：报「不存在或为空」，不调 saveBackupFile', async () => {
    useBackends({ webdav: fakeBackend({ listBackups: vi.fn(async () => ['vault-20261010-090000.totpbackup']) }) })
    const save = vi.fn(async () => true)
    const w = await mountCard(mkPlatform({ saveBackupFile: save }))
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-export').trigger('click')
    await flushPromises()
    expect(save).not.toHaveBeenCalled()
    expect(w.find('.err').exists()).toBe(true)
  })
})
