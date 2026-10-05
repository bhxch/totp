// packages/ui/src/fullIcons.ts
// 全量图标集懒加载（spec 2026-10-05 §1）：精选 218 项随包同步，全量 3460 项为独立
// 资产（gen 脚本产出），打开选择器时一次性 fetch + registerIcons 合并进 core 注册表。
// ready/error 为模块级响应式标志：依赖 builtin path 解析的计算属性（CodesPage/popup
// 的 entryIcons）纳入 fullIconsReady 依赖，加载完成后非精选 builtin 引用自动补渲染。
import { ref } from 'vue'
import { registerIcons, type BuiltinIcon } from '@totp/core'
import fullIconsUrl from './assets/icons-full.json?url'

export const fullIconsReady = ref(false)
export const fullIconsError = ref(false)
let inflight: Promise<void> | null = null

export function ensureFullIcons(): Promise<void> {
  if (fullIconsReady.value) return Promise.resolve()
  if (!inflight) {
    fullIconsError.value = false
    inflight = fetch(fullIconsUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{ icons: Record<string, BuiltinIcon> }>
      })
      .then((data) => {
        registerIcons(Object.values(data.icons))
        fullIconsReady.value = true
      })
      .catch((e) => {
        inflight = null
        fullIconsError.value = true
        throw e
      })
  }
  return inflight
}
