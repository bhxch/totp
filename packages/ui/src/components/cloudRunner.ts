/**
 * 云同步 runner（宿主侧编排，desktop/extension 双端共享）：把启用的源+凭据对组装为 core
 * syncMultipleTargets 输入并执行（rev 逻辑时钟编排，T9 全量改造）。守护与裁定：
 * - single-flight（spec §5 ④）：实例闭包 chain promise 链串行化 run()——手动到来时自动在跑则排队
 *   合并执行，不丢弃不并发；跨宿主（desktop 与 extension 同时写云）不额外加锁，由 rev 模型天然裁决；
 * - 仅解锁会话内执行（锁定/无 secret 记 null 跳过态直接 return），跳过态可观测裁定不变；
 * - auto 内容门（spec §1.3 内容门持久化）：持久化「解密后 vault JSON 规范化 contentHashVault」基线
 *   （loadContentHash/saveContentHash，跨会话/页面重开生效，取代旧实例内存 sha256 字节门）；
 *   门命中降级 pull-only 轮（零写云、远端基线去重、in-sync 零处理——保持下载可达性，终审 Fix2：
 *   desktop 唯一云触发是 auto，全静默短路使闲置端永远收不到对端变更）；仅全部目标确定结果才刷新
 *   基线，部分失败置 null 强制下轮全流程重试（防门吸收部分失败成静默僵死）；
 *   manual/pull 不设门（manual 成功后同样刷新）；
 * - manual 预览确认（spec §4）：先 mode:'preview' 只读跑一轮（core preview 零写云/零副本/零 state
 *   推导），任一目标 merged 时经 onManualConfirm 以预览摘要征询（缺省=直接执行，T11 接入真对话框）；
 *   false 中止本轮记跳过态，true 重跑 mode:'apply'（预览是只读的，落盘以 apply 轮为准）；
 * - pull 通道（extension 跟随，pull-only）：对每源走 syncWithCloudRev 只读形态（mode:'preview'，
 *   永不 put、永不存副本）——in-sync/uploaded（云端无对象/本地领先，收敛归推送通道）零处理；
 *   downloaded/merged 都只 persistAdopted 不写云。state 回写语义（本地写盘非云端写）：
 *   downloaded → base=采纳内容（与 core apply 推导同语义，下轮起 in-sync 稳定态）；merged →
 *   base=null——合并结果只在本地、远端仍是合并前内容，base=null 使下一轮推送通道按「云端未动、
 *   本地已改」纯上传把合并结果收敛上云（若 base=合并结果，远端旧内容会被误判「云端较新」把本地
 *   合并结果回退覆盖，丢本地变更）；merged 冲突记录经 onMergeConflicts 交宿主入库提示；
 * - 冲突强提示（spec §4）：apply 轮产出的 EntryConflict[] 经 onMergeConflicts 交宿主持久化，
 *   每轮结束 onConflicts(conflictCount()) 对账 badge/横幅（0=清除）；冲突副本仍经 saveConflictBackup
 *   落盘（Promise 原样交回 core await，副本失败=该目标同步失败，审查 I9 安全序不变）；
 * - onProgress 逐源进度（spec §6 ⑥）：core 串行编排——包装目标 i 的 backend，其首个后端调用到来
 *   即知目标 0..i-1 已完成（发 (i,total)），轮末补 (total,total)；preview 轮同样推进；
 * - keep 源 outcome=uploaded 后 enforceRemoteRetention 远端滚动删除（逐源隔离，结果经
 *   onRetentionDeleted 交宿主记录）不变；
 * - 单目标失败由 core 编排隔离（outcome=null + error），仅全程意外抛错才走 onError。
 */
import {
  BACKUP_NAME_RE, contentHashVault, enforceRemoteRetention, isAuthError, isAuthErrorCode,
  resolveObjectPath, resolveTimestampPath, syncMultipleTargets, syncWithCloudRev,
  type BackupSource, type CloudBackend, type CloudCred, type ConflictBackupResult, type EntryConflict,
  type KdfProfile, type RevSyncAction, type RevSyncOutcome, type SourceSyncState, type TargetResult,
} from '@totp/core'

