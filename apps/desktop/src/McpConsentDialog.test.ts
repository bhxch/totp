/**
 * McpConsentDialog 挂载冒烟（P4，盘点 B8.30 渲染分流缺口）：首连三键（deny/once/trust）与
 * 工具确认两键（deny=close/allow）形态分流、headline 分流（toolConfirmTitle 带 tool）、
 * 提示文案分流、close 事件上抛。Md* 组件以桩替换（本组件壳层逻辑是测试对象）。
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import McpConsentDialog from './McpConsentDialog.vue'
import type { McpConsentItem } from './mcpApprovalQueue'

const MdDialogStub = defineComponent({
  props: { open: { type: Boolean, default: false }, headline: { type: String, default: '' } },
  emits: ['close'],
  template: `<div v-if="open" data-test="dialog"><h1 data-test="headline">{{ headline }}</h1><slot /><slot name="actions" /><button data-test="dialog-close" @click="$emit('close')">esc</button></div>`,
})
const MdButtonStub = defineComponent({
  props: { variant: { type: String, default: 'text' }, danger: { type: Boolean, default: false } },
  emits: ['click'],
  template: `<button :data-variant="variant" :data-danger="danger ? '1' : '0'" @click="$emit('click')"><slot /></button>`,
})

/** 取词桩：键+参数序列化，断言分流与参数 */
const t = (key: string, params?: Record<string, unknown>): string =>
  `${key}${params && Object.keys(params).length ? `?${JSON.stringify(params)}` : ''}`

function mountDialog(request: McpConsentItem | null, open = request !== null) {
  return mount(McpConsentDialog, {
    props: { open, request, t },
    global: { stubs: { MdDialog: MdDialogStub, MdButton: MdButtonStub } },
  })
}

describe('首连审批形态（三键）', () => {
  it('打开 → 首连标题/提示；deny/once/trust 三键分别上抛 resolve', async () => {
    const wrapper = mountDialog({ ident: 'conn-1', tool: 'read_x' })
    expect(wrapper.find('[data-test="headline"]').text()).toBe('mcpConsent.title')
    expect(wrapper.text()).toContain('mcpConsent.hint') // 首连提示（非工具确认 body）
    const buttons = wrapper.findAll('button')
    const byText = (s: string) => buttons.find((b) => b.text() === s)!
    await byText('mcpConsent.deny').trigger('click')
    expect(wrapper.emitted('resolve')).toEqual([['deny']])
    await byText('mcpConsent.once').trigger('click')
    expect(wrapper.emitted('resolve')!.at(-1)).toEqual(['once'])
    await byText('mcpConsent.trust').trigger('click')
    expect(wrapper.emitted('resolve')!.at(-1)).toEqual(['trust'])
  })

  it('close（Esc/遮罩桩）上抛 close（宿主按通道分流 deny）', async () => {
    const wrapper = mountDialog({ ident: 'conn-1', tool: 'read_x' })
    await wrapper.find('[data-test="dialog-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('工具确认形态（两键）', () => {
  it('标题=toolConfirmTitle 带 tool；提示=toolConfirmBody；Deny 键走 close、Allow 键走 allow', async () => {
    const wrapper = mountDialog({ id: 7, ident: 'conn-2', tool: 'trigger_backup' })
    expect(wrapper.find('[data-test="headline"]').text()).toBe(
      `mcpConsent.toolConfirmTitle?${JSON.stringify({ tool: 'trigger_backup' })}`,
    )
    expect(wrapper.text()).toContain('mcpConsent.toolConfirmBody')
    expect(wrapper.text()).not.toContain('mcpConsent.hint\n') // 提示分支分流（无首个 hint 段落）
    const buttons = wrapper.findAll('button')
    const byText = (s: string) => buttons.find((b) => b.text() === s)!
    await byText('mcpConsent.deny').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1) // 工具确认 Deny=close（宿主回 result:false）
    expect(wrapper.emitted('resolve')).toBeUndefined()
    await byText('mcpConsent.allow').trigger('click')
    expect(wrapper.emitted('allow')).toHaveLength(1)
  })

  it('首连形态无 Allow 键；工具形态无 once/trust 键（互斥分流）', () => {
    const conn = mountDialog({ ident: 'c', tool: 't' })
    const connTexts = conn.findAll('button').map((b) => b.text())
    expect(connTexts).not.toContain('mcpConsent.allow')
    const tool = mountDialog({ id: 1, ident: 'c', tool: 't' })
    const toolTexts = tool.findAll('button').map((b) => b.text())
    expect(toolTexts).not.toContain('mcpConsent.once')
    expect(toolTexts).not.toContain('mcpConsent.trust')
  })
})

it('open=false → 对话框不渲染', () => {
  const wrapper = mountDialog({ ident: 'c', tool: 't' }, false)
  expect(wrapper.find('[data-test="dialog"]').exists()).toBe(false)
})
