/**
 * 多云目标同步编排（spec §2 活动目标单选）：primary 裁决 + replica 收敛复制，基线为 rev 逻辑时钟
 * （spec §1.2 SourceSyncState，取代旧字节 hash 基线——密文随机 IV 使字节摘要每轮必变，旧 hashes
 * 口径已随 syncWithCloud 一并删除）。
 *
 * 流程（每轮，顺序不并发）：
 * 1. primary = 首个 `source.enabled && source.role === 'primary'` 的目标；无 → throw
 *    Error('no primary target')（MCP 触发器 reason 复用此消息）。全 disabled 时可残留 role='primary'
 *    的源（normalizeSourceRoles 只在存在 enabled 源时归一），故必须同时校验 enabled（T6 审查裁定），
 *    不得只看 role。
 * 2. primary 裁决：syncWithCloudRev 四出口（in-sync/downloaded/uploaded/merged）推拉，产出
 *    finalVault（裁决后内容基线）。primary 失败（outcome=null + error/errorStatus）不阻断：
 *    final 回退本地入参，replica 仍按本地内容推平。
 * 3. replica 收敛复制：逐个以 final 为「本地内容」跑 syncWithCloudRev（state=replica 自身 state）——
 *    - 云端与 final 一致且 rev 未动 → in-sync 零写（spec §2 跳过）；
 *    - 云端未动、final 较新 → uploaded 推平：v3 头 rev=remoteRev+1 / baseRev=remoteRev /
 *      baseContentHash=远端旧内容 hash，由 syncOrchestrator uploaded 分支生成（审查 Critical-2 勘误
 *      后的 base 声明语义，以 syncOrchestrator 实际代码为准）；云端无对象时 rev 从 replica 已知时钟
 *      续起（首推为 1、baseRev 0），不因对象被删而回退时钟；
 *    - 云端较新且 final 未动（相对 replica 基线）→ downloaded：误配置/漂移保护——远端内容先按
 *      `mergeVaults(null, ours=final, theirs=replica内容)` 两方并入 final（base 未知，防丢；任务外
 *      裁定 4），随后以「远端现值」刷新 replica 基线再调一次 syncWithCloudRev 完成推平（其 uploaded
 *      分支保证 v3 头语义；并入后若与远端一致则 in-sync 零写，推平无必要）；
 *    - 双方都动（含 replica 被他设备误当主目标写入）→ merged：syncWithCloudRev 已合并并上传
 *      （base 可信则三方、否则降级两方，均不丢数据，spec §2「任何误配置下不丢数据」），final 采纳
 *      合并结果。
 *    推平失败记 convergeError 不覆盖原 outcome；单 replica 失败不阻断其余。
 *
 * states（每目标一份 SourceSyncState，spec §1.2/§2）推导（仅 apply 模式；preview 整轮只读、零推导，
 * 返回的 states 全为入参原样，宿主不得持久化）：
 * - primary：uploaded → { lastKnownRemoteRev: newRev, baseSnapshot: 实际上传内容(final) }；
 *   downloaded → { lastKnownRemoteRev: remoteRev, baseSnapshot: 采纳内容(final) }；merged →
 *   { lastKnownRemoteRev: newRev, baseSnapshot: 合并结果(final) }（采纳内容是以上传 newRev 写入云端
 *   的，state 两字段必须描述同一云版本——T13 缺陷修复：merged 原记 remoteRev 滞后一轮，下轮本地
 *   改动被误判为双方都动，降级两方合并把裁决结果回滚成合并默认主体）；remoteRev null=云端无对象
 *   或 v2 无头，保持原值不写 0；in-sync / 失败 → 原 state 不变。
 * - replica：跳过（in-sync）→ 原 state 不变；推平/合并成功 → { lastKnownRemoteRev: newRev,
 *   baseSnapshot: final }；失败 → 原 state 不变。
 * - replica 已知 rev 汇总记录在 primary 的 `state.primaryRev[key]`（二选一裁定采用 primary 承载制，
 *   T9 装配按此约定：装配时把 primary state 装入 primary 目标、同步后持久化各 state 即完成记录维护）。
 *
 * conflicts = 各目标 outcome.conflicts 拼接（EntryConflict[]）；adopted = final ≠ 入参 vaultJson
 * （primary 采纳/合并与 replica 误配置并入都计入，宿主据此 persistAdopted）。
 */
import type { KdfProfile } from '../backup/envelope'
import type { BackupSource } from '../backup/sources'
import { mergeVaults, type EntryConflict } from '../merge/vaultMerge'
import type { CloudBackend } from './backend'
import { syncWithCloudRev, type ConflictBackupResult, type RevSyncOutcome } from './syncOrchestrator'
import type { SourceSyncState } from './syncState'

