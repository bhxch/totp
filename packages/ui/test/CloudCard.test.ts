import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  return { ...actual, syncMultipleTargets: vi.fn(), pushEnvelope: vi.fn(actual.pushEnvelope) }
})
// createCloudBackend 由 CloudCard 从 ui 本地 cloudPlatform 导入：包为 vi.fn 且默认委托真实现，供 ⑯ 注入 fake 后端
vi.mock('../src/components/cloudPlatform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/cloudPlatform')>()
  return { ...actual, createCloudBackend: vi.fn(actual.createCloudBackend) }
})

import { pushEnvelope, syncMultipleTargets, type CloudBackend } from '@totp/core'
import { createCloudBackend } from '../src/components/cloudPlatform'
import CloudCard from '../src/components/CloudCard.vue'
import type { CloudPlatform, CloudTarget } from '../src/components/cloudPlatform'

const mockedSync = vi.mocked(syncMultipleTargets)
const mockedPush = vi.mocked(pushEnvelope)

const VALID_VAULT = JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 0 })
const EMPTY_RESULT = { results: [], finalVaultJson: VALID_VAULT, adopted: false, hashes: {} }

const WEBDAV_TARGET: CloudTarget = {
  cred: { backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'alice', password: 'davpw' },
  enabled: true,
}
const GIST_TARGET: CloudTarget = { cred: { backend: 'gist', token: 'tok', gistId: 'gid' }, enabled: true }

