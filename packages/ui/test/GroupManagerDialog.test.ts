import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage } from '@totp/core'
import { createVueStore } from '../src/store'
import GroupManagerDialog from '../src/components/GroupManagerDialog.vue'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addGroupOp('工作')
  await s.addGroupOp('生活')
  return s
}

describe('GroupManagerDialog', () => {
  it('open=false 不渲染弹层', () => {
    const s = createVueStore(createMemoryStorage())
    const w = mount(GroupManagerDialog, { props: { open: false, store: s } })
    expect(w.find('.md-dialog').exists()).toBe(false)
  })

  it('headline「分组管理」；建组表单提交走 addGroupOp 且清空输入', async () => {
    const s = await readyStore()
    const w = mount(GroupManagerDialog, { props: { open: true, store: s } })
    expect(w.find('.md-dialog__headline').text()).toBe('分组管理')
    await w.find('.group-add input').setValue('新组')
    await w.find('form.group-add').trigger('submit')
    // 输入清空发生在 addGroupOp promise resolve 之后（vault 先更新、清空在后），用 waitFor 等待
    await vi.waitFor(() => expect((w.find('.group-add input').element as HTMLInputElement).value).toBe(''))
    expect(s.vault.groups.map((g) => g.name)).toContain('新组')
  })

  it('空名称不调用 addGroupOp', async () => {
    const s = await readyStore()
    const before = s.vault.groups.length
    const w = mount(GroupManagerDialog, { props: { open: true, store: s } })
    await w.find('form.group-add').trigger('submit')
    await w.find('.group-add input').setValue('   ')
    await w.find('form.group-add').trigger('submit')
    expect(s.vault.groups.length).toBe(before)
  })

  it('行内重命名：enter 保存走 renameGroupOp', async () => {
    const s = await readyStore()
    const gid = s.vault.groups[0]!.id
    const w = mount(GroupManagerDialog, { props: { open: true, store: s } })
    const row = w.findAll('.group-list li').find((li) => li.text().includes('工作'))!
    await row.findAll('button').find((b) => b.text() === '编辑')!.trigger('click') // 编辑按钮 → 进入行内编辑
    const input = w.find('.group-list input')
    expect((input.element as HTMLInputElement).value).toBe('工作')
    await input.setValue('上班族')
    await input.trigger('keydown.enter')
    await vi.waitFor(() => expect(s.vault.groups.find((g) => g.id === gid)!.name).toBe('上班族'))
  })

  it('行内重命名：取消不改动', async () => {
    const s = await readyStore()
    const gid = s.vault.groups[0]!.id
    const w = mount(GroupManagerDialog, { props: { open: true, store: s } })
    const row = w.findAll('.group-list li').find((li) => li.text().includes('工作'))!
    await row.findAll('button').find((b) => b.text() === '编辑')!.trigger('click')
    await w.find('.group-list input').setValue('改动')
    const cancel = w.findAll('.group-list button').find((b) => b.text() === '取消')!
    await cancel.trigger('click')
    expect(s.vault.groups.find((g) => g.id === gid)!.name).toBe('工作')
  })

  it('关闭后状态复位：重开无行内编辑残留、新建输入为空', async () => {
    const s = await readyStore()
    const w = mount(GroupManagerDialog, { props: { open: true, store: s } })
    const row = w.findAll('.group-list li').find((li) => li.text().includes('工作'))!
    await row.findAll('button').find((b) => b.text() === '编辑')!.trigger('click') // 进入行内编辑
    expect(w.find('.group-list input').exists()).toBe(true)
    await w.find('.group-add input').setValue('待清空')
    await w.setProps({ open: false })
    await w.setProps({ open: true })
    expect(w.find('.group-list input').exists()).toBe(false) // 无行内编辑残留
    expect((w.find('.group-add input').element as HTMLInputElement).value).toBe('') // 新建输入已清空
  })

  it('删除走 removeGroupOp（级联清理 groupIds）', async () => {
    const s = await readyStore()
    const gid = s.vault.groups[0]!.id
    const w = mount(GroupManagerDialog, { props: { open: true, store: s } })
    const row = w.findAll('.group-list li').find((li) => li.text().includes('工作'))!
    await row.findAll('button').find((b) => b.text() === '删除')!.trigger('click') // 删除按钮
    await vi.waitFor(() => expect(s.vault.groups.find((g) => g.id === gid)).toBeUndefined())
  })

  it('分组列表显示计数与空态', async () => {
    const s = await readyStore()
    const w = mount(GroupManagerDialog, { props: { open: true, store: s } })
    expect(w.findAll('.group-list li')).toHaveLength(2)
    expect(w.find('.group-list').text()).toContain('0 条')
    const emptyStore = createVueStore(createMemoryStorage())
    await emptyStore.initStore()
    const w2 = mount(GroupManagerDialog, { props: { open: true, store: emptyStore } })
    expect(w2.text()).toContain('暂无分组')
  })

  it('scrim 点击/Esc → emit close', async () => {
    const s = await readyStore()
    const w = mount(GroupManagerDialog, { props: { open: true, store: s }, attachTo: document.body })
    await w.find('.md-dialog__scrim').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    await w.find('.md-dialog__scrim').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })
})
