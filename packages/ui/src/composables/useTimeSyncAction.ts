/**
 * 时间源同步动作（时间源特性 spec §6）：calibrateNow + 结果 toast 三态（落后/超前/已对齐）。
 * SettingsPage 与 CodesPage/popup 出码页按钮共用（Task 7）。toast 文案键在 timeSync.* 顶层域。
 *
 * translate：取词函数注入（默认 useI18n）。桌面 mini 窗在 setup 同步段取不到 useI18n
 * （i18n 插件随 boot 异步装入，见 desktopShell.useDesktopI18n），故由壳层传入 tr()。
 */
import { timeSource } from '../timeSource'
import { useI18n } from 'vue-i18n'
import { computed, type Ref } from 'vue'
import { useToast } from './useToast'

/** 取词函数形状（vue-i18n 的 t 与桌面壳层 tr 同形） */
export type TimeSyncTranslate = (key: string, params?: Record<string, unknown>) => string

/** 已对齐阈值：|offset| < 50ms 视为同步无偏差（toast 用「已对齐」文案）。设置页状态行共用
 * 此常量（终审 G2 hoist：单一事实源，消除 toast 与状态行的口径漂移） */
export const ALIGNED_EPS_MS = 50

export function useTimeSyncAction(translate?: TimeSyncTranslate): { syncing: Readonly<Ref<boolean>>; syncNow(): Promise<void> } {
  // 未注入时走 useI18n（须在 setup 同步段调用）；注入时不触碰 useI18n（mini 窗无 i18n 插件时不可用）
  const t = translate ?? (useI18n().t as unknown as TimeSyncTranslate)
  const toast = useToast()
  // 单例可被覆盖安装（宿主 boot 后 initTimeSync；桌面 mini 窗聚焦重载 store 后再装一次）——
  // 每次现取而非在 setup 期捕获实例：捕获会拿到「未安装前」的降级实例（校准恒败、syncing 恒 false）
  const syncing = computed(() => timeSource().syncing.value)
  async function syncNow(): Promise<void> {
    try {
      const st = await timeSource().calibrateNow()
      const off = st.offsetMs ?? 0
      if (Math.abs(off) < ALIGNED_EPS_MS) {
        toast.show(t('timeSync.toastAligned'))
      } else if (off > 0) {
        toast.show(t('timeSync.toastBehind', { seconds: (off / 1000).toFixed(1) }))
      } else {
        toast.show(t('timeSync.toastAhead', { seconds: (Math.abs(off) / 1000).toFixed(1) }))
      }
    } catch {
      toast.show(t('timeSync.toastFailed'), 'error')
    }
  }
  return { syncing, syncNow }
}
