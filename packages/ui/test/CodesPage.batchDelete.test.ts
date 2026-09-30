import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore, type VueStore } from '../src/store'
import CodesPage from '../src/pages/CodesPage.vue'
import { createTestI18n } from './helpers/i18n'

async function makeStore(): Promise<VueStore> {
  const adapter = createMemoryStorage()
  const s = createVueStore(adapter)
  await s.initStore()
  for (const uri of [
    'otpauth://totp/A:one?secret=JBSWY3DPEHPK3PXP',
    'otpauth://totp/B:two?secret=JBSWY3DPEHPK3PXP',
    'otpauth://totp/C:three?secret=JBSWY3DPEHPK3PXP',
  ]) await s.addEntryOp(newEntryFromUri(uri, 1700000000000))
  return s
}

async function mountPage() {
  const store = await makeStore()
  const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store } })
  await flushPromises()
  return { w, store }
}

describe('CodesPage 批量删除（④B）', () => {
  it('选择模式勾选两条 → 删除所选两击确认 → vault 少两条并退出选择模式', async () => {
    const { w, store } = await mountPage()
    await w.find('[data-test="select-mode"]').trigger('click')
    const checks = w.findAll('.row-check input[type="checkbox"]')
    expect(checks.length).toBe(3)
    await checks[0]!.setValue(true)
    await checks[2]!.setValue(true)
    expect(w.find('[data-test="select-bar"]').exists()).toBe(true)
    expect(w.find('[data-test="select-delete"]').text()).toContain('2')

    // 首击进入两击确认（按钮切换为确认删除），不落库
    await w.find('[data-test="select-delete"]').trigger('click')
    expect(w.find('[data-test="select-delete-confirm"]').exists()).toBe(true)
    expect(store.vault.entries).toHaveLength(3)

    // 再击确认：批量删除 + 退出选择模式
    await w.find('[data-test="select-delete-confirm"]').trigger('click')
    await flushPromises()
    expect(store.vault.entries.map((e) => e.issuer)).toEqual(['B'])
    expect(w.find('[data-test="select-bar"]').exists()).toBe(false)
  })

  it('取消选择不删除：退出后条目原样', async () => {
    const { w, store } = await mountPage()
    await w.find('[data-test="select-mode"]').trigger('click')
    await w.findAll('.row-check input[type="checkbox"]')[0]!.setValue(true)
    await w.find('[data-test="select-cancel"]').trigger('click')
    await flushPromises()
    expect(store.vault.entries).toHaveLength(3)
    expect(w.find('[data-test="select-bar"]').exists()).toBe(false)
  })
})
