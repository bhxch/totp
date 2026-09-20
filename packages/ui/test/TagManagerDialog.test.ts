import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryStorage } from '@totp/core'
import { createVueStore } from '../src/store'
import TagManagerDialog from '../src/components/TagManagerDialog.vue'
import { createTestI18n } from './helpers/i18n'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addTagOp('工作')
  await s.addTagOp('生活')
  return s
}

describe('TagManagerDialog', () => {
  it('open=false 不渲染弹层', () => {
    const s = createVueStore(createMemoryStorage())
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: false, store: s } })
    expect(w.find('.md-dialog').exists()).toBe(false)
  })

  it('headline「标签管理」；建标签表单提交走 addTagOp 且清空输入', async () => {
    const s = await readyStore()
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
    expect(w.find('.md-dialog__headline').text()).toBe('标签管理')
    await w.find('.tag-add input').setValue('新标签')
    await w.find('form.tag-add').trigger('submit')
    // 输入清空发生在 addTagOp promise resolve 之后（vault 先更新、清空在后），用 waitFor 等待
    await vi.waitFor(() => expect((w.find('.tag-add input').element as HTMLInputElement).value).toBe(''))
    expect(s.vault.tags.map((t) => t.name)).toContain('新标签')
  })

  it('空名称不调用 addTagOp', async () => {
    const s = await readyStore()
    const before = s.vault.tags.length
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
    await w.find('form.tag-add').trigger('submit')
    await w.find('.tag-add input').setValue('   ')
    await w.find('form.tag-add').trigger('submit')
    expect(s.vault.tags.length).toBe(before)
  })

  it('行内重命名：enter 保存走 renameTagOp', async () => {
    const s = await readyStore()
    const tid = s.vault.tags[0]!.id
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
    const row = w.findAll('.tag-list li').find((li) => li.text().includes('工作'))!
    await row.findAll('button').find((b) => b.text() === '编辑')!.trigger('click') // 编辑按钮 → 进入行内编辑
    const input = w.find('.tag-list input')
    expect((input.element as HTMLInputElement).value).toBe('工作')
    await input.setValue('上班族')
    await input.trigger('keydown.enter')
    await vi.waitFor(() => expect(s.vault.tags.find((t) => t.id === tid)!.name).toBe('上班族'))
  })

  it('行内重命名：取消不改动', async () => {
    const s = await readyStore()
    const tid = s.vault.tags[0]!.id
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
    const row = w.findAll('.tag-list li').find((li) => li.text().includes('工作'))!
    await row.findAll('button').find((b) => b.text() === '编辑')!.trigger('click')
    await w.find('.tag-list input').setValue('改动')
    const cancel = w.findAll('.tag-list button').find((b) => b.text() === '取消')!
    await cancel.trigger('click')
    expect(s.vault.tags.find((t) => t.id === tid)!.name).toBe('工作')
  })

  it('关闭后状态复位：重开无行内编辑残留、新建输入为空', async () => {
    const s = await readyStore()
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
    const row = w.findAll('.tag-list li').find((li) => li.text().includes('工作'))!
    await row.findAll('button').find((b) => b.text() === '编辑')!.trigger('click') // 进入行内编辑
    expect(w.find('.tag-list input').exists()).toBe(true)
    await w.find('.tag-add input').setValue('待清空')
    await w.setProps({ open: false })
    await w.setProps({ open: true })
    expect(w.find('.tag-list input').exists()).toBe(false) // 无行内编辑残留
    expect((w.find('.tag-add input').element as HTMLInputElement).value).toBe('') // 新建输入已清空
  })

  it('删除两击确认：首击仅进入 danger 确认态不删，再击才 removeTagOp（级联清理 tagIds）', async () => {
    const s = await readyStore()
    const tid = s.vault.tags[0]!.id
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
    const row = w.findAll('.tag-list li').find((li) => li.text().includes('工作'))!
    // 首击：进入确认态（danger 视觉），标签未删
    await row.findAll('button').find((b) => b.text() === '删除')!.trigger('click')
    const confirmBtn = w.find('.md-btn--danger')
    expect(confirmBtn.exists()).toBe(true)
    expect(confirmBtn.text()).toBe('确认删除？')
    expect(s.vault.tags.find((t) => t.id === tid)).toBeDefined()
    // 再击：真正删除
    await confirmBtn.trigger('click')
    await vi.waitFor(() => expect(s.vault.tags.find((t) => t.id === tid)).toBeUndefined())
  })

  it('删除确认 3s 超时自动复位（回到标准删除按钮，标签保留）', async () => {
    vi.useFakeTimers()
    try {
      const s = await readyStore()
      const tid = s.vault.tags[0]!.id
      const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
      const row = w.findAll('.tag-list li').find((li) => li.text().includes('工作'))!
      await row.findAll('button').find((b) => b.text() === '删除')!.trigger('click')
      expect(w.find('.md-btn--danger').exists()).toBe(true)
      vi.advanceTimersByTime(3000)
      await nextTick()
      expect(w.find('.md-btn--danger').exists()).toBe(false)
      expect(s.vault.tags.find((t) => t.id === tid)).toBeDefined()
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('确认态随关闭复位：重开后无「确认删除？」残留', async () => {
    const s = await readyStore()
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
    const row = w.findAll('.tag-list li').find((li) => li.text().includes('工作'))!
    await row.findAll('button').find((b) => b.text() === '删除')!.trigger('click')
    expect(w.find('.md-btn--danger').exists()).toBe(true)
    await w.setProps({ open: false })
    await w.setProps({ open: true })
    expect(w.find('.md-btn--danger').exists()).toBe(false)
    expect(s.vault.tags).toHaveLength(2)
  })

  it('标签列表显示计数与空态', async () => {
    const s = await readyStore()
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s } })
    expect(w.findAll('.tag-list li')).toHaveLength(2)
    expect(w.find('.tag-list').text()).toContain('0 条')
    const emptyStore = createVueStore(createMemoryStorage())
    await emptyStore.initStore()
    const w2 = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: emptyStore } })
    expect(w2.text()).toContain('暂无标签')
  })

  it('scrim 点击/Esc → emit close', async () => {
    const s = await readyStore()
    const w = mount(TagManagerDialog, { global: { plugins: [createTestI18n()] }, props: { open: true, store: s }, attachTo: document.body })
    await w.find('.md-dialog__scrim').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    await w.find('.md-dialog__scrim').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })
})