function makePlatform(over: Partial<CloudPlatform> = {}): CloudPlatform {
  const base: CloudPlatform = {
    loadCreds: vi.fn().mockResolvedValue([]),
    saveCreds: vi.fn().mockResolvedValue(undefined),
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
  await flushPromises() // onMounted 异步回填 targets/autoPrefs/autoStatus
  return w
}

async function clickSync(w: VueWrapper): Promise<void> {
  await w.find('button.cloud-sync').trigger('click')
  await flushPromises()
}

describe('CloudCard（多目标）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('①目标列表：loadCreds 回填两条启用目标，渲染标签与启用开关', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET, GIST_TARGET]) })
    const w = await mountCard(p)
    expect(w.findAll('.target')).toHaveLength(2)
    expect(w.text()).toContain('WebDAV')
    expect(w.text()).toContain('GitHub Gist')
    expect(w.find('input[aria-label="WebDAV启用"]').exists()).toBe(true)
    expect(w.find('input[aria-label="GitHub Gist启用"]').exists()).toBe(true)
  })

  it('②配置展开：显示该后端凭据字段与目标路径框（placeholder=缺省路径）', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p)
    // 收起态不渲染字段
    expect(w.find('input[aria-label="目标文件路径"]').exists()).toBe(false)
    await w.find('button.target-toggle').trigger('click')
    expect((w.find('input[placeholder="服务器地址（https://dav.example.com）"]').element as HTMLInputElement).value).toBe('https://dav.example.com')
    const pathInput = w.find('input[aria-label="目标文件路径"]')
    expect(pathInput.exists()).toBe(true)
    expect(pathInput.attributes('placeholder')).toBe('totp-backup.totpbackup')
    expect((pathInput.element as HTMLInputElement).value).toBe('') // 未自定义 objectPath
  })

  it('③仅 enabled 目标进入 syncMultipleTargets', async () => {
    mockedSync.mockResolvedValue(EMPTY_RESULT)
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET, { ...GIST_TARGET, enabled: false }]) })
    const w = await mountCard(p)
    await clickSync(w)
    expect(mockedSync).toHaveBeenCalledTimes(1)
    const inputs = mockedSync.mock.calls[0]![0].targets
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.key).toBe('webdav')
  })

  it('④objectPath 透传：resolveObjectPath 结果作 path，缺省回落 DEFAULT_OBJECT_PATH', async () => {
    mockedSync.mockResolvedValue(EMPTY_RESULT)
    const p = makePlatform({
      loadCreds: vi.fn().mockResolvedValue([
        { ...WEBDAV_TARGET, cred: { ...WEBDAV_TARGET.cred, objectPath: 'custom\\dir.totpbackup' } },
        GIST_TARGET,
      ]),
    })
    const w = await mountCard(p)
    await clickSync(w)
    expect(mockedSync).toHaveBeenCalledTimes(1)
    const inputs = mockedSync.mock.calls[0]![0].targets
    expect(inputs.map((x) => ({ key: x.key, path: x.path }))).toEqual([
      { key: 'webdav', path: 'custom/dir.totpbackup' }, // 反斜杠段归一为 /
      { key: 'gist', path: 'totp-backup.totpbackup' },
    ])
  })

  it('⑤hash 逐目标透传与回写：失败目标回写 null（删基线）', async () => {
    mockedSync.mockResolvedValue({
      results: [
        { key: 'webdav', outcome: { action: 'in-sync', hash: 'hw1' } },
        { key: 'gist', outcome: null, error: 'boom' },
      ],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { webdav: 'hw1' },
    })
    const p = makePlatform({
      loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET, GIST_TARGET]),
      loadTargetHash: vi.fn(async (b: string) => (b === 'webdav' ? 'h-w' : 'h-g')),
    })
    const w = await mountCard(p)
    await clickSync(w)
    const inputs = mockedSync.mock.calls[0]![0].targets
    expect(inputs.map((x) => ({ key: x.key, hash: x.hash }))).toEqual([
      { key: 'webdav', hash: 'h-w' },
      { key: 'gist', hash: 'h-g' },
    ])
    expect(p.saveTargetHash).toHaveBeenCalledWith('webdav', 'hw1')
    expect(p.saveTargetHash).toHaveBeenCalledWith('gist', null)
    expect(w.text()).toContain('失败：boom')
    expect(w.text()).toContain('已是最新')
  })

  it('⑥adopted：行内确认出现且确认前不落基线，确认后 persistDownloaded(finalVaultJson)+补写基线', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 'webdav', outcome: { action: 'downloaded', hash: 'h9', envelopeJson: VALID_VAULT } }],
      finalVaultJson: VALID_VAULT,
      adopted: true,
      hashes: { webdav: 'h9' },
    })
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p)
    await clickSync(w)
    expect(w.find('.confirm-row').exists()).toBe(true)
    expect(w.text()).toContain('采用云端将覆盖本地')
    expect(p.persistDownloaded).not.toHaveBeenCalled()
    expect(p.saveTargetHash).not.toHaveBeenCalled() // 采纳目标基线延后
    // 确认行挂起期间禁用立即同步（防二次同步覆盖待确认状态）
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(true)
    // 三态互斥：采纳确认挂起期间，行内移除按钮同步禁用
    expect((w.find('button.target-remove').element as HTMLButtonElement).disabled).toBe(true)
    await w.findAll('button').find((b) => b.text() === '采用云端')!.trigger('click')
    await flushPromises()
    expect(p.persistDownloaded).toHaveBeenCalledWith(VALID_VAULT)
    expect(p.saveTargetHash).toHaveBeenCalledWith('webdav', 'h9')
    expect(w.text()).toContain('已采用云端数据覆盖本地')
    expect(w.find('.confirm-row').exists()).toBe(false)
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('⑦取消采用：persistDownloaded 不调、基线不写，提示已保留冲突副本', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 'webdav', outcome: { action: 'conflict-resolved', hash: 'h8', envelopeJson: VALID_VAULT, conflictBackup: 'conflict-webdav-20260916-120000.totpbackup' } }],
      finalVaultJson: VALID_VAULT,
      adopted: true,
      hashes: { webdav: 'h8' },
    })
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p)
    await clickSync(w)
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    await flushPromises()
    expect(p.persistDownloaded).not.toHaveBeenCalled()
    expect(p.saveTargetHash).not.toHaveBeenCalled()
    expect(w.text()).toContain('已保留冲突副本，未改动本地')
    expect(w.find('.confirm-row').exists()).toBe(false)
  })

  it('⑦b混合采纳：确认前非采纳目标基线已写、采纳目标未写；取消后采纳目标零调用且非采纳基线保持', async () => {
    mockedSync.mockResolvedValue({
      results: [
        { key: 'webdav', outcome: { action: 'downloaded', hash: 'hw', envelopeJson: VALID_VAULT } },
        { key: 'gist', outcome: { action: 'in-sync', hash: 'hg' } },
      ],
      finalVaultJson: VALID_VAULT,
      adopted: true,
      hashes: { webdav: 'hw', gist: 'hg' },
    })
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET, GIST_TARGET]) })
    const w = await mountCard(p)
    await clickSync(w)
    expect(w.find('.confirm-row').exists()).toBe(true)
    // 确认前：非采纳目标（in-sync）基线已立即回写；采纳目标（downloaded）基线延后未写
    expect(p.saveTargetHash).toHaveBeenCalledTimes(1)
    expect(p.saveTargetHash).toHaveBeenCalledWith('gist', 'hg')
    // 取消：采纳目标 saveTargetHash 零调用，persistDownloaded 不调，非采纳目标已写基线保持（不回滚）
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    await flushPromises()
    expect(p.saveTargetHash).toHaveBeenCalledTimes(1)
    expect(p.saveTargetHash).not.toHaveBeenCalledWith('webdav', 'hw')
    expect(p.persistDownloaded).not.toHaveBeenCalled()
    expect(w.text()).toContain('已保留冲突副本，未改动本地')
  })

  it('⑧无 sessionSecret：同步按钮禁用并显示设置口令提示', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p, null)
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.text()).toContain('先在上方设置备份口令')
  })

  it('⑨未启用任何云目标：提示错误且不调同步编排', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([{ ...WEBDAV_TARGET, enabled: false }]) })
    const w = await mountCard(p)
    await clickSync(w)
    expect(mockedSync).not.toHaveBeenCalled()
    expect(p.readVaultJson).not.toHaveBeenCalled()
    expect(w.text()).toContain('未启用任何云目标')
  })

  it('⑩保存凭据：整列表调 saveCreds', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveCreds).toHaveBeenCalledWith([WEBDAV_TARGET])
    expect(w.text()).toContain('凭据已保存')
  })

  it('⑪单目标错误状态行不影响其余目标结果展示', async () => {
    mockedSync.mockResolvedValue({
      results: [
        { key: 'webdav', outcome: null, error: '网络错误' },
        { key: 'gist', outcome: { action: 'uploaded', hash: 'hu' } },
      ],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { gist: 'hu' },
    })
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET, GIST_TARGET]) })
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
      loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]),
    })
    const w = await mountCard(p)
    await w.find('input[aria-label="变更后自动同步"]').setValue(true)
    await vi.waitFor(() =>
      expect(p.autoPrefs.set).toHaveBeenLastCalledWith({ onChange: true, onInterval: false, intervalMinutes: 60 }),
    )
    await w.find('select.interval').setValue('1440')
    await vi.waitFor(() =>
      expect(p.autoPrefs.set).toHaveBeenLastCalledWith({ onChange: true, onInterval: false, intervalMinutes: 1440 }),
    )
  })

  it('⑬loadAutoStatus：渲染「上次自动同步」文本；未提供则不渲染该行', async () => {
    const p = makePlatform({
      autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
      loadAutoStatus: vi.fn(async () => '2026-09-16 12:00 成功：webdav: in-sync'),
      loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]),
    })
    const w = await mountCard(p)
    expect(w.find('.auto-status').text()).toBe('上次自动同步：2026-09-16 12:00 成功：webdav: in-sync')
    // 未提供 loadAutoStatus：状态行不渲染
    const w2 = await mountCard(makePlatform({
      autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
      loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]),
    }))
    expect(w2.find('.auto-status').exists()).toBe(false)
  })

  it('⑭添加目标：点「添加目标」弹菜单列全部缺失后端，点选后 push 空白凭据（enabled 开）并展开其配置', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p)
    expect(w.findAll('.target')).toHaveLength(1)
    const addBtn = w.find('button.target-add')
    expect(addBtn.text()).toBe('添加目标')
    await addBtn.trigger('click')
    // 菜单仅列缺失后端（不含已有 webdav），中文名
    const menuItems = w.findAll('.md-menu button').map((b) => b.text())
    expect(menuItems).toEqual(['S3', 'GitHub Gist', 'Google Drive', 'OneDrive'])
    await w.findAll('.md-menu button').find((b) => b.text() === 'S3')!.trigger('click')
    expect(w.findAll('.target')).toHaveLength(2)
    expect(w.find('.md-menu').exists()).toBe(false) // 点选后菜单关闭
    // 新目标展开态：S3 字段可见且为空白凭据
    expect(w.find('input[placeholder="Region（如 us-east-1）"]').exists()).toBe(true)
    expect((w.find('input[placeholder="Region（如 us-east-1）"]').element as HTMLInputElement).value).toBe('')
    expect(w.find('input[aria-label="S3启用"]').exists()).toBe(true)
    // 保存：整列表含新空白目标
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveCreds).toHaveBeenCalledWith([WEBDAV_TARGET, { cred: { backend: 's3', region: '', bucket: '', accessKeyId: '', secretAccessKey: '' }, enabled: true }])
  })

  it('⑮定时自动同步开关：onInterval 切换以最新完整对象回写 set', async () => {
    const set = vi.fn(async () => {})
    const p = makePlatform({
      autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set },
      loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]),
    })
    const w = await mountCard(p)
    await w.find('input[aria-label="定时自动同步"]').setValue(true)
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith({ onChange: false, onInterval: true, intervalMinutes: 60 }))
  })

  it('⑱b添加菜单只列缺失后端：已有 webdav/gist 时不含这两项', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET, GIST_TARGET]) })
    const w = await mountCard(p)
    await w.find('button.target-add').trigger('click')
    const menuItems = w.findAll('.md-menu button').map((b) => b.text())
    expect(menuItems).toEqual(['S3', 'Google Drive', 'OneDrive'])
  })

  it('⑱c全部后端已添加：「添加目标」按钮隐藏', async () => {
    const p = makePlatform({
      loadCreds: vi.fn().mockResolvedValue([
        WEBDAV_TARGET, GIST_TARGET,
        { cred: { backend: 's3', region: 'r', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }, enabled: true },
        { cred: { backend: 'gdrive', accessToken: 't' }, enabled: true },
        { cred: { backend: 'onedrive', accessToken: 't' }, enabled: true },
      ]),
    })
    const w = await mountCard(p)
    expect(w.find('button.target-add').exists()).toBe(false)
  })

  it('⑱d移除-空凭据：直接删（不弹确认、不调 saveCreds）', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
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
    expect(p.saveCreds).not.toHaveBeenCalled() // 未持久化过，无需落盘
  })

  it('⑱e移除-非空凭据：两步确认；确认后 saveCreds 以减去该项的列表调用，取消不动', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET, GIST_TARGET]) })
    const w = await mountCard(p)
    await w.findAll('button.target-remove')[1]!.trigger('click') // gist（非空）
    expect(w.text()).toContain('移除目标 GitHub Gist？已保存的凭据将从本机删除，云端对象不受影响。')
    // 取消：列表与存储均不动
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    expect(w.findAll('.target')).toHaveLength(2)
    expect(p.saveCreds).not.toHaveBeenCalled()
    // 再确认：saveCreds 收内存列表减去该项
    await w.findAll('button.target-remove')[1]!.trigger('click')
    await w.findAll('button').find((b) => b.text() === '确认移除')!.trigger('click')
    await flushPromises()
    expect(p.saveCreds).toHaveBeenCalledTimes(1)
    expect(p.saveCreds).toHaveBeenCalledWith([WEBDAV_TARGET])
    expect(w.findAll('.target')).toHaveLength(1)
    expect(w.find('.confirm-row').exists()).toBe(false)
  })

  it('⑱f挂起移除确认期间：立即同步按钮禁用；移除后可重置集合/采纳基线引用同步清理', async () => {
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p)
    await w.findAll('button.target-remove')[0]!.trigger('click')
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(true)
    await w.findAll('button').find((b) => b.text() === '确认移除')!.trigger('click')
    await flushPromises()
    expect((w.find('button.cloud-sync').element as HTMLButtonElement).disabled).toBe(false)
    expect(w.findAll('.target')).toHaveLength(0)
  })

  it('⑯gdrive 首推回存：后端 onChange 携新凭据（fileId）更新内存目标并 saveCreds 持久化', async () => {
    const GDRIVE: CloudTarget = { cred: { backend: 'gdrive', accessToken: 'tok' }, enabled: true }
    const p = makePlatform({
      loadCreds: vi.fn().mockResolvedValue([GDRIVE]),
      loadAutoStatus: vi.fn(async () => '2026-09-16 12:00 成功：gdrive: uploaded'),
    })
    // fake 后端：构造时立即触发 onChange 回存 fileId（编排已被 mock，链路断言聚焦 onChange 回写）
    vi.mocked(createCloudBackend).mockImplementationOnce((cred, onChange) => {
      onChange!({ backend: 'gdrive', accessToken: (cred as { accessToken: string }).accessToken, fileId: 'fid-new' })
      return { id: cred.backend, put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false } as CloudBackend
    })
    mockedSync.mockResolvedValue({
      results: [{ key: 'gdrive', outcome: { action: 'uploaded', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { gdrive: 'h1' },
    })
    const w = await mountCard(p)
    await clickSync(w)
    // onChange 已把 fileId 回写进内存目标并持久化
    expect(p.saveCreds).toHaveBeenCalledWith([{ cred: { backend: 'gdrive', accessToken: 'tok', fileId: 'fid-new' }, enabled: true }])
    expect(w.text()).toContain('已上传')
    // 手动完成后刷新「上次自动同步」状态行
    expect(w.find('.auto-status').text()).toContain('2026-09-16 12:00 成功：gdrive: uploaded')
  })

  it('⑯b onCredChange 单目标合并：saveCreds 收「已保存列表替换单项」，另一行未保存编辑不外溢；内存行 cred 已更新', async () => {
    const GDRIVE: CloudTarget = { cred: { backend: 'gdrive', accessToken: 'tok' }, enabled: true }
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([GDRIVE, WEBDAV_TARGET]) })
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
      results: [{ key: 'gdrive', outcome: { action: 'in-sync', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { gdrive: 'h1' },
    })
    await clickSync(w)
    // 持久化 = 已保存列表替换单项：webdav 保持已保存原值（edited 编辑不外溢落盘）
    expect(p.saveCreds).toHaveBeenCalledWith([
      { cred: { backend: 'gdrive', accessToken: 'tok', fileId: 'fid-new' }, enabled: true },
      WEBDAV_TARGET,
    ])
    // 内存：gdrive 行 cred 已回填 fileId、webdav 编辑保留 →「保存凭据」落的是内存整列表
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveCreds).toHaveBeenLastCalledWith([
      { cred: { backend: 'gdrive', accessToken: 'tok', fileId: 'fid-new' }, enabled: true },
      { ...WEBDAV_TARGET, cred: { ...WEBDAV_TARGET.cred, serverUrl: 'https://edited.example.com' } },
    ])
  })

  it('⑯c onCredChange 空列表守卫：loadCreds 返回 [] 时不调 saveCreds（防固化空存储）', async () => {
    const GDRIVE: CloudTarget = { cred: { backend: 'gdrive', accessToken: 'tok' }, enabled: true }
    const p = makePlatform({
      loadCreds: vi.fn().mockResolvedValueOnce([GDRIVE]).mockResolvedValue([]), // 首次回填正常，回存时读空
    })
    const w = await mountCard(p)
    vi.mocked(createCloudBackend).mockImplementationOnce((cred, onChange) => {
      onChange!({ backend: 'gdrive', accessToken: 'tok', fileId: 'fid-new' })
      return { id: cred.backend, put: async () => {}, get: async () => null, delete: async () => {}, exists: async () => false } as CloudBackend
    })
    mockedSync.mockResolvedValue({
      results: [{ key: 'gdrive', outcome: { action: 'in-sync', hash: 'h1' } }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: { gdrive: 'h1' },
    })
    await clickSync(w)
    expect(p.saveCreds).not.toHaveBeenCalled()
  })

  it('⑰防御路径：loadCreds 回填失败按未存凭据处理；getAutoStatus 失败显示「暂无」；编排抛错提示且不写基线', async () => {
    // 挂载段：loadCreds 拒绝 → 空列表；getAutoStatus 拒绝 → 状态行「暂无」
    const p1 = makePlatform({
      loadCreds: vi.fn().mockRejectedValue(new Error('存储坏')),
      loadAutoStatus: vi.fn(async () => { throw new Error('读状态失败') }),
    })
    const w1 = await mountCard(p1)
    expect(w1.findAll('.target')).toHaveLength(0) // 回填失败按未存凭据处理
    await vi.waitFor(() => expect(w1.find('.auto-status').text()).toContain('暂无'))
    // 同步段：正常回填一目标，编排意外抛错 → 错误提示、不写任何基线
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p)
    mockedSync.mockRejectedValue(new Error('编排崩溃'))
    await clickSync(w)
    expect(w.text()).toContain('编排崩溃')
    expect(p.saveTargetHash).not.toHaveBeenCalled()
  })

  const PW_MISMATCH_ERROR = '云端备份口令不匹配，无法合并——请确认口令或手动下载处理'

  it('⑱口令不匹配救济：状态显示+行内重置按钮，两步确认后 pushEnvelope 以当前口令重推并落基线', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 'webdav', outcome: null, error: PW_MISMATCH_ERROR }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: {},
    })
    mockedPush.mockResolvedValue({ hash: 'rh1', envelopeJson: '{"enc":1}' })
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
    const w = await mountCard(p)
    await clickSync(w)
    expect(w.text()).toContain('失败：口令不匹配')
    expect(w.find('button.cloud-reset').exists()).toBe(true)
    await w.find('button.cloud-reset').trigger('click')
    expect(w.text()).toContain('将用当前备份口令重新加密并覆盖云端 WebDAV 对象，云端旧数据将被替换。确认重置？')
    await w.findAll('button').find((b) => b.text() === '确认重置')!.trigger('click')
    await flushPromises()
    expect(vi.mocked(createCloudBackend)).toHaveBeenCalledWith(WEBDAV_TARGET.cred)
    expect(mockedPush).toHaveBeenCalledTimes(1)
    expect(mockedPush.mock.calls[0]![0]).toMatchObject({
      path: 'totp-backup.totpbackup',
      vaultJson: VALID_VAULT,
      password: 'pw',
    })
    expect(p.saveTargetHash).toHaveBeenLastCalledWith('webdav', 'rh1')
    expect(w.text()).toContain('已重置')
    expect(w.find('button.cloud-reset').exists()).toBe(false) // 重置完成清出可重置集合
  })

  it('⑲重置确认挂起：立即同步按钮禁用；取消后不调用 pushEnvelope 且确认行消失', async () => {
    mockedSync.mockResolvedValue({
      results: [{ key: 'webdav', outcome: null, error: PW_MISMATCH_ERROR }],
      finalVaultJson: VALID_VAULT,
      adopted: false,
      hashes: {},
    })
    const p = makePlatform({ loadCreds: vi.fn().mockResolvedValue([WEBDAV_TARGET]) })
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
