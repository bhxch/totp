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
import { addEntryOp, locked, settings, storageAdapter, store, vault } from '../src/store'
import { SOURCES_KEY } from '@totp/core'

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

  it('解锁且开关开：mount 即跟随拉取——runner 读源键并记录状态（ok=null 空表跳过，真实编排终点）', async () => {
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
})
