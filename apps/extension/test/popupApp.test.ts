/**
 * popup App 组件级单测（P4 Task 3 精简后形态）：
 * - header：无「添加」按钮/无粘贴 details/无行内管理钮；「打开主界面」→ tabs.create(options.html#/codes)；设置齿轮 → #/settings
 * - 列表区整体装配 QuickCodesPanel（tagRow/tags/tagMode/query/entries/loading 透传 + copy/dblclick 转发）
 * - 快捷新增仅剩确认态：?uri= / pendingOtpauth → EntryForm 预填 → save 落库（carried 字段透传）
 * - 评审 R1 回归：新建 yandex 条目 digits=8 经 toOtpDigits 收口直传 addEntryOp，不被覆写为 6
 * store 模块整体 mock：真实模块 import 期即建 chrome 侧 store 单例（src/store.ts 顶层
 * createExtensionStore），node/jsdom 测试环境不可用；组件树其余走真实实现。
 */
// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, type Ref } from 'vue'
import { useToast } from '@totp/ui'

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
    syncPrefs: { autoFollow: true }, // 跨端同步 T3：跟随拉取 gate 读取（真实 loadSettings 归一化产物形状）
    backupKdfProfile: 'balanced', // runner kdfProfile deps 读取位（真实 settings 形状）
  })
  const vault = reactive({ entries: [] as unknown[], tags: [] })
  const locked = ref(false)
  // runner（cloudRunnerFactory）消费的解锁态字段：ComputedRef 形状（.value）；默认 null=无会话口令
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
    // 云同步 runner/store 冲突面（Task 9/10 后真实导出面的新成员，缺位会让 runner 轮尾
    // conflictCount() 抛 TypeError 被调度器吞成假绿+噪声——审查 Important 2）
    conflictCount: { value: 0 },
    addMergeConflictsOp: vi.fn(async () => {}),
    saveMergeConflictsOp: vi.fn(async () => {}),
    resolveMergeConflictOp: vi.fn(async () => {}),
    sealWithDek: vi.fn(async () => null),
    unsealWithDek: vi.fn(async () => null),
  }
  return {
    persistFailed: ref(false),
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

vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

import App from '../entrypoints/popup/App.vue'
import { createTestI18n } from './helpers/i18n'
import { installChromeShim, type ChromeShim } from './helpers/chromeShim'
import { addEntryOp, commitSettings, initStore, locked, settings, storageAdapter, store, updateEntryOp, vault } from '../src/store'
import { SOURCES_KEY } from '@totp/core'
import { encodePending } from '../src/pendingOtpauth'

/** P3a 补齐用例的 shim 槽：按需注入（chromeShim 注入 globalThis.chrome，extApiMock 惰性桥实时可见） */
let shim: ChromeShim | undefined

/** OtpListItem 桩：渲染 code prop 供 waitFor 判定 codes 已就绪；未声明 emits，$emit 落父级 attrs 监听器（与真实组件 attrs fallthrough 同径；面板内同径转发 copy/dblclick） */
const OtpListItemStub = {
  name: 'OtpListItemStub',
  props: { code: { type: String, default: '' } },
  template: `<div class="otp-item-stub">{{ code }}</div>`,
}
/** TagFilterRow 桩：透出 selectedIds 供恢复/悬空剔除断言（P4 后渲染在 QuickCodesPanel 内部） */
const TagFilterRowStub = {
  name: 'TagFilterRowStub',
  props: ['tags', 'selectedIds', 'mode'],
  emits: ['update:selectedIds', 'update:mode'],
  template: `<div data-test="tag-filter-stub" />`,
}

async function mountApp(opts?: { otpListItem?: typeof OtpListItemStub; autoFollow?: boolean }) {
  // 默认关跟随拉取 gate：绝大多数用例不测同步，mount 首拉的真实 runner 执行只会产生
  // [cloudAutoSync] 噪音；「跟随拉取」describe 显式传 autoFollow: true 保持被测状态
  settings.syncPrefs.autoFollow = opts?.autoFollow ?? false
  const wrapper = mount(App, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        LockScreen: true,
        EntryForm: true,
        // 面板内 OtpListItem 桩掉：行内容与本测试无关，桩掉后按需换 OtpListItemStub 透出 code
        OtpListItem: opts?.otpListItem ?? true,
        TagFilterRow: TagFilterRowStub,
      },
    },
  })
  await flushPromises()
  active = wrapper // 统一入槽位：文件级 afterEach 兜底卸载，确保无实例跨用例存活
  return wrapper
}

/** 真实导出为 ComputedRef（只读类型）；mock 模块内是可写 ref，测试经断言直写（全文件唯一定义） */
const lockedRef = locked as unknown as Ref<boolean>

/** P3a 用例的活动实例槽位：mountTracked 记录、afterEach 统一卸载——
 *  泄漏实例的 watch(locked) 会在后续用例 afterEach 置 lockedRef=false 时触发跟随拉取噪音 */
let active: VueWrapper | null = null
async function mountTracked(opts?: { otpListItem?: typeof OtpListItemStub }) {
  active = await mountApp(opts)
  return active
}

/** P3a describe 的 afterEach 首步：卸载本用例实例，再恢复全局状态 */
function unmountActive(): void {
  active?.unmount()
  active = null
  settings.syncPrefs.autoFollow = true // 恢复 mountTracked 关掉的 gate（mock settings 默认值）
}

