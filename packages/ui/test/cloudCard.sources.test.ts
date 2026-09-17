/** plan16 T8 新增：CloudCard 源列表口径用例（同类型多份/uuid/每源保留策略/保管区凭据 op/keep 滚动删除/缺凭据降级） */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  // enforceRemoteRetention 包 vi.fn 委托真实现：默认走真实滚动删除（fake backend 计数断言），必要时可观测调用参数
  return { ...actual, syncMultipleTargets: vi.fn(), enforceRemoteRetention: vi.fn(actual.enforceRemoteRetention) }
})
vi.mock('../src/components/cloudPlatform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/cloudPlatform')>()
  return { ...actual, createCloudBackend: vi.fn(actual.createCloudBackend) }
})

import { enforceRemoteRetention, syncMultipleTargets, type BackupSource, type CloudBackend, type CloudCred } from '@totp/core'
import { createCloudBackend } from '../src/components/cloudPlatform'
import CloudCard from '../src/components/CloudCard.vue'
import type { CloudPlatform } from '../src/components/cloudPlatform'

const mockedSync = vi.mocked(syncMultipleTargets)
const mockedRetention = vi.mocked(enforceRemoteRetention)

const VALID_VAULT = JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 0 })
const WEBDAV_CRED: CloudCred = { backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'alice', password: 'davpw' }

const src = (over: Partial<BackupSource> = {}): BackupSource => ({
  id: 's1', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true, ...over,
})

function makePlatform(over: Partial<CloudPlatform> = {}): CloudPlatform {
  const base: CloudPlatform = {
    loadSources: vi.fn().mockResolvedValue([]),
    saveSources: vi.fn().mockResolvedValue(undefined),
    saveCred: vi.fn().mockResolvedValue(undefined),
    removeCred: vi.fn().mockResolvedValue(undefined),
    creds: {},
    readVaultJson: vi.fn().mockReturnValue(VALID_VAULT),
    persistDownloaded: vi.fn().mockResolvedValue(undefined),
    loadTargetHash: vi.fn().mockResolvedValue(null),
    saveTargetHash: vi.fn().mockResolvedValue(undefined),
    autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
  }
  return { ...base, ...over }
}

async function mountCard(p: CloudPlatform, sessionSecret: string | null = 'pw') {
  const w = mount(CloudCard, { props: { platform: p, sessionSecret } })
  await flushPromises()
  return w
}

async function clickSync(w: VueWrapper): Promise<void> {
  await w.find('button.cloud-sync').trigger('click')
  await flushPromises()
}

/** jsdom 的 crypto.randomUUID 存在性不定：存在则 spy，缺失则 defineProperty 注入；返回还原函数 */
function stubUuid(first: `${string}-${string}-${string}-${string}-${string}`): () => void {
  const c = globalThis.crypto as { randomUUID?: () => string }
  if (typeof c.randomUUID === 'function') {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(first)
    return () => spy.mockRestore()
  }
  Object.defineProperty(c, 'randomUUID', { value: () => first, configurable: true })
  return () => { delete (c as { randomUUID?: unknown }).randomUUID }
}

/** 带 listBackups 的 fake 后端：list 返回 3 份旧时间戳文件，delete 记名 */
function fakeListBackend(): CloudBackend & { deleted: string[] } {
  const deleted: string[] = []
  return {
    id: 'webdav',
    deleted,
    put: async () => {},
    get: async () => null,
    delete: async (p) => { deleted.push(p) },
    exists: async () => false,
    listBackups: async () => [
      'dir/vault-20260101-000000.totpbackup', 'dir/vault-20260202-000000.totpbackup', 'dir/vault-20260303-000000.totpbackup',
    ],
  } as CloudBackend & { deleted: string[] }
}

