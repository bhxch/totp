import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { getBuiltinIcons, type OtpEntry } from '@totp/core'
import OtpListItem from '../src/components/OtpListItem.vue'
import { createTestI18n } from './helpers/i18n'

const entry: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
}
const base = { code: '123456', remaining: 12, progress: 0.6 }

describe('OtpListItem 图标渲染', () => {
  it('无 icon 时首字母 avatar（向后兼容）', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base } })
    expect(w.find('.avatar').text()).toBe('G')
    expect(w.find('.avatar svg').exists()).toBe(false)
    expect(w.find('.avatar img').exists()).toBe(false)
  })

  it('icon.html 渲染 builtin svg（viewBox 0 0 24 24 + path 数据）', () => {
    const path = getBuiltinIcons()['github']!.path
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, icon: { html: `<path d="${path}"></path>` }, ...base } })
    const svg = w.find('.avatar svg')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    expect(svg.element.innerHTML).toContain(path.slice(0, 20))
  })

  it('icon.src 渲染 img（dataUrl）', () => {
    const src = 'data:image/png;base64,AAA'
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, icon: { src }, ...base } })
    expect(w.find('.avatar img').attributes('src')).toBe(src)
    expect(w.find('.avatar svg').exists()).toBe(false)
  })
})

describe('OtpListItem avatar 多彩取色（批④ §5）', () => {
  it('icon 缺省时 avatar 带 color-mix 内联 style（按 issuer 哈希取色）', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base } })
    expect(w.find('.avatar').attributes('style')).toMatch(/^background: color-mix\(in srgb, #/)
  })

  it('传入 icon.html 时 avatar 不带 style（保留 .avatar 默认底色）', () => {
    const path = getBuiltinIcons()['github']!.path
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, icon: { html: `<path d="${path}"></path>` }, ...base } })
    expect(w.find('.avatar').attributes('style')).toBeUndefined()
  })
})

describe('OtpListItem 右键菜单 / qr / INVALID（C16）', () => {
  it('qr 按钮 emit qr，且不冒泡触发 copy', async () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base } })
    await w.find('.show-qr').trigger('click')
    expect(w.emitted('qr')).toHaveLength(1)
    // @click.stop 已阻止冒泡，copy 不应被触发
    expect(w.emitted('copy')).toBeUndefined()
  })

  it('@contextmenu.prevent 默认 + emit context 携带 MouseEvent', async () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base } })
    await w.find('.otp-item').trigger('contextmenu', { clientX: 100, clientY: 200 })
    // 默认菜单已被 preventDefault 阻止（vue-test-utils 会保留 preventDefault 调用）
    expect(w.emitted('context')).toHaveLength(1)
    const ev = w.emitted('context')![0]![0] as MouseEvent
    expect(ev.clientX).toBe(100)
    expect(ev.clientY).toBe(200)
  })

  it('pinned=true 时显示 ★ 图标', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry: { ...entry, pinned: true }, ...base } })
    expect(w.find('.pin').exists()).toBe(true)
    expect(w.text()).toContain('★')
  })

  it('pinned 缺省/false 不显示 ★', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base } })
    expect(w.find('.pin').exists()).toBe(false)
  })

  it('C19：code=INVALID 时渲染「密钥非法」红字 + tooltip 显示原因', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
      props: { entry, code: 'INVALID', remaining: 12, progress: 0.4, error: 'invalid base32' },
    })
    expect(w.text()).toContain('密钥非法')
    const codeEl = w.find('.code.invalid')
    expect(codeEl.exists()).toBe(true)
    expect(codeEl.attributes('title')).toBe('密钥非法：invalid base32')
  })
})

describe('OtpListItem 宿主适配 prop（contextMenu/showQr，mini 等未接宿主传 false）', () => {
  it('默认（未传）保留 aria-haspopup、QR 按钮与 context emit（Vue Boolean casting 下显式 withDefaults 兜底）', async () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base } })
    expect(w.find('.otp-item').attributes('aria-haspopup')).toBe('menu')
    expect(w.find('.show-qr').exists()).toBe(true)
    await w.find('.otp-item').trigger('contextmenu', { clientX: 5, clientY: 6 })
    expect(w.emitted('context')).toHaveLength(1)
  })

  it('contextMenu=false（mini）：不声明 aria-haspopup、右键不 preventDefault 也不 emit', async () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base, contextMenu: false } })
    expect(w.find('.otp-item').attributes('aria-haspopup')).toBeUndefined()
    await w.find('.otp-item').trigger('contextmenu', { clientX: 5, clientY: 6 })
    expect(w.emitted('context')).toBeUndefined()
  })

  it('showQr=false（mini）：不渲染 QR 按钮（copy 按钮不受影响）', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base, showQr: false } })
    expect(w.find('.show-qr').exists()).toBe(false)
    expect(w.find('button.copy').exists()).toBe(true)
  })
})

describe('OtpListItem ring 几何（I52 + I61）', () => {
  it('stroke-dasharray = 2πr（r=16），stroke-dashoffset = circumference * (1 - progress) 平滑过渡', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, code: '123456', remaining: 12, progress: 0.4 } })
    const expectedCircumference = 2 * Math.PI * 16
    const fg = w.find('circle.ring-fg')
    expect(fg.exists()).toBe(true)
    expect(fg.attributes('r')).toBe('16')
    expect(Number(fg.attributes('stroke-dasharray'))).toBeCloseTo(expectedCircumference, 6)
    // progress=0.4 → offset = circumference * 0.6
    expect(Number(fg.attributes('stroke-dashoffset'))).toBeCloseTo(expectedCircumference * 0.6, 6)
  })

  it('progress 边界：0 → 全空圆（offset=full），1 → 全满圆（offset=0）', () => {
    const empty = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, code: '123456', remaining: 0, progress: 0 } })
    const full = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, code: '123456', remaining: 30, progress: 1 } })
    const expected = 2 * Math.PI * 16
    expect(Number(empty.find('circle.ring-fg').attributes('stroke-dashoffset'))).toBeCloseTo(expected, 6)
    expect(Number(full.find('circle.ring-fg').attributes('stroke-dashoffset'))).toBeCloseTo(0, 6)
  })
})
