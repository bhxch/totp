import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore, type VueStore } from '../src/store'
import CodesPage from '../src/pages/CodesPage.vue'
import { createTestI18n } from './helpers/i18n'

enableAutoUnmount(afterEach)

const URIS = [
  'otpauth://totp/A:one?secret=JBSWY3DPEHPK3PXP',
  'otpauth://totp/B:two?secret=JBSWY3DPEHPK3PXP',
  'otpauth://totp/C:three?secret=JBSWY3DPEHPK3PXP',
]

async function mountPage() {
  const adapter = createMemoryStorage()
  const store = createVueStore(adapter)
  await store.initStore()
  for (const uri of URIS) await store.addEntryOp(newEntryFromUri(uri, 1700000000000))
  const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store } })
  await flushPromises()
  return { w, store }
}

function issuers(s: VueStore): string[] {
  return [...s.vault.entries].sort((a, b) => a.order - b.order).map((e) => e.issuer)
}

describe('CodesPage 拖拽排序（④C）', () => {
  it('a 把手 dragstart → 悬停 c 下缘 → drop：新序 [B,C,A] 落库', async () => {
    const { w, store } = await mountPage()
    const rows = w.findAll('.row')
    await rows[0]!.find('.handle').trigger('dragstart', { dataTransfer: { setData() {}, effectAllowed: '' } })
    await rows[2]!.trigger('dragover', { clientY: 5 }) // jsdom rect 全 0：clientY≥0 → 下缘
    expect(rows[2]!.classes()).toContain('drag-below')
    await rows[2]!.trigger('drop')
    await flushPromises()
    expect(issuers(store)).toEqual(['B', 'C', 'A'])
  })

  it('把手 click.stop 不触发条目复制；dragend 清指示状态', async () => {
    const { w } = await mountPage()
    await w.findAll('.row')[0]!.find('.handle').trigger('click')
    expect(w.emitted('copy')).toBeUndefined()
    await w.findAll('.row')[0]!.find('.handle').trigger('dragstart', { dataTransfer: { setData() {}, effectAllowed: '' } })
    await w.findAll('.row')[1]!.trigger('dragover', { clientY: 5 })
    await w.findAll('.row')[1]!.trigger('dragend')
    expect(w.findAll('.row')[1]!.classes()).not.toContain('drag-below')
  })

  it('搜索过滤态：把手不渲染（全序语义禁拖）', async () => {
    const { w } = await mountPage()
    await w.find('input[type="search"], .search input').setValue('A')
    await flushPromises()
    expect(w.find('.handle').exists()).toBe(false)
  })

  it('杂-I2：行 drag-enabled class 随 dragEnabled 挂卸（把手渲染的挂载点）', async () => {
    const { w } = await mountPage()
    expect(w.findAll('.row').map((r) => r.classes())).toEqual([
      expect.arrayContaining(['drag-enabled']),
      expect.arrayContaining(['drag-enabled']),
      expect.arrayContaining(['drag-enabled']),
    ])
    await w.find('input[type="search"], .search input').setValue('A')
    await flushPromises()
    // 过滤态：把手不渲染且 drag-enabled 卸下
    expect(w.findAll('.row').every((r) => !r.classes().includes('drag-enabled'))).toBe(true)
    expect(w.find('.handle').exists()).toBe(false)
  })

  it('④C 修复：把手与序号并列渲染（hover 不隐藏序号，鼠标点击序号仍可打开输入）', async () => {
    // jsdom 不应用 SFC scoped CSS，display 样式断言不稳：以结构并存 + clickable/title 断言
    // 「把手并列出现、序号保持可见可点」（display:none 隐藏已被撤销，结构上二者共存即新行为）
    const { w } = await mountPage()
    const row = w.findAll('.row')[0]!
    expect(row.find('.handle').exists()).toBe(true)
    const num = row.find('.index-num')
    expect(num.exists()).toBe(true)
    expect(num.classes()).toContain('clickable')
    expect(num.attributes('title')).toBe('点击输入序号移动')
    // 序号点击路径在并列布局下依然可用（物理遮挡已由 CSS 撤销，行为回归保障）
    await num.trigger('click')
    expect(row.find('.index-input').exists()).toBe(true)
  })

  it('过滤态：序号 title 展示禁用提示（h1，spec §3.3）', async () => {
    const { w } = await mountPage()
    await w.find('input[type="search"], .search input').setValue('A')
    await flushPromises()
    const idx = w.find('.index-num')
    expect(idx.attributes('title')).toContain('禁用')
    expect(idx.classes()).not.toContain('clickable')
  })
})

