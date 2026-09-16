import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  return { ...actual, syncMultipleTargets: vi.fn() }
})

import { syncMultipleTargets } from '@totp/core'
import CloudCard from '../src/components/CloudCard.vue'
import type { CloudPlatform, CloudTarget } from '../src/components/cloudPlatform'

const mockedSync = vi.mocked(syncMultipleTargets)

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
})
