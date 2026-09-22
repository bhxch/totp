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
 * 凭据失效暂停（跨端同步 T4）：runPull reject 经 core isAuthError 判定（结构化
 * status 优先——ensureHttpOk 抛 CloudHttpError 携带数字状态码；消息「xx 请求失败
 * （HTTP nnn）」定界匹配兜底，审查 I2 收紧——旧 /401|403/ 裸匹配过宽）→ 置
 * authFailed、停 interval（防风暴重试）、经 deps.onAuthFailed 通知宿主展示重授权
 * 提示；start() 复位；手动同步成功后宿主调 resume() 复位并重启轮询（审查 I1 闭环）。
 */
import { isAuthError } from '@totp/core'

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
  /** 凭据失效标志查询（T4）：true=已因 401/403 暂停轮询；start()/resume()/同步成功复位 */
  authFailed(): boolean
  /** 凭据失效恢复闭环（审查 I1）：手动同步成功后宿主调用——复位 authFailed 并按当前
   *  intervalMs 重启轮询。与 start() 不同：不重挂解锁钩子（避免重复注册），不复位其它状态 */
  resume(): void
}

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
      // 凭据失效（审查 I2 结构化判定，消息定界兜底）：置位 + 停轮询（防风暴重试）+ 通知宿主；
      // 置位期间不重复通知
      if (isAuthError(err) && !authFailedFlag) {
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
    resume() {
      authFailedFlag = false
      stopTimer() // 幂等：未置位时重建 interval 无害（旧 timer 先清，不会双跑）
      const ms = deps.intervalMs()
      if (ms !== null) {
        timer = setInterval(() => void syncNow(), ms)
      }
    },
  }
}
