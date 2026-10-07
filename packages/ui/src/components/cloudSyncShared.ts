/**
 * 云同步双通道共享底座（R1）：runner 通道（cloudRunner）与 CloudCard 手动直调通道的「真正同构」
 * 部分单点化——targets 组装（含 keep 源 readPath 读/写分离）、动作状态文案表（cloudRunner.action.*
 * 单一键域）、keep 滚动清理、settled 判定、single-flight 共享链。
 *
 * 【有意语义差异，不进本模块】两通道的「采纳落盘与基线回写时机」是设计而非债务：
 * runner apply 通道立即 persistAdopted、采纳先于基线回写；手动通道「两步确认后整体替换+落基线」
 * （人工确认流）。该分叉由各通道自持，本模块只收同构路径（重构方案 R1 首选范围）。
 */
import {
  BACKUP_NAME_RE, enforceRemoteRetention, resolveObjectPath, resolveTimestampPath,
  type BackupSource, type CloudBackend, type CloudCred, type MultiTargetInput, type RevSyncAction,
  type RevSyncOutcome, type SourceSyncState, type TargetResult,
} from '@totp/core'

/** 同步动作 → 状态文案 key（common.json cloudRunner.action.* 单一来源，R1 文案表合并）：
 *  runner 状态摘要（deps.t 记录时取词）与手动卡状态行共用一份，消除双份键域漂移 */
export const CLOUD_ACTION_STATUS_KEYS: Record<RevSyncAction, string> = {
  uploaded: 'cloudRunner.action.uploaded',
  downloaded: 'cloudRunner.action.downloaded',
  merged: 'cloudRunner.action.merged',
  'in-sync': 'cloudRunner.action.inSync',
}
const MERGED_DEGRADED_KEY = 'cloudRunner.action.mergedDegraded'

/** 动作文案 key（含降级分支）：merged 且 mergeDegraded（远端祖先校验失败走两方合并）→ 专用文案 */
export function actionStatusLabelKey(o: RevSyncOutcome): string {
  return o.action === 'merged' && o.mergeDegraded === true ? MERGED_DEGRADED_KEY : CLOUD_ACTION_STATUS_KEYS[o.action]
}

/** 错误消息单行摘要（R2-M3 双通道共用）：CloudHttpError message 内嵌 \n（bodySnippet 前缀，
 *  core backend.ts）与 XML 响应体碎片，截断前先归一空白——摘要进设置页状态行/手动卡状态行
 *  须单行。e4c6e5c 只修了 runner 侧（内联 replace），本函数下沉后 runner 与 CloudCard.trunc
 *  共用单一口径。max 默认 60 字符（两通道既有截断宽度） */
export function errorDigest(message: string, max = 60): string {
  return message.replace(/\s+/g, ' ').slice(0, max)
}

/** keep 源远端最新份路径：listBackups 名单内时间戳备份的最新份（字典序=时间序，与滚动删除同口径）；
 *  后端不支持列名单/名单为空/listBackups 抛错 → null。抛错同按 null 走（该源按云端无对象首推，
 *  收敛归后续轮；本地/远端内容零丢失）——读侧名单失败不得炸整轮 Promise.all（逐源隔离，同 ⑮ 裁定） */
export async function latestKeepPath(backend: CloudBackend): Promise<string | null> {
  if (!backend.listBackups) return null
  const basename = (p: string): string => p.split('/').filter((s) => s !== '').pop() ?? p
  let names: string[]
  try {
    names = (await backend.listBackups()).filter((p) => BACKUP_NAME_RE.test(basename(p))).sort()
  } catch (err) {
    // spec §4.3：吞错返回 null 的首推语义保留（读侧名单失败不得炸整轮），但留痕可排查
    console.warn('[cloud] listBackups 失败，keep 源按云端无对象首推', err)
    return null
  }
  return names[names.length - 1] ?? null
}

