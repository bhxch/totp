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
import { describe, expect, it, vi } from 'vitest'

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
  })
  const vault = reactive({ entries: [] as unknown[], tags: [] })
  const locked = ref(false)
  const store = {
    settings,
    vault,
    locked,
    commitSettings: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  }
  return {
    storageAdapter: { get: vi.fn(async () => null), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    store,
    settings,
    vault,
    locked,
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
import { addEntryOp, vault } from '../src/store'

/** BatchPastePanel 桩：保留 added 事件发射能力（点内嵌按钮触发），data-test 判定渲染 */
const BatchPastePanelStub = {
  name: 'BatchPastePanelStub',
  props: { store: { type: null, required: false } },
  emits: ['added'],
  template: `<div data-test="batch-paste-stub"><button data-test="batch-added-btn" @click="$emit('added', 1)">x</button></div>`,
}

async function mountApp() {
  const wrapper = mount(App, {
    global: {
      plugins: [createTestI18n()],
      stubs: {
        LockScreen: true,
        EntryForm: true,
        BatchPastePanel: BatchPastePanelStub,
        // 编辑态用例需要 item-wrap 渲染出 ✎ 按钮；行内容与本测试无关，桩掉
        OtpListItem: true,
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
