/** KDF 档位（设计 §2）：备份 envelope 与本地库 securityStore 共用的档位类型与展开常量。
 *  fast≈OWASP 最低档（低端机快），balanced=历史默认（65536/3/1），paranoid=保守。
 *  展开参数写入时随信封/设置落盘，读端仍按展开值钳制——profile 仅记录写入意图。
 *  本文件为 security/securityStore 与 backup/envelope 的公共依赖，两侧各自 import，零循环。 */

export type KdfProfile = 'fast' | 'balanced' | 'paranoid'

export const KDF_PROFILES: Record<KdfProfile, { m: number; t: number; p: number }> = {
  fast: { m: 19_456, t: 2, p: 1 },
  balanced: { m: 65_536, t: 3, p: 1 },
  paranoid: { m: 262_144, t: 4, p: 1 },
}

export const DEFAULT_KDF_PROFILE: KdfProfile = 'balanced'

/** 脏值守护：旧数据/宿主误传非法档位时回落默认，而非让 KDF_PROFILES[profile] 直接崩 */
export function isKdfProfile(x: unknown): x is KdfProfile {
  return typeof x === 'string' && x in KDF_PROFILES
}
