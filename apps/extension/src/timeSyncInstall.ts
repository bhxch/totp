/**
 * 扩展端时间源装配（spec §4）：popup/options 各上下文安装一次 ui timeSource 单例——
 * 设备本地键=ext.storage.local['timeSyncState']（与 vault/settings 同 adapter 分区，浏览器
 * sync 同步引擎只同步白名单键，timeSyncState 不在列）；校准器=sendMessage 驱动 background
 * 执行（SW 长驻，popup 关闭中断无碍——下次打开再校）。unlock 窗不安装（无出码列表，解锁自关）。
 *
 * 源链剖面（2026-11-13 全球链）：由**界面语言**判定（timeSourceProfileFor），随校准消息带给
 * background——SW 无设置上下文（locale 在 settings，SW 不读），故判定留在页面侧。
 */
import { normalizeTimeSyncState, TIME_SYNC_STATE_KEY, type TimeSyncState } from '@totp/core'
import { initTimeSync, timeSourceProfileFor, type CalibrateResult, type VueStore } from '@totp/ui'
import { ext } from './extApi'

/** 消息回包形状（background time-sync-calibrate 分支） */
interface CalibrateResponse {
  ok: boolean
  offsetMs?: number
  sourceId?: string
}

/** 页面端校准客户端：发消息给 background，等回包（handler 返回 true 保住 sendResponse 通道） */
async function calibrateViaBackground(preferred: string | null, profile: 'cn' | 'global'): Promise<CalibrateResult> {
  const resp = (await ext!.runtime.sendMessage({ type: 'time-sync-calibrate', preferred, profile })) as CalibrateResponse | undefined
  if (!resp?.ok || typeof resp.offsetMs !== 'number' || typeof resp.sourceId !== 'string') {
    throw new Error('time source: background calibration failed')
  }
  return { offsetMs: resp.offsetMs, sourceId: resp.sourceId }
}

/** 安装（popup main.ts / options App.vue setup 调用）；load/save 的 IO 错误吞掉仅影响本次
 *  读取（内存态回退空状态），不打断出码主流程 */
export function installExtensionTimeSync(store: VueStore): void {
  initTimeSync({
    load: async (): Promise<TimeSyncState | null> => {
      try {
        const got = await ext!.storage.local.get(TIME_SYNC_STATE_KEY)
        const raw = got[TIME_SYNC_STATE_KEY]
        return typeof raw === 'string' ? normalizeTimeSyncState(JSON.parse(raw)) : null
      } catch {
        return null
      }
    },
    save: async (st) => {
      try {
        await ext!.storage.local.set({ [TIME_SYNC_STATE_KEY]: JSON.stringify(st) })
      } catch { /* 落盘失败不影响内存态生效（校准结果本会话仍生效） */ }
    },
    isNetworkMode: () => store.settings.timeSource === 'network',
    // 剖面现取（语言设置可运行时切换）：locale 变更后下次校准即走对应链
    calibrate: (preferred) => calibrateViaBackground(preferred, timeSourceProfileFor(store.settings.locale)),
  })
}