// ==================== P4 Task 3：popup 精简改造 ====================

const VALID_URI = 'otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP'

// 文件级兜底卸载：泄漏实例的 watch(locked) 会在后续用例锁定翻转时集体触发跟随拉取
// （[cloudAutoSync] 连发噪音）。describe 级 afterEach 先执行，此处对剩余实例兜底。
afterEach(() => {
  if (active) {
    active.unmount()
    active = null
  }
  // toast 模块级单例（P3）：清残留防跨用例串扰（fake timers 下 3s 自动过期不触发）
  const { toasts, dismiss } = useToast()
  for (const t of [...toasts.value]) dismiss(t.key)
})

/** 挂载前注入 ?uri= 查询参数（Firefox ext+otpauth 协议回调入口），尾部恢复干净路径 */
function withUriQuery(uri: string | null): void {
  window.history.replaceState({}, '', uri === null ? '/' : `/?uri=${encodeURIComponent(uri)}`)
}

/** 恢复 clipboard 相关全局（clipboard mock/offscreen 注入/settings 开关） */
function resetClipboardEnv(): void {
  settings.clipboardClearEnabled = false
  try {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard
  } catch { /* 不可删则留给下个 defineProperty 覆盖 */ }
}

describe('popup header 精简与主界面入口（P4 Task 3）', () => {
  afterEach(() => {
    unmountActive()
    vault.entries.length = 0
    shim?.restore()
  })

  it('移除项不在：无「添加」按钮、无粘贴 details、无行内 ✎/🗑 管理钮', async () => {
    vault.entries.push({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    const wrapper = await mountTracked()

    expect(wrapper.findAll('button').some((b) => b.text().includes('添加'))).toBe(false)
    expect(wrapper.find('details.otpauth-import').exists()).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text() === '✎')).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text() === '🗑')).toBe(false)
  })

  it('「打开主界面」：tabs.create 打开 options.html#/codes；设置齿轮 → #/settings', async () => {
    shim = installChromeShim()
    const wrapper = await mountTracked()

    const mainBtn = wrapper.findAll('button').find((b) => b.attributes('aria-label') === '打开主界面')
    expect(mainBtn).toBeTruthy()
    await mainBtn!.trigger('click')
    expect(shim!.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://test-id/options.html#/codes' })

    const settingsBtn = wrapper.findAll('button').find((b) => b.attributes('aria-label') === '打开设置')
    expect(settingsBtn).toBeTruthy()
    await settingsBtn!.trigger('click')
    expect(shim!.tabs.create).toHaveBeenLastCalledWith({ url: 'chrome-extension://test-id/options.html#/settings' })
  })
})