/** 手动合并预览摘要（onManualConfirm 入参）：T11 差异预览对话框消费 */
export interface ManualMergePreview {
  /** 预览轮合并产出的条目冲突（仅预览未落盘——确认中止则随之丢弃） */
  conflicts: EntryConflict[]
  /** 任一合并目标走了两方合并降级（远端祖先校验失败） */
  mergeDegraded: boolean
  /** 合并目标显示名（多个以 '; ' 连接；deps.sourceName 缺省回退源 id） */
  sourceName: string
}

export interface CloudRunnerDeps {
  /** 锁定态：锁定或无 secret 时自动触发直接跳过 */
  isLocked(): boolean
  /** 会话口令（null=无） */
  getSecret(): string | null
  /** 当前 vault JSON 快照 */
  getVaultJson(): string
  /** 启用源与其凭据对（宿主装配：元数据自 backupSources、凭据自保管区 credsCache；锁定态凭据缺失自然为空） */
  loadSources(): Promise<Array<{ source: BackupSource; cred: CloudCred }>>
  /** 该源 rev 基线（core loadSyncState；spec §1.2 SourceSyncState），无记录 → 空状态。
   *  seal 装配（baseSnapshot DEK 静态保护）为宿主职责 */
  loadSyncState(sourceId: string): Promise<SourceSyncState>
  /** 该源 rev 基线持久化（core saveSyncState；编排返回 states 逐源回写，失败源=原样幂等） */
  saveSyncState(sourceId: string, state: SourceSyncState): Promise<void>
  /** 本机设备标识（core loadDeviceId 持久 UUID，写入 v3 sync 头） */
  deviceId(): Promise<string>
  /** auto 内容门持久基线：上次成功同步的规范化内容 hash（contentHashVault 口径，剔除顶层 rev——
   *  F8 水位随加密落盘推进，非 vault 内容；spec §1.3；null=无基线必同步）。
   *  跨实例/跨会话生效——页面重开内容未变不再盲目全量推拉 */
  loadContentHash(): Promise<string | null>
  /** 内容门基线持久化：全部目标确定结果=final 内容 hash；部分失败=null（清除，强制下轮重试） */
  saveContentHash(h: string | null): Promise<void>
  /** 凭据 → backend 实例。生产=core 五工厂 dispatch；测试=注入 fake */
  makeBackend(cred: CloudCred): CloudBackend
  /** 采纳云端/合并版本后整体替换本地存储（生产=store.replaceAllOp） */
  persistAdopted(json: string): Promise<void>
  /** 冲突副本落盘（key=源 id）；缺省则丢弃副本提示。审查 I9：返回 Promise 原样经 core 编排
   *  await——写盘拒绝 → 该目标同步失败（不采纳远端、不回推覆盖云端），本地旧内容在无副本落盘
   *  的情况下不被覆盖；返回文件名（desktop saveConflictBackupToDir 形态）时随 outcome 透传 */
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
   *  三态（批 4）：true=成功 / false=失败 / null=跳过（锁定/无 secret/空目标/手动合并被拒；跳过态可观测裁定） */
  recordStatus?(ok: boolean | null, summary: string): void
  /** 状态摘要翻译器（D2 抽串）：宿主注入（i18n.global.t 同签名），key 见 common.json cloudRunner.*。
   *  摘要随 recordStatus 持久化，翻译发生在记录时（locale 切换不改已落盘摘要，与手动卡状态行同限制） */
  t(key: string, params?: Record<string, unknown>): string
  /** 手动合并预览确认（spec §4）：任一目标 merged 时以预览摘要征询；缺省=直接执行（宿主 T11 接入对话框）。
   *  返回 false 中止本轮（recordStatus 记跳过态），true 重跑 apply */
  onManualConfirm?(preview: ManualMergePreview): Promise<boolean>
  /** 逐源进度（spec §6 ⑥）：done=已完成目标数，total=参与目标数 */
  onProgress?(done: number, total: number): void
  /** 冲突强提示（spec §4 badge/横幅）：每轮结束对账，值为未裁决冲突数（宿主自 store conflictCount
   *  闭包读取）；0=冲突全部裁决或无冲突，提示随之清除 */
  onConflicts?(count: number): void
  /** 未裁决冲突数读取器（宿主自 store conflictCount 闭包提供；缺省按 0 上报） */
  conflictCount?(): number
  /** apply 轮产出的条目冲突入库（宿主桥 store.addMergeConflictsOp 持久化，T11 裁决列表消费）；
   *  fire-and-forget：入库失败不影响同步结果（下轮合并重报） */
  onMergeConflicts?(conflicts: EntryConflict[]): void
  onError?(err: unknown): void
  /** [可选] 云凭据失效通知（跨端同步 T4）：任一目标凭据失效（401/403，结构化 status 或消息定界
   *  匹配，见 core isAuthError）时回调——err 为消息原文，status 为错误对象携带的数字状态码
   *  （CloudHttpError 才有，缺省 undefined）。core 编排对目标级失败不抛错（outcome=null + error），
   *  宿主调度器无法经 reject 感知，经此钩子感知后暂停自动跟随；缺省不回调（desktop 零影响） */
  onAuthFailure?(err: string, status?: number): void
}

