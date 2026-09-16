import { createAutoRunScheduler, decideAutoRun, type AutoRunReason, type AutoRunScheduler } from '@totp/core'

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
  /** 当前 vault JSON 快照（未锁定时才被读取） */
  getVaultJson(): string
  backupPrefs(): AutoChannelPrefs
  /** 云通道偏好；null=本端无云能力（desktop 云多目标编排 Task 11 接入前恒 null） */
  cloudPrefs(): AutoChannelPrefs | null
  getLastBackupHash(): string | null
  setLastBackupHash(h: string): void
  doBackup(json: string, secret: string): Promise<unknown>
  /** 云同步（Task 11 接入多目标编排；接入前宿主传 no-op） */
  doCloudSync(): Promise<unknown>
  /** 摘要函数注入：desktop 用 core sha256Hex(TextEncoder(vaultJson))，测试用轻量实现 */
  sha256Hex(s: string): Promise<string>
  /** 通道级错误兜底（backup/cloud）；缺省则 console.warn */
  onError?(err: unknown, channel: 'backup' | 'cloud'): void
}

export interface DesktopAutoRunner {
  notifyChanged(): void
  start(): void
  stop(): void
}

const DEFAULT_DEBOUNCE_MS = 10_000

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

  async function runBackup(reason: AutoRunReason): Promise<void> {
    const prefs = deps.backupPrefs()
    if (!prefsGate(prefs, reason)) return
    const currentHash = await deps.sha256Hex(deps.getVaultJson())
    const decision = decideAutoRun({
      currentHash,
      lastHash: deps.getLastBackupHash(),
      locked: deps.isLocked(),
      hasSecret: deps.getSecret() !== null,
    })
    if (decision.action === 'skip') return
    const secret = deps.getSecret()
    if (secret === null) return // decideAutoRun 已挡 no-secret；此处窄化满足 TS
    await deps.doBackup(deps.getVaultJson(), secret)
    deps.setLastBackupHash(currentHash)
  }

  async function runCloud(reason: AutoRunReason): Promise<void> {
    const prefs = deps.cloudPrefs()
    if (prefs === null || !prefsGate(prefs, reason)) return
    // 云侧不做 lastHash 去重：多目标编排自去重（Task 4 in-sync 判定），本地 hash 门会误伤多目标
    await deps.doCloudSync()
  }

  const backup: AutoRunScheduler = createAutoRunScheduler({
    debounceMs,
    intervalMs: () => intervalMsOf(deps.backupPrefs()),
    run: runBackup,
    onError: (err) => report(err, 'backup'),
  })
  const cloud: AutoRunScheduler = createAutoRunScheduler({
    debounceMs,
    intervalMs: () => intervalMsOf(deps.cloudPrefs()),
    run: runCloud,
    onError: (err) => report(err, 'cloud'),
  })

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
  }
}
