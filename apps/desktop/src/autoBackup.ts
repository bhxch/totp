import { createAutoRunScheduler, decideAutoRun, loadSources, sha256Hex, type AutoRunReason, type AutoRunScheduler, type StorageAdapter } from '@totp/core'
import type { VueStore } from '@totp/ui'
import { createBackupToSources, type BackupSourcesResult } from './backupService'
import {
  BACKUP_AUTO_STATUS_KEY, loadBackupPrefs, loadCloudPrefs, readLastBackupHash, recordAutoStatus, writeLastBackupHash,
} from './desktopPrefs'

/** 自动通道偏好（形态与 ui BackupAutoPrefs 一致；desktop 宿主经 loadBackupPrefs 提供） */
export interface AutoChannelPrefs {
  onChange: boolean
  onInterval: boolean
  intervalMinutes: number
}

export interface AutoBackupDeps {
  /** 锁定态（decideAutoRun 的 locked 守护源） */
  isLocked(): boolean
  /** 会话备份口令（null=无，decideAutoRun 的 no-secret 守护源） */
  getSecret(): string | null
  /** 当前 vault JSON 快照（unchanged 判定用；备份本体由 doBackup 内部单次取快照，见 M3） */
  getVaultJson(): string
  backupPrefs(): AutoChannelPrefs
  /** 云通道偏好；null=本端无云能力（desktop 云多目标编排 Task 11 接入前恒 null） */
  cloudPrefs(): AutoChannelPrefs | null
  getLastBackupHash(): string | null
  setLastBackupHash(h: string): void
  /** 备份执行（审查 M3）：secret 由 runner 传入，vault 快照由实现内部单次取得并随
   *  BackupSourcesResult.vaultJson 返回——runner 以落盘内容计基线 hash，消除先算后备份的窗口 */
  doBackup(secret: string): Promise<BackupSourcesResult>
  /** 云同步（Task 11 接入多目标编排；接入前宿主传 no-op） */
  doCloudSync(): Promise<unknown>
  /** 摘要函数注入：desktop 用 core sha256Hex(TextEncoder(vaultJson))，测试用轻量实现 */
  sha256Hex(s: string): Promise<string>
  /** 「上次自动备份」状态记录（design §4.1：App.vue 写 localStorage backupAutoStatus）；缺省不记录。
   *  三态（批 4）：true=成功 / false=失败 / null=跳过（locked/no-secret 等用户需要知道的原因；unchanged 静默不记） */
  recordStatus?(ok: boolean | null, summary: string): void
  /** 通道级错误兜底（backup/cloud）；缺省则 console.warn */
  onError?(err: unknown, channel: 'backup' | 'cloud'): void
}

export interface DesktopAutoRunner {
  notifyChanged(): void
  start(): void
  stop(): void
  /** 手动触发一次备份通道（spec §6.1 trigger_backup 执行体）：绕过通道偏好门（MCP 显式
   *  请求非自动调度，不与 onChange/onInterval 开关挂钩），decideAutoRun 守护照常——
   *  locked/no-secret/unchanged 跳过即静默返回（bridge 侧前置检查已给结构化 reason，不重复）；
   *  业务结果经状态行呈现，不向调用方回传 vault 数据 */
  runBackupNow(): Promise<void>
}

const DEFAULT_DEBOUNCE_MS = 10_000

// 格式化纯函数本体已移入 desktopPrefs.ts（状态键所有权归其处，消除与本模块的循环导入）；
// 此处 re-export 兼容既有导入面（autoBackup.test 等三态单测）
export { formatAutoStatusText } from './desktopPrefs'

/** desktop 自动备份 runner（D2）：backup/cloud 双通道各挂一个 core 调度器。
 *  锁定/无 secret/unchanged 的守护全部收敛在 core decideAutoRun（调度触发永不绕过） */
