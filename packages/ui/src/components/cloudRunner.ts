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
  /** 「上次自动同步」状态记录（design §4.1：desktop 写 localStorage / extension 写 storage.local 的 cloudAutoStatus） */
  recordStatus?(ok: boolean, summary: string): void
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
    const secret = deps.getSecret()
    if (deps.isLocked() || secret === null) return // 自动触发只在解锁会话内
    busy = true
    try {
      const targets = (await deps.loadCreds()).filter((t) => t.enabled)
      if (targets.length === 0) return
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
