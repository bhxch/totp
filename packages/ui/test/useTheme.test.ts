import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { reactive } from 'vue'
import type { VueStore } from '../src/store'
import { applyThemeAttributes, isThemeColor, THEME_PALETTES, useTheme } from '../src/theme/useTheme'

// mock 静态依赖链上的加载器:loadPalettes 每次被调用即代表发起一次 palettes chunk 动态导入;
// 失败分支经 setTimeout 异步化,模拟真实网络往返(同步 reject 会在 watchEffect 同 tick 重试,失真)
const palettesMock = vi.hoisted(() => ({ loads: 0, failNext: false }))
vi.mock('../src/theme/loadPalettes', () => ({
  loadPalettes: vi.fn(async () => {
    palettesMock.loads++
    if (palettesMock.failNext) {
      palettesMock.failNext = false
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      throw new Error('chunk load failed')
    }
    return {}
  }),
}))

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
    expect(JSON.parse(localStorage.getItem('themePref')!)).toEqual({ mode: 'dark', color: 'teal', contrast: 'standard' })
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
  it('镜像与 settings 不一致时创建即回写校正(spec §4.5)', () => {
    localStorage.setItem('themePref', JSON.stringify({ mode: 'light', color: 'blue' }))
    const s = store()
    s.settings.themeMode = 'dark'
    s.settings.themeColor = 'teal'
    useTheme(s)
    expect(JSON.parse(localStorage.getItem('themePref')!)).toEqual({ mode: 'dark', color: 'teal', contrast: 'standard' })
  })
  it('AMOLED 对比档写入镜像 contrast 字段（FOUC 镜像补 contrast）', () => {
    const s = store()
    s.settings.themeMode = 'dark'
    s.settings.themeContrast = 'amoled'
    const t = useTheme(s)
    t.mode.value = 'dark'
    expect(JSON.parse(localStorage.getItem('themePref')!)).toEqual({ mode: 'dark', color: 'blue', contrast: 'amoled' })
    expect(document.documentElement.dataset.contrast).toBe('amoled')
  })
  it('四入口 html 内联脚本据镜像还原 data-contrast（无 contrast 值不设置）', () => {
    for (const f of ['apps/desktop/index.html', 'apps/desktop/mini.html', 'apps/extension/entrypoints/popup/index.html', 'apps/extension/entrypoints/options/index.html']) {
      const html = readFileSync(join(__dirname, '../../../', f), 'utf8')
      expect(html).toContain("if(p.contrast)d.contrast=p.contrast")
    }
  })
})

describe('ensurePalettes 懒加载(tokens-palettes.css 动态导入)', () => {
  beforeEach(() => {
    vi.resetModules()
    palettesMock.loads = 0
  })
  it('color 设为非默认种子触发动态导入', async () => {
    const { useTheme: freshUseTheme } = await import('../src/theme/useTheme')
    const t = freshUseTheme(store())
    t.color.value = 'teal'
    await vi.dynamicImportSettled()
    expect(palettesMock.loads).toBe(1)
  })
  it('color 设为 blue(默认种子)不触发导入', async () => {
    const { useTheme: freshUseTheme } = await import('../src/theme/useTheme')
    const t = freshUseTheme(store())
    t.color.value = 'blue'
    await Promise.resolve()
    expect(palettesMock.loads).toBe(0)
  })
  it('首载 settings 即非默认种子也触发(watchEffect 路径)', async () => {
    const { useTheme: freshUseTheme } = await import('../src/theme/useTheme')
    const s = store()
    s.settings.themeColor = 'violet'
    freshUseTheme(s)
    await vi.dynamicImportSettled()
    expect(palettesMock.loads).toBe(1)
  })
  it('重复 set 非默认种子只导入一次(promise 缓存)', async () => {
    const { useTheme: freshUseTheme } = await import('../src/theme/useTheme')
    const t = freshUseTheme(store())
    t.color.value = 'teal'
    await vi.dynamicImportSettled()
    t.color.value = 'pink'
    await vi.dynamicImportSettled()
    expect(palettesMock.loads).toBe(1)
  })
  it('加载失败清缓存:下次 set 非默认种子重新尝试导入', async () => {
    const { useTheme: freshUseTheme } = await import('../src/theme/useTheme')
    palettesMock.failNext = true
    const t = freshUseTheme(store())
    t.color.value = 'teal'
    await vi.dynamicImportSettled()
    await new Promise(resolve => setTimeout(resolve, 5)) // 等失败传播、catch 清缓存落地
    expect(palettesMock.loads).toBe(1)
    t.color.value = 'pink'
    await vi.dynamicImportSettled()
    expect(palettesMock.loads).toBe(2)
  })
})

describe('applyThemeAttributes', () => {
  it('直接写 dataset', () => {
    applyThemeAttributes('light', 'slate')
    expect(document.documentElement.dataset).toMatchObject({ mode: 'light', color: 'slate' })
  })
})
