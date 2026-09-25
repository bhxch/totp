/**
 * popup App.vue 新建表单双 Tab（Task 14c）组件级单测：
 * - 仅 creating 显「手动填写/智能粘贴」Tab；默认手动；切智能粘贴渲染 BatchPastePanel
 * - 粘贴落库（added）→ 关表单回列表；再次新建回到默认手动 Tab
 * - 编辑态不显 Tab（保持原纯手动表单）
 * - 评审 R1 回归：新建 yandex 条目 digits=8 经 toOtpDigits 收口直传 addEntryOp，不被覆写为 6
 * store 模块整体 mock：真实模块 import 期即建 chrome 侧 store 单例（src/store.ts 顶层
 * createExtensionStore），node/jsdom 测试环境不可用；组件树其余走真实实现。
 */
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { addEntryOp, initStore, locked, removeEntryOp, settings, storageAdapter, store, updateEntryOp, vault } from '../src/store'
import { SOURCES_KEY } from '@totp/core'

/** P3a 补齐用例的 shim 槽：按需注入（chromeShim 注入 globalThis.chrome，extApiMock 惰性桥实时可见） */
let shim: ChromeShim | undefined

/** BatchPastePanel 桩：保留 added 事件发射能力（点内嵌按钮触发），data-test 判定渲染 */
const BatchPastePanelStub = {
  name: 'BatchPastePanelStub',
  props: { store: { type: null, required: false } },
  emits: ['added'],
  template: `<div data-test="batch-paste-stub"><button data-test="batch-added-btn" @click="$emit('added', 1)">x</button></div>`,
}

/** OtpListItem 桩：渲染 code prop 供 waitFor 判定 codes 已就绪；未声明 emits，$emit 落父级 attrs 监听器（与真实组件 attrs fallthrough 同径） */
const OtpListItemStub = {
  name: 'OtpListItemStub',
  props: { code: { type: String, default: '' } },
  template: `<div class="otp-item-stub">{{ code }}</div>`,
}

/** MdMenu 桩（P3a 右键菜单用例）：open 时渲染 slot 内菜单项，省去真实组件的定位/Teleport 复杂度 */
const MdMenuStub = {
  name: 'MdMenuStub',
  props: ['open', 'x', 'y', 'triggerEl'],
  template: `<div v-if="open" data-test="ctx-menu"><slot /></div>`,
}
/** OtpQrDialog 桩：open 时渲染 entry 标识 */
const OtpQrDialogStub = {
  name: 'OtpQrDialogStub',
  props: ['open', 'entry'],
  template: `<div v-if="open" data-test="qr-dialog">{{ entry?.issuer }}</div>`,
}
/** TagFilterRow 桩：透出 selectedIds 供恢复/悬空剔除断言 */
const TagFilterRowStub = {
  name: 'TagFilterRowStub',
  props: ['tags', 'selectedIds', 'mode'],
  emits: ['update:selectedIds', 'update:mode'],
  template: `<div data-test="tag-filter-stub" />`,
}

async function mountApp(opts?: { otpListItem?: typeof OtpListItemStub }) {
  const wrapper = mount(App, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        LockScreen: true,
        EntryForm: true,
        BatchPastePanel: BatchPastePanelStub,
        // 编辑态用例需要 item-wrap 渲染出 ✎ 按钮；行内容与本测试无关，桩掉
        OtpListItem: opts?.otpListItem ?? true,
        MdMenu: MdMenuStub,
        OtpQrDialog: OtpQrDialogStub,
        TagFilterRow: TagFilterRowStub,
      },
    },
  })
  await flushPromises()
  return wrapper
}

const findAddButton = (w: Awaited<ReturnType<typeof mountApp>>) =>
  w.findAll('button').find((b) => b.text().includes('添加'))!

