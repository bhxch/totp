/**
 * 桌面端时间源装配（时间源特性 spec §5）：设备本地键=localStorage['timeSyncState']
 * （desktopPrefs 同款模式，main/mini 双窗同 origin 共享）；校准器=invoke('time_calibrate')
 * （Rust SNTP 池 racing + 毫秒 API 降级，Task 4）。bootDesktopStore 内安装——main/mini
 * 双窗共用该 boot 序列，天然覆盖；幂等（重复安装覆盖 ui 单例）。
 *
 * 源链剖面（2026-11-13 全球链）：由**界面语言**判定（timeSourceProfileFor）后随命令入参
 * 带下——Rust 侧无界面上下文，判定留在前端；locale 运行时可改，故剖面每次校准现取。
 */
import { normalizeTimeSyncState, TIME_SYNC_STATE_KEY, type TimeSyncState } from '@totp/core'
import { initTimeSync, timeSourceProfileFor, type VueStore } from '@totp/ui'
import { invoke } from '@tauri-apps/api/core'

/** localStorage 本地键 IO（desktopPrefs 同款：坏 JSON/不可写静默回退，不打断出码主流程） */
export const timeSyncStorage = {
  async load(): Promise<TimeSyncState | null> {
    try {
      const raw = localStorage.getItem(TIME_SYNC_STATE_KEY)
      return raw ? normalizeTimeSyncState(JSON.parse(raw)) : null
    } catch {
      return null
    }
  },
  async save(st: TimeSyncState): Promise<void> {
    try {
      localStorage.setItem(TIME_SYNC_STATE_KEY, JSON.stringify(st))
    } catch { /* 落盘失败不影响内存态生效 */ }
  },
}

interface TimeCalibrateDto {
  offsetMs: number
  sourceId: string
}

export function installDesktopTimeSync(s: VueStore): void {
  initTimeSync({
    load: () => timeSyncStorage.load(),
    save: (st) => timeSyncStorage.save(st),
    isNetworkMode: () => s.settings.timeSource === 'network',
    calibrate: async (preferred): Promise<{ offsetMs: number; sourceId: string }> => {
      const profile = timeSourceProfileFor(s.settings.locale)
      const r = await invoke<TimeCalibrateDto>('time_calibrate', { preferred: preferred ?? null, profile })
      return { offsetMs: r.offsetMs, sourceId: r.sourceId }
    },
  })
}