describe('CodesPage 排序落库失败留痕（h3）', () => {
  it('reorderOp 落库失败：console.error 留痕不抛断（h3，spec §3.3）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { w, store } = await mountPage()
    vi.spyOn(store, 'reorderOp').mockRejectedValueOnce(new Error('disk full'))
    const rows = w.findAll('.row')
    await rows[0]!.find('.handle').trigger('dragstart', { dataTransfer: { setData() {}, effectAllowed: '' } })
    await rows[1]!.trigger('dragover', { clientY: 5 })
    await rows[1]!.trigger('drop')
    await flushPromises()
    expect(errSpy).toHaveBeenCalledWith('[codes] reorder failed:', expect.any(Error))
    errSpy.mockRestore()
  })
})

describe('CodesPage 序号定位移动（④C）', () => {
  it('点击第三条序号输入 1 → Enter：该条移到最前 [C,A,B]', async () => {
    const { w, store } = await mountPage()
    const nums = w.findAll('.index-num')
    expect(nums).toHaveLength(3)
    await nums[2]!.trigger('click')
    const input = w.find('.index-input')
    expect(input.exists()).toBe(true)
    await input.setValue('1')
    await input.trigger('keydown.enter')
    await flushPromises()
    expect(issuers(store)).toEqual(['C', 'A', 'B'])
    expect(w.find('.index-input').exists()).toBe(false)
  })

  it('输入超最大序号落末尾：A 输入 99 → [B,C,A]', async () => {
    const { w, store } = await mountPage()
    await w.findAll('.index-num')[0]!.trigger('click')
    const input = w.find('.index-input')
    await input.setValue('99')
    await input.trigger('keydown.enter')
    await flushPromises()
    expect(issuers(store)).toEqual(['B', 'C', 'A'])
  })

  it('Esc 取消不落库', async () => {
    const { w, store } = await mountPage()
    await w.findAll('.index-num')[0]!.trigger('click')
    const input = w.find('.index-input')
    await input.setValue('3')
    await input.trigger('keydown.esc')
    await flushPromises()
    expect(issuers(store)).toEqual(['A', 'B', 'C'])
    expect(w.find('.index-input').exists()).toBe(false)
  })

  it('杂-I3：序号按钮仅 dragEnabled 时声明 button 语义（role/tabindex/aria-label），过滤态移除', async () => {
    const { w } = await mountPage()
    const num = w.findAll('.index-num')[0]!
    expect(num.classes()).toContain('clickable')
    expect(num.attributes('role')).toBe('button')
    expect(num.attributes('tabindex')).toBe('0')
    expect(num.attributes('aria-label')).toBe('按序号移动 one（Enter 确认）')
    await w.find('input[type="search"], .search input').setValue('A')
    await flushPromises()
    const filtered = w.findAll('.index-num')[0]!
    expect(filtered.classes()).not.toContain('clickable')
    expect(filtered.attributes('role')).toBeUndefined()
    expect(filtered.attributes('tabindex')).toBeUndefined()
    expect(filtered.attributes('aria-label')).toBeUndefined()
  })

  it('杂-I3：键盘 Enter/Space 触发与 click 同一 handler（打开序号输入框）；Enter 不冒泡触发条目复制', async () => {
    const { w } = await mountPage()
    await w.findAll('.index-num')[0]!.trigger('keydown.enter')
    expect(w.find('.index-input').exists()).toBe(true)
    // .stop 阻断冒泡：.otp-item 根的 keydown.enter（emit copy）不被触发
    expect(w.emitted('copy')).toBeUndefined()
    await w.find('.index-input').trigger('keydown.esc')
    expect(w.find('.index-input').exists()).toBe(false)
    await w.findAll('.index-num')[1]!.trigger('keydown.space')
    expect(w.find('.index-input').exists()).toBe(true)
  })
})
