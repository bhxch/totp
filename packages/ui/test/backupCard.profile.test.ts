/** plan16 T11.5 新增：BackupCard 备份加密强度档位用例（渲染条件/初值异步载入防闪烁/变更回写/get 失败不渲染） */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { KdfProfile } from '@totp/core'
import BackupCard from '../src/components/BackupCard.vue'
import { createTestI18n } from './helpers/i18n'
import type { BackupPlatform } from '../src/components/backupPlatform'

function makePlatform(over: Partial<BackupPlatform> = {}): BackupPlatform {
  return {
    createBackup: vi.fn(async () => '已备份到 1 个目录'),
    ...over,
  }
}

/** 档位读写桩：get 初值可变，set 即时改内存（供断言回写后的完整值） */
function makeProfileApi(initial: KdfProfile = 'balanced') {
  let cur = initial
  return {
    get cur(): KdfProfile {
      return cur
    },
    api: {
      get: vi.fn(async (): Promise<KdfProfile> => cur),
      set: vi.fn((p: KdfProfile): void => { cur = p }),
    },
  }
}

async function mountCard(p: BackupPlatform, sessionSecret: string | null = 'pw') {
  const w = mount(BackupCard, { global: { plugins: [createTestI18n()] }, props: { platform: p, vaultJson: '{}', sessionSecret } })
  await flushPromises()
  return w
}

/** 打开档位下拉并点选指定 label 的选项（同 SecurityCard plan16 测试口径） */
async function selectOption(w: ReturnType<typeof mount>, label: string): Promise<void> {
  await w.find('.profile-row button.md-select__trigger').trigger('click')
  const opt = w.findAll('[role="option"]').find((o) => o.text() === label)
  expect(opt, `选项「${label}」应存在`).toBeDefined()
  await opt!.trigger('click')
}

describe('BackupCard 备份加密强度档位（plan16 T11.5）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('P1 渲染条件：platform 未提供 backupKdfProfile → 档位行不渲染', async () => {
    const w = await mountCard(makePlatform())
    expect(w.find('.profile-row').exists()).toBe(false)
  })

  it('P2 防闪烁：get 未 resolve 前不渲染；resolve 后渲染并回显初值档位 label', async () => {
    let resolveGet!: (v: KdfProfile) => void
    const api = {
      get: vi.fn((): Promise<KdfProfile> => new Promise((r) => { resolveGet = r })),
      set: vi.fn(),
    }
    const w = mount(BackupCard, { global: { plugins: [createTestI18n()] }, props: { platform: makePlatform({ backupKdfProfile: api }), vaultJson: '{}', sessionSecret: 'pw' } })
    await flushPromises()
    expect(w.find('.profile-row').exists()).toBe(false) // 载入完成前不渲染（不闪默认值）
    resolveGet('paranoid')
    await flushPromises()
    expect(w.find('.profile-row').exists()).toBe(true)
    expect(w.find('.profile-row button.md-select__trigger').text()).toContain('更慢更耐暴力破解')
  })

  it('P3 get 失败 → 档位行不渲染（同 lockPrefs 载入失败按未提供处理）', async () => {
    const api = { get: vi.fn(async (): Promise<KdfProfile> => { throw new Error('boom') }), set: vi.fn() }
    const w = await mountCard(makePlatform({ backupKdfProfile: api }))
    expect(w.find('.profile-row').exists()).toBe(false)
  })

  it('P4 三档选项与 hint 齐备：fast/balanced/paranoid 及 Argon2id 说明', async () => {
    const w = await mountCard(makePlatform({ backupKdfProfile: makeProfileApi().api }))
    await w.find('.profile-row button.md-select__trigger').trigger('click')
    expect(w.findAll('[role="option"]').map((o) => o.text())).toEqual([
      '更快（低端机友好）',
      '平衡（默认）',
      '更慢更耐暴力破解',
    ])
    expect(w.find('.profile-row').text()).toContain('用于本地备份文件与云端同步对象的加密参数（Argon2id 强度）')
  })

  it('P5 变更回写：get 初值 balanced → 选「更快（低端机友好）」→ set 收到完整值 fast（内存同步前进）', async () => {
    const prof = makeProfileApi('balanced')
    const w = await mountCard(makePlatform({ backupKdfProfile: prof.api }))
    await vi.waitFor(() => expect(w.find('.profile-row').exists()).toBe(true))
    await selectOption(w, '更快（低端机友好）')
    await vi.waitFor(() => expect(prof.api.set).toHaveBeenCalledTimes(1))
    expect(prof.api.set).toHaveBeenCalledWith('fast')
    expect(prof.cur).toBe('fast')
    // 触发框回显新档位
    expect(w.find('.profile-row button.md-select__trigger').text()).toContain('更快（低端机友好）')
  })

  it('P6 变更回写：切「更慢更耐暴力破解」→ set 收到 paranoid', async () => {
    const prof = makeProfileApi('fast')
    const w = await mountCard(makePlatform({ backupKdfProfile: prof.api }))
    await vi.waitFor(() => expect(w.find('.profile-row').exists()).toBe(true))
    await selectOption(w, '更慢更耐暴力破解')
    await vi.waitFor(() => expect(prof.api.set).toHaveBeenCalledWith('paranoid'))
  })

  it('P7 set 返回 Promise 也可（void | Promise<void> 兼容）：拒绝不外抛且错误进 msg 通道', async () => {
    const api = { get: vi.fn(async (): Promise<KdfProfile> => 'balanced'), set: vi.fn(async (): Promise<void> => { throw new Error('write fail') }) }
    const w = await mountCard(makePlatform({ backupKdfProfile: api }))
    await vi.waitFor(() => expect(w.find('.profile-row').exists()).toBe(true))
    await selectOption(w, '更慢更耐暴力破解')
    await flushPromises()
    expect(api.set).toHaveBeenCalledWith('paranoid') // 不因 set 拒绝而抛出
    expect(w.find('[role="status"]').text()).toContain('write fail') // 错误经 fail() 展示而非静默
  })
})