/** 双通道共享的 targets 组装（core syncMultipleTargets 输入）：每对 {source, cred} 造 backend、
 *  解析写路径、keep 源补 readPath、装载 rev 基线。keep 源「读最新份、写新时间戳份」分离（readPath）：
 *  读侧参与 rev 判定/下载/合并（审查 Important-2——不分离则读恒落空、合并不可达，双设备并发编辑
 *  退化为 last-writer-wins 且败者内容被滚动删除清除）；写侧每次新时间戳文件。overwrite 源固定路径
 *  读写同一对象。keep 读侧名单空/后端不支持列名单 → 无 readPath，按云端无对象首推，收敛归后续轮 */
export async function buildSyncTargets(opts: {
  pairs: Array<{ source: BackupSource; cred: CloudCred }>
  /** cred → backend 实例（runner=deps.makeBackend；手动卡=带 onCredChange 回存的 createCloudBackend 包装）；
   *  key=源 id（手动卡凭据回存按源定位编辑副本/持久化单源 op 用） */
  makeBackend: (cred: CloudCred, key: string) => CloudBackend
  loadState: (id: string) => Promise<SourceSyncState>
  now?: Date
}): Promise<MultiTargetInput[]> {
  return Promise.all(opts.pairs.map(async ({ source, cred }) => {
    const backend = opts.makeBackend(cred, source.id)
    const keep = source.retention.type === 'keep'
    const readPath = keep ? ((await latestKeepPath(backend)) ?? undefined) : undefined
    return {
      key: source.id,
      backend,
      path: keep ? resolveTimestampPath(cred, opts.now ?? new Date()) : resolveObjectPath(cred),
      readPath,
      source,
      state: await opts.loadState(source.id),
    }
  }))
}

/** 全部目标拿到确定结果（无目标级失败/收敛失败）：手动卡 onManualSynced 宿主通知（跨端审查 I1）
 *  与 runner 内容门基线刷新（spec §1.3）的共同谓词。runner 另需叠加「基线回写无失败」标记，
 *  由调用方在本谓词上组合（两通道对 stateWriteFailed 的处置本就不同，不强并） */
export function allTargetsSettled(results: TargetResult[]): boolean {
  return results.every((x) => x.outcome !== null && !x.convergeError)
}

/** keep 源远端滚动清理（双通道共享）：仅 outcome=uploaded（上传/收敛回推成功）的 keep 源执行
 *  enforceRemoteRetention——in-sync 无新文件，失败源无可清理依据。逐源 try/catch 隔离：
 *  listBackups 网络抛错或宿主回调抛错只损失本轮清理（onFailed 回调），不改写该源 uploaded 结果、
 *  不中断其余源清理；清理失败下轮同步自动重试（不进 onError，区别于编排层意外） */
export async function runKeepRetention(
  inputs: MultiTargetInput[],
  results: TargetResult[],
  /** 成功回调：deleted=实际删除份数（-1=后端不支持，宿主降级提示）；truncated=F6 名单来自截断
   *  分页（滚动删除可能不完整）——手动卡据此附加「请手动清理」告警；runner 转发层只取前两位 */
  onDeleted: (id: string, deleted: number, truncated: boolean) => void,
  /** [可选] 单源清理抛错回调（手动卡附「清理失败」提示；runner 静默，下轮重试） */
  onFailed?: (id: string) => void,
): Promise<void> {
  for (const res of results) {
    if (!res.outcome || res.outcome.action !== 'uploaded') continue
    const input = inputs.find((x) => x.key === res.key)
    if (!input || input.source.retention.type !== 'keep') continue
    try {
      const r = await enforceRemoteRetention(input.backend, input.source.retention.n, input.source.retention.days ?? 0)
      onDeleted(res.key, r.deleted, r.truncated)
    } catch {
      onFailed?.(res.key)
    }
  }
}

// single-flight 共享链（spec §5 ④）：模块级 chain 串行化 runner 各轮（auto/manual/pull）与
// CloudCard 手动直调（R1）——同页运行时单 runner 单 CloudCard（cloudSyncBridge 同口径互斥论据），
// 共链使手动直调不再与 auto 轮并发（原分叉：直调绕过 runner 实例链）。各轮 promise 独立 settle：
// 前轮意外失败不传染排队轮（链上吞错仅用于衔接，单轮错误在轮内自转 onError/recordStatus/卡内 fail）
let chain: Promise<unknown> = Promise.resolve()
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.then(() => {}, () => {})
  return p
}
