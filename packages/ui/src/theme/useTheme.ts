import { computed, ref, watchEffect, type ComputedRef, type WritableComputedRef } from 'vue'
import type { VueStore } from '../store'
import { DEFAULT_THEME_COLOR, isThemeColor } from './palette'

// re-export 供 `@totp/ui` 消费方与测试统一从本模块取 palette 原语
export { DEFAULT_THEME_COLOR, isThemeColor, THEME_PALETTES } from './palette'

export type ThemeModeValue = 'light' | 'dark' | 'auto'
export const THEME_PREF_KEY = 'themePref'

export function applyThemeAttributes(mode: string, color: string): void {
  document.documentElement.dataset.mode = mode
  document.documentElement.dataset.color = color
}

export function readThemeMirror(): { mode?: string; color?: string } {
  try { return JSON.parse(localStorage.getItem(THEME_PREF_KEY) ?? '{}') } catch { return {} }
}

export function useTheme(store: VueStore): { mode: WritableComputedRef<ThemeModeValue>; color: WritableComputedRef<string>; resolvedMode: ComputedRef<'light' | 'dark'> } {
  const systemDark = ref(false)
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = mq.matches
    mq.addEventListener?.('change', (e) => (systemDark.value = e.matches))
  }
  const mode = computed<ThemeModeValue>({
    get: () => (store.settings.themeMode === 'light' || store.settings.themeMode === 'dark' ? store.settings.themeMode : 'auto'),
    set(v) {
      store.settings.themeMode = v
      writeMirror(v, color.value)
      void store.commitSettings()
    },
  })
  const color = computed<string>({
    get: () => (isThemeColor(store.settings.themeColor) ? store.settings.themeColor : DEFAULT_THEME_COLOR),
    set(v) {
      if (!isThemeColor(v)) return
      store.settings.themeColor = v
      writeMirror(mode.value, v)
      void store.commitSettings()
    },
  })
  const resolvedMode = computed<'light' | 'dark'>(() => (mode.value === 'auto' ? (systemDark.value ? 'dark' : 'light') : mode.value))
  // 仅应用属性(首帧由 html 内联脚本兜底);镜像仅在 set 写,避免加载前默认值覆盖镜像
  watchEffect(() => applyThemeAttributes(mode.value, color.value))
  function writeMirror(m: string, c: string) {
    try { localStorage.setItem(THEME_PREF_KEY, JSON.stringify({ mode: m, color: c })) } catch { /* 镜像失败不影响功能 */ }
  }
  return { mode, color, resolvedMode }
}
