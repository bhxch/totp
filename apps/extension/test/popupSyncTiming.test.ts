/**
 * popup 首拉真实时序测试（终审 Critical-1/Important-2 修复回归）：独立文件承载——
 * popupApp.test.ts 存在历史挂载组件（前序用例未卸载），其解锁边沿 watcher 会在共享
 * locked ref 翻转时以 null 口令拉取并写 noSecret 跳过态，污染时序探针；本文件模块级
 * 隔离（vitest 每文件独立模块注册表），组件级链路全部真实（store 仅 mock chrome 侧）。
 *
 * 场景 = session DEK 恢复路径（加密库在会话内已解锁过一次，重开 popup）：
 * - store 创建态 locked=false、backupSecret=null（ui store 初始 ref，ui/src/store.ts 头部）；
 * - initStore 经 dekPersist 自动恢复：applyDekAndUnlock 装载保管区口令后 locked 仍 false——
 *   全程无 true→false 翻转，watch(locked) 钩子无边沿可捕，首拉只能靠 initStore 后显式 syncNow
 *   （旧实现 mount 即 syncNow：secret 恒 null → runner noSecret 早退写伪 cloudAutoStatus 且
 *   该路径永不重拉——每次开 popup 都看不到桌面新条目）。
 * 断言三件事：首拉触达 loadSources（读源键）/ initStore 执行时刻之前零 cloudAutoStatus 写盘
 * （伪写消除探针）/ 落盘为空表跳过态而非 noSecret 伪态。
 */
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { Ref } from 'vue'

vi.mock('../src/store', async () => {
  const { reactive, ref } = await import('vue')
  const settings = reactive({
    rememberTagFilter: false,
    lastTagFilterIds: [] as string[],
    tagFilterMode: 'all',
    urlFilterEnabled: false,
    popupCloseDelayMs: 3000,
    clipboardClearEnabled: false,
    themeMode: 'auto',
    themeColor: 'blue',
    syncEnabled: false,
    syncPrefs: { autoFollow: true },
    backupKdfProfile: 'balanced',
  })
  const vault = reactive({ entries: [] as unknown[], tags: [] })
  const locked = ref(false)
  const backupSecret = ref(null)
  const credsCache = ref<Record<string, unknown>>({})
  const store = {
    settings,
    vault,
    locked,
    backupSecret,
    credsCache,
    commitSettings: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    replaceAllOp: vi.fn(async () => {}),
  }
  return {
    storageAdapter: { get: vi.fn(async () => null), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    store,
    settings,
    vault,
    locked,
    backupSecret,
    credsCache,
    initStore: vi.fn(async () => {}),
    registerStorageSync: vi.fn(),
    commitSettings: vi.fn(async () => {}),
    addEntryOp: vi.fn(async () => ({})),
    updateEntryOp: vi.fn(async () => ({})),
    removeEntryOp: vi.fn(async () => {}),
    addTagOp: vi.fn(async () => 'tag'),
    renameTagOp: vi.fn(async () => {}),
    removeTagOp: vi.fn(async () => {}),
    reorderOp: vi.fn(async () => {}),
    replaceAllOp: vi.fn(async () => {}),
  }
})

import App from '../entrypoints/popup/App.vue'
import { createTestI18n } from './helpers/i18n'
import { initStore, locked, settings, storageAdapter, store } from '../src/store'
import { SOURCES_KEY } from '@totp/core'

describe('popup 首拉真实时序（终审 Critical-1/Important-2）', () => {
  // 真实模块导出的 locked 是 ComputedRef（只读类型）；mock 模块内是可写 ref，断言直写
  const lockedRef = locked as unknown as Ref<boolean>
  const backupSecretRef = store.backupSecret as unknown as Ref<string | null>

  it('mount 时刻口令未装载（locked 恒 false 无解锁边沿）：首拉仅在 initStore 完成后触达 runner，此前零伪写', async () => {
    lockedRef.value = false // session DEK 恢复路径的真实创建态：无 true→false 边沿可捕
    backupSecretRef.value = null // mount 时刻口令未装载（仅 applyDekAndUnlock 装载）
    settings.syncPrefs.autoFollow = true
    let statusWritesAtInit = -1
    vi.mocked(initStore).mockImplementation(async () => {
      // 伪写探针：initStore 执行时刻若已有 cloudAutoStatus 写盘 = mount 即拉取的旧时序
      //（旧实现该写必为 runner noSecret 早退的 recordStatus(null,'未设置备份口令')）
      statusWritesAtInit = vi.mocked(storageAdapter.set).mock.calls.filter((c) => c[0] === 'cloudAutoStatus').length
      backupSecretRef.value = 'pw' // initStore 完成时点口令就位（保管区装载语义）
    })
    const wrapper = mount(App, {
      global: {
        plugins: [createTestI18n()],
        stubs: { LockScreen: true, EntryForm: true, BatchPastePanel: true, OtpListItem: true },
      },
    })
    try {
      await flushPromises()
      // 首拉触达证据：runner 越过 noSecret 早退走到 loadSources（读源键）并真实落状态
      expect(storageAdapter.get).toHaveBeenCalledWith(SOURCES_KEY)
      expect(storageAdapter.set).toHaveBeenCalledWith('cloudAutoStatus', expect.anything())
      // 伪写消除：initStore 执行时刻之前零 cloudAutoStatus 写盘
      expect(statusWritesAtInit).toBe(0)
      // 落盘为空表跳过态而非 noSecret 伪态（summary 区分 runner 分支：'未启用云源' vs '未设置备份口令'）
      const record = vi.mocked(storageAdapter.set).mock.calls.find((c) => c[0] === 'cloudAutoStatus')!
      expect((JSON.parse(record[1] as string) as { summary: string }).summary).not.toContain('未设置备份口令')
    } finally {
      wrapper.unmount() // onScopeDispose → syncFollow.stop（反注册解锁 watcher，防进程内残留）
      await flushPromises()
    }
  })
})
