/** 规范化 JSON 与内容 hash（spec §1.3 内容门）：对解密后 vault JSON 做稳定序列化再 sha256，
 *  消除键序抖动——「内容未变」判定与字节形态解耦。
 *  R15③：sha256Hex 单点实现归位本模块（超集签名，一处吸收 s3/syncOrchestrator/winauth 三处
 *  逐字副本与下方 contentHash×2 的内联摘要转换；oauthRefresh 改导入后不再反向依赖编排模块）。 */

export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null'
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`
  const keys = Object.keys(x as Record<string, unknown>)
    .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((x as Record<string, unknown>)[k])}`).join(',')}}`
}

/** SHA-256 摘要转小写 hex（crypto.subtle）。string 入参按 UTF-8 编码（s3 SigV4 口径），
 *  Uint8Array 原样摘要（同步链路/导入口令层口径）。 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 含 rev 的全量内容 hash（旧口径）。**生产零消费，仅测试用**（R15②）：同步链路的 vault 内容
 * 比对与信封 baseContentHash 一律用 contentHashVault——rev 是 F8 水位（store 加密落盘恒推进），
 * 属本端存储状态而非 vault 内容，参与 hash 会使采纳落盘后恒判「本地已动」。
 *
 * @deprecated 仅测试口径（ui CloudCard/cloudRunner 测试与本包 canonicalVaultHash 守卫仍消费）。
 * 从 '@totp/core' 公共出口摘除待 ui 测试迁移后进行（消费方不在 R15 允许改动范围内）。
 */
export async function contentHash(vaultJson: string): Promise<string> {
  return sha256Hex(canonicalJson(JSON.parse(vaultJson)))
}

/**
 * vault 内容 hash（同步链路口径，T-FINAL Fix1/I-1）：剔除顶层 `rev` 后 canonicalJson+sha256。
 *
 * `rev` 是 F8 水位（store 加密落盘恒推进，进密文明文），属本端存储状态而非 vault 内容——
 * 若参与内容 hash，采纳（downloaded/merged）落盘后 stored JSON 恒多 rev 字段 ≠ 基线：
 * ①每采纳周期一次冗余云写；②下轮 localUnchanged=false；③零条目冲突合并轮沉淀冲突副本。
 * 同步链路的 vault 内容比对/信封 baseContentHash 声明与校验一律用此口径（两端必须同口径）；
 * 既有 contentHash 保留不动（含 rev 旧口径，未发布无存量基线兼容负担：stored
 * cloudContentHash 旧值与 states.baseSnapshot 旧口径值首轮多一次同步，保守路径自愈，不做迁移）。
 */
export async function contentHashVault(vaultJson: string): Promise<string> {
  const parsed = JSON.parse(vaultJson) as Record<string, unknown>
  const stripped = { ...parsed }
  delete stripped.rev
  return sha256Hex(canonicalJson(stripped))
}
