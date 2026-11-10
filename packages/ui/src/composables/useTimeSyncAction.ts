/**
 * 时间源同步动作（时间源特性 spec §6）：calibrateNow + 结果 toast 三态（落后/超前/已对齐）。
 * SettingsPage 与 CodesPage/popup 出码页按钮共用（Task 7）。toast 文案键在 timeSync.* 顶层域。
 */
import { timeSource } from '../timeSource'
import { useI18n } from 'vue-i18n'
import { useToast } from './useToast'

/** 已对齐阈值：|offset| < 50ms 视为同步无偏差（toast 用「已对齐」文案） */
const ALIGNED_EPS_MS = 50

export function useTimeSyncAction(): { syncing: import('vue').Ref<boolean>; syncNow(): Promise<void> } {
  const ts = timeSource()
  const { t } = useI18n()
  const toast = useToast()
  async function syncNow(): Promise<void> {
    try {
      const st = await ts.calibrateNow()
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
  return { syncing: ts.syncing, syncNow }
}
