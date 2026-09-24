import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage } from '@totp/core'
import { createVueStore } from '../src/store'
import BatchPastePanel from '../src/components/BatchPastePanel.vue'
import { createTestI18n } from './helpers/i18n'

const URI_A = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
const URI_B = 'otpauth://totp/GitLab:bob?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitLab'

function mkStore() {
  const store = createVueStore(createMemoryStorage())
  return store.initStore().then(() => store)
}

describe('BatchPastePanel', () => {
  it('输入区为 MdTextField multiline（6 行）：v-model/placeholder/aria-label 语义平移', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    // 裸 textarea 已收口为 MdTextField（结构断言）；paste-zone 容器保持不变
    const ta = w.find('[data-test="paste-input"]')
    expect(ta.exists()).toBe(true)
    expect(ta.element.tagName).toBe('TEXTAREA')
    expect(ta.attributes('rows')).toBe('6')
    expect(ta.attributes('placeholder')).toContain('otpauth')
    expect(ta.attributes('aria-label')).toBe('粘贴文本')
    await ta.setValue(URI_A)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1)
  })
  it('粘贴两条 URI：显示 2 行解析结果且可添加', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(`${URI_A}\n${URI_B}`)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(2)
    await w.find('[data-test="paste-commit"]').trigger('click')
    // added 事件在 commit 队列（含落盘 await）全部完成后才发出，以此作等待观察点
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([2]))
    expect(store.vault.entries).toHaveLength(2)
  })
  it('重复粘贴同一条：identical 行默认跳过，第二次添加不产生重复', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(URI_A)
    await w.find('[data-test="paste-parse"]').trigger('click')
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([1]))
    expect(store.vault.entries).toHaveLength(1)
    await w.find('textarea').setValue(URI_A)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1)
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[1]).toEqual([0]))
    expect(store.vault.entries).toHaveLength(1)
  })
  it('批内重复行去重：同一 URI 粘两遍仅出 1 行 new，落库恰 1 条', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(`${URI_A}\n${URI_A}`)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1)
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([1]))
    expect(store.vault.entries).toHaveLength(1)
  })
  it('失败行显示原因且不阻塞其他行', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(`${URI_A}\nnot-a-uri`)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1)
    expect(w.text()).toContain('第 2 行')
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([1]))
    expect(store.vault.entries).toHaveLength(1)
  })
})