/** 同步动作 → 状态文案 key（D2：原 CLOUD_ACTION_LABEL zh 常量上移至 common.json cloudRunner.action.*）。
 *  键 = rev 编排四出口（RevSyncAction）；merged 且降级（祖先校验失败走两方合并）时换专用文案 */
const ACTION_LABEL_KEY: Record<RevSyncAction, string> = {
  uploaded: 'cloudRunner.action.uploaded',
  downloaded: 'cloudRunner.action.downloaded',
  merged: 'cloudRunner.action.merged',
  'in-sync': 'cloudRunner.action.inSync',
}
const MERGED_DEGRADED_KEY = 'cloudRunner.action.mergedDegraded'

/** 动作文案 key（含降级分支）：merged 且 mergeDegraded → mergedDegraded 专用文案 */
function actionLabel(o: RevSyncOutcome): string {
  return o.action === 'merged' && o.mergeDegraded === true ? MERGED_DEGRADED_KEY : ACTION_LABEL_KEY[o.action]
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 凭据失效的目标判定（审查 I2）：结构化 errorStatus 优先（core multiTarget 自 CloudHttpError 透传），
 *  缺失按消息定界形式兜底（core isAuthError 的字符串分支） */
function isAuthFailureTarget(x: TargetResult): boolean {
  return x.outcome === null && x.error !== undefined
    && (typeof x.errorStatus === 'number' ? isAuthErrorCode(x.errorStatus) : isAuthError(new Error(x.error)))
}

/** backend 包装：该目标首个后端调用到来时回调一次（core 串行编排 ⇒ 目标 0..i-1 已完成，即进度语义），
 *  其余行为原样委托（onCredChange/listBackups 可选成员保真透传）。 */
function instrumentBackend(b: CloudBackend, onFirst: () => void): CloudBackend {
  let fired = false
  const once = (): void => {
    if (!fired) {
      fired = true
      onFirst()
    }
  }
  const backend: CloudBackend = {
    id: b.id,
    put: async (path, data) => {
      once()
      return b.put(path, data)
    },
    get: async (path) => {
      once()
      return b.get(path)
    },
    delete: async (path) => {
      once()
      return b.delete(path)
    },
    exists: async (path) => {
      once()
      return b.exists(path)
    },
  }
  if (b.onCredChange) backend.onCredChange = (cred) => b.onCredChange!(cred)
  if (b.listBackups) {
    backend.listBackups = async () => {
      once()
      return b.listBackups!()
    }
  }
  return backend
}

/** keep 源远端最新份路径：listBackups 名单内时间戳备份的最新份（字典序=时间序，与滚动删除同口径）；
 *  后端不支持列名单/名单为空/listBackups 抛错 → null。抛错同按 null 走（该源按云端无对象首推，
 *  收敛归后续轮；本地/远端内容零丢失）——读侧名单失败不得炸整轮 Promise.all（逐源隔离，同 ⑮ 裁定） */
async function latestKeepPath(backend: CloudBackend): Promise<string | null> {
  if (!backend.listBackups) return null
  const basename = (p: string): string => p.split('/').filter((s) => s !== '').pop() ?? p
  let names: string[]
  try {
    names = (await backend.listBackups()).filter((p) => BACKUP_NAME_RE.test(basename(p))).sort()
  } catch {
    return null
  }
  return names[names.length - 1] ?? null
}

type MultiTargetRun = Awaited<ReturnType<typeof syncMultipleTargets>>

export function createCloudSyncRunner(deps: CloudRunnerDeps): { run(mode?: 'auto' | 'manual' | 'pull'): Promise<void> } {
  /** 显示名解析：sourceName 提供时用宿主名称，否则回退源 id（审查 I4） */
  const displayName = (id: string): string => deps.sourceName?.(id) ?? id

  /**
   * 跟随拉取（pull-only 通道，extension popup/options）：对每源走 syncWithCloudRev 只读形态
   * （mode:'preview'——零 put、零副本、零 state 推导），在预览结果上做本通道专属的本地落盘：
   * - in-sync：云端与基线一致/内容等价（对端重推同内容）→ 零处理；
   * - uploaded（preview）：云端无对象（首推属推通道职责，不代劳）或本地领先（本通道不推送，
   *   收敛归推送通道）→ 零处理；
   * - downloaded：采纳远端（persistAdopted）+ state{remoteRev, base=采纳内容}——本地未动才走到
   *   此分支，采纳无损；下轮起 rev/内容双一致 → in-sync 稳定态；
   * - merged：本地也动过 → 采纳合并结果 + state{remoteRev, base=null}（base 语义见文件头注释：
   *   让下一轮推送通道把合并结果按纯上传收敛上云）+ 冲突记录交宿主入库。
   * 逐源隔离：单源失败（网络/口令/采纳落盘）不动该源 state（下轮重做），不中断其余源；
   * 凭据失效经 onAuthFailure 上抛（宿主转 reject → 调度器停轮询，与推拉通道同口径）。
   */
  async function pullAll(secret: string): Promise<void> {
    const vaultJson = deps.getVaultJson()
    const pairs = (await deps.loadSources()).filter((p) => p.source.enabled)
    if (pairs.length === 0) {
      deps.recordStatus?.(null, deps.t('cloudRunner.noSources'))
      return
    }
    let current = vaultJson // 多源顺序处理：某源采纳后，其余源的「本地内容」以采纳后的最新值为准（同 core 收敛口径）
    const labels: string[] = []
    let authErr: { message: string; status?: number } | null = null
    for (const { source, cred } of pairs) {
      try {
        const backend = deps.makeBackend(cred)
        const path = source.retention.type === 'keep' ? await latestKeepPath(backend) : resolveObjectPath(cred)
        if (path === null) {
          labels.push(`${displayName(source.id)}: ${deps.t(ACTION_LABEL_KEY['in-sync'])}`)
          continue
        }
        const state = await deps.loadSyncState(source.id)
        const o = await syncWithCloudRev({
          backend,
          path,
          vaultJson: current,
          password: secret,
          profile: deps.kdfProfile?.(),
          state,
          deviceId: await deps.deviceId(),
          mode: 'preview', // 只读形态：永不写云端、永不存副本（pull-only 的存在意义）
        })
        if (o.action === 'in-sync' || o.action === 'uploaded') {
          labels.push(`${displayName(source.id)}: ${deps.t(ACTION_LABEL_KEY['in-sync'])}`)
          continue
        }
        const applied = o.appliedVaultJson
        if (applied === undefined) {
          // 防御：downloaded/merged 预览必带采纳内容，缺省按本源失败（下轮重做）
          labels.push(`${displayName(source.id)}: ${deps.t('cloudRunner.failed')}`)
          continue
        }
        if (applied !== current) {
          // 采纳落盘失败=本源失败（rejection 进 catch），state 不回写 → 下轮自动重拉
          await deps.persistAdopted(applied)
          current = applied
        }
        await deps.saveSyncState(source.id, {
          ...state,
          lastKnownRemoteRev: o.remoteRev ?? state.lastKnownRemoteRev,
          baseSnapshot: o.action === 'downloaded' ? applied : null,
        })
        if (o.action === 'merged' && o.conflicts?.length) deps.onMergeConflicts?.(o.conflicts)
        labels.push(`${displayName(source.id)}: ${deps.t(actionLabel(o))}`)
      } catch (err) {
        if (authErr === null && isAuthError(err)) {
          const status = (err as { status?: unknown }).status
          authErr = { message: errMsg(err), status: typeof status === 'number' ? status : undefined }
        }
        labels.push(`${displayName(source.id)}: ${deps.t('cloudRunner.failed')}`)
      }
    }
    if (authErr !== null) {
      // status 缺省保持单参调用形态（向后兼容既有宿主/测试）；结构化 status 有值才透传第二参
      if (authErr.status !== undefined) deps.onAuthFailure?.(authErr.message, authErr.status)
      else deps.onAuthFailure?.(authErr.message)
    }
    deps.recordStatus?.(true, labels.join('; '))
  }

  /**
   * 一轮多目标同步。apply=落盘/推导/通知全套；preview=整轮只读（core 侧零写零推导，runner 侧
   * 也不落任何盘面），返回编排结果供 manual 确认流消费。返回 null=空源跳过态（已记 recordStatus）。
   */
  async function runTargets(mode: 'apply' | 'preview', secret: string): Promise<MultiTargetRun | null> {
    const vaultJson = deps.getVaultJson()
    const pairs = (await deps.loadSources()).filter((p) => p.source.enabled)
    if (pairs.length === 0) {
      deps.recordStatus?.(null, deps.t('cloudRunner.noSources'))
      return null
    }
    const total = pairs.length
    const inputs = await Promise.all(
      pairs.map(async ({ source, cred }) => {
        const backend = deps.makeBackend(cred)
        // keep 源「读最新份、写新时间戳份」分离（readPath）：读侧参与 rev 判定/下载/合并（审查
        // Important-2——不分离则读恒落空、合并不可达，双设备并发编辑退化为 last-writer-wins 且
        // 败者内容被滚动删除清除）；写侧每次新时间戳文件。overwrite 源固定路径读写同一对象。
        // keep 读侧名单空/后端不支持列名单 → 无 readPath，按云端无对象首推，收敛归后续轮
        const keep = source.retention.type === 'keep'
        const readPath = keep ? ((await latestKeepPath(backend)) ?? undefined) : undefined
        return {
          key: source.id,
          backend,
          path: keep ? resolveTimestampPath(cred, new Date()) : resolveObjectPath(cred),
          readPath,
          source,
          state: await deps.loadSyncState(source.id),
        }
      }),
    )
    // 逐源进度挂点（spec §6 ⑥）：首目标开始不发 0（无信息量），i≥1 的首个后端调用到来发 (i,total)
    const wrapped = inputs.map((input, i) =>
      i === 0 ? input : { ...input, backend: instrumentBackend(input.backend, () => deps.onProgress?.(i, total)) },
    )
    // 轮末进度经 finally 发（S2）：编排抛错（如 no primary target）也必须结清进度条，
    // 否则 CloudCard spinner 滞留至下一成功轮
    let r: MultiTargetRun
    try {
      r = await syncMultipleTargets({
        targets: wrapped,
        vaultJson,
        password: secret,
        deviceId: await deps.deviceId(),
        // 审查 I9：saveConflictBackup 的 Promise 原样交回 core（syncWithCloudRev await 该回调），
        // 写盘拒绝 → 该目标同步失败（outcome=null + error），防止无本地副本时照常采纳远端并回推；
        // preview 模式 core 恒不调用（只读）
        onConflictBackup: (key, bytes) => deps.saveConflictBackup?.(key, bytes),
        profile: deps.kdfProfile?.(),
        mode,
      })
    } finally {
      deps.onProgress?.(total, total)
    }
    if (mode === 'preview') return r

    // ---- 以下为 apply 专属落盘与通知（preview 的 states 为入参原样，宿主不得持久化）----
    // 采纳先于基线回写（审查裁定）：persistAdopted 失败则本轮 states 一并不落盘，下轮基线
    // 缺失/为旧值 → 自动重试下载/合并；若先写基线，失败会使下轮全线 in-sync，云端较新版本永远
    // 不再被自动下载（静默僵持无自愈）
    if (r.adopted) await deps.persistAdopted(r.finalVaultJson)
    // 条目冲突入库（spec §3/§4）：fire-and-forget——宿主 store.addMergeConflictsOp 持久化供 T11
    // 裁决列表消费；入库失败（含在途锁定 seal 抛错）只损失本轮提示，下轮合并重报
    if (r.conflicts.length > 0) deps.onMergeConflicts?.(r.conflicts)
    // 回写各源 rev 基线：states 恒含参与源（失败源=原样，回写幂等；无 primary 时 core 抛错走 catch 不及此）。
    // per-source 隔离（在途锁定裁定）：宿主 seal 于 lock() 后抛 'vault locked' → 该源跳过基线回写
    // （下轮按旧基线重做，与 persistAdopted 失败同语义），不中断其余源、不上溢为整轮失败
    let stateWriteFailed = false
    for (const t of inputs) {
      const st = r.states[t.key]
      if (!st) continue
      try {
        await deps.saveSyncState(t.key, st)
      } catch {
        stateWriteFailed = true
      }
    }
    // keep 源滚动删除（基线回写后执行；复用原 backend 实例）：仅对 outcome=uploaded（上传/收敛
    // 回推成功）的源执行——in-sync 无新文件，失败源无可清理依据。per-source try/catch 隔离：
    // listBackups 网络抛错或宿主回调抛错只损失本轮清理（下轮重试），不改写该源 uploaded 结果、
    // 不中断其余源清理与最终 summary（上传成功的既成事实不因清理失败回滚）
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
    // 内容门基线刷新（spec §1.3）：仅当全部目标拿到确定结果（outcome 非 null 且无 convergeError）
    // 且基线回写无失败 才以 finalVaultJson 刷新；否则置 null——下轮不被门短路，失败目标按全量重比
    // 自愈重试，防部分失败/在途锁定被门吸收成静默僵死。落盘失败不毁本轮结果（基线残留最多让下轮
    // 多做一次同步）
    const allSettled = r.results.every((x) => x.outcome !== null && !x.convergeError) && !stateWriteFailed
    try {
      await deps.saveContentHash(allSettled ? await contentHashVault(r.finalVaultJson) : null)
    } catch { /* 基线落盘失败：保留下轮重试 */ }
    // T4 凭据失效分类（审查 I2 结构化）：目标级失败不抛错，宿主调度器无从感知——结构化 errorStatus
    // 优先，消息定界匹配兜底，命中上抛钩子（GDrive 403 配额类无法在 HTTP 层区分，同判见 core isAuthError）；
    // status 缺省保持单参调用形态（向后兼容既有宿主/测试）
    const authTarget = r.results.find(isAuthFailureTarget)
    if (authTarget?.error !== undefined) {
      if (authTarget.errorStatus !== undefined) deps.onAuthFailure?.(authTarget.error, authTarget.errorStatus)
      else deps.onAuthFailure?.(authTarget.error)
    }
    // summary 动作文案（D2 i18n；merged 降级换专用文案）：单目标失败（outcome=null）记「失败」；
    // 源显示名（审查 I4）。整体 ok=true 为既有部分失败 summary 语义（全部目标 settle 与否看基线门）
    deps.recordStatus?.(true, r.results.map((x) => `${displayName(x.key)}: ${x.outcome ? deps.t(actionLabel(x.outcome)) : deps.t('cloudRunner.failed')}`).join('; '))
    return r
  }

  async function runOnce(mode: 'auto' | 'manual' | 'pull'): Promise<void> {
    try {
      // 跳过态可观测（批 4 裁定）：锁定/无 secret/空目标是「用户需要知道的原因」，return 前记 null 跳过态。
      // summary 仅存原因文本，不携带「跳过：」前缀——前缀由宿主格式化按 ok=null 拼装（label 拼装职责单一）。
      // 写入频率自审：调度器防抖 10s / 到点 ≥15min（pull 轮询 3min），每次触发事件至多写一条，量级可接受
      if (deps.isLocked()) {
        deps.recordStatus?.(null, deps.t('cloudRunner.lockedVault'))
        return
      }
      const secret = deps.getSecret()
      if (secret === null) {
        deps.recordStatus?.(null, deps.t('cloudRunner.noSecret'))
        return // 自动触发只在解锁会话内
      }
      if (mode === 'pull') {
        await pullAll(secret)
        return
      }
      const vaultJson = deps.getVaultJson()
      // auto 内容门（spec §1.3 持久化）：持久基线命中且明文内容未变 → 降级执行 pull-only 轮
      // （终审 Fix2/I-2：门命中不再直接 return 全静默——desktop 唯一云触发是 auto，全静默使
      // 闲置端永远收不到对端变更（downloaded 分支不可达），状态行记「内容未变」误导，同类回归面
      // 即当年 C1 把门挪到下载前。pullAll 为 runner 内既有只读形态：零写云、远端基线去重、
      // in-sync 零处理；不推门基线（pull 轮失败不推门语义一致）——采纳使本地内容前进后门自然
      // 未命中，下一轮完整推拉轮收敛并自愈刷新基线）。门未命中保持完整推拉轮不变；
      // manual/pull 不设门（pull 的去重是预览判定的内容比对）
      if (mode === 'auto') {
        const baseline = await deps.loadContentHash()
        if (baseline !== null && (await contentHashVault(vaultJson)) === baseline) {
          await pullAll(secret)
          return
        }
      }
      if (mode === 'manual') {
        // 手动合并预览确认（spec §4）：先只读预览，任一目标 merged 才征询；无 onManualConfirm（缺省）
        // =直接执行。确认 false 中止本轮记跳过态（预览只读，本地/云端零痕迹）；true 重跑 apply 落盘
        const pv = await runTargets('preview', secret)
        if (pv === null) return // 空源跳过态已记录
        const mergedResults = pv.results.filter((x) => x.outcome?.action === 'merged')
        if (mergedResults.length > 0 && deps.onManualConfirm) {
          const ok = await deps.onManualConfirm({
            conflicts: pv.conflicts,
            mergeDegraded: mergedResults.some((x) => x.outcome?.mergeDegraded === true),
            sourceName: mergedResults.map((x) => displayName(x.key)).join('; '),
          })
          if (!ok) {
            deps.recordStatus?.(null, deps.t('cloudRunner.manualSkipped'))
            return
          }
        }
      }
      await runTargets('apply', secret)
    } catch (err) {
      deps.onError?.(err)
      deps.recordStatus?.(false, errMsg(err).slice(0, 100))
    }
  }

  // single-flight（spec §5 ④）：实例闭包 chain 链串行化——手动到来时自动在跑则排队合并执行，
  // 不丢弃不并发（取代旧 busy 直接 return）。各轮返回 promise 独立 settle：前轮意外失败不传染
  // 排队轮（链上吞错仅用于衔接，单轮错误已在 runOnce 内转 onError/recordStatus）。
  // 每轮结束（无论成败）对账冲突强提示：badge/横幅随宿主实时未裁决数亮/清（spec §4）
  let chain: Promise<void> = Promise.resolve()
  const run = (mode: 'auto' | 'manual' | 'pull' = 'auto'): Promise<void> => {
    const exec = (): Promise<void> =>
      runOnce(mode).finally(() => {
        deps.onConflicts?.(deps.conflictCount?.() ?? 0)
      })
    const p = chain.then(exec, exec)
    chain = p.then(() => {}, () => {})
    return p
  }
  return { run }
}