describe('CloudCard（源列表 plan16 T8）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('S1 同类型两源：两个 webdav 源各自渲染（名称区分），凭据副本按 sourceId 隔离', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([
        src({ id: 'a1', name: '家里 WebDAV' }),
        src({ id: 'a2', name: '公司 WebDAV' }),
      ]),
      creds: { a1: WEBDAV_CRED }, // a2 无已存凭据 → 空白副本
    })
    const w = await mountCard(p)
    expect(w.findAll('.target')).toHaveLength(2)
    expect(w.text()).toContain('家里 WebDAV')
    expect(w.text()).toContain('公司 WebDAV')
    // 各自展开后凭据互不串扰：a1 回填已存值、a2 空白
    await w.findAll('button.target-toggle')[0]!.trigger('click')
    expect((w.find('input[placeholder="服务器地址（https://dav.example.com）"]').element as HTMLInputElement).value).toBe('https://dav.example.com')
    await w.findAll('button.target-toggle')[0]!.trigger('click')
    await w.findAll('button.target-toggle')[1]!.trigger('click')
    expect((w.find('input[placeholder="服务器地址（https://dav.example.com）"]').element as HTMLInputElement).value).toBe('')
  })

  it('S2 添加源生成 crypto.randomUUID 的源（默认名=后端名、覆盖策略、enabled 开）', async () => {
    const restore = stubUuid('00000000-0000-4000-8000-000000000001')
    try {
      const p = makePlatform()
      const w = await mountCard(p)
      await w.find('button.target-add').trigger('click')
      await w.findAll('.md-menu button').find((b) => b.text() === 'WebDAV')!.trigger('click')
      expect(w.findAll('.target')).toHaveLength(1)
      await w.find('button.creds-save').trigger('click')
      await flushPromises()
      expect(p.saveSources).toHaveBeenCalledWith([
        { id: '00000000-0000-4000-8000-000000000001', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true },
      ])
      expect(p.saveCred).not.toHaveBeenCalled() // 空白凭据跳过
    } finally {
      restore()
    }
  })

  it('S3 保留策略编辑：覆盖→保留最近出现份数输入（默认 3），改 5 后保存落 {keep,5}；切回覆盖输入消失', async () => {
    const p = makePlatform({ loadSources: vi.fn().mockResolvedValue([src({ id: 's1' })]), creds: { s1: WEBDAV_CRED } })
    const w = await mountCard(p)
    await w.find('button.target-toggle').trigger('click')
    expect(w.find('input[aria-label="保留份数"]').exists()).toBe(false) // 默认覆盖无份数输入
    await w.findAll('.md-seg__item').find((b) => b.text() === '保留最近')!.trigger('click')
    const n = w.find('input[aria-label="保留份数"]')
    expect(n.exists()).toBe(true)
    expect((n.element as HTMLInputElement).value).toBe('3')
    await n.setValue('5')
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenCalledWith([src({ id: 's1', retention: { type: 'keep', n: 5 } })])
    // 切回覆盖：份数输入消失、retention 回 overwrite
    await w.findAll('.md-seg__item').find((b) => b.text() === '覆盖')!.trigger('click')
    expect(w.find('input[aria-label="保留份数"]').exists()).toBe(false)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenLastCalledWith([src({ id: 's1' })])
  })

  it('S3b 保留份数非法输入钳制：空串回落 3、0/负数钳 1', async () => {
    const p = makePlatform({ loadSources: vi.fn().mockResolvedValue([src({ id: 's1' })]), creds: { s1: WEBDAV_CRED } })
    const w = await mountCard(p)
    await w.find('button.target-toggle').trigger('click')
    await w.findAll('.md-seg__item').find((b) => b.text() === '保留最近')!.trigger('click')
    const n = w.find('input[aria-label="保留份数"]')
    await n.setValue('0')
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenLastCalledWith([src({ id: 's1', retention: { type: 'keep', n: 1 } })])
    await n.setValue('')
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenLastCalledWith([src({ id: 's1', retention: { type: 'keep', n: 3 } })])
  })

  it('S4 保存调用序列：saveSources 先于逐源 saveCred（禁用源凭据一并保存不静默丢失）；空白源计数提示', async () => {
    const S2_CRED: CloudCred = { backend: 'gist', token: 'tok2', gistId: 'gid2' }
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([
        src({ id: 's1' }),
        src({ id: 's2', kind: 'gist', name: '禁用源', enabled: false }),
        src({ id: 's3', name: '未配置源' }),
      ]),
      creds: { s1: WEBDAV_CRED, s2: S2_CRED }, // s3 空白（无已存凭据）
    })
    const w = await mountCard(p)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenCalledTimes(1)
    expect(p.saveCred).toHaveBeenCalledTimes(2)
    expect(p.saveCred).toHaveBeenCalledWith('s1', WEBDAV_CRED)
    expect(p.saveCred).toHaveBeenCalledWith('s2', S2_CRED) // 禁用源凭据不跳过
    // 序列：saveSources 先落盘，再写各源凭据
    const saveSourcesOrder = vi.mocked(p.saveSources).mock.invocationCallOrder[0]!
    const saveCredOrder = vi.mocked(p.saveCred).mock.invocationCallOrder[0]!
    expect(saveSourcesOrder).toBeLessThan(saveCredOrder)
    expect(w.text()).toContain('凭据已保存（1 个空白源凭据未保存）')
  })

  it('S4b 保存凭据失败：saveCred 拒绝（未解锁中文错）→ 错误通道展示', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([src({ id: 's1' })]),
      creds: { s1: WEBDAV_CRED },
      saveCred: vi.fn().mockRejectedValue(new Error('库已锁定，解锁后才能保存云凭据')),
    })
    const w = await mountCard(p)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('库已锁定，解锁后才能保存云凭据')
  })

  it('S5 keep 源：path=对象目录时间戳名；uploaded 后按 n 滚动删除并附「滚动清理 N 份」', async () => {
    const backend = fakeListBackend()
    vi.mocked(createCloudBackend).mockImplementation(() => backend)
    mockedSync.mockResolvedValue({
      results: [{ key: 'k1', outcome: { action: 'uploaded', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { k1: 'h1' },
    })
    const cred = { ...WEBDAV_CRED, objectPath: 'dir/totp-backup.totpbackup' }
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([src({ id: 'k1', name: '滚动', retention: { type: 'keep', n: 2 }, objectPath: 'dir/totp-backup.totpbackup' })]),
      creds: { k1: cred },
    })
    const w = await mountCard(p)
    await clickSync(w)
    // path 为同目录时间戳名（非覆盖固定对象）
    const inputs = mockedSync.mock.calls[0]![0].targets
    expect(inputs[0]!.path).toMatch(/^dir\/vault-\d{8}-\d{6}\.totpbackup$/)
    // 滚动删除走真实 enforceRemoteRetention：keep=2 删最旧 1 份（conflict/非 vault 名不参与由 core 保证）
    expect(mockedRetention).toHaveBeenCalledWith(backend, 2)
    expect(backend.deleted).toEqual(['dir/vault-20260101-000000.totpbackup'])
    expect(w.text()).toContain('已上传（滚动清理 1 份）')
  })

  it('S5b keep 源后端不支持 listBackups：状态行提示「不支持自动清理、会累积」，删除零调用', async () => {
    const plain: CloudBackend = { id: 'webdav', put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false }
    const delSpy = vi.spyOn(plain, 'delete')
    vi.mocked(createCloudBackend).mockImplementation(() => plain)
    mockedSync.mockResolvedValue({
      results: [{ key: 'k1', outcome: { action: 'uploaded', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { k1: 'h1' },
    })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([src({ id: 'k1', name: '滚动', retention: { type: 'keep', n: 2 } })]),
      creds: { k1: WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(mockedRetention).toHaveBeenCalledWith(plain, 2)
    expect(delSpy).not.toHaveBeenCalled()
    // 时间戳文件已写入（主流程 uploaded 不改写），仅清理能力缺失如实提示
    expect(w.text()).toContain('已上传（该后端不支持自动清理，历史备份会累积，可手动清理或改用覆盖模式）')
  })

  it('S5c keep 源 listBackups 抛错：per-source 隔离——该源仍记「已上传（滚动清理失败，下轮同步重试）」，其余源结果与基线回写不中断', async () => {
    const bad: CloudBackend = {
      id: 'webdav', put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false,
      listBackups: async () => { throw new Error('PROPFIND 网络失败') },
    }
    const plain: CloudBackend = { id: 'gist', put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false }
    vi.mocked(createCloudBackend).mockImplementation((cred) => (cred.backend === 'webdav' ? bad : plain))
    mockedSync.mockResolvedValue({
      results: [
        { key: 'k1', outcome: { action: 'uploaded', hash: 'h1' } },
        { key: 's2', outcome: { action: 'uploaded', hash: 'h2' } },
      ],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { k1: 'h1', s2: 'h2' },
    })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([
        src({ id: 'k1', name: '滚动', retention: { type: 'keep', n: 2 } }),
        src({ id: 's2', kind: 'gist', name: '普通源' }),
      ]),
      creds: { k1: WEBDAV_CRED, s2: { backend: 'gist', token: 't', gistId: 'g' } },
    })
    const w = await mountCard(p)
    await clickSync(w)
    const statuses = w.findAll('.target-status').map((s) => s.text())
    expect(statuses).toEqual(['已上传（滚动清理失败，下轮同步重试）', '已上传'])
    // 异常未中断基线回写：两源基线均按成功结果落盘
    expect(p.saveTargetHash).toHaveBeenCalledWith('k1', 'h1')
    expect(p.saveTargetHash).toHaveBeenCalledWith('s2', 'h2')
  })

  it('S6 GDrive 回存按 sourceId：仅触发源更新 saveCred(id, next)，同类型另一源不受影响', async () => {
    const G1: BackupSource = { id: 'g1', kind: 'gdrive', name: 'G-A', retention: { type: 'overwrite' }, enabled: true }
    const G2: BackupSource = { id: 'g2', kind: 'gdrive', name: 'G-B', retention: { type: 'overwrite' }, enabled: true }
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([G1, G2]),
      creds: { g1: { backend: 'gdrive', accessToken: 'tok-a' }, g2: { backend: 'gdrive', accessToken: 'tok-b' } },
    })
    // 捕获每个源 backend 的 onCredChange，模拟仅 g1 首推建文件回存 fileId
    const changes: Array<(c: CloudCred) => void> = []
    vi.mocked(createCloudBackend).mockImplementation((_cred, onChange) => {
      if (onChange) changes.push(onChange)
      return { id: 'gdrive', put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false } as CloudBackend
    })
    mockedSync.mockResolvedValue({
      results: [
        { key: 'g1', outcome: { action: 'uploaded', hash: 'h1' } },
        { key: 'g2', outcome: { action: 'uploaded', hash: 'h2' } },
      ],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { g1: 'h1', g2: 'h2' },
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(changes).toHaveLength(2) // 两源各建一个 backend 实例
    // 模拟仅 g1 首推建文件回存 fileId（闭包按 sourceId 绑定，sync 后触发仍走正确源）
    changes[0]!({ backend: 'gdrive', accessToken: 'tok-a', fileId: 'fid-1' })
    await flushPromises()
    expect(p.saveCred).toHaveBeenCalledTimes(1)
    expect(p.saveCred).toHaveBeenCalledWith('g1', { backend: 'gdrive', accessToken: 'tok-a', fileId: 'fid-1' })
    expect(p.saveCred).not.toHaveBeenCalledWith('g2', expect.anything())
  })

  it('S7 锁定态缺凭据源：状态行「缺少凭据」跳过不阻塞其他源；全部缺失时报错且不调编排', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 's1', outcome: { action: 'uploaded', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { s1: 'h1' },
    })
    // 一有一无：缺失源状态行提示、有凭据源正常同步
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([src({ id: 's1' }), src({ id: 's2', name: '未配置' })]),
      creds: { s1: WEBDAV_CRED }, // s2 无凭据（锁定态缓存空同此形态）
    })
    const w = await mountCard(p)
    await clickSync(w)
    const inputs = mockedSync.mock.calls[0]![0].targets
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.key).toBe('s1')
    const statuses = w.findAll('.target-status').map((s) => s.text())
    expect(statuses).toContain('缺少凭据：解锁后保存凭据后再同步')
    expect(statuses).toContain('已上传')
    // 全部缺失：报错、不调编排
    const p2 = makePlatform({ loadSources: vi.fn().mockResolvedValue([src({ id: 's1' })]), creds: {} })
    const w2 = await mountCard(p2)
    await clickSync(w2)
    expect(mockedSync).toHaveBeenCalledTimes(1) // 仅第一次用例调用
    expect(w2.text()).toContain('启用源均缺少凭据，请先解锁并保存凭据')
  })

  it('S8 源名称编辑：v-model 生效并随 saveSources 落盘', async () => {
    const p = makePlatform({ loadSources: vi.fn().mockResolvedValue([src({ id: 's1' })]), creds: { s1: WEBDAV_CRED } })
    const w = await mountCard(p)
    await w.find('button.target-toggle').trigger('click')
    await w.find('input[aria-label="源名称"]').setValue('家里 WebDAV')
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenLastCalledWith([src({ id: 's1', name: '家里 WebDAV' })])
    expect(w.text()).toContain('家里 WebDAV')
  })

  it('S9 kdfProfile 透传：platform.kdfProfile 提供时随 syncMultipleTargets 下发', async () => {
    vi.mocked(createCloudBackend).mockImplementation(() => ({ id: 'webdav', put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false }))
    mockedSync.mockResolvedValue({ results: [], finalVaultJson: VALID_VAULT, adopted: false, hashes: {} })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([src({ id: 's1' })]),
      creds: { s1: WEBDAV_CRED },
      kdfProfile: () => 'paranoid',
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(mockedSync).toHaveBeenCalledTimes(1)
    expect(mockedSync.mock.calls[0]![0].profile).toBe('paranoid')
  })
})
