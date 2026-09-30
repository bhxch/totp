import { afterEach, describe, expect, it } from 'vitest'
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
})