describe('popup QuickCodesPanel 装配（P4 Task 3）', () => {
  afterEach(() => {
    unmountActive()
    vault.entries.length = 0
    vault.tags.length = 0
    settings.tagFilterMode = 'all'
    settings.urlFilterEnabled = false // R5-I1 用例翻转过该开关，复位防跨用例泄漏
  })

  it('面板承载搜索/标签行/列表：tagRow/tags/tagMode/loading/entries 透传，query 双向，tag 行贯通', async () => {
    vault.entries.push({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    vault.tags.push({ id: 't1', name: '工作' } as never)
    const wrapper = await mountTracked({ otpListItem: OtpListItemStub })

    const panel = wrapper.findComponent({ name: 'QuickCodesPanel' })
    expect(panel.exists()).toBe(true)
    expect(panel.props('tagRow')).toBe(true)
    expect(panel.props('tags')).toEqual(vault.tags)
    expect(panel.props('tagMode')).toBe('all')
    expect(panel.props('loading')).toBe(false) // loaded 已就绪
    expect(panel.props('entries')).toHaveLength(1)
    // 列表经面板渲染（OtpListItem 桩在面板内部）
    expect(wrapper.find('.otp-item-stub').exists()).toBe(true)
    // tag 行贯通：面板内 TagFilterRow 桩收到宿主选中集合
    expect(wrapper.findComponent({ name: 'TagFilterRowStub' }).props('selectedIds')).toEqual([])

    // query 双向：面板 update:query → 宿主 ref → prop 回流
    await panel.vm.$emit('update:query', 'Git')
    expect(wrapper.findComponent({ name: 'QuickCodesPanel' }).props('query')).toBe('Git')
  })

  it('update:tagMode → setTagMode 落 settings 并 commitSettings（筛选模式持久化）', async () => {
    vault.tags.push({ id: 't1', name: '工作' } as never)
    const wrapper = await mountTracked()
    vi.mocked(commitSettings).mockClear()

    wrapper.findComponent({ name: 'QuickCodesPanel' }).vm.$emit('update:tagMode', 'any')
    await flushPromises()

    expect(settings.tagFilterMode).toBe('any')
    expect(commitSettings).toHaveBeenCalled()
  })

  it('URL 过滤空态语义（R5-I1）：过滤开+站点无匹配 → emptyText 切 noMatch 文案；过滤关/无站点回退引导文案', async () => {
    // 有标签页 URL（http 前缀门槛同宿主过滤判定），库空、无 query、无标签选中——面板内部
    // 两态判定（只看 query/标签）会显示 emptyText，宿主须按 URL 过滤激活态改传 noMatch 文案
    shim = installChromeShim({ tabUrls: ['https://example.com/page'] })
    settings.urlFilterEnabled = true
    let wrapper = await mountTracked()
    expect(wrapper.findComponent({ name: 'QuickCodesPanel' }).props('emptyText')).toBe('无匹配结果')
    unmountActive()

    // 过滤关：回退「暂无条目」引导文案（旧行为）
    settings.urlFilterEnabled = false
    wrapper = await mountTracked()
    expect(wrapper.findComponent({ name: 'QuickCodesPanel' }).props('emptyText')).toBe('暂无条目，点击右上角「打开主界面」录入。')
    unmountActive()

    // 开关开着但读不到标签页 URL（新标签页等）：urlFilterActive=false 无过滤事实，仍是引导文案
    shim.restore()
    shim = installChromeShim({ tabUrls: [] })
    settings.urlFilterEnabled = true
    wrapper = await mountTracked()
    expect(wrapper.findComponent({ name: 'QuickCodesPanel' }).props('emptyText')).toBe('暂无条目，点击右上角「打开主界面」录入。')
  })
})

describe('popup 新建条目 digits 经 toOtpDigits 收口（评审 R1 回归）', () => {
  afterEach(() => {
    unmountActive()
    withUriQuery(null)
  })

  it('新建 yandex 条目：表单提交 digits=8 直传 addEntryOp，不被覆写为 6；pin 原样透传', async () => {
    // P4 后唯一新建入口 = pending 预填确认态：totp URI 预填（carried 与 yandex 表单不同 type → 失效）
    withUriQuery(VALID_URI)
    vi.mocked(addEntryOp).mockClear()
    const wrapper = await mountTracked()
    expect(wrapper.find('entry-form-stub').exists()).toBe(true)

    // 模拟共享 EntryForm submit 的 payload（表单校验已保证 yandex digits=8；pin 仅 yandex 携带）
    wrapper.findComponent({ name: 'EntryForm' }).vm.$emit('save', {
      type: 'yandex',
      issuer: 'Yandex',
      label: 'me',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 8,
      period: 30,
      note: '',
      tagIds: [],
      matchRules: [],
      pin: '1234',
    })
    await flushPromises()

    expect(addEntryOp).toHaveBeenCalledTimes(1)
    const entry = vi.mocked(addEntryOp).mock.calls[0]![0]
    expect(entry.type).toBe('yandex')
    // 此前 create 路径字面量 `steam ? 5 : 6` 把 8 覆写为 6，写路径不校验直接落盘，
    // 下次 loadVault 经 validateVaultObject 整记录拒绝致 vault 不可用
    expect(entry.digits).toBe(8)
    expect(entry.pin).toBe('1234')
  })

  it('新建 totp 条目：URI digits=7 经 toOtpDigits 白名单放行直传，不回落 6', async () => {
    // 同 type 预填 → carried 生效（carried.digits 已在 parseUriToEntryData 内经 toOtpDigits 收口）：
    // 落库取 carried.digits=7 而非字面量 6——白名单放行语义与旧「表单提交 digits=7」用例等价
    withUriQuery('otpauth://totp/Acme:dev?secret=JBSWY3DPEHPK3PXP&digits=7')
    vi.mocked(addEntryOp).mockClear()
    const wrapper = await mountTracked()
    wrapper.findComponent({ name: 'EntryForm' }).vm.$emit('save', {
      type: 'totp',
      issuer: 'GitHub',
      label: 'me',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 7,
      period: 30,
      note: '',
      tagIds: [],
      matchRules: [],
    })
    await flushPromises()

    expect(addEntryOp).toHaveBeenCalledTimes(1)
    const entry = vi.mocked(addEntryOp).mock.calls[0]![0]
    expect(entry.type).toBe('totp')
    expect(entry.digits).toBe(7)
  })
})

describe('popup 双击揭示取消复制后自动关闭（终审 Important-1）', () => {
  it('copy 后双击条目：自动关闭取消，到期不关窗；之后的普通 copy 仍按 popupCloseDelayMs 关窗', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    })
    vault.entries.push({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    try {
      // codes 首算走真实异步 crypto.subtle，须在 fake timers 接管前完成
      const wrapper = await mountApp({ otpListItem: OtpListItemStub })
      await vi.waitFor(() => {
        expect(wrapper.find('.otp-item-stub').text()).not.toBe('------')
      })
      vi.useFakeTimers()

      const item = wrapper.findComponent({ name: 'OtpListItemStub' })
      item.vm.$emit('copy')
      await flushPromises()
      expect(closeSpy).not.toHaveBeenCalled()

      // 双击：取消本次复制后的 3s 自动关闭
      item.vm.$emit('dblclick')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(3000)
      expect(closeSpy).not.toHaveBeenCalled()

      // 对照：未双击的 copy 到期照常关窗
      item.vm.$emit('copy')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(3000)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      closeSpy.mockRestore()
      vault.entries.length = 0
    }
  })
})

describe('popup 双击揭示 vs copy 武装竞态（审查 I-1）', () => {
  it('copy 的 clipboard await 迟于 dblclick 落地：双击序列两次在途 copy 均不武装自动关闭；其后普通 copy 照常关窗', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    // writeText 返回可控 promise：模拟慢剪贴板/IPC——resolve 晚于 dblclick 派发（慢机器可复现时序）
    const resolvers: Array<() => void> = []
    const writeText = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)))
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    vault.entries.push({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    try {
      // codes 首算走真实异步 crypto.subtle，须在 fake timers 接管前完成
      const wrapper = await mountApp({ otpListItem: OtpListItemStub })
      await vi.waitFor(() => {
        expect(wrapper.find('.otp-item-stub').text()).not.toBe('------')
      })
      vi.useFakeTimers()

      const item = wrapper.findComponent({ name: 'OtpListItemStub' })
      // 双击序列 click→click→dblclick：两次 copy 都在 await 上挂起（closeTimer 尚未武装）
      item.vm.$emit('copy')
      item.vm.$emit('copy')
      item.vm.$emit('dblclick') // cancel 到达：此刻 closeTimer 仍为 null，仅 clearTimeout 取消落空
      await flushPromises()
      resolvers.splice(0).forEach((resolve) => resolve()) // await 落地晚于 dblclick：旧实现在此武装 → 到期关窗截断揭示
      await flushPromises()
      await vi.advanceTimersByTimeAsync(3000)
      expect(closeSpy).not.toHaveBeenCalled()

      // 对照：揭示期间的全新普通 copy 到期照常关窗（守卫只作用于 await 期间发生过双击的 copy）
      item.vm.$emit('copy')
      await flushPromises()
      expect(resolvers.length).toBe(1)
      resolvers[0]!()
      await flushPromises()
      await vi.advanceTimersByTimeAsync(3000)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      closeSpy.mockRestore()
      vault.entries.length = 0
    }
  })
})

