import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../src/store'
import VaultManager from '../src/components/VaultManager.vue'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@ex.com?secret=JBSWY3DPEHPK3PXP', 1700000000000))
  return s
}

describe('VaultManager', () => {
  it('渲染条目与搜索过滤', async () => {
    const s = await readyStore()
    const w = mount(VaultManager, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const input = w.find('input[type="search"]')
    await input.setValue('不存在')
    expect(w.text()).not.toContain('GitHub')
  })

  it('enableCopy=false 时不调用剪贴板；分组卡显示空态', async () => {
    const s = await readyStore()
    const writeText = vi.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mount(VaultManager, { props: { store: s } })
    await (w.find('.otp-item').trigger('click'))
    expect(writeText).not.toHaveBeenCalled()
    expect(w.text()).toContain('暂无分组')
  })

  it('enableCopy=true 时点击条目 emit copy 且携带验证码', async () => {
    const s = await readyStore()
    const w = mount(VaultManager, { props: { store: s, enableCopy: true } })
    // 等验证码就绪（recompute 异步，未就绪时显示占位 '------'）
    await vi.waitFor(() => expect(w.find('.otp-item .code').text()).not.toBe('------'))
    await w.find('.otp-item').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
    expect(String(w.emitted('copy')![0]![0])).toMatch(/^\d{6}$/)
  })
})
