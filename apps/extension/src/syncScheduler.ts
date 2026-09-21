/**
 * 云同步跟随调度器（跨端同步 T1）：纯调度逻辑，网络能力由依赖注入，可单测。
 *
 * 安全裁定：锁定态（SW 无凭据无 DEK）禁止任何云盘网络请求——syncNow 与解锁
 * 边沿钩子均先过 gate（isUnlocked && autoFollowEnabled），未过即静默跳过。
 *
 * 使用方式（T2 接线）：popup 传 intervalMs() => null（不轮询），options 传
 * 180_000；popup/options 卸载时 stop() 清理 interval 与钩子。
 *
 * in-flight 标志防重入：一次拉取进行中的重入（如边沿+轮询同时到点）直接跳过；
 * runPull 抛错经 onError 上报，不中断调度。
 *
 * 凭据失效暂停（跨端同步 T4）：runPull reject 消息含 401/403（core ensureHttpOk
 * 抛「xx 请求失败（HTTP nnn）」形态）→ 置 authFailed、停 interval（防风暴重试）、
 * 经 deps.onAuthFailed 通知宿主展示重授权提示；start() 或同步成功即复位。
 */
export interface SyncSchedulerDeps {
  isUnlocked(): boolean
  /** 解锁状态翻转通知（false→true 边沿触发 syncNow），返回反注册函数 */
  onUnlocked(cb: () => void): () => void
  runPull(): Promise<unknown>
  /** 自动跟随开关（core settings.syncPrefs.autoFollow，Task 3 接入前可恒 true） */
  autoFollowEnabled(): boolean
  /** 轮询间隔毫秒；null 表示不轮询（popup） */
  intervalMs(): number | null
  onError(err: unknown): void
  /** [可选] 云凭据失效通知（T4）：401/403 置位时回调一次，复位后再次失效可再通知 */
  onAuthFailed?(): void
}

export interface SyncScheduler {
  /** 启动轮询（若 intervalMs 非 null）+ 注册解锁钩子；并复位凭据失效标志 */
  start(): void
  /** 清 interval 与钩子（popup/options 卸载时） */
  stop(): void
  /** 解锁且开关开启才执行；否则静默跳过 */
  syncNow(): Promise<void>
  /** 凭据失效标志查询（T4）：true=已因 401/403 暂停轮询；start()/同步成功复位 */
  authFailed(): boolean
}

/** 认证类错误判定：core ensureHttpOk 抛 `${label} 请求失败（HTTP ${status}）`，字符串含状态码 */
const AUTH_ERR_RE = /401|403/

export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
  let timer: ReturnType<typeof setInterval> | null = null
  let unregister: (() => void) | null = null
  let inFlight = false
  let authFailedFlag = false

  const gateOpen = (): boolean => deps.isUnlocked() && deps.autoFollowEnabled()

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const syncNow = async (): Promise<void> => {
    if (!gateOpen() || inFlight) return
    inFlight = true
    try {
      await deps.runPull()
      authFailedFlag = false // 同步成功即复位（凭据已恢复/已更换）
    } catch (err) {
      // 凭据失效：置位 + 停轮询（防风暴重试）+ 通知宿主；置位期间不重复通知
      if (AUTH_ERR_RE.test(String(err)) && !authFailedFlag) {
        authFailedFlag = true
        stopTimer()
        deps.onAuthFailed?.()
      }
      deps.onError(err)
    } finally {
      inFlight = false
    }
  }

  return {
    start() {
      authFailedFlag = false // 下次 start() 复位（brief 复位语义：重启宿主即给恢复机会）
      unregister = deps.onUnlocked(() => {
        if (gateOpen()) void syncNow()
      })
      const ms = deps.intervalMs()
      if (ms !== null) {
        timer = setInterval(() => void syncNow(), ms)
      }
    },
    stop() {
      stopTimer()
      unregister?.()
      unregister = null
    },
    syncNow,
    authFailed: () => authFailedFlag,
  }
}
