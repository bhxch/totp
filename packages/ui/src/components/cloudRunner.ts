/**
 * 云自动同步 runner（D6 宿主侧编排，desktop/extension 双端共享；原 desktop cloudRunner 上提）：
 * 把启用的源+凭据对组装为 core syncMultipleTargets 输入并执行。守护与裁定：
 * - 仅解锁会话内执行（锁定/无 secret 直接 return），与自动备份 runner 同口径；
 * - 冲突副本经 onConflictBackup 落盘（宿主 saveConflictBackup），adopt 分支自动执行、
 *   不弹确认——设计 §4「自动执行结果不打扰」（区别于 CloudCard 手动同步的两步确认）；
 * - 单目标失败由 core 编排隔离（outcome=null + error），仅全程意外抛错才走 onError；
 * - keep 源 outcome=uploaded（含收敛改写后 uploaded）后执行 enforceRemoteRetention 远端滚动删除，
 *   结果经 onRetentionDeleted 交宿主记录（deleted=-1=后端不支持，宿主降级提示）；清理全程逐源
 *   try/catch 隔离，失败不影响该源上传结果与其余源（下轮重试）；
 * - 已知边界：busy 只防 runner 重入（自动与自动重叠），与 CloudCard 手动同步可能并发，
 *   由两边各自的 hash 回写顺序兜底（后完成者覆盖基线），不引入跨实例锁；
 * - 明文内容 hash 门（审查 I1 最小闭环）：core in-sync 判据生产不可达（远端恒为 envelope 密文，
 *   见 core multiTarget 头注释勘误），自动通道在本 runner 内做内容级门——上次自动同步成功时的
 *   sha256(vaultJson) 与当前相同则不发起任何同步（实例内存级，宿主页存活期生效，跨会话/页面重开
 *   首次仍会同步一次）；手动通道（run('manual')）不设门，对齐设计「手动不跳过」。
 */
import {
  enforceRemoteRetention, resolveObjectPath, resolveTimestampPath, sha256Hex, syncMultipleTargets,
  type BackupSource, type CloudBackend, type CloudCred, type CloudSyncOutcome, type ConflictBackupResult, type KdfProfile,
} from '@totp/core'

export interface CloudRunnerDeps {
  /** 锁定态：锁定或无 secret 时自动触发直接跳过 */
  isLocked(): boolean
  /** 会话口令（null=无） */
  getSecret(): string | null
  /** 当前 vault JSON 快照 */
  getVaultJson(): string
  /** 启用源与其凭据对（宿主装配：元数据自 backupSources、凭据自保管区 credsCache；锁定态凭据缺失自然为空） */
  loadSources(): Promise<Array<{ source: BackupSource; cred: CloudCred }>>
  loadTargetHash(sourceId: string): Promise<string | null>
  saveTargetHash(sourceId: string, hash: string | null): Promise<void>
  /** 凭据 → backend 实例。生产=core 五工厂 dispatch；测试=注入 fake */
  makeBackend(cred: CloudCred): CloudBackend
  /** 采纳云端版本后整体替换本地存储（生产=store.replaceAllOp） */
  persistAdopted(json: string): Promise<void>
  /** 冲突副本落盘（key=源 id）；缺省则丢弃副本提示。审查 I9：返回 Promise 时 rejection
   *  经 core 编排 await 链传播——该目标记为失败（不采纳远端、不回推覆盖云端），本地旧内容
   *  在无副本落盘的情况下不被覆盖；fire-and-forget（void）保持旧行为。返回文件名（desktop
   *  saveConflictBackupToDir 的形态）时随该目标 outcome.conflictBackup 透传，编排层不消费 */
  saveConflictBackup?(key: string, bytes: Uint8Array): ConflictBackupResult
  /** KDF 档位（备份设置所选，信封生成用）；缺省 balanced */
  kdfProfile?: () => KdfProfile
  /** keep 源滚动删除完成回调（sourceId=显示名（deps.sourceName 解析，缺省回退源 id）；deleted=实际删除
   *  份数；-1=后端不支持，宿主降级提示）；缺省忽略 */
  onRetentionDeleted?(sourceId: string, deleted: number): void
  /** 源 id → 显示名（审查 I4：宿主从源列表取 name，取不到回退 id）。recordStatus summary 与
   *  onRetentionDeleted 提示统一用显示名，避免新建源的 uuid 直接上屏；缺省直接用源 id */
  sourceName?(id: string): string
  /** 「上次自动同步」状态记录（design §4.1：desktop 写 localStorage / extension 写 storage.local 的 cloudAutoStatus）。
   *  三态（批 4）：true=成功 / false=失败 / null=跳过（锁定/无 secret/空目标/内容无变化；记录仅来自自动通道——
   *  手动同步走 CloudCard 自身的 platform 链路，不经过本 runner，不会污染手动状态行） */
  recordStatus?(ok: boolean | null, summary: string): void
  /** 状态摘要翻译器（D2 抽串）：宿主注入（i18n.global.t 同签名），key 见 common.json cloudRunner.*。
   *  摘要随 recordStatus 持久化，翻译发生在记录时（locale 切换不改已落盘摘要，与手动卡状态行同限制） */
  t(key: string, params?: Record<string, unknown>): string
  onError?(err: unknown): void
  /** [可选] 云凭据失效通知（跨端同步 T4）：任一目标错误消息含 401/403 时回调（消息原文，
   *  含 HTTP 状态码）。core 编排对目标级失败不抛错（outcome=null + error），宿主调度器无法
   *  经 reject 感知，经此钩子感知后暂停自动跟随；缺省不回调（desktop 零影响） */
  onAuthFailure?(err: string): void
}

