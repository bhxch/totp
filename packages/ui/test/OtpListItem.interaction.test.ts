import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import OtpListItem from '../src/components/OtpListItem.vue'
import { createTestI18n } from './helpers/i18n'

const entry = {
  uuid: 'u1', issuer: 'GitHub', label: 'a@b.c', type: 'totp', secret: 'JBSWY3DP',
  algorithm: 'SHA1', digits: 6, period: 30, icon: '', pinned: false, order: 0, tags: [],
} as never

function mountItem(code = '123456') {
  return mount(OtpListItem, {
    props: { entry, code, remaining: 30, progress: 1 },
    global: { plugins: [createTestI18n()] },
  })
}

afterEach(() => vi.useRealTimers())

describe('OtpListItem 打码与复制', () => {
  it('默认打码，不渲染真实验证码', () => {
    const w = mountItem()
    expect(w.text()).not.toContain('123456')
    expect(w.text()).toContain('••• •••')
  })

  it('单击条目 emit copy', async () => {
    const w = mountItem()
    await w.find('.otp-item').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
  })

  it('复制按钮 emit copy 且不冒泡重复触发', async () => {
    const w = mountItem()
    await w.find('button.copy').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
  })

  it('双击显示真实码，8 秒后自动打回', async () => {
    vi.useFakeTimers()
    const w = mountItem()
    await w.find('.otp-item').trigger('dblclick')
    expect(w.text()).toContain('123 456')
    vi.advanceTimersByTime(8000)
    await vi.runOnlyPendingTimersAsync()
    expect(w.text()).toContain('••• •••')
    expect(w.text()).not.toContain('123456')
  })

  it('不再提供 🔑 reveal 按钮与 reveal 事件', async () => {
    vi.useFakeTimers()
    const w = mountItem()
    expect(w.find('.reveal').exists()).toBe(false)
    await w.find('.otp-item').trigger('dblclick')
    expect(w.emitted('reveal')).toBeUndefined()
  })

  it('INVALID 状态不受打码影响（保留错误提示可见）', () => {
    const w = mountItem('INVALID')
    expect(w.find('.code.invalid').exists()).toBe(true)
  })
})
