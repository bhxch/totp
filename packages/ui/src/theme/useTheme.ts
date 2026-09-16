import { computed, getCurrentScope, onScopeDispose, ref, watchEffect, type ComputedRef, type WritableComputedRef } from 'vue'
import type { VueStore } from '../store'
import { DEFAULT_THEME_COLOR, isThemeColor } from './palette'
import { loadPalettes } from './loadPalettes'

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

// 非默认种子的 palettes chunk 懒加载:模块级 promise 缓存,多次调用只发起一次动态导入。
// blue(base 兜底)直接跳过;加载完成前以 base 的 blue 值渲染,加载后由更高特异度自动换色(ms 级)。
// 加载失败清空缓存:同会话下次切换颜色可重试,避免一次网络抖动永久停留在 blue 兜底。
let palettesPromise: Promise<unknown> | undefined
function ensurePalettes(color: string): void {
  if (color === DEFAULT_THEME_COLOR || palettesPromise) return
  palettesPromise = loadPalettes().catch(() => { palettesPromise = undefined /* 失败可重试 */ })
}

export function useTheme(store: VueStore): { mode: WritableComputedRef<ThemeModeValue>; color: WritableComputedRef<string>; resolvedMode: ComputedRef<'light' | 'dark'> } {
  const systemDark = ref(false)
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onSystemChange = (e: MediaQueryListEvent): void => {
      systemDark.value = e.matches
    }
    systemDark.value = mq.matches
    mq.addEventListener?.('change', onSystemChange)
    // scope 存在（setup/onMounted 调用契约）时挂销毁清理，避免组件卸载后监听器泄漏
    if (getCurrentScope()) onScopeDispose(() => mq.removeEventListener?.('change', onSystemChange))
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
      ensurePalettes(v) // 不 await:兜底为 blue,palettes 加载完成自动换色
      store.settings.themeColor = v
      writeMirror(mode.value, v)
      void store.commitSettings()
    },
  })
  const resolvedMode = computed<'light' | 'dark'>(() => (mode.value === 'auto' ? (systemDark.value ? 'dark' : 'light') : mode.value))
  // 应用属性(首帧由 html 内联脚本兜底)+ spec §4.5 镜像校正:调用契约是 initStore 成功后进入 setup,
  // watchEffect 首次执行时 settings 已是真实值;镜像与 settings 不一致则以 AppSettings 为准回写镜像,
  // 镜像不存在时写入的也是同一值,不会用默认值覆盖有效镜像
  watchEffect(() => {
    const m = mode.value
    const c = color.value
    ensurePalettes(c) // fire-and-forget:覆盖「设置加载即为非默认种子」的首载路径
    applyThemeAttributes(m, c)
    const mirror = readThemeMirror()
    if (mirror.mode !== m || mirror.color !== c) writeMirror(m, c)
  })
  function writeMirror(m: string, c: string) {
    try { localStorage.setItem(THEME_PREF_KEY, JSON.stringify({ mode: m, color: c })) } catch { /* 镜像失败不影响功能 */ }
  }
  return { mode, color, resolvedMode }
}