/** 单个云目标同步输入：key 为宿主侧稳定标识（源 id）；source 携带 role/enabled 裁定元数据；
 *  state 为该源本端持久 rev 基线（primary 的 primaryRev 字段承载各 replica 已知 rev）。 */
export interface MultiTargetInput {
  key: string
  backend: CloudBackend
  path: string
  source: BackupSource
  state: SourceSyncState
}

/** 单目标结果：outcome 为 null 表示该目标本轮 syncWithCloudRev 抛错（error 为消息）；convergeError
 *  仅在 replica 推平阶段失败时出现（不覆盖原 outcome）。errorStatus（审查 I2）：抛错对象携带数字
 *  status（CloudHttpError）时透传，供宿主结构化判定凭据失效。 */
export interface TargetResult {
  key: string
  outcome: RevSyncOutcome | null
  error?: string
  errorStatus?: number
  convergeError?: string
}

export interface MultiTargetSyncResult {
  results: TargetResult[]
  /** 收敛后的最终本地明文 vault（primary 采纳/合并与 replica 误配置并入都会推进；preview 时为预览） */
  finalVaultJson: string
  /** 本轮 final 是否偏离入参（宿主据此 persistAdopted；preview 时表示「将采纳」的预览） */
  adopted: boolean
  /** 各目标 outcome.conflicts 拼接（merged 分支产出） */
  conflicts: EntryConflict[]
  /** 各目标推导后的本端持久基线；失败目标=原样。preview 模式全为入参原样，宿主不得持久化 */
  states: Record<string, SourceSyncState>
}

function errorFields(err: unknown): { error: string; errorStatus?: number } {
  const status = (err as { status?: unknown } | null)?.status
  return {
    error: err instanceof Error ? err.message : String(err),
    ...(typeof status === 'number' ? { errorStatus: status } : {}),
  }
}

