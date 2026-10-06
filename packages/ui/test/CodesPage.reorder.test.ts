import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
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

/** pointer 拖拽驱动（jsdom）：把手 pointerdown → window pointermove（需先 stub document.elementFromPoint 指向目标行）→ pointerup */
async function pointerDrag(
  w: { findAll: (sel: string) => Array<{ find: (sel2: string) => { trigger: (ev: string, init?: Record<string, unknown>) => Promise<void>; element: HTMLElement } }> },
  fromRow: number,
  toRow: number,
) {
  const rows = w.findAll('.row')
  document.elementFromPoint = () => rows[toRow]!.find('.otp-item').element as HTMLElement
  await rows[fromRow]!.find('.handle').trigger('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 })
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 40 }))
  await flushPromises()
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 30, clientY: 40 }))
  await flushPromises()
}

describe('CodesPage 拖拽排序（④C，pointer 长按方案）', () => {
  it('a 把手 pointerdown → 移动越阈值 → 悬停 c 下缘 → pointerup：新序 [B,C,A] 落库且指示清空', async () => {
    const { w, store } = await mountPage()
    const rows = w.findAll('.row')
    document.elementFromPoint = () => rows[2]!.find('.otp-item').element as HTMLElement
    await rows[0]!.find('.handle').trigger('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 40 }))
    await flushPromises()
    expect(rows[2]!.classes()).toContain('drag-below') // jsdom rect 全 0：位移向下 → 下缘
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 30, clientY: 40 }))
    await flushPromises()
    expect(issuers(store)).toEqual(['B', 'C', 'A'])
    expect(rows[2]!.classes()).not.toContain('drag-below')
  })

  it('把手 click.stop 不触发条目复制；pointercancel 清指示且不落库', async () => {
    const { w, store } = await mountPage()
    await w.findAll('.row')[0]!.find('.handle').trigger('click')
    expect(w.emitted('copy')).toBeUndefined()
    const rows = w.findAll('.row')
    document.elementFromPoint = () => rows[1]!.find('.otp-item').element as HTMLElement
    await rows[0]!.find('.handle').trigger('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 40 }))
    await flushPromises()
    expect(rows[1]!.classes()).toContain('drag-below')
    window.dispatchEvent(new Event('pointercancel'))
    await flushPromises()
    expect(rows[1]!.classes()).not.toContain('drag-below')
    expect(issuers(store)).toEqual(['A', 'B', 'C'])
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
  it('reorderOp 落库失败：console.error 留痕不抛断（h3，spec §3.3）', async () => {    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { w, store } = await mountPage()
    vi.spyOn(store, 'reorderOp').mockRejectedValueOnce(new Error('disk full'))
    await pointerDrag(w, 0, 1)
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

  it('真机缺陷修复（2026-10-06 e2e）：编辑器打开即聚焦并全选（真实键入直接生效）', async () => {
    const adapter = createMemoryStorage()
    const store = createVueStore(adapter)
    await store.initStore()
    for (const uri of URIS) await store.addEntryOp(newEntryFromUri(uri, 1700000000000))
    // focus() 仅对已入档元素生效：attachTo document 挂载（enableAutoUnmount 兜底清理）
    const w = mount(CodesPage, { attachTo: document.body, global: { plugins: [createTestI18n()] }, props: { store } })
    await flushPromises()
    await w.findAll('.index-num')[0]!.trigger('click')
    await flushPromises()
    await nextTick()
    const input = w.find('.index-input')
    expect(input.exists()).toBe(true)
    expect(document.activeElement).toBe(input.element)
    w.unmount()
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
