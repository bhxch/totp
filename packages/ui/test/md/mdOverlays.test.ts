import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MdDialog from '../../src/components/md/MdDialog.vue'
import MdMenu from '../../src/components/md/MdMenu.vue'
import MdListItem from '../../src/components/md/MdListItem.vue'

describe('MdDialog', () => {
  it('open=false 不渲染', () => {
    expect(mount(MdDialog, { props: { open: false } }).find('.md-dialog').exists()).toBe(false)
  })
  it('Esc 关闭;actions 内 data-md-close 点击关闭', async () => {
    const w = mount(MdDialog, { props: { open: true, headline: '确认' }, slots: { actions: '<button data-md-close>好</button>' }, attachTo: document.body })
    await w.find('.md-dialog__scrim').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    await w.find('[data-md-close]').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })
})
describe('MdMenu', () => {
  it('定位到 x/y 且 open=false 不渲染', () => {
    const closed = mount(MdMenu, { props: { open: false, x: 0, y: 0 } })
    expect(closed.find('.md-menu').exists()).toBe(false)
    const w = mount(MdMenu, { props: { open: true, x: 40, y: 60 } })
    expect(w.find('.md-menu').attributes('style')).toContain('left: 40px')
    expect(w.find('.md-menu').attributes('style')).toContain('top: 60px')
  })
})
describe('MdListItem', () => {
  it('danger 类与 click', async () => {
    const w = mount(MdListItem, { props: { label: '删除', danger: true } })
    expect(w.classes()).toContain('md-list-item--danger')
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })
})
