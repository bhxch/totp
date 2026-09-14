import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { getBuiltinIcons, type OtpEntry } from '@totp/core'
import OtpListItem from '../src/components/OtpListItem.vue'

const entry: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 0,
}
const base = { code: '123456', remaining: 12, progress: 0.6 }

describe('OtpListItem 图标渲染', () => {
  it('无 icon 时首字母 avatar（向后兼容）', () => {
    const w = mount(OtpListItem, { props: { entry, ...base } })
    expect(w.find('.avatar').text()).toBe('G')
    expect(w.find('.avatar svg').exists()).toBe(false)
    expect(w.find('.avatar img').exists()).toBe(false)
  })

  it('icon.html 渲染 builtin svg（viewBox 0 0 24 24 + path 数据）', () => {
    const path = getBuiltinIcons()['github']!.path
    const w = mount(OtpListItem, { props: { entry, icon: { html: `<path d="${path}"></path>` }, ...base } })
    const svg = w.find('.avatar svg')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    expect(svg.element.innerHTML).toContain(path.slice(0, 20))
  })

  it('icon.src 渲染 img（dataUrl）', () => {
    const src = 'data:image/png;base64,AAA'
    const w = mount(OtpListItem, { props: { entry, icon: { src }, ...base } })
    expect(w.find('.avatar img').attributes('src')).toBe(src)
    expect(w.find('.avatar svg').exists()).toBe(false)
  })
})