describe('popup App 新建表单双 Tab（14c）', () => {
  it('新建状态切「智能粘贴」后渲染 BatchPastePanel，added 关表单回列表；再次新建回默认手动', async () => {
    const wrapper = await mountApp()

    // 列表态：无 Tab、无表单
    expect(wrapper.find('.md-seg').exists()).toBe(false)

    // 进入新建：默认「手动填写」→ EntryForm 渲染，粘贴面板不渲染
    await findAddButton(wrapper).trigger('click')
    expect(wrapper.find('.md-seg').exists()).toBe(true)
    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    expect(wrapper.find('[data-test="batch-paste-stub"]').exists()).toBe(false)

    // 切「智能粘贴」：EntryForm 卸载，BatchPastePanel 渲染（本任务核心断言）
    const pasteTab = wrapper.findAll('button').find((b) => b.text() === '智能粘贴')!
    expect(pasteTab).toBeTruthy()
    await pasteTab.trigger('click')
    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
    expect(wrapper.find('[data-test="batch-paste-stub"]').exists()).toBe(true)

    // 粘贴落库（added）→ 关表单回列表：Tab 与面板全部消失
    await wrapper.find('[data-test="batch-added-btn"]').trigger('click')
    expect(wrapper.find('.md-seg').exists()).toBe(false)
    expect(wrapper.find('[data-test="batch-paste-stub"]').exists()).toBe(false)

    // 再次新建：回到默认「手动填写」（Tab 状态复位）
    await findAddButton(wrapper).trigger('click')
    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    expect(wrapper.find('[data-test="batch-paste-stub"]').exists()).toBe(false)
  })

  it('智能粘贴 Tab 激活时经粘贴框导入 URI 预填：Tab 切回「手动填写」', async () => {
    const wrapper = await mountApp()
    await findAddButton(wrapper).trigger('click')
    const pasteTab = wrapper.findAll('button').find((b) => b.text() === '智能粘贴')!
    await pasteTab.trigger('click')
    expect(wrapper.find('[data-test="batch-paste-stub"]').exists()).toBe(true)

    // creating 已 true：creating watch 不触发——预填必须显式切回手动 Tab，否则被粘贴面板挡住
    await wrapper.find('.otpauth-import textarea').setValue(
      'otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    )
    await wrapper.findAll('button').find((b) => b.text() === '导入')!.trigger('click')
    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    expect(wrapper.find('[data-test="batch-paste-stub"]').exists()).toBe(false)
  })

  it('编辑态不显 Tab：直接渲染 EntryForm（原语义不变）', async () => {
    vault.entries.push({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    try {
      const wrapper = await mountApp()
      const editBtn = wrapper.findAll('button').find((b) => b.text() === '✎')!
      expect(editBtn).toBeTruthy()
      await editBtn.trigger('click')
      expect(wrapper.find('.md-seg').exists()).toBe(false)
      expect(wrapper.find('entry-form-stub').exists()).toBe(true)
      expect(wrapper.find('[data-test="batch-paste-stub"]').exists()).toBe(false)
    } finally {
      vault.entries.length = 0
    }
  })
})

describe('popup 新建条目 digits 经 toOtpDigits 收口（评审 R1 回归）', () => {
  it('新建 yandex 条目：表单提交 digits=8 直传 addEntryOp，不被覆写为 6；pin 原样透传', async () => {
    vi.mocked(addEntryOp).mockClear()
    const wrapper = await mountApp()
    await findAddButton(wrapper).trigger('click')
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

  it('新建 totp 条目：表单提交 digits=7 经 toOtpDigits 白名单放行，不回落 6', async () => {
    vi.mocked(addEntryOp).mockClear()
    const wrapper = await mountApp()
    await findAddButton(wrapper).trigger('click')
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

describe('popup 复制失败反馈（真机发现：剪贴板被第三方独占时静默无提示）', () => {
  it('writeText 拒绝：显示错误横幅（role=alert）不显示「已复制」，且不武装自动关窗', async () => {
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
      expect(wrapper.find('.copied-banner--error').exists()).toBe(true)
      expect(wrapper.find('.copied-banner--error').attributes('role')).toBe('alert')
      expect(wrapper.find('.copied-banner:not(.copied-banner--error)').exists()).toBe(false)

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
  // 真实 store 导出的 locked 是 ComputedRef（只读类型）；mock 模块内是可写 ref，测试经断言直写。
  // backupSecret 未被真实模块顶层解构导出，经 store 成员取（mock 与真实同为 ComputedRef 形状）
  const lockedRef = locked as unknown as Ref<boolean>
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
    active = await mountApp()
    await vi.waitFor(() => expect(storageAdapter.get).toHaveBeenCalledWith(SOURCES_KEY))
    await vi.waitFor(() => expect(storageAdapter.set).toHaveBeenCalledWith('cloudAutoStatus', expect.any(String)))
    const record = vi.mocked(storageAdapter.set).mock.calls.find((c) => c[0] === 'cloudAutoStatus')
    expect((JSON.parse(record![1] as string) as { ok: unknown }).ok).toBe(null)
  })

  it('锁定态：gate 拦截——零网络（不读源键、不写状态）', async () => {
    backupSecretRef.value = 'pw' // 保持 beforeEach 的锁定态：gate 因锁定拦截，与口令无关
    active = await mountApp()
    await flushPromises() // 补一拍：确证是「未触发」而非「未及执行」
    expect(storageAdapter.get).not.toHaveBeenCalledWith(SOURCES_KEY)
    expect(storageAdapter.set).not.toHaveBeenCalledWith('cloudAutoStatus', expect.anything())
  })

  it('autoFollow=false：gate 拦截——零网络，同锁定态', async () => {
    lockedRef.value = false // 解锁态下仅关开关：证明拦截来自 autoFollow 而非锁定
    settings.syncPrefs.autoFollow = false
    backupSecretRef.value = 'pw'
    active = await mountApp()
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
      active = await mountApp()
      await vi.waitFor(() => expect(storageAdapter.get).toHaveBeenCalledWith(SOURCES_KEY))
      await vi.waitFor(() => expect(storageAdapter.set).toHaveBeenCalledWith('cloudAutoStatus', expect.anything()))
    } finally {
      // 恢复默认空实现：clearAllMocks 不清 implementation，防 side-effect 泄漏到后续用例
      vi.mocked(initStore).mockImplementation(async () => {})
    }
  })

  it('锁定态打开：initStore 后首拉被 gate 拦（零写盘），解锁边沿钩子承接拉取', async () => {
    backupSecretRef.value = 'pw' // 保持 beforeEach 锁定态；口令在位（解锁语义）
    active = await mountApp()
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

// ==================== P3a 补齐（盘点 B3-11~17）====================

const VALID_URI = 'otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP'
const lockedRef = locked as unknown as Ref<boolean>

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

describe('popup otpauth 导入入口（B3-13：?uri= 优先、pendingOtpauth 读取即清）', () => {
  afterEach(() => {
    withUriQuery(null)
    shim?.restore()
  })

  it('?uri= 协议回调优先消费：合法 URI → EntryForm 预填，不读 pendingOtpauth', async () => {
    withUriQuery('otpauth://totp/Acme:dev?secret=JBSWY3DPEHPK3PXP')
    const wrapper = await mountApp()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    const initial = wrapper.findComponent({ name: 'EntryForm' }).props('initial') as { issuer?: string } | null
    expect(initial).toMatchObject({ issuer: 'Acme' })
    expect(wrapper.find('.error').exists()).toBe(false)
  })

  it('?uri= 非法 URI：importError 常显（details 折叠时也在），不渲染预填表单', async () => {
    withUriQuery('notauri')
    const wrapper = await mountApp()

    const err = wrapper.find('.error')
    expect(err.exists()).toBe(true)
    expect(err.text()).not.toBe('')
    // 错误置于 details 外：details 保持折叠仍可见（本次直接断言 details 无 open 属性）
    expect(wrapper.find('details.otpauth-import').attributes('open')).toBeUndefined()
    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
  })

  it('无 ?uri= 时读 pendingOtpauth（Chrome 右键菜单写入）：合法→预填，读取即 remove', async () => {
    shim = installChromeShim({ local: { pendingOtpauth: VALID_URI } })
    const wrapper = await mountApp()

    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    const initial = wrapper.findComponent({ name: 'EntryForm' }).props('initial') as { issuer?: string } | null
    expect(initial).toMatchObject({ issuer: 'GitHub' })
    expect(shim.local.data['pendingOtpauth']).toBeUndefined() // 读取即清除
    expect(shim.local.calls.remove).toBe(1)
  })

  it('pendingOtpauth 非法字符串：importError 报错，但同样消费即清（不残留重弹）', async () => {
    shim = installChromeShim({ local: { pendingOtpauth: 'junk-uri' } })
    const wrapper = await mountApp()

    expect(wrapper.find('.error').exists()).toBe(true)
    expect(wrapper.find('entry-form-stub').exists()).toBe(false)
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
  })
})

describe('popup 右键菜单四项（B3-17：编辑/显示二维码/复制 URI/置顶）', () => {
  const yandexEntry = {
    uuid: 'e-y', type: 'yandex', issuer: 'Yandex', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 8, period: 30, pin: '1234', tagIds: [], order: 0, createdAt: 0,
  }

  async function mountWithEntryAndOpenMenu(entry: Record<string, unknown>) {
    vault.entries.push(entry as never)
    const wrapper = await mountApp({ otpListItem: OtpListItemStub })
    wrapper
      .findComponent({ name: 'OtpListItemStub' })
      .vm.$emit('context', { clientX: 10, clientY: 20, currentTarget: null })
    await flushPromises()
    return wrapper
  }

  afterEach(() => {
    vault.entries.length = 0
    shim?.restore()
    resetClipboardEnv()
  })

  it('菜单打开渲染四项；「编辑」→ 编辑态 EntryForm 并收起菜单', async () => {
    const wrapper = await mountWithEntryAndOpenMenu({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    })
    const items = wrapper.findAll('[data-test="ctx-menu"] .ctx-item')
    expect(items).toHaveLength(4)
    expect(items[0]!.text()).toBe('编辑')
    expect(items[3]!.text()).toBe('置顶')

    await items[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('entry-form-stub').exists()).toBe(true)
    expect(wrapper.find('[data-test="ctx-menu"]').exists()).toBe(false)
  })

  it('「显示二维码」：OtpQrDialog 打开并携带该条目', async () => {
    const wrapper = await mountWithEntryAndOpenMenu(yandexEntry)
    await wrapper.findAll('[data-test="ctx-menu"] .ctx-item')[1]!.trigger('click')
    await flushPromises()

    const dialog = wrapper.find('[data-test="qr-dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('Yandex')
  })

  it('「复制 URI」：yandex 条目经 buildOtpUri 产出 yaotp host + pin（I1d），成功出已复制横幅', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = await mountWithEntryAndOpenMenu(yandexEntry)

    await wrapper.findAll('[data-test="ctx-menu"] .ctx-item')[2]!.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    const uri = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(uri).toContain('otpauth://yaotp/')
    expect(uri).toContain('pin=1234')
    expect(wrapper.find('.copied-banner:not(.copied-banner--error)').exists()).toBe(true)
  })

  it('「置顶」切换：未置顶 → updateEntryOp(uuid,{pinned:true})；已置顶文案为「取消置顶」', async () => {
    vi.mocked(updateEntryOp).mockClear()
    const wrapper = await mountWithEntryAndOpenMenu(yandexEntry)
    const items = wrapper.findAll('[data-test="ctx-menu"] .ctx-item')
    await items[3]!.trigger('click')
    await flushPromises()
    expect(updateEntryOp).toHaveBeenCalledWith('e-y', { pinned: true })
    expect(wrapper.find('[data-test="ctx-menu"]').exists()).toBe(false)

    // 已置顶条目：mock 不回写 vault，手动置位（contextMenu.entry 与 vault 同引用）——
    // 菜单文案切换为「取消置顶」，点击撤销
    ;(yandexEntry as { pinned?: boolean }).pinned = true
    vi.mocked(updateEntryOp).mockClear()
    wrapper.findComponent({ name: 'OtpListItemStub' }).vm.$emit('context', { clientX: 1, clientY: 1, currentTarget: null })
    await flushPromises()
    const items2 = wrapper.findAll('[data-test="ctx-menu"] .ctx-item')
    expect(items2[3]!.text()).toBe('取消置顶')
    await items2[3]!.trigger('click')
    await flushPromises()
    expect(updateEntryOp).toHaveBeenCalledWith('e-y', { pinned: false })
  })
})

describe('popup 复制行为补齐（B3-15/16：HOTP 递增、清剪贴板三重门控）', () => {
  const totpEntry = {
    uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
  }

  afterEach(() => {
    vault.entries.length = 0
    shim?.restore()
    resetClipboardEnv()
    vi.useRealTimers()
  })

  async function mountTotpReady() {
    vault.entries.push(totpEntry as never)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true })
    const wrapper = await mountApp({ otpListItem: OtpListItemStub })
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
    const wrapper = await mountApp({ otpListItem: OtpListItemStub })
    await vi.waitFor(() => {
      expect(wrapper.find('.otp-item-stub').text()).not.toBe('------')
    })
    vi.useFakeTimers()

    wrapper.findComponent({ name: 'OtpListItemStub' }).vm.$emit('copy')
    await flushPromises()

    expect(updateEntryOp).toHaveBeenCalledWith('e-h', { counter: 3 })
    expect(wrapper.find('.copied-banner:not(.copied-banner--error)').exists()).toBe(true)
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

describe('popup 删除两击确认与 3s 超时复位（B3-17）', () => {
  afterEach(() => {
    vault.entries.length = 0
    vi.useRealTimers()
  })

  async function mountWithEntry() {
    vault.entries.push({
      uuid: 'e1', type: 'totp', issuer: 'GitHub', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    return await mountApp()
  }

  it('首击出确认按钮，3s 超时复位回删除钮；两击内确认才真正删除', async () => {
    vi.mocked(removeEntryOp).mockClear()
    const wrapper = await mountWithEntry()
    await vi.waitFor(() => {
      expect(wrapper.findAll('button').some((b) => b.text() === '🗑')).toBe(true)
    })
    vi.useFakeTimers()

    const delBtn = () => wrapper.findAll('button').find((b) => b.text() === '🗑')
    const confirmBtn = () => wrapper.findAll('button').find((b) => b.text().includes('删除'))

    // 首击：进入确认态（删除钮被确认钮替换）
    expect(delBtn()).toBeTruthy()
    await delBtn()!.trigger('click')
    expect(delBtn()).toBeUndefined()
    expect(confirmBtn()).toBeTruthy()

    // 3s 无操作：超时复位回删除钮
    await vi.advanceTimersByTimeAsync(3000)
    expect(confirmBtn()).toBeUndefined()
    expect(delBtn()).toBeTruthy()
    expect(removeEntryOp).not.toHaveBeenCalled()

    // 两击内确认：删除落地
    await delBtn()!.trigger('click')
    await confirmBtn()!.trigger('click')
    await flushPromises()
    expect(removeEntryOp).toHaveBeenCalledWith('e1')
  })
})

describe('popup 编辑 digits 重算与 URI 导入 carried 透传（B3-16）', () => {
  afterEach(() => {
    vault.entries.length = 0
    shim?.restore()
    withUriQuery(null)
  })

  it('编辑路径 type 变更：steam→totp 时 digits 重算（5→6），type 未变沿用表单值', async () => {
    vault.entries.push({
      uuid: 'e-s', type: 'steam', issuer: 'Steam', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 5, period: 30, tagIds: [], order: 0, createdAt: 0,
    } as never)
    const wrapper = await mountApp()
    await wrapper.findAll('button').find((b) => b.text() === '✎')!.trigger('click')
    const form = wrapper.findComponent({ name: 'EntryForm' })

    form.vm.$emit('save', {
      type: 'totp', issuer: 'Steam', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, note: '', tagIds: [], matchRules: [],
    })
    await flushPromises()
    expect(updateEntryOp).toHaveBeenCalledWith('e-s', expect.objectContaining({ type: 'totp', digits: 6 }))

    // type 未变（steam）：沿用表单提交值 5
    vi.mocked(updateEntryOp).mockClear()
    await wrapper.findAll('button').find((b) => b.text() === '✎')!.trigger('click')
    wrapper.findComponent({ name: 'EntryForm' }).vm.$emit('save', {
      type: 'steam', issuer: 'Steam', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 5, period: 30, note: '', tagIds: [], matchRules: [],
    })
    await flushPromises()
    expect(updateEntryOp).toHaveBeenCalledWith('e-s', expect.objectContaining({ type: 'steam', digits: 5 }))
  })

  it('URI 导入预填同 type：carried 透传 algorithm/digits/period/counter（hotp counter 保留）', async () => {
    withUriQuery('otpauth://hotp/Acme:dev?secret=JBSWY3DPEHPK3PXP&counter=5&digits=7')
    vi.mocked(addEntryOp).mockClear()
    const wrapper = await mountApp()
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
    const wrapper = await mountApp()

    wrapper.findComponent({ name: 'EntryForm' }).vm.$emit('save', {
      type: 'totp', issuer: 'Acme', label: 'dev', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 45, note: '', tagIds: [], matchRules: [],
    })
    await flushPromises()

    const entry = vi.mocked(addEntryOp).mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(entry.type).toBe('totp')
    expect(entry.counter).toBeUndefined() // carried=null：hotp counter 不带
    expect(entry.digits).toBe(6)
    // 现状锚定：carried=null 时 period 恒 30（`period: carried?.period ?? 30` 覆盖 ...data 的表单值）
    expect(entry.period).toBe(30)
  })
})

describe('popup 锁定态与标签筛选恢复（B3-11/14）', () => {
  afterEach(() => {
    vault.tags.length = 0
    settings.rememberTagFilter = false
    settings.lastTagFilterIds = []
    lockedRef.value = false
  })

  it('锁定态：渲染 LockScreen 且 allowPasskey=false（popup 无 WebAuthn 入口）', async () => {
    lockedRef.value = true
    const wrapper = await mountApp()
    expect(wrapper.find('lock-screen-stub').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'LockScreen' }).props('allowPasskey')).toBe(false)
    expect(wrapper.find('main').exists()).toBe(false)
  })

  it('rememberTagFilter 恢复：悬空 id 剔除、有效选中恢复并透传 TagFilterRow', async () => {
    settings.rememberTagFilter = true
    settings.lastTagFilterIds = ['t1', 'gone']
    vault.tags.push({ id: 't1', name: '工作' }, { id: 't2', name: '个人' } as never)

    const wrapper = await mountApp()
    const stub = wrapper.findComponent({ name: 'TagFilterRowStub' })
    expect(stub.props('selectedIds')).toEqual(['t1']) // gone 已被悬空剔除
  })

  it('rememberTagFilter 关闭：不恢复持久化选中（空集合）', async () => {
    settings.rememberTagFilter = false
    settings.lastTagFilterIds = ['t1']
    vault.tags.push({ id: 't1', name: '工作' } as never)

    const wrapper = await mountApp()
    expect(wrapper.findComponent({ name: 'TagFilterRowStub' }).props('selectedIds')).toEqual([])
  })
})
