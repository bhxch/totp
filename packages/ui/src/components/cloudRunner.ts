/**
 * 云自动同步 runner（D6 宿主侧编排，desktop/extension 双端共享；原 desktop cloudRunner 上提）：
 * 把启用的多目标凭据组装为 core syncMultipleTargets 输入并执行。守护与裁定：
 * - 仅解锁会话内执行（锁定/无 secret 直接 return），与自动备份 runner 同口径；
 * - 冲突副本经 onConflictBackup 落盘（宿主 saveConflictBackup），adopt 分支自动执行、
 *   不弹确认——设计 §4「自动执行结果不打扰」（区别于 CloudCard 手动同步的两步确认）；
 * - 单目标失败由 core 编排隔离（outcome=null + error），仅全程意外抛错才走 onError；
 * - 已知边界：busy 只防 runner 重入（自动与自动重叠），与 CloudCard 手动同步可能并发，
 *   由两边各自的 hash 回写顺序兜底（后完成者覆盖基线），不引入跨实例锁。
 */
import { resolveObjectPath, syncMultipleTargets, type CloudBackend, type CloudCred } from '@totp/core'
import { CLOUD_ACTION_LABEL, type CloudTarget } from './cloudPlatform'

export interface CloudRunnerDeps {
  /** 锁定态：锁定或无 secret 时自动触发直接跳过 */
  isLocked(): boolean
  /** 会话口令（null=无） */
  getSecret(): string | null
  /** 当前 vault JSON 快照 */
  getVaultJson(): string
  loadCreds(): Promise<CloudTarget[]>
  loadTargetHash(backend: string): Promise<string | null>
  saveTargetHash(backend: string, hash: string | null): Promise<void>
  /** 凭据 → backend 实例。生产=core 五工厂 dispatch；测试=注入 fake */
  makeBackend(cred: CloudCred): CloudBackend
  /** 采纳云端版本后整体替换本地存储（生产=store.replaceAllOp） */
  persistAdopted(json: string): Promise<void>
  /** 冲突副本落盘（key=目标 backend 键）；缺省则丢弃副本提示 */
  saveConflictBackup?(key: string, bytes: Uint8Array): void
  /** 「上次自动同步」状态记录（design §4.1：desktop 写 localStorage / extension 写 storage.local 的 cloudAutoStatus）。
   *  三态（批 4）：true=成功 / false=失败 / null=跳过（锁定/无 secret/空目标；记录仅来自自动通道——
   *  手动同步走 CloudCard 自身的 platform 链路，不经过本 runner，不会污染手动状态行） */
  recordStatus?(ok: boolean | null, summary: string): void
  onError?(err: unknown): void
}

/** 模块级防重入标志：run 在途时再次 run 直接 return（自动与自动重叠防护） */
let busy = false

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createCloudSyncRunner(deps: CloudRunnerDeps): { run(): Promise<void> } {
  async function run(): Promise<void> {
    if (busy) return
    // 跳过态可观测（批 4 裁定）：锁定/无 secret/空目标是「用户需要知道的原因」，return 前记 null 跳过态。
    // summary 仅存原因文本，不携带「跳过：」前缀——前缀由宿主格式化按 ok=null 拼装（label 拼装职责单一）。
    // 写入频率自审：调度器防抖 10s / 到点 ≥15min，每次触发事件至多写一条，量级可接受
    if (deps.isLocked()) {
      deps.recordStatus?.(null, '库已锁定')
      return
    }
    const secret = deps.getSecret()
    if (secret === null) {
      deps.recordStatus?.(null, '未设置备份口令')
      return // 自动触发只在解锁会话内
    }
    busy = true
    try {
      const targets = (await deps.loadCreds()).filter((t) => t.enabled)
      if (targets.length === 0) {
        deps.recordStatus?.(null, '未启用云目标')
        return
      }
      const inputs = await Promise.all(
        targets.map(async (t) => ({
          key: t.cred.backend,
          backend: deps.makeBackend(t.cred),
          path: resolveObjectPath(t.cred),
          hash: await deps.loadTargetHash(t.cred.backend),
        })),
      )
      const r = await syncMultipleTargets({
        targets: inputs,
        vaultJson: deps.getVaultJson(),
        password: secret,
        onConflictBackup: (key, bytes) => {
          deps.saveConflictBackup?.(key, bytes)
        },
      })
      // 采纳先于基线回写（审查裁定）：persistAdopted 失败则本轮 hashes 一并不落盘，下轮基线
      // 缺失/为旧值 → 自动重试下载；若先写基线，失败会使下轮全线 in-sync，云端较新版本永远
      // 不再被自动下载（静默僵持无自愈）
      if (r.adopted) await deps.persistAdopted(r.finalVaultJson)
      // 回写各目标基线：成功目标=新 hash；失败目标（hashes 无键）=null 即删除基线（下轮全量重比）
      for (const t of inputs) await deps.saveTargetHash(t.key, r.hashes[t.key] ?? null)
      // summary 动作中文化（Minor-6）：与手动同步状态行同口径；单目标失败（outcome=null）记「失败」
      deps.recordStatus?.(true, r.results.map((x) => `${x.key}: ${x.outcome ? CLOUD_ACTION_LABEL[x.outcome.action] : '失败'}`).join('; '))
    } catch (err) {
      deps.onError?.(err)
      deps.recordStatus?.(false, errMsg(err).slice(0, 100))
    } finally {
      busy = false
    }
  }
  return { run }
}