describe('popup 标签页形态跳过自动关窗（R5-M2，?pending=1 Firefox 回退标签页）', () => {
  it('复制成功后不武装自动关窗：到期不 window.close，「已复制」反馈照常，用户自行关闭标签页', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    })
    withUriQuery(null)
    window.history.replaceState({}, '', '/?pending=1')
    vault.entries.push({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    try {
      const wrapper = await mountApp({ otpListItem: OtpListItemStub })
      await vi.waitFor(() => {
        expect(wrapper.find('.otp-item-stub').text()).not.toBe('------')
      })
      vi.useFakeTimers()

      wrapper.findComponent({ name: 'OtpListItemStub' }).vm.$emit('copy')
      await flushPromises()
      // 「已复制」反馈照常（fake timers 推进前断言：toast 3s 自动过期会被推进掉）
      expect(wrapper.find('.toast:not(.toast--error)').exists()).toBe(true)
      await vi.advanceTimersByTimeAsync(3000)
      expect(closeSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      closeSpy.mockRestore()
      vault.entries.length = 0
      withUriQuery(null)
    }
  })
})

describe('popup 复制失败反馈（真机发现：剪贴板被第三方独占时静默无提示）', () => {
  it('writeText 拒绝：入队 error toast（复制失败文案）不显示「已复制」，且不武装自动关窗', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    const writeText = vi.fn(() => Promise.reject(new DOMException('Denied', 'NotAllowedError')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vault.entries.push({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    try {
      const wrapper = await mountApp({ otpListItem: OtpListItemStub })
      await vi.waitFor(() => {
        expect(wrapper.find('.otp-item-stub').text()).not.toBe('------')
      })
      vi.useFakeTimers()

      const item = wrapper.findComponent({ name: 'OtpListItemStub' })
      item.vm.$emit('copy')
      await flushPromises()
      expect(writeText).toHaveBeenCalledTimes(1)
      // 失败反馈迁全局 toast（P3）：error toast 替代旧错误横幅；横幅区已整体移除
      const errToast = wrapper.find('.toast--error')
      expect(errToast.exists()).toBe(true)
      expect(errToast.text()).toBe('复制失败：剪贴板不可用')
      expect(wrapper.find('.toast:not(.toast--error)').exists()).toBe(false)
      expect(wrapper.find('.copied-banner').exists()).toBe(false)

      // 失败路径不武装自动关窗：横幅停留可供阅读，窗口不自行关闭
      await vi.advanceTimersByTimeAsync(3000)
      expect(closeSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      closeSpy.mockRestore()
      vault.entries.length = 0
    }
  })
})

describe('popup 跟随拉取行为（跨端同步 T2/T3，审查修复）', () => {
  // mock 边界：runner 链止于 storage mock——loadSources 读 'backupSources'（mock 返回 null → 空表），
  // 无真网络；runner 触达的可观察信号 = 读源键 + recordStatus 写 'cloudAutoStatus'（工厂硬编码键）。
  // 零网络断言 = gate 在 runPull 之前拦截，上述两信号均不发生（runner 完全未执行，非异常兜底）
  let active: Awaited<ReturnType<typeof mountApp>> | null = null
  // lockedRef 用模块级唯一定义；backupSecret 未被真实模块顶层解构导出，经 store 成员取
  const backupSecretRef = store.backupSecret as unknown as Ref<string | null>
  beforeEach(() => {
    vi.clearAllMocks() // 清调用记录（mockClear 语义：get/set 实现保留）
    // 先置锁定：本文档之前的用例组件未卸载，其解锁 watcher 会在下方 true→false 边沿触发——
    // 锁定态下 gate 必拦，残留触发零副作用；各用例体再自行解锁到目标态（被测状态）
    lockedRef.value = true
    settings.syncPrefs.autoFollow = true
    backupSecretRef.value = null
  })
  afterEach(async () => {
    // 卸载即 stop：反注册本用例组件的解锁 watcher——否则前序组件残留的 watch(locked) 会在
    // 下个用例 beforeEach 置回 locked=false 的边沿上触发跟随拉取（真实生命周期卫生的镜像：
    // popup 卸载时 onScopeDispose → syncFollow.stop 正是防在途钩子）
    active?.unmount()
    active = null
    await flushPromises()
  })

  it('解锁且开关开：打开后跟随拉取一次——runner 读源键并记录状态（ok=null 空表跳过，真实编排终点）', async () => {
    lockedRef.value = false // 解锁到目标态（边沿触发的残留 watcher 经 gate 后行为与被测一致）
    backupSecretRef.value = 'pw' // 会话口令在位（解锁语义），拉取链走通到网络边界
    active = await mountApp({ autoFollow: true })
    await vi.waitFor(() => expect(storageAdapter.get).toHaveBeenCalledWith(SOURCES_KEY))
    await vi.waitFor(() => expect(storageAdapter.set).toHaveBeenCalledWith('cloudAutoStatus', expect.any(String)))
    const record = vi.mocked(storageAdapter.set).mock.calls.find((c) => c[0] === 'cloudAutoStatus')
    expect((JSON.parse(record![1] as string) as { ok: unknown }).ok).toBe(null)
  })

  it('锁定态：gate 拦截——零网络（不读源键、不写状态）', async () => {
    backupSecretRef.value = 'pw' // 保持 beforeEach 的锁定态：gate 因锁定拦截，与口令无关
    active = await mountApp({ autoFollow: true })
    await flushPromises() // 补一拍：确证是「未触发」而非「未及执行」
    expect(storageAdapter.get).not.toHaveBeenCalledWith(SOURCES_KEY)
    expect(storageAdapter.set).not.toHaveBeenCalledWith('cloudAutoStatus', expect.anything())
  })

  it('autoFollow=false：gate 拦截——零网络，同锁定态', async () => {
    lockedRef.value = false // 解锁态下仅关开关：证明拦截来自 autoFollow 而非锁定
    settings.syncPrefs.autoFollow = false
    backupSecretRef.value = 'pw'
    active = await mountApp() // 被测状态即关开关：不传 autoFollow: true
    await flushPromises()
    expect(storageAdapter.get).not.toHaveBeenCalledWith(SOURCES_KEY)
    expect(storageAdapter.set).not.toHaveBeenCalledWith('cloudAutoStatus', expect.anything())
  })

  it('真实时序（终审 Critical-1/Important-2）：mount 时刻口令未装载，initStore 完成后首拉才触达 runner', async () => {
    // session DEK 恢复路径的真实形态：locked 恒 false（无 true→false 边沿，watch 钩子不可依赖），
    // backupSecret 仅在 initStore → applyDekAndUnlock 装载后才非 null——旧实现 mount 即 syncNow
    // 必在 secret=null 下走 runner noSecret 早退 recordStatus(null) 写伪状态且永不重拉。
    // 本文件有历史挂载组件的解锁边沿噪音，精确时序断言在独立文件 popupSyncTiming.test.ts 承载；
    // 此处仅验证核心信号：initStore 后 runner 越过 noSecret 早退走到 loadSources（读源键）
    lockedRef.value = false
    backupSecretRef.value = null
    vi.mocked(initStore).mockImplementation(async () => {
      backupSecretRef.value = 'pw' // initStore 完成时点口令就位（保管区装载语义）
    })
    try {
      active = await mountApp({ autoFollow: true })
      await vi.waitFor(() => expect(storageAdapter.get).toHaveBeenCalledWith(SOURCES_KEY))
      await vi.waitFor(() => expect(storageAdapter.set).toHaveBeenCalledWith('cloudAutoStatus', expect.anything()))
    } finally {
      // 恢复默认空实现：clearAllMocks 不清 implementation，防 side-effect 泄漏到后续用例
      vi.mocked(initStore).mockImplementation(async () => {})
    }
  })

  it('锁定态打开：initStore 后首拉被 gate 拦（零写盘），解锁边沿钩子承接拉取', async () => {
    backupSecretRef.value = 'pw' // 保持 beforeEach 锁定态；口令在位（解锁语义）
    active = await mountApp({ autoFollow: true })
    await flushPromises()
    // initStore 后首拉在锁定态被 gate 拦截：gate 先于 runner，零网络零写盘（Important-2 锁定分支）
    expect(storageAdapter.get).not.toHaveBeenCalledWith(SOURCES_KEY)
    expect(storageAdapter.set).not.toHaveBeenCalledWith('cloudAutoStatus', expect.anything())
    // 用户输口令解锁 → true→false 边沿 → start 注册的钩子承接拉取（锁定用户路径可达）
    lockedRef.value = false
    await vi.waitFor(() => expect(storageAdapter.get).toHaveBeenCalledWith(SOURCES_KEY))
    await vi.waitFor(() => expect(storageAdapter.set).toHaveBeenCalledWith('cloudAutoStatus', expect.anything()))
  })
})

// ==================== P3a 补齐（盘点 B3-11~17，P4 Task 3 按精简形态保留）====================

describe('popup otpauth 导入入口（B3-13：?uri= 优先、pendingOtpauth 读取即清；P4 后为唯一新建入口）', () => {
  afterEach(() => {
    unmountActive()
    withUriQuery(null)
    shim?.restore()
    vi.mocked(addEntryOp).mockClear()
  })

  it('?uri= 协议回调优先消费：合法 URI → EntryForm 预填确认态，不读 pendingOtpauth', async () => {
    withUriQuery('otpauth://totp/Acme:dev?secret=JBSWY3DPEHPK3PXP')
    const wrapper = await mountTracked()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    const initial = wrapper.findComponent({ name: 'EntryForm' }).props('initial') as { issuer?: string } | null
    expect(initial).toMatchObject({ issuer: 'Acme' })
    expect(wrapper.find('.error').exists()).toBe(false)
  })

  it('?uri= 非法 URI：importError 常显，不渲染预填表单', async () => {
    withUriQuery('notauri')
    const wrapper = await mountTracked()

    const err = wrapper.find('.error')
    expect(err.exists()).toBe(true)
    expect(err.text()).not.toBe('')
    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
  })

  it('无 ?uri= 时读 pendingOtpauth（Chrome 右键菜单写入）：合法→预填确认态，读取即 remove，save 落库', async () => {
    shim = installChromeShim({ local: { pendingOtpauth: VALID_URI } })
    const wrapper = await mountTracked()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    const initial = wrapper.findComponent({ name: 'EntryForm' }).props('initial') as { issuer?: string } | null
    expect(initial).toMatchObject({ issuer: 'GitHub' })
    expect(shim.local.data['pendingOtpauth']).toBeUndefined() // 读取即清除
    expect(shim.local.calls.remove).toBe(1)

    // 确认态落库（P4 Task 3 加强）：确认表单 save → 新建分支落库 → 关表单回列表
    wrapper.findComponent({ name: 'EntryForm' }).vm.$emit('save', {
      type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, note: '', tagIds: [], matchRules: [],
    })
    await flushPromises()
    expect(addEntryOp).toHaveBeenCalledTimes(1)
    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
  })

  it('pendingOtpauth 非法字符串：importError 报错，但同样消费即清（不残留重弹）', async () => {
    shim = installChromeShim({ local: { pendingOtpauth: 'junk-uri' } })
    const wrapper = await mountTracked()

    expect(wrapper.find('.error').exists()).toBe(true)
    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
  })
})

describe('popup pending 信封分派（P5 Task 2：kind=uri|pasted；上方裸 URI 用例即旧格式兼容回归）', () => {
  // SteamGuard 明文 JSON 夹具（口径同 core importPaste.test：20 字节 shared_secret = Steam 真实长度）
  const SHARED_SECRET_FF_B64 = btoa(String.fromCharCode(...new Uint8Array(20).fill(0xff)))
  const SG_JSON = JSON.stringify({
    shared_secret: SHARED_SECRET_FF_B64,
    serial_number: '12345678901',
    steamid: '76561190000000000',
  })

  afterEach(() => {
    unmountActive()
    withUriQuery(null)
    shim?.restore()
  })

  it('kind=uri 信封：text 为 otpauth URI → URI 预填确认态，读取即清除', async () => {
    shim = installChromeShim({
      local: {
        pendingOtpauth: encodePending({ v: 1, kind: 'uri', text: 'otpauth://totp/Acme:dev?secret=JBSWY3DPEHPK3PXP' }),
      },
    })
    const wrapper = await mountTracked()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    const initial = wrapper.findComponent({ name: 'EntryForm' }).props('initial') as { issuer?: string } | null
    expect(initial).toMatchObject({ issuer: 'Acme' })
    expect(wrapper.find('.error').exists()).toBe(false)
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
    expect(shim.local.calls.remove).toBe(1)
  })

  it('kind=pasted 信封：单条 SteamGuard JSON → 复解进确认态 issuer=Steam（type/digits steam 收口、note 保真），读取即清除', async () => {
    shim = installChromeShim({ local: { pendingOtpauth: encodePending({ v: 1, kind: 'pasted', text: SG_JSON }) } })
    const wrapper = await mountTracked()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    const initial = wrapper.findComponent({ name: 'EntryForm' }).props('initial') as Record<string, unknown> | null
    expect(initial).toMatchObject({ type: 'steam', issuer: 'Steam', digits: 5, note: '12345678901' })
    // 哑值预填（uuid 空串）按新建处理：EntryForm isNew 语义（按钮「添加」），保存时宿主覆盖
    expect(initial?.uuid).toBe('')
    expect(wrapper.find('.error').exists()).toBe(false)
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
    expect(shim.local.calls.remove).toBe(1)
  })

  it('kind=pasted 信封但文本不可解析（旧盘残留/竞态兜底）：importError 透传嗅探文案，不渲染表单', async () => {
    shim = installChromeShim({ local: { pendingOtpauth: encodePending({ v: 1, kind: 'pasted', text: 'plain junk' }) } })
    const wrapper = await mountTracked()

    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
    expect(wrapper.find('.error').text()).toBe('无法识别粘贴内容格式')
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
  })

  it('带 ts 未过期信封（R5-I3）：消费成功进确认态，读取即清除', async () => {
    shim = installChromeShim({
      local: { pendingOtpauth: encodePending({ v: 1, kind: 'uri', text: 'otpauth://totp/Acme:dev?secret=JBSWY3DPEHPK3PXP' }) },
    })
    const wrapper = await mountTracked()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    expect(wrapper.find('.error').exists()).toBe(false)
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
  })

  it('带 ts 过期信封（R5-I3）：删除 + 提示重新右键添加，不渲染表单', async () => {
    const expired = JSON.stringify({
      v: 1, kind: 'pasted', text: SG_JSON, ts: Date.now() - (10 * 60 * 1000) - 1, // 超过 PENDING_TTL_MS 1ms
    })
    shim = installChromeShim({ local: { pendingOtpauth: expired } })
    const wrapper = await mountTracked()

    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
    expect(wrapper.find('.error').text()).toBe('添加请求已过期，请重新右键添加')
    // 信封已删除（raw 读取即 remove 路径覆盖过期分支），不残留重弹
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
    expect(shim.local.calls.remove).toBe(1)
  })

  it('无 ts 旧信封（R5-I3 升级兼容）：不过期，正常消费', async () => {
    shim = installChromeShim({
      local: { pendingOtpauth: JSON.stringify({ v: 1, kind: 'uri', text: 'otpauth://totp/Acme:dev?secret=JBSWY3DPEHPK3PXP' }) },
    })
    const wrapper = await mountTracked()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    expect(wrapper.find('.error').exists()).toBe(false)
  })

  it('运行中收到新信封（R5-M4）：storage.onChanged 触发消费 → 预填确认态，读取即清除', async () => {
    shim = installChromeShim()
    const wrapper = await mountTracked()
    expect(wrapper.find('entry-form-stub').exists()).toBe(false)

    const fresh = encodePending({ v: 1, kind: 'uri', text: 'otpauth://totp/Acme:dev?secret=JBSWY3DPEHPK3PXP' })
    shim.local.data['pendingOtpauth'] = fresh
    shim.emit({ pendingOtpauth: { newValue: fresh } }, 'local')
    await flushPromises()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    const initial = wrapper.findComponent({ name: 'EntryForm' }).props('initial') as { issuer?: string } | null
    expect(initial).toMatchObject({ issuer: 'Acme' })
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
    expect(shim.local.calls.remove).toBe(1)
  })

  it('onChanged 防重入（R5-M4）：remove 自写回声读到空信封 no-op；非 pending 键变更不触发读盘', async () => {
    shim = installChromeShim()
    const wrapper = await mountTracked()

    // 消费触发的 remove 自写回声（仅 oldValue 无 newValue）：listener 触发但读到空信封 no-op
    shim.emit({ pendingOtpauth: { oldValue: 'x' } }, 'local')
    await flushPromises()
    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
    expect(wrapper.find('.error').exists()).toBe(false)
    const getsAfterEcho = shim.local.calls.get

    // 非 pending 键的 local 变更：listener 直接短路，不读盘
    shim.emit({ vault: { newValue: 'y' } }, 'local')
    await flushPromises()
    expect(shim.local.calls.get).toBe(getsAfterEcho)
  })
})

describe('popup 复制行为补齐（B3-15/16：HOTP 递增、清剪贴板三重门控）', () => {
  const totpEntry = {
    uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
  }

  afterEach(() => {
    unmountActive()
    vault.entries.length = 0
    shim?.restore()
    resetClipboardEnv()
    vi.useRealTimers()
  })

  async function mountTotpReady() {
    vault.entries.push(totpEntry as never)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true })
    const wrapper = await mountTracked({ otpListItem: OtpListItemStub })
    await vi.waitFor(() => {
      expect(wrapper.find('.otp-item-stub').text()).not.toBe('------')
    })
    return wrapper
  }

  it('HOTP 复制：复制旧 counter 的码后递增 counter（RFC 语义）', async () => {
    vault.entries.push({
      uuid: 'e-h', type: 'hotp', issuer: 'H', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, counter: 2, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true })
    vi.mocked(updateEntryOp).mockClear()
    const wrapper = await mountTracked({ otpListItem: OtpListItemStub })
    await vi.waitFor(() => {
      expect(wrapper.find('.otp-item-stub').text()).not.toBe('------')
    })
    vi.useFakeTimers()

    wrapper.findComponent({ name: 'OtpListItemStub' }).vm.$emit('copy')
    await flushPromises()

    expect(updateEntryOp).toHaveBeenCalledWith('e-h', { counter: 3 })
    // 成功反馈迁全局 toast（P3）：ToastHost 真渲染，断言 success toast DOM
    expect(wrapper.find('.toast:not(.toast--error)').exists()).toBe(true)
  })

  it('清剪贴板三重门控：开关关不发；canOffscreen false 不发；两者齐备才发 delayMs 消息', async () => {
    shim = installChromeShim()
    const wrapper = await mountTotpReady()
    vi.useFakeTimers()
    const sendSpy = vi.spyOn(
      shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> },
      'sendMessage',
    )
    const item = wrapper.findComponent({ name: 'OtpListItemStub' })

    // 门 1：开关关（默认设置）
    item.vm.$emit('copy')
    await flushPromises()
    expect(sendSpy).not.toHaveBeenCalled()

    // 门 2：开关开但无 offscreen API（Firefox 形态——shim 未注入 offscreen）
    settings.clipboardClearEnabled = true
    item.vm.$emit('copy')
    await flushPromises()
    expect(sendSpy).not.toHaveBeenCalled()

    // 三门齐备：发 schedule-clipboard-clear（CLIPBOARD_CLEAR_DELAY_MS=30s）
    shim.chrome.offscreen = {}
    item.vm.$emit('copy')
    await flushPromises()
    expect(sendSpy).toHaveBeenCalledWith({ type: 'schedule-clipboard-clear', delayMs: 30_000 })
  })
})

describe('popup URI 导入 carried 透传（B3-16）', () => {
  afterEach(() => {
    unmountActive()
    vault.entries.length = 0
    shim?.restore()
    withUriQuery(null)
  })

  it('URI 导入预填同 type：carried 透传 algorithm/digits/period/counter（hotp counter 保留）', async () => {
    withUriQuery('otpauth://hotp/Acme:dev?secret=JBSWY3DPEHPK3PXP&counter=5&digits=7')
    vi.mocked(addEntryOp).mockClear()
    const wrapper = await mountTracked()
    expect(wrapper.find('entry-form-stub').exists()).toBe(true)

    wrapper.findComponent({ name: 'EntryForm' }).vm.$emit('save', {
      type: 'hotp', issuer: 'Acme', label: 'dev', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 7, period: 30, note: '', tagIds: [], matchRules: [],
    })
    await flushPromises()

    const entry = vi.mocked(addEntryOp).mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(entry.type).toBe('hotp')
    expect(entry.counter).toBe(5) // carried.counter（同 type 透传）
    expect(entry.digits).toBe(7) // carried.digits
    expect(entry.algorithm).toBe('SHA1')
    expect(entry.period).toBe(30)
  })

  it('URI 导入 type 变更（hotp→totp）：carried 失效，counter 不透传，digits 按表单收口', async () => {
    withUriQuery('otpauth://hotp/Acme:dev?secret=JBSWY3DPEHPK3PXP&counter=5')
    vi.mocked(addEntryOp).mockClear()
    const wrapper = await mountTracked()

    wrapper.findComponent({ name: 'EntryForm' }).vm.$emit('save', {
      type: 'totp', issuer: 'Acme', label: 'dev', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 45, note: '', tagIds: [], matchRules: [],
    })
    await flushPromises()

    const entry = vi.mocked(addEntryOp).mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(entry.type).toBe('totp')
    expect(entry.counter).toBeUndefined() // carried=null：hotp counter 不带
    expect(entry.digits).toBe(6)
    // B11 修复：carried=null 时 period 取表单提交值，不再被 30 覆盖
    expect(entry.period).toBe(45)
  })
})

describe('popup 锁定态与标签筛选恢复（B3-11/14）', () => {
  afterEach(() => {
    unmountActive() // 先卸载：泄漏实例会在下方 lockedRef=false 翻转时触发跟随拉取
    vault.tags.length = 0
    settings.rememberTagFilter = false
    settings.lastTagFilterIds = []
    lockedRef.value = false
  })

  it('锁定态：渲染 LockScreen 且 allowPasskey=false（popup 无 WebAuthn 入口）', async () => {
    lockedRef.value = true
    const wrapper = await mountTracked()
    expect(wrapper.find('lock-screen-stub').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'LockScreen' }).props('allowPasskey')).toBe(false)
    expect(wrapper.find('main').exists()).toBe(false)
  })

  it('rememberTagFilter 恢复：悬空 id 剔除、有效选中恢复并透传面板内 TagFilterRow', async () => {
    settings.rememberTagFilter = true
    settings.lastTagFilterIds = ['t1', 'gone']
    vault.tags.push({ id: 't1', name: '工作' }, { id: 't2', name: '个人' } as never)

    const wrapper = await mountTracked()
    const stub = wrapper.findComponent({ name: 'TagFilterRowStub' })
    expect(stub.props('selectedIds')).toEqual(['t1']) // gone 已被悬空剔除
  })

  it('rememberTagFilter 关闭：不恢复持久化选中（空集合）', async () => {
    settings.rememberTagFilter = false
    settings.lastTagFilterIds = ['t1']
    vault.tags.push({ id: 't1', name: '工作' } as never)

    const wrapper = await mountTracked()
    expect(wrapper.findComponent({ name: 'TagFilterRowStub' }).props('selectedIds')).toEqual([])
  })
})

describe('popup App entryIcons 全量 ready 依赖（2026-10-05 full-icons Task 9）', () => {
  it('fullIconsReady 翻转后 EntryForm 的 icons prop 重算产出新对象（非精选 builtin 补渲染触发）', async () => {
    const { fullIconsReady } = await import('@totp/ui')
    withUriQuery(VALID_URI) // P4 后唯一新建入口：预填确认态挂出 EntryForm
    const wrapper = await mountTracked()
    const form = wrapper.findComponent({ name: 'EntryForm' })
    expect(form.exists()).toBe(true)
    const before = form.props('icons') as Record<string, unknown>
    fullIconsReady.value = true
    await nextTick()
    // getBuiltinIcons 返回活引用，内容断言无法区分是否重算；同一性变化才能证明 ready 已被依赖追踪
    expect(form.props('icons')).not.toBe(before)
    fullIconsReady.value = false // 模块级单例复位，不污染其他用例
  })
})