/** 同步动作 → 状态文案 key（D2：原 CLOUD_ACTION_LABEL zh 常量上移至 common.json cloudRunner.action.*） */
const ACTION_LABEL_KEY: Record<CloudSyncOutcome['action'], string> = {
  uploaded: 'cloudRunner.action.uploaded',
  downloaded: 'cloudRunner.action.downloaded',
  'conflict-resolved': 'cloudRunner.action.conflictResolved',
  'in-sync': 'cloudRunner.action.inSync',
}

/** 模块级防重入标志：run 在途时再次 run 直接 return（自动与自动重叠防护） */
let busy = false

const encoder = new TextEncoder()

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createCloudSyncRunner(deps: CloudRunnerDeps): { run(mode?: 'auto' | 'manual'): Promise<void> } {
  /**
   * 自动通道明文内容 hash 门基线（审查 I1 最小闭环）：上次「全部目标确定结果」自动同步时的
   * sha256(vaultJson)。实例内存级——宿主页存活期生效，跨会话/页面重开首次仍会同步一次（最小闭环
   * 边界）；仅全部目标 outcome 非 null 且无 convergeError 时刷新（以 core 收敛后的最终内容为准：
   * 无采纳=入参快照，采纳=persistAdopted 落地的云端版本），存在部分失败/收敛失败置 null 强制下轮
   * 全流程重试，catch 意外同样不刷新。手动通道不设门但成功后同样刷新基线，手动推完的内容后续
   * 自动 tick 无需重传。
   */
  let lastAutoVaultHash: string | null = null
  /** 显示名解析：sourceName 提供时用宿主名称，否则回退源 id（审查 I4） */
  const displayName = (id: string): string => deps.sourceName?.(id) ?? id
  async function run(mode: 'auto' | 'manual' = 'auto'): Promise<void> {
    if (busy) return
    // 跳过态可观测（批 4 裁定）：锁定/无 secret/空目标是「用户需要知道的原因」，return 前记 null 跳过态。
    // summary 仅存原因文本，不携带「跳过：」前缀——前缀由宿主格式化按 ok=null 拼装（label 拼装职责单一）。
    // 写入频率自审：调度器防抖 10s / 到点 ≥15min，每次触发事件至多写一条，量级可接受
    if (deps.isLocked()) {
      deps.recordStatus?.(null, deps.t('cloudRunner.lockedVault'))
      return
    }
    const secret = deps.getSecret()
    if (secret === null) {
      deps.recordStatus?.(null, deps.t('cloudRunner.noSecret'))
      return // 自动触发只在解锁会话内
    }
    busy = true
    try {
      const vaultJson = deps.getVaultJson()
      // 自动通道内容门（审查 I1）：已有基线且明文内容未变 → 不发起任何同步（连 loadSources 都不进，
      // 零网络请求），记 null 跳过态；manual 不设门（对齐设计「手动不跳过」）
      if (mode === 'auto' && lastAutoVaultHash !== null && (await sha256Hex(encoder.encode(vaultJson))) === lastAutoVaultHash) {
        deps.recordStatus?.(null, deps.t('cloudRunner.noChange'))
        return
      }
      const pairs = (await deps.loadSources()).filter((p) => p.source.enabled)
      if (pairs.length === 0) {
        deps.recordStatus?.(null, deps.t('cloudRunner.noSources'))
        return
      }
      const inputs = await Promise.all(
        pairs.map(async ({ source, cred }) => ({
          key: source.id,
          backend: deps.makeBackend(cred),
          // keep 源每次写新时间戳文件；overwrite 源写固定对象路径（均经 core 校验/缺省回落）
          path: source.retention.type === 'keep' ? resolveTimestampPath(cred, new Date()) : resolveObjectPath(cred),
          hash: await deps.loadTargetHash(source.id),
        })),
      )
      const r = await syncMultipleTargets({
        targets: inputs,
        vaultJson,
        password: secret,
        // 审查 I9：saveConflictBackup 的 Promise 原样交回 core（syncWithCloud await 该回调），
        // 写盘拒绝 → 该目标同步失败（outcome=null + error），防止无本地副本时照常采纳远端并回推
        onConflictBackup: (key, bytes) => deps.saveConflictBackup?.(key, bytes),
        profile: deps.kdfProfile?.(),
      })
      // 采纳先于基线回写（审查裁定）：persistAdopted 失败则本轮 hashes 一并不落盘，下轮基线
      // 缺失/为旧值 → 自动重试下载；若先写基线，失败会使下轮全线 in-sync，云端较新版本永远
      // 不再被自动下载（静默僵持无自愈）
      if (r.adopted) await deps.persistAdopted(r.finalVaultJson)
      // 回写各源基线：成功目标=新 hash；失败目标（hashes 无键）=null 即删除基线（下轮全量重比）
      for (const t of inputs) await deps.saveTargetHash(t.key, r.hashes[t.key] ?? null)
      // keep 源滚动删除（基线回写后执行；复用 input.backend 实例，onCredChange 回写口径一致）：
      // 仅对 outcome=uploaded（上传/收敛回推成功）的源执行——in-sync 无新文件，失败源无可清理依据。
      // per-source try/catch 隔离：listBackups 网络抛错或宿主回调抛错只损失本轮清理（下轮重试），
      // 不改写该源 uploaded 结果、不中断其余源清理与最终 summary（上传成功的既成事实不因清理失败回滚）
      for (const { source } of pairs) {
        if (source.retention.type !== 'keep') continue
        const res = r.results.find((x) => x.key === source.id)
        if (!res?.outcome || res.outcome.action !== 'uploaded') continue
        const backend = inputs.find((x) => x.key === source.id)!.backend
        try {
          const deleted = await enforceRemoteRetention(backend, source.retention.n)
          deps.onRetentionDeleted?.(displayName(source.id), deleted)
        } catch {
          // 不进 onError（区别于编排层意外）：清理失败下轮同步自动重试
        }
      }
      // summary 动作文案（Minor-6 → D2 i18n）：与手动同步状态行同口径；单目标失败（outcome=null）记失败；
      // 源显示名（审查 I4）：sourceName 提供时用名称，新建源 uuid 不上屏。
      // 内容门基线刷新裁定（复审必修）：core 对单目标失败（outcome=null）与收敛回推失败（convergeError）
      // 均不抛错，仅当全部目标拿到确定结果（outcome 非 null 且无 convergeError）才以 finalVaultJson 刷新
      // 基线；否则置 null——下轮不被门短路，失败目标按「删基线全量重比」既有自愈重试，防部分失败被门
      // 吸收成静默僵死。全程意外走 catch 同样不刷新（catch 内不动基线，保持 null/旧值语义）
      const allSettled = r.results.every((x) => x.outcome !== null && !x.convergeError)
      lastAutoVaultHash = allSettled ? await sha256Hex(encoder.encode(r.finalVaultJson)) : null
      // T4 凭据失效分类：目标级失败不抛错，宿主调度器无从感知——在此扫描错误消息，401/403 上抛钩子
      const authErr = r.results.find((x) => x.outcome === null && x.error !== undefined && /401|403/.test(x.error))
      if (authErr?.error !== undefined) deps.onAuthFailure?.(authErr.error)
      deps.recordStatus?.(true, r.results.map((x) => `${displayName(x.key)}: ${x.outcome ? deps.t(ACTION_LABEL_KEY[x.outcome.action]) : deps.t('cloudRunner.failed')}`).join('; '))
    } catch (err) {
      deps.onError?.(err)
      deps.recordStatus?.(false, errMsg(err).slice(0, 100))
    } finally {
      busy = false
    }
  }
  return { run }
}
