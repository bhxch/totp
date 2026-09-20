import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, getBuiltinIcons, type OtpEntry } from '@totp/core'
import { createVueStore } from '../src/store'
import EntryFormDialog from '../src/components/EntryFormDialog.vue'
import { createTestI18n } from './helpers/i18n'

const entry: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
}

const icons = { builtin: getBuiltinIcons(), stored: {} }

const URI_A = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'

/** 智能粘贴 Tab 数据源：内存 storage mock（BatchPastePanel.test 同口径），须 initStore 后 vault 可写 */
async function mkStore() {
  const store = createVueStore(createMemoryStorage())
  await store.initStore()
  return store
}

function mountDialog(over: Partial<{ open: boolean; editing: OtpEntry | null }> = {}) {
  return mount(EntryFormDialog, { global: { plugins: [createTestI18n()] },
    props: { open: true, editing: null, tags: [], icons, store: createVueStore(createMemoryStorage()), ...over },
  })
}

/** Tab 按钮：MdSegmentedButton 渲染 .md-seg__item 按钮（SettingsPage/BackupCard 同款） */
function pasteTab(w: ReturnType<typeof mount>) {
  return w.findAll('.md-seg__item').find((b) => b.text() === '智能粘贴')!
}

describe('EntryFormDialog', () => {
  it('open=false 不渲染弹层（EntryForm 不挂载）', () => {
    const w = mountDialog({ open: false })
    expect(w.find('.md-dialog').exists()).toBe(false)
    expect(w.find('form.entry-form').exists()).toBe(false)
  })

  it('编辑态：headline「编辑条目」，submit 发 save 携带全量字段，自身不 emit close', async () => {
    const w = mountDialog({ editing: entry })
    expect(w.find('.md-dialog__headline').text()).toBe('编辑条目')
    await w.find('form.entry-form').trigger('submit')
    const payload = w.emitted('save')![0]![0]
    expect(payload).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, note: '', tagIds: [], matchRules: [],
    })
    // 关弹由父组件在 save 后负责，对话框本身不 emit close
    expect(w.emitted('close')).toBeUndefined()
  })

  it('新建态：headline「新建条目」，save 透传表单数据（新建默认值分支留在 CodesPage）', async () => {
    const w = mountDialog()
    expect(w.find('.md-dialog__headline').text()).toBe('新建条目')
    await w.find('input[placeholder="服务名（如 GitHub）"]').setValue('MyApp')
    await w.find('input[placeholder="密钥 base32"]').setValue('JBSWY3DPEHPK3PXP')
    await w.find('form.entry-form').trigger('submit')
    const payload = w.emitted('save')![0]![0]
    expect(payload).toMatchObject({ type: 'totp', issuer: 'MyApp', secret: 'JBSWY3DPEHPK3PXP' })
  })

  it('非法 secret 阻止提交：不 emit save', async () => {
    const w = mountDialog()
    await w.find('input[placeholder="密钥 base32"]').setValue('AB01')
    await w.find('form.entry-form').trigger('submit')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.text()).toContain('base32')
  })

  it('EntryForm 取消 → emit close', async () => {
    const w = mountDialog({ editing: entry })
    const cancel = w.findAll('form.entry-form button').find((b) => b.text() === '取消')!
    await cancel.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('createTag 透传 EntryForm：内联建 tag 回车创建后自动勾选（CodesPage 接 store.addTagOp）', async () => {
    const w = mount(EntryFormDialog, { global: { plugins: [createTestI18n()] },
      props: {
        open: true, editing: null, tags: [{ id: 't1', name: '工作' }], icons, store: await mkStore(),
        createTag: async (name: string) => (name === '银行' ? 't9' : ''),
      },
    })
    // 未透传时内联建行不存在：选择器找不到即失败（RED 口径与实现一致）
    const newTag = () => w.find('input[aria-label="新标签名称"]')
    await newTag().setValue('银行')
    await newTag().trigger('keydown.enter')
    // 等透传的 createTag 异步 resolve 且 EntryForm 重渲染：新 tag 复选框出现
    await vi.waitFor(() => expect(w.findAll('input[type="checkbox"]')).toHaveLength(2))
    const checks = w.findAll('input[type="checkbox"]').map((c) => (c.element as HTMLInputElement).checked)
    expect(checks).toEqual([false, true]) // t1 未勾、新建 t9 自动勾选
  })

  it('Esc 关闭 → emit close', async () => {
    const w = mount(EntryFormDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, editing: entry, tags: [], icons, store: await mkStore() }, attachTo: document.body })
    await w.find('.md-dialog__scrim').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('双 Tab：默认「手动填写」渲染 EntryForm；切「智能粘贴」渲染 BatchPastePanel 且 EntryForm 卸载', async () => {
    const w = mountDialog()
    expect(w.find('form.entry-form').exists()).toBe(true)
    expect(w.find('.batch-paste').exists()).toBe(false)
    await pasteTab(w).trigger('click')
    expect(w.find('form.entry-form').exists()).toBe(false)
    expect(w.find('.batch-paste').exists()).toBe(true)
    // 切回手动：EntryForm 重建（:key 现状保持），粘贴面板卸载即重置
    await w.findAll('.md-seg__item').find((b) => b.text() === '手动填写')!.trigger('click')
    expect(w.find('form.entry-form').exists()).toBe(true)
    expect(w.find('.batch-paste').exists()).toBe(false)
  })

  it('粘贴 Tab 提交落库后冒泡 batch-added [count]（宿主收后关弹窗）', async () => {
    const store = await mkStore()
    const w = mount(EntryFormDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, editing: null, tags: [], icons, store } })
    await pasteTab(w).trigger('click')
    await w.find('.batch-paste textarea').setValue(URI_A)
    await w.find('[data-test="paste-parse"]').trigger('click')
    await w.find('[data-test="paste-commit"]').trigger('click')
    // added 在 commit 落盘 await 完成后才发出（BatchPastePanel.test 同口径）
    await vi.waitFor(() => expect(w.emitted('batch-added')?.[0]).toEqual([1]))
    expect(store.vault.entries).toHaveLength(1)
  })
})
