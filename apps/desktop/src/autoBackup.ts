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
}

const DEFAULT_DEBOUNCE_MS = 10_000

/** doBackup 结果 → 中文 summary（Minor-6 中文化；未知结果兜底「已完成」） */
const BACKUP_RESULT_LABEL: Record<string, string> = { created: '已创建备份', overwritten: '已覆盖备份' }

/** 自动状态 JSON → 卡片展示文本（design §4.1）：「YYYY-MM-DD HH:mm 成功/失败/跳过：summary」；
 *  缺字段/坏 JSON/null → null（卡片显示「暂无」）。ok=null 渲染「跳过」（写侧 summary 仅存原因，
 *  前缀由本函数拼装）；旧 JSON 的 ok 恒为 true/false，照常渲染成功/失败。
 *  纯函数导出：App.vue readAutoStatusText 委托实现，抽出供三态单测（审查 Minor-2） */
export function formatAutoStatusText(raw: string | null): string | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as { at?: unknown; ok?: unknown; summary?: unknown }
    if (typeof s.at !== 'number' || typeof s.summary !== 'string' || s.summary === '') return null
    const d = new Date(s.at)
    const p = (n: number) => String(n).padStart(2, '0')
    const label = s.ok === null ? '跳过' : s.ok === true ? '成功' : '失败'
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${label}：${s.summary}`
  } catch {
    return null
  }
}

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
      const r = await deps.doBackup(deps.getVaultJson(), secret)
      deps.setLastBackupHash(currentHash)
      // 状态记录（design §4.1）：summary 取 doBackup 结果——created/overwritten 走中文化 label 表，
      // plan16 T14 起多源中文摘要（如「已备份到 2 个目录（…）」）不在表内，原样透传（诚实反映每源成败）
      deps.recordStatus?.(true, typeof r === 'string' ? (BACKUP_RESULT_LABEL[r] ?? r) : '已完成')
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
    // 明文内容 hash 门落地（doCloudSync 即该 runner，见 packages/ui/src/components/cloudRunner.ts），
    // 编排层现状仍每轮全量 syncWithCloud
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