export async function syncMultipleTargets(opts: {
  targets: MultiTargetInput[]
  vaultJson: string
  password: string
  profile?: KdfProfile
  /** 本机设备标识（写入 v3 sync 头，宿主经 core loadDeviceId 持久化） */
  deviceId: string
  /** preview：整轮只读（任何目标不 put 不存副本、states 零推导）；缺省 apply */
  mode?: 'apply' | 'preview'
  onConflictBackup?: (key: string, bytes: Uint8Array) => ConflictBackupResult
}): Promise<MultiTargetSyncResult> {
  const { targets, vaultJson, password, profile, deviceId, onConflictBackup } = opts
  const mode = opts.mode ?? 'apply'
  // 裁定 1：enabled + role 双校验（全 disabled 时可残留 role='primary' 的源，不得误判为活动目标）
  const primary = targets.find((t) => t.source.enabled && t.source.role === 'primary')
  if (!primary) throw new Error('no primary target')
  const replicas = targets.filter((t) => t.source.enabled && t.source.role === 'replica')

  const results: TargetResult[] = []
  const states: Record<string, SourceSyncState> = {}
  const conflicts: EntryConflict[] = []
  const replicaRevs: Record<string, number> = { ...(primary.state.primaryRev ?? {}) }
  let final = vaultJson

  // ---- primary 裁决：四出口推拉，产出 final ----
  let primaryOutcome: RevSyncOutcome | null = null
  try {
    primaryOutcome = await syncWithCloudRev({
      backend: primary.backend,
      path: primary.path,
      vaultJson,
      password,
      profile,
      state: primary.state,
      deviceId,
      mode,
      onConflictBackup: (bytes) => onConflictBackup?.(primary.key, bytes),
    })
    if (primaryOutcome.conflicts) conflicts.push(...primaryOutcome.conflicts)
  } catch (err) {
    // primary 失败=本轮终止该源：final 保持本地入参，replica 仍按本地内容推平
    results.push({ key: primary.key, outcome: null, ...errorFields(err) })
  }
  if (primaryOutcome !== null) {
    results.push({ key: primary.key, outcome: primaryOutcome })
    // downloaded/merged：final 采纳云端/合并结果（uploaded/in-sync 的 final 保持入参）
    if (
      (primaryOutcome.action === 'downloaded' || primaryOutcome.action === 'merged') &&
      primaryOutcome.appliedVaultJson !== undefined
    ) {
      final = primaryOutcome.appliedVaultJson
    }
    // state 推导（裁定 5 + T13 缺陷修复）：newRev 优先（uploaded 上传内容、merged 合并结果都以
    // newRev 落云，baseSnapshot 与时钟必须同版本，与下方 replica 推导 newRev ?? remoteRev 同口径）；
    // downloaded 无 newRev → remoteRev（采纳内容=远端现值）；remoteRev null 保持原值不写 0；
    // in-sync → 原 state 不变
    if (mode === 'apply' && primaryOutcome.action !== 'in-sync') {
      states[primary.key] = {
        ...primary.state,
        lastKnownRemoteRev:
          (primaryOutcome.newRev ?? primaryOutcome.remoteRev) ?? primary.state.lastKnownRemoteRev,
        baseSnapshot: final,
      }
    }
  }

  // ---- replica 收敛复制：逐个以 final 为本地内容，跳过/推平/并入 ----
  for (const t of replicas) {
    const result: TargetResult = { key: t.key, outcome: null }
    try {
      let r = await syncWithCloudRev({
        backend: t.backend,
        path: t.path,
        vaultJson: final,
        password,
        profile,
        state: t.state,
        deviceId,
        mode,
        onConflictBackup: (bytes) => onConflictBackup?.(t.key, bytes),
      })
      if (r.action === 'downloaded' && r.appliedVaultJson !== undefined) {
        // 误配置保护（裁定 4）：replica 云端较新且 final 未动 → 远端内容先两方并入 final
        //（base 未知，mergeVaults(null, ours=final, theirs=replica) 防丢），再以远端现值刷新
        // replica 基线并推平（outcome 先记 downloaded，推平失败时不覆盖——裁定 8）
        result.outcome = r
        const mergedJson = JSON.stringify(mergeVaults(null, JSON.parse(final), JSON.parse(r.appliedVaultJson)).vault)
        final = mergedJson // 先并入 final（数据不丢），再推平——推平失败不回滚并入（随 finalVaultJson 交宿主）
        r = await syncWithCloudRev({
          backend: t.backend,
          path: t.path,
          vaultJson: mergedJson,
          password,
          profile,
          state: { lastKnownRemoteRev: r.remoteRev ?? t.state.lastKnownRemoteRev, baseSnapshot: r.appliedVaultJson },
          deviceId,
          mode,
          onConflictBackup: (bytes) => onConflictBackup?.(t.key, bytes),
        })
      } else if (r.action === 'merged' && r.appliedVaultJson !== undefined) {
        // 双方都动：syncWithCloudRev 已合并并上传（rev 单调、base 校验失败自动降级两方），
        // final 采纳合并结果——误配置写入的内容不丢
        final = r.appliedVaultJson
      }
      result.outcome = r
      if (r.conflicts) conflicts.push(...r.conflicts)
      if (mode === 'apply') {
        // replica state 推导：跳过（in-sync）原样语义由「以远端现值等价刷新」达成（内容/时钟均等价）；
        // 推平/合并成功 → newRev+final；downloaded 残留不可能（上方必接二次调用）
        states[t.key] = {
          ...t.state,
          lastKnownRemoteRev: (r.newRev ?? r.remoteRev) ?? t.state.lastKnownRemoteRev,
          baseSnapshot: final,
        }
        // primaryRev 记录推进（primary 承载制）：跳过=远端现值（与记录一致或刷新漂移），推平=newRev
        if (r.newRev !== undefined) replicaRevs[t.key] = r.newRev
        else if (r.remoteRev !== null) replicaRevs[t.key] = r.remoteRev
      } else {
        states[t.key] = t.state
      }
    } catch (err) {
      const fields = errorFields(err)
      if (result.outcome === null) {
        // 首次调用即失败：outcome=null + error/errorStatus，state 原样（下轮重做）
        Object.assign(result, fields)
      } else {
        // 推平阶段失败：convergeError，不覆盖原 outcome（裁定 8），state 原样
        result.convergeError = fields.error
      }
      states[t.key] = t.state
    }
    results.push(result)
  }

  // states 恒含所有参与目标：primary 键补齐（preview/失败/in-sync=原样），apply 模式挂 primaryRev
  // 记录（承载制，replica 已知 rev 汇总）；preview 模式全键原样，宿主不得持久化
  const primaryState = states[primary.key] ?? primary.state
  if (mode === 'apply' && (replicas.length > 0 || primaryState.primaryRev !== undefined)) {
    states[primary.key] = { ...primaryState, primaryRev: replicaRevs }
  } else {
    states[primary.key] = primaryState
  }

  return { results, finalVaultJson: final, adopted: final !== vaultJson, conflicts, states }
}
