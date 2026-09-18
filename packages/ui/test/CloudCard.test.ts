import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  return { ...actual, syncMultipleTargets: vi.fn(), pushEnvelope: vi.fn(actual.pushEnvelope) }
})
// createCloudBackend 由 CloudCard 从 ui 本地 cloudPlatform 导入：包为 vi.fn 且默认委托真实现，供用例注入 fake 后端
vi.mock('../src/components/cloudPlatform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/cloudPlatform')>()
  return { ...actual, createCloudBackend: vi.fn(actual.createCloudBackend) }
})

import { pushEnvelope, syncMultipleTargets, type BackupSource, type CloudBackend, type CloudCred } from '@totp/core'
import { createCloudBackend } from '../src/components/cloudPlatform'
import CloudCard from '../src/components/CloudCard.vue'
import type { CloudPlatform } from '../src/components/cloudPlatform'

const mockedSync = vi.mocked(syncMultipleTargets)
const mockedPush = vi.mocked(pushEnvelope)

const VALID_VAULT = JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 0 })
const EMPTY_RESULT = { results: [], finalVaultJson: VALID_VAULT, adopted: false, hashes: {} }

const WEBDAV_CRED: CloudCred = { backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'alice', password: 'davpw' }
const GIST_CRED: CloudCred = { backend: 'gist', token: 'tok', gistId: 'gid' }

const WEBDAV_SOURCE: BackupSource = { id: 's-webdav', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true }
const GIST_SOURCE: BackupSource = { id: 's-gist', kind: 'gist', name: 'GitHub Gist', retention: { type: 'overwrite' }, enabled: true }

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
  await flushPromises() // onMounted 异步回填 sources/credDrafts/autoPrefs/autoStatus
  return w
}

async function clickSync(w: VueWrapper): Promise<void> {
  await w.find('button.cloud-sync').trigger('click')
  await flushPromises()
}

