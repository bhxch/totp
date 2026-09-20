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

/** 读端（解密侧）KDF 参数钳制边界，backup/envelope 与 security/securityStore 共用：
 *  下限遵循 Argon2id 规范/OWASP 最低推荐（m≥1024 KiB / t≥1 / p≥1）；
 *  上限取全部已发布档位的最大展开值——写侧（createBackupEnvelope/setupVaultEncryption/
 *  changeVaultPassphrase）只可能写入 KDF_PROFILES 中的档位值，合法数据必落在该包络内，
 *  故上限与写侧最重档同源派生、永不漂移（F9：旧上限 2**21/t=10/p=8 远超最重档，恶意云对象
 *  可在口令验证前驱动超档 Argon2id，现超限一律在 deriveKek 前按结构非法拒绝）。
 *  残余风险（如实备注）：包络内的恶意远端对象仍可在口令验证前反复迫使合法最重档（当前
 *  256MiB/t=4）KDF 运算——客户端同步通道无后端速率限制，此为钳制方案的固有限制。 */
export const KDF_DECRYPT_CLAMP = {
  minM: 1024,
  maxM: Math.max(...Object.values(KDF_PROFILES).map((v) => v.m)),
  minT: 1,
  maxT: Math.max(...Object.values(KDF_PROFILES).map((v) => v.t)),
  minP: 1,
  maxP: Math.max(...Object.values(KDF_PROFILES).map((v) => v.p)),
} as const

/** 脏值守护：旧数据/宿主误传非法档位时回落默认，而非让 KDF_PROFILES[profile] 直接崩 */
export function isKdfProfile(x: unknown): x is KdfProfile {
  return typeof x === 'string' && x in KDF_PROFILES
}