export function createDesktopAutoRunner(deps: AutoBackupDeps, opts?: { debounceMs?: number }): DesktopAutoRunner {
  const debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS

  function report(err: unknown, channel: 'backup' | 'cloud'): void {
    if (deps.onError) deps.onError(err, channel)
    else console.warn(`[autoBackup:${channel}]`, err)
  }

  function prefsGate(prefs: AutoChannelPrefs, reason: AutoRunReason): boolean {
    if (reason === 'change') return prefs.onChange
    return prefs.onInterval
  }

  function intervalMsOf(prefs: AutoChannelPrefs | null): number | null {
    // 每次 tick 重新求值（core 调度器约定）；min 15min 由宿主 loadBackupPrefs 兜底，此处不重复钳制
    if (prefs === null || !prefs.onInterval) return null
    return prefs.intervalMinutes * 60_000
  }

  async function runBackup(reason: AutoRunReason, opts?: { skipPrefsGate?: boolean }): Promise<void> {
    const prefs = deps.backupPrefs()
    if (!opts?.skipPrefsGate && !prefsGate(prefs, reason)) return
    try {
      const currentHash = await deps.sha256Hex(deps.getVaultJson())
      const decision = decideAutoRun({
        currentHash,
        lastHash: deps.getLastBackupHash(),
        locked: deps.isLocked(),
        hasSecret: deps.getSecret() !== null,
      })
      if (decision.action === 'skip') {
        // 跳过态可观测（批 4 裁定）：locked/no-secret 是「用户开了开关却无法执行」的原因，记 null 跳过态；
        // unchanged 维持静默（内容没变无需用户处理）。summary 仅存原因文本，不携带「跳过：」前缀——
        // 前缀由宿主格式化按 ok=null 拼装（label 拼装职责单一）。写入频率自审：调度器防抖 10s（change）/
        // 到点 ≥15min（interval），每次触发事件至多写一条，量级可接受
        if (decision.cause === 'locked') deps.recordStatus?.(null, '库已锁定')
        else if (decision.cause === 'no-secret') deps.recordStatus?.(null, '未设置备份口令')
        return
      }
      const secret = deps.getSecret()
      if (secret === null) return // decideAutoRun 已挡 no-secret；此处窄化满足 TS
      // 审查 I8：doBackup 返回结构化成败结果，基线推进与状态记录按 outcome 如实处理——
      // 仅全部启用源成功才写 lastBackupHash（部分/全部失败不写基线，下轮同内容也会重试，
      // 不再出现「recordStatus(true, 备份失败：X)」自相矛盾 + unchanged 跳过致静默停摆）
      const r = await deps.doBackup(secret)
      if (r.outcome === 'ok') {
        // 审查 M3：基线以实际落盘内容（doBackup 内部单次快照）计 hash——decisionHash 判定与
        // 落盘之间 vault 再变时，基线不会新于落盘内容（下轮照常重跑，不会漏备份）
        deps.setLastBackupHash(await deps.sha256Hex(r.vaultJson))
        deps.recordStatus?.(true, r.summary)
        return
      }
      if (r.outcome === 'empty') {
        // 无启用源：无可备份内容，记跳过态且不写基线（防止先记基线后配源时变更被 unchanged 误吞）
        deps.recordStatus?.(null, r.summary)
        return
      }
      // partial / failed：失败明细（summary 含失败源名，截断口径与 catch 分支一致）
      deps.recordStatus?.(false, r.summary.slice(0, 100))
    } catch (err) {
      // 失败也记状态；rethrow 交调度器 onError 兜底（行为不变）
      deps.recordStatus?.(false, (err instanceof Error ? err.message : String(err)).slice(0, 100))
      throw err
    }
  }

  async function runCloud(reason: AutoRunReason): Promise<void> {
    const prefs = deps.cloudPrefs()
    if (prefs === null || !prefsGate(prefs, reason)) return
    // 云侧不做 lastHash 去重。勘误（2026-09-18 审查）：原注释声称「多目标编排自去重（in-sync 判定）」，
    // 实际该判据拿远端 envelope 密文摘要与本地明文摘要比较，生产形态下不可达，编排层并无去重；
    // 本地 hash 门会误伤多目标（各目标基线独立）。云通道内容级去重已由 cloudRunner 的自动通道
    // 明文内容 hash 门落地（doCloudSync 即该 runner，见 packages/ui/src/components/cloudRunner.ts）。
    // T8 起编排层为 rev 逻辑时钟（syncWithCloudRev）：基线一致即 in-sync 零写，不再每轮全量重推
    await deps.doCloudSync()
  }

  // 通道级 single-flight（审查 Important 1 + M12 终审勘误）：bridge_call 5s 超时 + 慢备份 →
  // 客户端收 "app busy" 重试 → 二次受理并发触发；且 MCP trigger_backup 与防抖调度的自动轮
  // 是两条入口，若只串行化 runBackupNow 自身仍可并发执行同一备份通道。in-flight promise 链
  // 收敛到通道级：调度轮与 trigger 轮排队依次执行不并发 doBackup——后轮在基线推进后照常执行，
  // unchanged 自然跳过，不会冗余备份或双写基线（与 cloudRunner single-flight 同法）
  let backupChain: Promise<void> = Promise.resolve()
  function enqueueBackup(job: () => Promise<void>): Promise<void> {
    const next = backupChain.then(job, job)
    // 链不断：前轮失败（runBackup rethrow）不阻断后续轮次
    backupChain = next.catch(() => {})
    return next
  }
  function runBackupNow(): Promise<void> {
    return enqueueBackup(() => runBackup('change', { skipPrefsGate: true }))
  }

  const backup: AutoRunScheduler = createAutoRunScheduler({
    debounceMs,
    intervalMs: () => intervalMsOf(deps.backupPrefs()),
    run: (reason) => enqueueBackup(() => runBackup(reason)),
    onError: (err) => report(err, 'backup'),
  })
  const cloud: AutoRunScheduler = createAutoRunScheduler({
    debounceMs,
    intervalMs: () => intervalMsOf(deps.cloudPrefs()),
    run: runCloud,
    onError: (err) => report(err, 'cloud'),
  })

  // 实例装配：备份通道 single-flight 见上方 enqueueBackup（调度轮与 trigger 轮共用一条链）

  return {
    notifyChanged() {
      backup.notifyChanged()
      cloud.notifyChanged()
    },
    start() {
      backup.start()
      cloud.start()
    },
    stop() {
      backup.stop()
      cloud.stop()
    },
    // reason 仅被 prefsGate 消费，跳过偏好门后无语义；执行体与守护与自动通道完全同一份
    runBackupNow,
  }
}