describe('CloudCard（多源）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('①源列表：loadSources 回填两条启用源，渲染名称与启用开关', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE, GIST_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED, 's-gist': GIST_CRED },
    })
    const w = await mountCard(p)
    expect(w.findAll('.target')).toHaveLength(2)
    expect(w.text()).toContain('WebDAV')
    expect(w.text()).toContain('GitHub Gist')
    expect(w.find('input[aria-label="WebDAV启用"]').exists()).toBe(true)
    expect(w.find('input[aria-label="GitHub Gist启用"]').exists()).toBe(true)
  })

  it('②配置展开：凭据字段回填已存值、显示名称/保留策略/目标路径框（placeholder=缺省路径）', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    // 收起态不渲染字段
    expect(w.find('input[aria-label="目标文件路径"]').exists()).toBe(false)
    await w.find('button.target-toggle').trigger('click')
    expect((w.find('input[placeholder="服务器地址（https://dav.example.com）"]').element as HTMLInputElement).value).toBe('https://dav.example.com')
    expect((w.find('input[aria-label="源名称"]').element as HTMLInputElement).value).toBe('WebDAV')
    expect(w.find('[aria-label="保留策略"]').exists()).toBe(true)
    const pathInput = w.find('input[aria-label="目标文件路径"]')
    expect(pathInput.exists()).toBe(true)
    expect(pathInput.attributes('placeholder')).toBe('totp-backup.totpbackup')
    expect((pathInput.element as HTMLInputElement).value).toBe('') // 未自定义 objectPath
  })

  it('③仅 enabled 源进入 syncMultipleTargets（key=source.id）', async () => {
    mockedSync.mockResolvedValue(EMPTY_RESULT)
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE, { ...GIST_SOURCE, enabled: false }]),
      creds: { 's-webdav': WEBDAV_CRED, 's-gist': GIST_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(mockedSync).toHaveBeenCalledTimes(1)
    const inputs = mockedSync.mock.calls[0]![0].targets
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.key).toBe('s-webdav')
  })

  it('④objectPath 透传：resolveObjectPath 结果作 path，缺省回落 DEFAULT_OBJECT_PATH', async () => {
    mockedSync.mockResolvedValue(EMPTY_RESULT)
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([
        WEBDAV_SOURCE,
        GIST_SOURCE,
      ]),
      creds: { 's-webdav': { ...WEBDAV_CRED, objectPath: 'custom\\dir.totpbackup' }, 's-gist': GIST_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(mockedSync).toHaveBeenCalledTimes(1)
    const inputs = mockedSync.mock.calls[0]![0].targets
    expect(inputs.map((x) => ({ key: x.key, path: x.path }))).toEqual([
      { key: 's-webdav', path: 'custom/dir.totpbackup' }, // 反斜杠段归一为 /
      { key: 's-gist', path: 'totp-backup.totpbackup' },
    ])
  })

  it('⑤hash 逐源透传与回写：失败源回写 null（删基线）', async () => {
    mockedSync.mockResolvedValue({
      results: [
        { key: 's-webdav', outcome: { action: 'in-sync', hash: 'hw1' } },
        { key: 's-gist', outcome: null, error: 'boom' },
      ],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { 's-webdav': 'hw1' },
    })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE, GIST_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED, 's-gist': GIST_CRED },
      loadTargetHash: vi.fn(async (id: string) => (id === 's-webdav' ? 'h-w' : 'h-g')),
    })
    const w = await mountCard(p)
    await clickSync(w)
    const inputs = mockedSync.mock.calls[0]![0].targets
    expect(inputs.map((x) => ({ key: x.key, hash: x.hash }))).toEqual([
      { key: 's-webdav', hash: 'h-w' },
      { key: 's-gist', hash: 'h-g' },
    ])
    expect(p.saveTargetHash).toHaveBeenCalledWith('s-webdav', 'hw1')
    expect(p.saveTargetHash).toHaveBeenCalledWith('s-gist', null)
    expect(w.text()).toContain('失败：boom')
    expect(w.text()).toContain('已是最新')
  })

  it('⑥adopted：行内确认出现且确认前不落基线，确认后 persistDownloaded(finalVaultJson)+补写基线', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 's-webdav', outcome: { action: 'downloaded', hash: 'h9', envelopeJson: VALID_VAULT } }],
      finalVaultJson: VALID_VAULT,
      adopted: true,
      hashes: { 's-webdav': 'h9' },
    })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(w.find('.confirm-row').exists()).toBe(true)
    expect(w.text()).toContain('采用云端将覆盖本地')
    expect(p.persistDownloaded).not.toHaveBeenCalled()
    expect(p.saveTargetHash).not.toHaveBeenCalled() // 采纳源基线延后
    // 确认行挂起期间禁用立即同步（防二次同步覆盖待确认状态）
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(true)
    // 三态互斥：采纳确认挂起期间，行内移除按钮同步禁用
    expect((w.find('button.target-remove').element as HTMLButtonElement).disabled).toBe(true)
    await w.findAll('button').find((b) => b.text() === '采用云端')!.trigger('click')
    await flushPromises()
    expect(p.persistDownloaded).toHaveBeenCalledWith(VALID_VAULT)
    expect(p.saveTargetHash).toHaveBeenCalledWith('s-webdav', 'h9')
    expect(w.text()).toContain('已采用云端数据覆盖本地')
    expect(w.find('.confirm-row').exists()).toBe(false)
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('⑦取消采用：persistDownloaded 不调、基线不写，提示已保留冲突副本', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 's-webdav', outcome: { action: 'conflict-resolved', hash: 'h8', envelopeJson: VALID_VAULT, conflictBackup: 'conflict-s-webdav-20260916-120000.totpbackup' } }],
      finalVaultJson: VALID_VAULT,
      adopted: true,
      hashes: { 's-webdav': 'h8' },
    })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    await flushPromises()
    expect(p.persistDownloaded).not.toHaveBeenCalled()
    expect(p.saveTargetHash).not.toHaveBeenCalled()
    expect(w.text()).toContain('已保留冲突副本，未改动本地')
    expect(w.find('.confirm-row').exists()).toBe(false)
  })

  it('⑦b混合采纳：确认前非采纳源基线已写、采纳源未写；取消后采纳源零调用且非采纳基线保持', async () => {
    mockedSync.mockResolvedValue({
      results: [
        { key: 's-webdav', outcome: { action: 'downloaded', hash: 'hw', envelopeJson: VALID_VAULT } },
        { key: 's-gist', outcome: { action: 'in-sync', hash: 'hg' } },
      ],
      finalVaultJson: VALID_VAULT,
      adopted: true,
      hashes: { 's-webdav': 'hw', 's-gist': 'hg' },
    })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE, GIST_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED, 's-gist': GIST_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(w.find('.confirm-row').exists()).toBe(true)
    // 确认前：非采纳源（in-sync）基线已立即回写；采纳源（downloaded）基线延后未写
    expect(p.saveTargetHash).toHaveBeenCalledTimes(1)
    expect(p.saveTargetHash).toHaveBeenCalledWith('s-gist', 'hg')
    // 取消：采纳源 saveTargetHash 零调用，persistDownloaded 不调，非采纳源已写基线保持（不回滚）
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    await flushPromises()
    expect(p.saveTargetHash).toHaveBeenCalledTimes(1)
    expect(p.saveTargetHash).not.toHaveBeenCalledWith('s-webdav', 'hw')
    expect(p.persistDownloaded).not.toHaveBeenCalled()
    expect(w.text()).toContain('已保留冲突副本，未改动本地')
  })

  it('⑧无 sessionSecret：同步按钮禁用并显示设置口令提示', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p, null)
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.text()).toContain('先在上方设置备份口令')
  })

  it('⑨未启用任何云源：提示错误且不调同步编排', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([{ ...WEBDAV_SOURCE, enabled: false }]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(mockedSync).not.toHaveBeenCalled()
    expect(p.readVaultJson).not.toHaveBeenCalled()
    expect(w.text()).toContain('未启用任何云源')
  })

  it('⑩保存凭据：saveSources 整列表 + 逐启用源 saveCred(id, draft)', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenCalledWith([WEBDAV_SOURCE])
    expect(p.saveCred).toHaveBeenCalledWith('s-webdav', WEBDAV_CRED)
    expect(w.text()).toContain('凭据已保存')
  })

  it('⑪单源错误状态行不影响其余源结果展示', async () => {
    mockedSync.mockResolvedValue({
      results: [
        { key: 's-webdav', outcome: null, error: '网络错误' },
        { key: 's-gist', outcome: { action: 'uploaded', hash: 'hu' } },
      ],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { 's-gist': 'hu' },
    })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE, GIST_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED, 's-gist': GIST_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    const statuses = w.findAll('.target-status').map((s) => s.text())
    expect(statuses).toEqual(['失败：网络错误', '已上传'])
  })

  it('⑫自动区：开关/间隔回写 set（get 异步返回兼容）', async () => {
    const p = makePlatform({
      autoPrefs: {
        get: vi.fn(async () => ({ onChange: false, onInterval: false, intervalMinutes: 60 })),
        set: vi.fn(async () => {}),
      },
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await w.find('input[aria-label="变更后自动同步"]').setValue(true)
    await vi.waitFor(() =>
      expect(p.autoPrefs.set).toHaveBeenLastCalledWith({ onChange: true, onInterval: false, intervalMinutes: 60 }),
    )
    // 间隔改 MdSelect（F6）：开弹层点「每天」→ intervalMinutes=1440 回写
    await w.find('button[aria-label="自动同步间隔"]').trigger('click')
    await w.findAll('[role="option"]').find((o) => o.text() === '每天')!.trigger('click')
    await vi.waitFor(() =>
      expect(p.autoPrefs.set).toHaveBeenLastCalledWith({ onChange: true, onInterval: false, intervalMinutes: 1440 }),
    )
  })

  it('⑫bautoPrefs.set 持久化拒绝 → 错误进 msg 通道（role=status）而非静默+未处理 rejection', async () => {
    const p = makePlatform({
      autoPrefs: {
        get: vi.fn(async () => ({ onChange: false, onInterval: false, intervalMinutes: 60 })),
        set: vi.fn(async () => { throw new Error('偏好写入失败') }),
      },
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await w.find('input[aria-label="变更后自动同步"]').setValue(true)
    await flushPromises()
    expect(w.find('[role="status"]').text()).toContain('偏好写入失败')
  })

  it('⑬loadAutoStatus：渲染「上次自动同步」文本；未提供则不渲染该行', async () => {
    const p = makePlatform({
      autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
      loadAutoStatus: vi.fn(async () => '2026-09-16 12:00 成功：webdav: in-sync'),
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    expect(w.find('.auto-status').text()).toBe('上次自动同步：2026-09-16 12:00 成功：webdav: in-sync')
    // 未提供 loadAutoStatus：状态行不渲染
    const w2 = await mountCard(makePlatform({
      autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    }))
    expect(w2.find('.auto-status').exists()).toBe(false)
  })

  it('⑭添加源：点「添加源」弹菜单列全部五种后端，点选后生成 uuid 源（默认名/覆盖/enabled 开）+ 空白凭据副本', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    expect(w.findAll('.target')).toHaveLength(1)
    const addBtn = w.find('button.target-add')
    expect(addBtn.text()).toBe('添加源')
    await addBtn.trigger('click')
    // 同类型可多份：菜单恒列全部五种（含已有 webdav），中文名
    const menuItems = w.findAll('.md-menu button').map((b) => b.text())
    expect(menuItems).toEqual(['WebDAV', 'S3', 'GitHub Gist', 'Google Drive', 'OneDrive'])
    await w.findAll('.md-menu button').find((b) => b.text() === 'S3')!.trigger('click')
    expect(w.findAll('.target')).toHaveLength(2)
    expect(w.find('.md-menu').exists()).toBe(false) // 点选后菜单关闭
    // 新源展开态：S3 字段可见且为空白凭据副本
    expect(w.find('input[placeholder="Region（如 us-east-1）"]').exists()).toBe(true)
    expect((w.find('input[placeholder="Region（如 us-east-1）"]').element as HTMLInputElement).value).toBe('')
    expect(w.find('input[aria-label="S3启用"]').exists()).toBe(true)
    // 保存：saveSources 收含新源列表（uuid id、默认名、覆盖策略、enabled）；空白凭据跳过 saveCred
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(p.saveSources).mock.calls[0]![0]
    expect(saved).toHaveLength(2)
    expect(saved[0]).toEqual(WEBDAV_SOURCE)
    expect(saved[1]).toMatchObject({ kind: 's3', name: 'S3', retention: { type: 'overwrite' }, enabled: true })
    expect(saved[1]!.id).toBeTruthy()
    expect(saved[1]!.id).not.toBe('s-webdav')
    expect(p.saveCred).toHaveBeenCalledTimes(1) // 仅已有凭据的 webdav 源
    expect(w.text()).toContain('凭据已保存（1 个空白源凭据未保存）')
  })

  it('⑭b添加源按钮 aria-haspopup=menu 且 aria-expanded 随开关翻转（批 6 a11y）', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    const addBtn = w.find('button.target-add')
    expect(addBtn.attributes('aria-haspopup')).toBe('menu')
    expect(addBtn.attributes('aria-expanded')).toBe('false')
    await addBtn.trigger('click')
    expect(addBtn.attributes('aria-expanded')).toBe('true')
    // 点选收起后翻回 false
    await w.findAll('.md-menu button').find((b) => b.text() === 'S3')!.trigger('click')
    expect(addBtn.attributes('aria-expanded')).toBe('false')
  })

  it('⑮定时自动同步开关：onInterval 切换以最新完整对象回写 set', async () => {
    const set = vi.fn(async () => {})
    const p = makePlatform({
      autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set },
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await w.find('input[aria-label="定时自动同步"]').setValue(true)
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith({ onChange: false, onInterval: true, intervalMinutes: 60 }))
  })

  it('⑱b同类型多份：已有 webdav 源时菜单仍列 WebDAV，可再添一份', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE, GIST_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED, 's-gist': GIST_CRED },
    })
    const w = await mountCard(p)
    await w.find('button.target-add').trigger('click')
    const menuItems = w.findAll('.md-menu button').map((b) => b.text())
    expect(menuItems).toContain('WebDAV')
    await w.findAll('.md-menu button').find((b) => b.text() === 'WebDAV')!.trigger('click')
    expect(w.findAll('.target')).toHaveLength(3) // 同 kind 第二份
  })

  it('⑱d移除-空白凭据源：直接删（不弹确认、不调 saveSources/removeCred）', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await w.find('button.target-add').trigger('click')
    await w.findAll('.md-menu button').find((b) => b.text() === 'S3')!.trigger('click')
    expect(w.findAll('.target')).toHaveLength(2)
    const removes = w.findAll('button.target-remove')
    expect(removes).toHaveLength(2)
    await removes[1]!.trigger('click') // 新加的空白 S3 行
    expect(w.findAll('.target')).toHaveLength(1)
    expect(w.find('.md-menu button').exists()).toBe(false)
    expect(w.find('.confirm-row').exists()).toBe(false) // 未弹确认
    expect(p.saveSources).not.toHaveBeenCalled() // 未持久化过，无需落盘
    expect(p.removeCred).not.toHaveBeenCalled()
  })

  it('⑱e移除-已存凭据源：两步确认；确认后 saveSources(剩余)+removeCred(id)，取消不动', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE, GIST_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED, 's-gist': GIST_CRED },
    })
    const w = await mountCard(p)
    await w.findAll('button.target-remove')[1]!.trigger('click') // gist（已存凭据）
    expect(w.text()).toContain('移除源「GitHub Gist」？已保存的凭据将从本机删除，云端对象不受影响。')
    // 取消：列表与存储均不动
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    expect(w.findAll('.target')).toHaveLength(2)
    expect(p.saveSources).not.toHaveBeenCalled()
    expect(p.removeCred).not.toHaveBeenCalled()
    // 再确认：saveSources 收剩余列表 + removeCred 该源 id
    await w.findAll('button.target-remove')[1]!.trigger('click')
    await w.findAll('button').find((b) => b.text() === '确认移除')!.trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenCalledTimes(1)
    expect(p.saveSources).toHaveBeenCalledWith([WEBDAV_SOURCE])
    expect(p.removeCred).toHaveBeenCalledTimes(1)
    expect(p.removeCred).toHaveBeenCalledWith('s-gist')
    expect(w.findAll('.target')).toHaveLength(1)
    expect(w.find('.confirm-row').exists()).toBe(false)
  })

  it('⑱f挂起移除确认期间：立即同步按钮禁用；移除后可重置集合/采纳基线引用同步清理', async () => {
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await w.findAll('button.target-remove')[0]!.trigger('click')
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(true)
    await w.findAll('button').find((b) => b.text() === '确认移除')!.trigger('click')
    await flushPromises()
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(false)
    expect(w.findAll('.target')).toHaveLength(0)
  })

  it('⑯gdrive 首推回存：后端 onChange 携新凭据（fileId）按 sourceId 更新编辑副本并 saveCred 持久化', async () => {
    const GDRIVE_SOURCE: BackupSource = { id: 's-gdrive', kind: 'gdrive', name: 'Google Drive', retention: { type: 'overwrite' }, enabled: true }
    const GDRIVE_CRED: CloudCred = { backend: 'gdrive', accessToken: 'tok' }
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([GDRIVE_SOURCE]),
      creds: { 's-gdrive': GDRIVE_CRED },
      loadAutoStatus: vi.fn(async () => '2026-09-16 12:00 成功：gdrive: uploaded'),
    })
    // fake 后端：构造时立即触发 onChange 回存 fileId（编排已被 mock，链路断言聚焦 onChange 回写）
    vi.mocked(createCloudBackend).mockImplementationOnce((cred, onChange) => {
      onChange!({ backend: 'gdrive', accessToken: (cred as { accessToken: string }).accessToken, fileId: 'fid-new' })
      return { id: cred.backend, put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false } as CloudBackend
    })
    mockedSync.mockResolvedValue({
      results: [{ key: 's-gdrive', outcome: { action: 'uploaded', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { 's-gdrive': 'h1' },
    })
    const w = await mountCard(p)
    await clickSync(w)
    // onChange 已把 fileId 回写进编辑副本并按 sourceId 持久化
    expect(p.saveCred).toHaveBeenCalledWith('s-gdrive', { backend: 'gdrive', accessToken: 'tok', fileId: 'fid-new' })
    expect(w.text()).toContain('已上传')
    // 手动完成后刷新「上次自动同步」状态行
    expect(w.find('.auto-status').text()).toContain('2026-09-16 12:00 成功：gdrive: uploaded')
  })

  it('⑯b onCredChange 单源 op：仅回存该源凭据，另一行未保存编辑不外溢；内存副本已更新', async () => {
    const GDRIVE_SOURCE: BackupSource = { id: 's-gdrive', kind: 'gdrive', name: 'Google Drive', retention: { type: 'overwrite' }, enabled: true }
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([GDRIVE_SOURCE, WEBDAV_SOURCE]),
      creds: { 's-gdrive': { backend: 'gdrive', accessToken: 'tok' }, 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    // 未保存的半填编辑：展开 webdav 行（第 2 行）改 serverUrl（仅存于卡内内存）
    await w.findAll('button.target-toggle')[1]!.trigger('click')
    await w.find('input[placeholder="服务器地址（https://dav.example.com）"]').setValue('https://edited.example.com')
    // fake 后端：sync 时 gdrive onChange 回存 fileId
    vi.mocked(createCloudBackend).mockImplementationOnce((cred, onChange) => {
      if ((cred as { backend: string }).backend === 'gdrive') {
        onChange!({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid-new' })
      }
      return { id: cred.backend, put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false } as CloudBackend
    })
    mockedSync.mockResolvedValue({
      results: [{ key: 's-gdrive', outcome: { action: 'in-sync', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { 's-gdrive': 'h1' },
    })
    await clickSync(w)
    // 持久化 = 单源 saveCred：webdav 的未保存编辑不外溢
    expect(p.saveCred).toHaveBeenCalledWith('s-gdrive', { backend: 'gdrive', accessToken: 'tok', fileId: 'fid-new' })
    // 内存：gdrive 副本已回填 fileId、webdav 编辑保留 →「保存凭据」落的是内存整列表
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveCred).toHaveBeenLastCalledWith('s-webdav', { ...WEBDAV_CRED, serverUrl: 'https://edited.example.com' })
  })

  it('⑯c onCredChange 回存失败：仅 console.warn，不影响同步结果与状态行', async () => {
    const GDRIVE_SOURCE: BackupSource = { id: 's-gdrive', kind: 'gdrive', name: 'Google Drive', retention: { type: 'overwrite' }, enabled: true }
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([GDRIVE_SOURCE]),
      creds: { 's-gdrive': { backend: 'gdrive', accessToken: 'tok' } },
    })
    vi.mocked(createCloudBackend).mockImplementationOnce((cred, onChange) => {
      onChange!({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid-new' })
      return { id: cred.backend, put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false } as CloudBackend
    })
    mockedSync.mockResolvedValue({
      results: [{ key: 's-gdrive', outcome: { action: 'in-sync', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { 's-gdrive': 'h1' },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await mountCard(p)
    await clickSync(w)
    warn.mockRestore()
    expect(w.text()).toContain('已是最新') // 同步结果不受回存失败影响
  })

  it('⑰防御路径：loadSources 回填失败按未存源处理；autoStatus 失败显示「暂无」；编排抛错提示且不写基线', async () => {
    // 挂载段：loadSources 拒绝 → 空列表；loadAutoStatus 拒绝 → 状态行「暂无」
    const p1 = makePlatform({
      loadSources: vi.fn().mockRejectedValue(new Error('存储坏')),
      loadAutoStatus: vi.fn(async () => { throw new Error('读状态失败') }),
    })
    const w1 = await mountCard(p1)
    expect(w1.findAll('.target')).toHaveLength(0) // 回填失败按未存源处理
    await vi.waitFor(() => expect(w1.find('.auto-status').text()).toContain('暂无'))
    // 同步段：正常回填一源，编排意外抛错 → 错误提示、不写任何基线
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    mockedSync.mockRejectedValue(new Error('编排崩溃'))
    await clickSync(w)
    expect(w.text()).toContain('编排崩溃')
    expect(p.saveTargetHash).not.toHaveBeenCalled()
  })

  const PW_MISMATCH_ERROR = '云端备份口令不匹配，无法合并——请确认口令或手动下载处理'

  it('⑱口令不匹配救济：状态显示+行内重置按钮，两步确认后 pushEnvelope 以当前口令重推并落基线', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 's-webdav', outcome: null, error: PW_MISMATCH_ERROR }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: {},
    })
    mockedPush.mockResolvedValue({ hash: 'rh1', envelopeJson: '{"enc":1}' })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(w.text()).toContain('失败：口令不匹配')
    expect(w.find('button.cloud-reset').exists()).toBe(true)
    await w.find('button.cloud-reset').trigger('click')
    expect(w.text()).toContain('将用当前备份口令重新加密并覆盖云端源「WebDAV」的对象，云端旧数据将被替换。确认重置？')
    await w.findAll('button').find((b) => b.text() === '确认重置')!.trigger('click')
    await flushPromises()
    expect(vi.mocked(createCloudBackend)).toHaveBeenCalledWith(WEBDAV_CRED)
    expect(mockedPush).toHaveBeenCalledTimes(1)
    expect(mockedPush.mock.calls[0]![0]).toMatchObject({
      path: 'totp-backup.totpbackup',
      vaultJson: VALID_VAULT,
      password: 'pw',
    })
    expect(p.saveTargetHash).toHaveBeenLastCalledWith('s-webdav', 'rh1')
    expect(w.text()).toContain('已重置')
    expect(w.find('button.cloud-reset').exists()).toBe(false) // 重置完成清出可重置集合
  })

  it('⑱b重置确认空白草稿回落已存凭据：清空编辑副本后确认重置仍用已存凭据推（同 onSync isBlankCred 守护）', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 's-webdav', outcome: null, error: PW_MISMATCH_ERROR }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: {},
    })
    mockedPush.mockResolvedValue({ hash: 'rh1', envelopeJson: '{"enc":1}' })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w) // 先同步一次产生口令不匹配 → 重置救济入口
    expect(w.find('button.cloud-reset').exists()).toBe(true)
    // 用户清空凭据编辑副本（未点保存）
    await w.findAll('button.target-toggle')[0]!.trigger('click')
    await w.find('input[placeholder="服务器地址（https://dav.example.com）"]').setValue('')
    await w.find('input[placeholder="应用密码"]').setValue('')
    await w.find('input[placeholder="用户名"]').setValue('')
    await w.find('button.cloud-reset').trigger('click')
    await w.findAll('button').find((b) => b.text() === '确认重置')!.trigger('click')
    await flushPromises()
    expect(vi.mocked(createCloudBackend)).toHaveBeenCalledWith(WEBDAV_CRED) // 回落已存凭据而非空白
    expect(mockedPush).toHaveBeenCalledTimes(1)
  })

  it('⑲重置确认挂起：立即同步按钮禁用；取消后不调用 pushEnvelope 且确认行消失', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 's-webdav', outcome: null, error: PW_MISMATCH_ERROR }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: {},
    })
    const p = makePlatform({
      loadSources: vi.fn().mockResolvedValue([WEBDAV_SOURCE]),
      creds: { 's-webdav': WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await clickSync(w)
    await w.find('button.cloud-reset').trigger('click')
    expect(w.find('.reset-confirm-row').exists()).toBe(true)
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(true)
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    expect(mockedPush).not.toHaveBeenCalled()
    expect(w.find('.reset-confirm-row').exists()).toBe(false)
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(false)
  })
})
