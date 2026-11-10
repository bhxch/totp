import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, nextTick } from 'vue'
import { __resetCloudFetchForTest, createMemoryStorage, EMPTY_TIME_SYNC_STATE, HTTPS_TIME_SOURCE_IDS, setCloudFetch } from '@totp/core'
import type { TimeSyncState } from '@totp/core'
import { createVueStore } from '../../src/store'
import SettingsPage from '../../src/pages/SettingsPage.vue'
import MdSelect from '../../src/components/md/MdSelect.vue'
import { timeSource } from '../../src/timeSource'
import { useToast } from '../../src/composables/useToast'
import { createTestI18n } from '../helpers/i18n'
import type { SecurityPlatform } from '../../src/components/securityPlatform'

async function readyStore(themeMode: 'auto' | 'light' | 'dark' = 'auto') {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  s.settings.themeMode = themeMode
  return s
}

function secPlatform(): SecurityPlatform {
  return {
    security: null,
    clipboardClearEnabled: computed(() => true),
    setClipboardClear: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  __resetCloudFetchForTest()
})

describe('SettingsPage 外观区', () => {
  it('色板渲染 10 个圆点（title=色名，默认 blue 选中）', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    const dots = w.findAll('button.theme-dot')
    expect(dots).toHaveLength(10)
    expect(w.find('button.theme-dot[data-color-id="blue"].theme-dot--selected').exists()).toBe(true)
    expect(w.find('button.theme-dot[data-color-id="teal"]').attributes('style')).toContain('rgb(0, 121, 107)') // teal #00796B
  })

  it('点 teal 圆点 → settings.themeColor=teal + commitSettings 调用 + localStorage 镜像写入', async () => {
    const s = await readyStore()
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('button.theme-dot[data-color-id="teal"]').trigger('click')
    expect(s.settings.themeColor).toBe('teal')
    expect(commit).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('themePref')!)).toMatchObject({ mode: 'auto', color: 'teal' })
    expect(w.find('button.theme-dot--selected[data-color-id="teal"]').exists()).toBe(true)
  })

  it('模式分段点「深色」→ settings.themeMode=dark + 镜像写入', async () => {
    const s = await readyStore()
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.findAll('.md-seg__item').find((b) => b.text() === '深色')!.trigger('click')
    expect(s.settings.themeMode).toBe('dark')
    expect(commit).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('themePref')!)).toMatchObject({ mode: 'dark' })
    expect(w.find('.md-seg__item--selected').text()).toContain('深色')
  })

  it('resolvedMode 展示当前生效模式（themeMode=dark → 深色）', async () => {
    const s = await readyStore('dark')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    expect(w.find('.theme-resolved').text()).toContain('深色')
  })

  it('语言选择：点选 English → settings.locale=en + commitSettings 调用（D1）', async () => {
    const s = await readyStore()
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    // 默认 auto：「跟随浏览器」为当前选中项
    expect(w.find('.set-locale .md-select__value').text()).toBe('跟随浏览器')
    await w.find('.set-locale .md-select__trigger').trigger('click')
    await w.findAll('.set-locale .md-select__option').find((o) => o.text() === 'English')!.trigger('click')
    expect(s.settings.locale).toBe('en')
    expect(commit).toHaveBeenCalled()
    expect(w.find('.set-locale .md-select__value').text()).toBe('English')
  })
})

describe('SettingsPage 通用区', () => {
  it('showDesktop=false 不渲染失焦自动隐藏开关；true 渲染且切换写 settings + commitSettings', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: false } })
    expect(w.find('.set-blur-hide').exists()).toBe(false)
    const w2 = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: true } })
    const commit = vi.spyOn(s, 'commitSettings')
    expect(s.settings.blurHideEnabled).toBe(false)
    await w2.find('.set-blur-hide input').setValue(true)
    expect(s.settings.blurHideEnabled).toBe(true)
    expect(commit).toHaveBeenCalled()
  })

  it('showExtension=false 不渲染 URL 过滤与弹窗延迟；true 渲染且写入生效', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: true, showExtension: false } })
    expect(w.find('.set-url-filter').exists()).toBe(false)
    expect(w.find('.set-popup-delay').exists()).toBe(false)
    const w2 = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: true, showExtension: true } })
    // 默认 urlFilterEnabled=true、popupCloseDelayMs=2000（DEFAULT_SETTINGS）
    expect((w2.find('.set-url-filter input').element as HTMLInputElement).checked).toBe(true)
    await w2.find('.set-url-filter input').setValue(false)
    expect(s.settings.urlFilterEnabled).toBe(false)
    await w2.find('.set-popup-delay input').setValue('3000')
    expect(s.settings.popupCloseDelayMs).toBe(3000)
  })

  it('弹窗延迟：空串/负值忽略不落盘不调 commitSettings；小数四舍五入取整', async () => {
    const s = await readyStore()
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: true, showExtension: true } })
    await w.find('.set-popup-delay input').setValue('   ')
    expect(s.settings.popupCloseDelayMs).toBe(2000) // 默认值未被空串清成 0
    expect(commit).not.toHaveBeenCalled()
    await w.find('.set-popup-delay input').setValue('12.7')
    expect(s.settings.popupCloseDelayMs).toBe(13)
    await w.find('.set-popup-delay input').setValue('-5')
    expect(s.settings.popupCloseDelayMs).toBe(13)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('记住标签筛选开关写入 settings', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('input.set-remember-tag-filter, .set-remember-tag-filter input').setValue(true)
    await vi.waitFor(() => expect(s.settings.rememberTagFilter).toBe(true))
  })

  it('剪贴板开关：securityPlatform.setClipboardClear 缺失不渲染；存在则渲染且切换写 settings', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    expect(w.find('.set-clipboard-clear').exists()).toBe(false)
    const w2 = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, securityPlatform: secPlatform() } })
    expect(w2.find('.set-clipboard-clear').exists()).toBe(true)
    expect(s.settings.clipboardClearEnabled).toBe(true)
    await w2.find('.set-clipboard-clear input').setValue(false)
    expect(s.settings.clipboardClearEnabled).toBe(false)
  })
})

