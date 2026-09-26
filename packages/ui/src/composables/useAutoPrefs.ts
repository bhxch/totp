import { ref, type Ref } from 'vue'

/** 自动偏好形状（Cloud/Backup 两平台结构同构）：变更触发/间隔触发/间隔分钟数 */
export interface AutoPrefsShape {
  onChange: boolean
  onInterval: boolean
  intervalMinutes: number
}

/** 自动偏好读写通道（与 CloudPlatform.autoPrefs{get,set} 同形态，R7 顺带统一的消费面）：
 *  CloudCard 直传 platform.autoPrefs；BackupCard 的顶层 getAutoPrefs/setAutoPrefs 在卡内
 *  适配成同形后接入。channel 经 getter 惰性求值——platform prop 在挂载时可能尚未就绪（null）。 */
export interface AutoPrefsChannel<P> {
  get(): P | Promise<P>
  set(p: P): void | Promise<void>
}

/**
 * 卡片自动偏好三件套（R7，原 Cloud/Backup 两卡各写一份）：偏好编辑副本 +「上次自动执行」状态
 * 文本 + 三个变更 handler（任一变更以完整对象整体回写，连续切换不丢字段）。
 * 回写失败经 onError（msg 通道）而非静默成未处理 rejection（BackupCard 原实现缺 catch，
 * 借此与 CloudCard 口径对齐）；状态读取失败保持旧值（初值 null 即「暂无」）。
 */
export function useAutoPrefs<P extends AutoPrefsShape>(
  getChannel: () => AutoPrefsChannel<P> | null | undefined,
  options: { onError?: (e: unknown) => void; loadStatus?: () => string | null | Promise<string | null> } = {},
) {
  const autoPrefs = ref({ onChange: false, onInterval: false, intervalMinutes: 60 }) as Ref<P>
  const autoStatus = ref<string | null>(null)

  /** 「上次自动同步/备份」状态文本刷新（读失败保持旧值；供挂载装载与手动操作完成后重刷） */
  async function refreshStatus(): Promise<void> {
    try {
      autoStatus.value = (await options.loadStatus?.()) ?? null
    } catch { /* 状态读取失败不影响主流程 */ }
  }

  /** 挂载装载：偏好读初值（读取失败保持默认）+ 状态初值。CloudCard await 以保持既有装载时序，
   *  BackupCard 原为同步读+状态 .then，void 调用即可。get 同步返回时在调用栈内同步落初值——
   *  不留 await 微任务窗口，避免「初值回写覆盖用户挂载后立即做的内存改动」竞态 */
  async function load(): Promise<void> {
    const channel = getChannel()
    if (channel) {
      try {
        const v = channel.get()
        autoPrefs.value = { ...(v instanceof Promise ? await v : v) }
      } catch { /* 读取失败保持默认 */ }
    }
    await refreshStatus()
  }

  /** 以卡内最新偏好整体回写平台；失败走 onError（msg 通道）而非静默 */
  async function sync(): Promise<void> {
    const channel = getChannel()
    if (!channel) return
    try {
      await channel.set({ ...autoPrefs.value })
    } catch (e) {
      options.onError?.(e)
    }
  }

  function onAutoOnChange(v: boolean): void {
    autoPrefs.value = { ...autoPrefs.value, onChange: v }
    void sync()
  }
  function onAutoIntervalToggle(v: boolean): void {
    autoPrefs.value = { ...autoPrefs.value, onInterval: v }
    void sync()
  }
  function onIntervalChange(v: string | number): void {
    autoPrefs.value = { ...autoPrefs.value, intervalMinutes: Number(v) }
    void sync()
  }

  return { autoPrefs, autoStatus, load, refreshStatus, sync, onAutoOnChange, onAutoIntervalToggle, onIntervalChange }
}
