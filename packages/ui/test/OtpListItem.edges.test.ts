import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { getBuiltinIcons, type OtpEntry } from '@totp/core'
import OtpListItem from '../src/components/OtpListItem.vue'
import { createTestI18n } from './helpers/i18n'

const entry: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
}
const base = { code: '123456', remaining: 12, progress: 0.6 }

describe('OtpListItem 分支补全', () => {
  it('icon.src 形态（stored/url 图标）：渲染 img 而非 svg/字母', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
      props: { entry, icon: { src: 'data:image/png;base64,aGk=' }, ...base } })
    expect(w.find('.avatar img.icon-img').exists()).toBe(true)
    expect((w.find('.avatar img').element as HTMLImageElement).src).toContain('aGk=')
  })

  it('空 issuer：首字母回落「?」（slice 后空串兜底）', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
      props: { entry: { ...entry, issuer: '' }, ...base } })
    expect(w.find('.avatar').text()).toBe('?')
  })

  it('grouped：5/7/8 位码不插空格（steam/非常规位数原样展示）', async () => {
    vi.useFakeTimers()
    try {
      for (const code of ['12345', '1234567', '12345678']) {
        const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
          props: { entry, code, remaining: 12, progress: 0.6 } })
        await w.find('.otp-item').trigger('dblclick') // 揭示态展示真实码
        await vi.advanceTimersByTimeAsync(0)
        expect(w.find('.otp-item .code').text()).toBe(code)
        w.unmount()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('揭示态重复双击：重置 8s 计时器（clearTimeout 分支），期间保持显示', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
        props: { entry, ...base } })
      await w.find('.otp-item').trigger('dblclick')
      await vi.advanceTimersByTimeAsync(4000)
      await w.find('.otp-item').trigger('dblclick') // 第二次双击重置计时
      await vi.advanceTimersByTimeAsync(4000)
      expect(w.find('.otp-item .code').text()).toBe('123 456') // 仍在揭示态
      await vi.advanceTimersByTimeAsync(5000)
      expect(w.find('.otp-item .code').text()).not.toBe('123 456') // 重置后 8s 到点打码
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('卸载时清理揭示计时器（onScopeDispose 分支不抛错）', () => {
    vi.useFakeTimers()
    try {
      const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base } })
      w.find('.otp-item').trigger('dblclick')
      expect(() => w.unmount()).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('builtin 图标渲染（getBuiltinIcons 数据源）', () => {
    const path = getBuiltinIcons()['github']!.path
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
      props: { entry, icon: { html: `<path d="${path}"></path>` }, ...base } })
    expect(w.find('.avatar svg').exists()).toBe(true)
  })
})