/** 更新检查 stub：返回指定 tag 的 release JSON */
function stubLatest(tag: string): void {
  setCloudFetch(async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/bhxch/totp/releases/tag/${tag}` }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

describe('SettingsPage 关于卡（版本行 + 检查更新）', () => {
  it('版本行显示宿主注入的 appVersion；缺省显示占位符', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, appVersion: '1.0.2' } })
    expect(w.find('[data-test="app-version"]').text()).toBe('v1.0.2')
    const w2 = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    expect(w2.find('[data-test="app-version"]').text()).toBe('—')
  })

  it('检查更新：远端更新 → note 外链（含 href），按钮恢复可用', async () => {
    stubLatest('v1.1.0')
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, appVersion: '1.0.2' } })
    await w.find('[data-test="check-update"]').trigger('click')
    await flushPromises()
    const note = w.find('[data-test="update-note"] a')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('v1.1.0')
    expect(note.attributes('href')).toBe('https://github.com/bhxch/totp/releases/tag/v1.1.0')
    expect((w.find('[data-test="check-update"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('远端不高于本地 → 「已是最新」hint，无外链行', async () => {
    stubLatest('v1.0.2')
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, appVersion: '1.0.2' } })
    await w.find('[data-test="check-update"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="update-uptodate"]').exists()).toBe(true)
    expect(w.find('[data-test="update-note"]').exists()).toBe(false)
  })

  it('本地版本未知（appVersion 缺省）→ hint 展示远端版本号，不出比较外链', async () => {
    stubLatest('v1.1.0')
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('[data-test="check-update"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="update-latest-unknown"]').text()).toBe('v1.1.0')
    expect(w.find('[data-test="update-note"]').exists()).toBe(false)
  })

  it('检查失败 → role=alert 错误行展示原因', async () => {
    setCloudFetch(async () => new Response('rate limited', { status: 403 }))
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, appVersion: '1.0.2' } })
    await w.find('[data-test="check-update"]').trigger('click')
    await flushPromises()
    const err = w.find('[data-test="update-error"]')
    expect(err.attributes('role')).toBe('alert')
    expect(err.text()).toContain('403')
  })

  it('检查中按钮禁用防重入，完成后恢复', async () => {
    let release!: () => void
    setCloudFetch(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ tag_name: 'v1.1.0', html_url: 'https://github.com/bhxch/totp/releases/tag/v1.1.0' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }))
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, appVersion: '1.0.2' } })
    await w.find('[data-test="check-update"]').trigger('click')
    expect((w.find('[data-test="check-update"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.find('[data-test="check-update"]').text()).toContain('检查中')
    release()
    await flushPromises()
    expect((w.find('[data-test="check-update"]').element as HTMLButtonElement).disabled).toBe(false)
  })
})

/** 时间源单例跨用例复位（模块级单例防线）：state 回空形态 + 清全局 toast 队列 */
function resetTimeSync(): void {
  timeSource().state.value = { ...EMPTY_TIME_SYNC_STATE }
  useToast().toasts.value.splice(0, useToast().toasts.value.length)
}

/** calibrateNow mock 用成功态（TimeSyncState 全形；sourceId 缺省 baidu） */
function calibratedState(offsetMs: number, sourceId = 'baidu'): TimeSyncState {
  const now = Date.now()
  return { v: 1, offsetMs, syncedAt: now, sourceId, lastAttemptAt: now, lastAttemptFailed: false, preferredSourceId: null }
}

/** 已挂 network 模式的 store（时间源卡展开态前提：template v-if 依赖 settings.timeSource） */
async function readyNetworkStore() {
  const s = await readyStore()
  s.settings.timeSource = 'network'
  return s
}

/** 时间源卡首选源 MdSelect 组件包装器（凭 set-time-source class 与 locale 下拉区分） */
function timePreferredSelect(w: ReturnType<typeof mount>) {
  const sel = w.findAllComponents(MdSelect).find((c) => c.classes().includes('set-time-source'))
  expect(sel, '首选源 MdSelect 应已渲染').toBeDefined()
  return sel!
}

describe('时间源卡（plan24 spec §6）', () => {
  beforeEach(() => {
    resetTimeSync()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('device 模式：仅模式行渲染，无首选源/同步按钮', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    const items = w.findAll('[data-test="time-mode"] .md-seg__item')
    expect(items.map((b) => b.text())).toEqual(['设备时间', '网络时间'])
    expect(w.find('[data-test="time-preferred"]').exists()).toBe(false)
    expect(w.find('[data-test="time-sync-now"]').exists()).toBe(false)
    expect(w.find('[data-test="time-status"]').exists()).toBe(false)
  })

  it('切到 network：展开首选源与同步区', async () => {
    const s = await readyStore()
    // 模式切换在 offsetMs===null 时会触发一次校准（spec §3-②），spy 掉避免走降级实例的恒败路径
    vi.spyOn(timeSource(), 'calibrateNow').mockResolvedValue(calibratedState(100))
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.findAll('[data-test="time-mode"] .md-seg__item').find((b) => b.text() === '网络时间')!.trigger('click')
    expect(s.settings.timeSource).toBe('network')
    expect(commit).toHaveBeenCalled()
    expect(w.find('[data-test="time-preferred"]').exists()).toBe(true)
    expect(w.find('[data-test="time-sync-now"]').exists()).toBe(true)
    await flushPromises()
  })

  it('首选源 options：扩展端为 HTTPS 七源+auto（showDesktop=false）', async () => {
    const s = await readyNetworkStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    const options = timePreferredSelect(w).props('options') as Array<{ value: string; label: string }>
    expect(options.map((o) => o.value)).toEqual(['auto', ...HTTPS_TIME_SOURCE_IDS])
    expect(options[0]!.label).toBe('自动（按内置优先级）')
  })

  it('首选源变更：setPreferredSource 落盘不触发校准', async () => {
    const s = await readyNetworkStore()
    const calibrate = vi.spyOn(timeSource(), 'calibrateNow').mockResolvedValue(calibratedState(0, 'gitee'))
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    // 默认 auto：选中值显示「自动（按内置优先级）」
    expect(w.find('[data-test="time-preferred"] .md-select__value').text()).toBe('自动（按内置优先级）')
    await w.find('[data-test="time-preferred"] .md-select__trigger').trigger('click')
    await w.findAll('[data-test="time-preferred"] .md-select__option').find((o) => o.text() === 'Gitee')!.trigger('click')
    await flushPromises()
    expect(timeSource().state.value.preferredSourceId).toBe('gitee')
    expect(calibrate).not.toHaveBeenCalled()
    expect(w.find('[data-test="time-preferred"] .md-select__value').text()).toBe('Gitee')
  })

  it('立即同步成功：toast 方向文案（offset>0 落后）', async () => {
    const s = await readyNetworkStore()
    vi.spyOn(timeSource(), 'calibrateNow').mockResolvedValue(calibratedState(2500))
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('[data-test="time-sync-now"]').trigger('click')
    await flushPromises()
    const messages = useToast().toasts.value
    expect(messages.some((t) => t.kind === 'success' && t.message.includes('2.5'))).toBe(true)
  })

  it('立即同步失败：toast error', async () => {
    const s = await readyNetworkStore()
    vi.spyOn(timeSource(), 'calibrateNow').mockRejectedValue(new Error('network down'))
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('[data-test="time-sync-now"]').trigger('click')
    await flushPromises()
    const messages = useToast().toasts.value
    expect(messages.some((t) => t.kind === 'error' && t.message.includes('时间同步失败'))).toBe(true)
  })

  it('状态行：从未同步 / 上次成功含来源与偏差 / 上次失败', async () => {
    const s = await readyNetworkStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    // ① 空形态（含装载闸门未落定的降级形态）→「尚未同步」
    expect(w.find('[data-test="time-status"]').text()).toBe('尚未同步')
    // ② 上次成功：时刻+来源+偏差方向
    timeSource().state.value = {
      v: 1, offsetMs: 2500, syncedAt: Date.now(), sourceId: 'gitee',
      lastAttemptAt: Date.now(), lastAttemptFailed: false, preferredSourceId: null,
    }
    await nextTick()
    expect(w.find('[data-test="time-status"]').text()).toContain('上次同步')
    expect(w.find('[data-test="time-status"]').text()).toContain('Gitee')
    expect(w.find('[data-test="time-status"]').text()).toContain('本机落后 2.5 秒')
    // ③ 上次失败：无偏移，仅失败时刻
    timeSource().state.value = {
      v: 1, offsetMs: null, syncedAt: null, sourceId: null,
      lastAttemptAt: Date.now(), lastAttemptFailed: true, preferredSourceId: null,
    }
    await nextTick()
    expect(w.find('[data-test="time-status"]').text()).toContain('上次同步失败')
  })
})