/** desktop 自动通道装配 deps（P4 自 App.vue 抽出）：store/adapter 闭包实时读取 + 云编排注入 */
export interface DesktopAutoChannelsDeps {
  getStore(): VueStore | null
  getAdapter(): StorageAdapter | null
  /** 云通道（Task 11 接入）：desktop 云多目标编排（createDesktopCloudSync 的 run），busy 防重入内建于 runner */
  doCloudSync(): Promise<unknown>
}

/** desktop 自动备份双通道装配（P4 自 App.vue onMounted 前的 setup 段抽出，纯搬移行为不变）：
 *  deps 闭包实时读 store/adapter/localStorage，store 未就绪时 isLocked 兜底 true →
 *  decideAutoRun skip，保证锁定态/未初始化永不自动写 */
export function createDesktopAutoChannels(deps: DesktopAutoChannelsDeps): DesktopAutoRunner {
  function requireAdapter(): StorageAdapter {
    const a = deps.getAdapter()
    if (!a) throw new Error('数据尚未就绪')
    return a
  }
  return createDesktopAutoRunner({
    isLocked: () => deps.getStore()?.locked.value ?? true,
    getSecret: () => deps.getStore()?.backupSecret.value ?? null,
    getVaultJson: () => JSON.stringify(deps.getStore()?.vault ?? null),
    backupPrefs: () => loadBackupPrefs(),
    // 云通道偏好（Task 11 接入）：与 CloudCard autoPrefs 同一读写实现（cloudAutoPrefs 键）
    cloudPrefs: () => loadCloudPrefs(),
    getLastBackupHash: () => readLastBackupHash(),
    setLastBackupHash: (h) => writeLastBackupHash(h),
    doBackup: async (secret) => {
      // plan16 T14：全部启用本地源各按 retention 落盘；审查 I8：返回结构化成败结果（部分失败
      // 不推进基线）；审查 M3：vault 快照在此单次取得并随结果返回，runner 以落盘内容计基线 hash
      const all = await loadSources(requireAdapter())
      const vaultJson = JSON.stringify(deps.getStore()?.vault ?? null)
      const profile = deps.getStore()?.settings.backupKdfProfile ?? 'balanced'
      return createBackupToSources(all, vaultJson, secret, profile)
    },
    doCloudSync: () => deps.doCloudSync(),
    // core sha256Hex 接收字节：vault JSON → UTF-8 编码后摘要
    sha256Hex: (s) => sha256Hex(new TextEncoder().encode(s)),
    // 「上次自动备份/同步」状态记录（design §4.1；Task 13 卡片渲染消费）
    recordStatus: (ok, summary) => recordAutoStatus(BACKUP_AUTO_STATUS_KEY, ok, summary),
    onError: (err, channel) => console.warn(`[autoBackup:${channel}]`, err),
  })
}
