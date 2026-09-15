import { describe, expect, it, vi, beforeEach } from 'vitest'
import { reactive } from 'vue'
import type { VueStore } from '../src/store'
import { applyThemeAttributes, isThemeColor, THEME_PALETTES, useTheme } from '../src/theme/useTheme'

// stub 只提供 useTheme 依赖的 settings/commitSettings 两成员;断言为 VueStore 满足签名(useTheme 不触及其余成员)
const store = () => ({
  settings: reactive({ themeMode: 'auto', themeColor: 'blue' }),
  commitSettings: vi.fn(async () => {}),
}) as unknown as VueStore

beforeEach(() => {
  localStorage.clear()
  document.documentElement.dataset.mode = ''
  document.documentElement.dataset.color = ''
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true,
    value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn() }) })
})

describe('palette', () => {
  it('色板10项且 isThemeColor 校验', () => {
    expect(THEME_PALETTES).toHaveLength(10)
    expect(isThemeColor('teal')).toBe(true)
    expect(isThemeColor('nope')).toBe(false)
  })
})

describe('useTheme', () => {
  it('应用 data-mode/data-color 到根元素并写镜像(经 set)', async () => {
    const s = store()
    const t = useTheme(s)
    t.mode.value = 'dark'
    t.color.value = 'teal'
    await Promise.resolve()
    expect(document.documentElement.dataset.mode).toBe('dark')
    expect(document.documentElement.dataset.color).toBe('teal')
    expect(JSON.parse(localStorage.getItem('themePref')!)).toEqual({ mode: 'dark', color: 'teal' })
    expect(s.commitSettings).toHaveBeenCalled()
  })
  it('非法 color 读侧回退 blue', () => {
    const s = store(); s.settings.themeColor = 'nope'
    expect(useTheme(s).color.value).toBe('blue')
  })
  it('resolvedMode:auto 跟随 matchMedia(dark 系统→dark)', () => {
    const s = store(); s.settings.themeMode = 'auto'
    expect(useTheme(s).resolvedMode.value).toBe('dark')
  })
})

describe('applyThemeAttributes', () => {
  it('直接写 dataset', () => {
    applyThemeAttributes('light', 'slate')
    expect(document.documentElement.dataset).toMatchObject({ mode: 'light', color: 'slate' })
  })
})
