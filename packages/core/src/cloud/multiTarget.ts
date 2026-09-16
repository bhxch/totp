/**
 * 多云目标同步编排（设计 §6.2 收敛规则）：各目标持有独立基线 hash，顺序（不并发）逐目标
 * syncWithCloud；任一目标采纳到较新的云端版本后，终局把该版本收敛回推到所有基线不一致的
 * 目标（含本轮失败过的）。单目标失败不阻断其余目标。
 *
 * 基线口径：全程「云端远端字节摘要」，与既有 cloudRev 语义一致——outcome.hash（in-sync/downloaded/
 * conflict-resolved 为远端 get 字节 sha256，uploaded 为本次上传信封字节 sha256）与 pushEnvelope 返回的
 * hash 同一口径；宿主可把 hashes 原样持久化并在下轮作 localHash 使用。
 */
import { pushEnvelope, syncWithCloud } from './syncOrchestrator'
import type { CloudBackend } from './backend'

/** 供测试与其他调用方直接复用单目标加密推送（re-export 自 syncOrchestrator）。 */
export { pushEnvelope }

/** 单个云目标的同步输入：key 为宿主侧稳定标识，hash 为该目标上次已知云端内容基线。 */
export interface CloudTargetInput {
  key: string
  backend: CloudBackend
  path: string
  hash: string | null
}

/** 单目标结果：outcome 为 null 表示该目标本轮 syncWithCloud 抛错（error 为消息）；convergeError 仅在收敛回推失败时出现。 */
export interface TargetResult {
  key: string
  outcome: Awaited<ReturnType<typeof syncWithCloud>> | null
  error?: string
  convergeError?: string
}

export interface MultiTargetSyncResult {
  results: TargetResult[]
  /** 收敛后的最终本地明文 vault（adopted 时为被采纳的云端版本，否则为入参原值） */
  finalVaultJson: string
  /** 本轮是否从某目标采纳了较新的云端版本 */
  adopted: boolean
  /** 各目标最终基线 hash（宿主持久化用，仅含本轮处理成功的目标） */
  hashes: Record<string, string>
}

/**
 * 多目标顺序同步 + 收敛：
 * 1. 逐目标 syncWithCloud（独立基线）；downloaded / conflict-resolved 且有 envelopeJson 时采纳为当前内容，
 *    赢家基线 = 该目标 outcome.hash（远端字节摘要，见 syncOrchestrator 冲突分支返回值）。
 * 2. 收敛终局：凡基线 ≠ 赢家 hash 的目标（含本轮失败过的）一律 pushEnvelope 回推赢家内容——成功则
 *    基线更新为新信封字节摘要、outcome 就地改写为 uploaded（类型完整，其余字段置 undefined）；
 *    失败则记 convergeError，outcome 保持原值。基线已等于赢家（如采纳源自身）跳过不重推。
 */
export async function syncMultipleTargets(opts: {
  targets: CloudTargetInput[]
  vaultJson: string
  password: string
  onConflictBackup?: (key: string, bytes: Uint8Array) => string | null | void | Promise<string | null | void>
}): Promise<MultiTargetSyncResult> {
  const { targets, vaultJson, password, onConflictBackup } = opts
  let current = vaultJson
  let adopted = false
  let winnerHash: string | undefined
  const results: TargetResult[] = []
  const hashes: Record<string, string> = {}

  for (const t of targets) {
    try {
      const outcome = await syncWithCloud({
        backend: t.backend,
        path: t.path,
        vaultJson: current,
        password,
        localHash: t.hash,
        onConflictBackup: (bytes) => onConflictBackup?.(t.key, bytes),
      })
      hashes[t.key] = outcome.hash
      if ((outcome.action === 'downloaded' || outcome.action === 'conflict-resolved') && outcome.envelopeJson !== undefined) {
        current = outcome.envelopeJson
        adopted = true
        // downloaded/conflict-resolved 的 outcome.hash 即远端 get 字节的 sha256，直接作赢家基线
        winnerHash = outcome.hash
      }
      results.push({ key: t.key, outcome })
    } catch (err) {
      results.push({ key: t.key, outcome: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (winnerHash !== undefined) {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!
      if (hashes[t.key] === winnerHash) continue
      const result = results[i]!
      try {
        const pushed = await pushEnvelope({ backend: t.backend, path: t.path, vaultJson: current, password })
        hashes[t.key] = pushed.hash
        result.outcome = { action: 'uploaded', envelopeJson: undefined, conflictBackup: undefined, hash: pushed.hash }
      } catch (err) {
        result.convergeError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return { results, finalVaultJson: current, adopted, hashes }
}
