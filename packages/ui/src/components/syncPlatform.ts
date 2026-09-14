/** 浏览器同步状态快照（engine 写入 local 区 `sync:status`：状态是每设备各自的） */
import type { ComputedRef } from 'vue'

export interface SyncStatus {
  state: string
  at: number
  /** I57：同步区占用百分比 0..100（QUOTA_BYTES ≈ 100KB）；可选——未提供时不显示百分比 */
  pct?: number
}

/** 浏览器同步平台能力；desktop/popup 不组装（null）→ SyncCard 整卡不渲染 */
export interface SyncPlatform {
  /** 当前开关（宿主用 getter 包 reactive settings，保持响应式） */
  readonly syncEnabled: boolean
  /** [可选] 本端是否已启用落盘加密（ComputedRef 保持响应式，SyncCard 通过 .value 读取）；
   *  未提供时按未知处理（不显示明文同步警示） */
  readonly hasEncryption?: ComputedRef<boolean>
  /** 开关变更：宿主负责持久化 settings（关闭时同时写 sync:status='off'） */
  setSyncEnabled(v: boolean): Promise<void>
  /** 读取最近一次同步状态；从未写入/读取失败 → null */
  readStatus(): Promise<SyncStatus | null>
  /** 当前环境是否支持浏览器同步（chrome.storage.sync 存在）；false 时开关禁用 */
  canSync: boolean
}
