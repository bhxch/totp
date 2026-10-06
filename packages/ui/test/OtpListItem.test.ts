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

  it('showQr=false（mini）：不渲染 QR 按钮；行内复制按钮已随两行布局删除（单击行复制由宿主承接）', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base, showQr: false } })
    expect(w.find('.show-qr').exists()).toBe(false)
    expect(w.find('button.copy').exists()).toBe(false)
  })

  it('默认（showQr 缺省 true）仍渲染 QR 按钮', () => {
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base } })
    expect(w.find('.show-qr').exists()).toBe(true)
  })
})

describe('OtpListItem 行顶进度条（Aegis 式两行布局，替环形倒计时）', () => {
  const mountItem = (progress: number, remaining = 12) =>
    mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, code: '123456', remaining, progress } })

  it('progress 映射为 progress-fill 宽度百分比（Math.round）', () => {
    const w = mountItem(0.4)
    expect(w.find('.progress-line').exists()).toBe(true)
    expect(w.find('.progress-line').attributes('aria-hidden')).toBe('true')
    expect(w.find('.progress-fill').attributes('style')).toContain('width: 40%')
  })

  it('progress 边界：0 → 0%，1 → 100%', () => {
    expect(mountItem(0).find('.progress-fill').attributes('style')).toContain('width: 0%')
    expect(mountItem(1).find('.progress-fill').attributes('style')).toContain('width: 100%')
  })

  it('环形倒计时已移除：不再渲染 svg.ring 与剩余秒数（remaining prop 保留签名但不渲染）', () => {
    const w = mountItem(0.4, 12)
    expect(w.find('svg.ring').exists()).toBe(false)
    expect(w.find('.ring-text').exists()).toBe(false)
  })
})

describe('OtpListItem 标题行（Aegis 两行布局上行：issuer/label 合并 + 溢出跑马灯）', () => {
  const mountItem = (over: Partial<OtpEntry> = {}) =>
    mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry: { ...entry, ...over }, ...base } })

  it('issuer + label → 「issuer/label」单行', () => {
    expect(mountItem().find('.title-text').text()).toBe('GitHub/me@ex.com')
  })

  it('label 为空只显 issuer', () => {
    expect(mountItem({ label: '' }).find('.title-text').text()).toBe('GitHub')
  })

  it('issuer 为空只显 label', () => {
    expect(mountItem({ issuer: '' }).find('.title-text').text()).toBe('me@ex.com')
  })

  it('pin ★ 渲染在标题行内（title-text 内，先星标后标题）', () => {
    const w = mountItem({ pinned: true })
    const title = w.find('.title-text')
    expect(title.find('.pin').exists()).toBe(true)
    expect(title.text()).toContain('★')
  })

  it('标题未溢出无 marquee；溢出（scrollWidth > clientWidth）加 marquee class（jsdom 无布局，mock 元素尺寸 + setProps 触发 watch 验证）', async () => {
    const w = mountItem()
    expect(w.find('.title-text').classes()).not.toContain('marquee')
    const el = w.find('.title-text').element as HTMLElement
    Object.defineProperty(el, 'scrollWidth', { value: 500, configurable: true })
    Object.defineProperty(el, 'clientWidth', { value: 160, configurable: true })
    await w.setProps({ entry: { ...entry, label: 'renamed@ex.com' } }) // 触发 watch(flush post) 重测溢出
    expect(w.find('.title-text').classes()).toContain('marquee')
  })
})

describe('OtpListItem 序号 / 倒计时紧急色 / 揭示醒目色（④A 三宿主共享）', () => {
  const idxMount = (props: Record<string, unknown>, slots: Record<string, string> = {}) =>
    mount(OtpListItem, { global: { plugins: [createTestI18n()] }, props: { entry, ...base, ...props }, slots })

  it('index 传入时行首渲染序号；未传不渲染（mini/popup 传，宿主自定）', () => {
    expect(idxMount({ index: 3 }).find('.index').text()).toBe('3')
    expect(idxMount({}).find('.index').exists()).toBe(false)
  })
  it('#lead slot 覆盖默认序号文本（CodesPage 把手/序号切换区）', () => {
    const w = idxMount({ index: 2 }, { lead: '<span class="handle">⠿</span>' })
    expect(w.find('.index .handle').exists()).toBe(true)
    expect(w.find('.index').text()).not.toContain('2')
  })
  it('倒计时末三分之一：progress ≤ 1/3 时进度条加 urgent（error 色挂载点）', () => {
    expect(idxMount({ code: '123456', remaining: 10, progress: 10 / 30 }).find('.progress-fill.urgent').exists()).toBe(true)
    expect(idxMount({ code: '123456', remaining: 11, progress: 11 / 30 }).find('.progress-fill.urgent').exists()).toBe(false)
  })
  it('杂-I1：hotp 码不过期，即使 progress 落末三分之一也不 urgent', () => {
    const hotpEntry: OtpEntry = { ...entry, type: 'hotp', counter: 5 }
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
      props: { entry: hotpEntry, code: '123456', remaining: 2, progress: 2 / 30 } })
    expect(w.find('.progress-fill.urgent').exists()).toBe(false)
  })
  it('杂-I1：占位码 ------（首帧 codes 未就绪）不 urgent，TOTP 实码同 progress 仍 urgent', () => {
    const placeholder = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
      props: { entry, code: '------', remaining: 0, progress: 0 } })
    expect(placeholder.find('.progress-fill.urgent').exists()).toBe(false)
    const real = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
      props: { entry, code: '123456', remaining: 0, progress: 0 } })
    expect(real.find('.progress-fill.urgent').exists()).toBe(true)
  })
  it('杂-I1：yandex 亦时间基（counter 由 nowMs 推导），末三分之一仍 urgent', () => {
    const yandexEntry: OtpEntry = { ...entry, type: 'yandex', pin: '1234' }
    const w = mount(OtpListItem, { global: { plugins: [createTestI18n()] },
      props: { entry: yandexEntry, code: 'abcdefgh', remaining: 9, progress: 9 / 30 } })
    expect(w.find('.progress-fill.urgent').exists()).toBe(true)
  })
  it('Enter（无 Shift）复制且不揭示（键盘复制与 Shift+Enter 揭示分链）', async () => {
    const w = idxMount({})
    await w.find('.otp-item').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('copy')).toHaveLength(1)
    expect(w.find('.code.revealed').exists()).toBe(false)
  })
  it('揭示态 .code 加 revealed 醒目色 class；INVALID 恒不加（错误文案非秘密但语义不同）', async () => {
    const w = idxMount({})
    expect(w.find('.code.revealed').exists()).toBe(false)
    await w.find('.otp-item').trigger('dblclick')
    expect(w.find('.code.revealed').exists()).toBe(true)
    const inv = idxMount({ code: 'INVALID', remaining: 5, progress: 0.1, error: 'bad secret' })
    await inv.find('.otp-item').trigger('dblclick')
    expect(inv.find('.code.revealed').exists()).toBe(false)
  })
})
