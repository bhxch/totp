/** 扩展 API 统一通道（spec 批⑧ §1 差异处理模式第 3 层）：
 *  Firefox 全局 browser（Promise 风格）优先，Chrome MV3 chrome（已 Promise 化）兜底；
 *  桌面/测试等无扩展宿主环境为 undefined，调用点须先经 canXxx() 能力探测（capabilities 模式）。
 *  不 import 'wxt/browser'：vitest 无宿主环境下 polyfill 行为不可控，全局探测与
 *  lockEnforcer 既有模式一致（N1 注释口径）。 */
type ChromeLike = typeof chrome
export const ext: ChromeLike | undefined = (globalThis as { browser?: ChromeLike }).browser
  ?? (globalThis as { chrome?: ChromeLike }).chrome

/** offscreen 能力（仅 Chrome MV3；Firefox 无此 API——清剪贴板降级为本地不调度） */
export function canOffscreen(): boolean {
  return typeof ext?.offscreen !== 'undefined'
}

/** idle 能力（Firefox 无 idle 权限时缺失——空闲/锁屏自动锁定降级上报） */
export function canIdle(): boolean {
  return typeof ext?.idle?.queryState === 'function'
}

/** action 徽标能力（旧内核/上下文缺失时静默） */
export function canSetBadge(): boolean {
  return typeof ext?.action?.setBadgeText === 'function'
}

/** openPopup 能力（仅部分 Chromium 版本开放） */
export function canOpenPopup(): boolean {
  return typeof (ext?.action as { openPopup?: unknown } | undefined)?.openPopup === 'function'
}
