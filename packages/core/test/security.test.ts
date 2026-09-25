import { describe, expect, it } from 'vitest'
import {
  addPrfSource, changeVaultPassphrase, decryptVaultWithDek, decryptVaultWithDekDetailed, encryptVaultWithDek,
  isEncryptedVault, isSecuritySettings, setupVaultEncryption, unlockVaultEncryption, SECURITY_KEY, VaultRollbackError,
} from '../src/security/securityStore'
import type { SecuritySettings } from '../src/security/securityStore'
import { unlockWithPrf } from '../src/security/multiKek'
import { bytesToBase64, randomBytes } from '../src/crypto/aesgcm'

const vaultJson = JSON.stringify({ version: 2, entries: [{ uuid: 'a' }], tags: [], updatedAt: 1 })

describe('securityStore', () => {
  it('setup→unlock→encrypt/decrypt 往返', async () => {
    const { security, encrypted, dek } = await setupVaultEncryption(vaultJson, '口令123')
    expect(security.v).toBe(1)
    expect(encrypted.enc).toBe(true)
    expect(isEncryptedVault(encrypted)).toBe(true)
    expect(await decryptVaultWithDek(dek, encrypted)).toBe(vaultJson)
    expect(SECURITY_KEY).toBe('security')

    const dek2 = await unlockVaultEncryption(security, '口令123')
    expect(await decryptVaultWithDek(dek2, encrypted)).toBe(vaultJson)
  })
  it('setupVaultEncryption 非档位 opts 被忽略：永远用默认 balanced 65536/3/1，防止注入极弱 KDF', async () => {
    // 故意传非法 profile/杂项字段，期望被忽略（写入仍为默认 balanced），unlock 用同参数风格不受影响
    const { security } = await setupVaultEncryption(vaultJson, 'p', { profile: 'bogus' as never, m: 1e9, t: 1, p: 1 } as never)
    expect(security.kdf.m).toBe(65536)
    expect(security.kdf.t).toBe(3)
    expect(security.kdf.p).toBe(1)
    expect(security.profile).toBe('balanced')
    expect(typeof security.passwordChangedAt).toBe('number')
  })
  it('setupVaultEncryption 写入 profile 与 passwordChangedAt', async () => {
    const r = await setupVaultEncryption('{}', '口令', { profile: 'paranoid' })
    expect(r.security.profile).toBe('paranoid')
    expect(r.security.kdf.m).toBe(262144)
    expect(typeof r.security.passwordChangedAt).toBe('number')
    // 档位展开参数真实参与派生：新口令可解锁
    expect(await unlockVaultEncryption(r.security, '口令')).toEqual(r.dek)
  })
  it('口令错误报中文错误', async () => {
    const { security } = await setupVaultEncryption(vaultJson, '对')
    await expect(unlockVaultEncryption(security, '错')).rejects.toThrow('口令错误或数据已损坏')
  })
  it('changePassphrase 后新口令可解、旧口令不可（缺省仅重包裹，dek=null）', async () => {
    const { security, dek } = await setupVaultEncryption(vaultJson, '旧')
    const rewrap = await changeVaultPassphrase(security, dek, '新')
    expect(rewrap.dek).toBeNull()
    const s2 = rewrap.security
    expect(s2.kdf.salt).not.toBe(security.kdf.salt)
    expect(s2.profile).toBe(security.profile)
    expect(s2.passwordChangedAt).toBeGreaterThanOrEqual(security.passwordChangedAt!)
    const dek2 = await unlockVaultEncryption(s2, '新')
    expect(dek2).toEqual(dek) // 同一 DEK：数据无需重加密
    await expect(unlockVaultEncryption(s2, '旧')).rejects.toThrow('口令错误或数据已损坏')
  })
  it('changeVaultPassphrase rotateDek=true 返回新 DEK，丢弃 prf 死凭证源，旧 DEK 解不开新 wrappedDek', async () => {
    const setup = await setupVaultEncryption(vaultJson, '旧')
    // 先绑定 prf 源：其包裹指向旧 DEK，轮换后必须被数据层丢弃（方案a：旧 DEK 不可信，可解包裹物不留盘）
    const prfOutput = randomBytes(64)
    const withPrf = await addPrfSource(setup.security, setup.dek, 'cred-1', prfOutput, bytesToBase64(randomBytes(32)))
    expect(withPrf.kekSources).toHaveLength(2)
    const rotated = await changeVaultPassphrase(withPrf, setup.dek, '新', { rotateDek: true, profile: 'fast' })
    expect(rotated.dek).not.toBeNull()
    expect(rotated.dek).not.toEqual(setup.dek)
    expect(rotated.security.kdf.profile).toBe('fast')
    expect(rotated.security.kdf.m).toBe(19456)
    expect(rotated.security.passwordChangedAt).toBeGreaterThanOrEqual(setup.security.passwordChangedAt!)
    // 轮换丢弃死凭证源：kekSources 仅剩 password（口令通道恒可用，不产生死锁）
    expect(rotated.security.kekSources).toEqual([{ kind: 'password' }])
    // prf 路径从「解密失败误导」变为「明确的未绑定」：passkey 解锁失败
    await expect(unlockWithPrf(rotated.security, prfOutput)).rejects.toThrow('passkey 解锁失败')
    // 新口令解开的是新 DEK；旧 DEK 不再匹配新 wrappedDek（unlock 返回值 ≠ 旧 DEK）
    expect(await unlockVaultEncryption(rotated.security, '新')).toEqual(rotated.dek)
    await expect(unlockVaultEncryption(rotated.security, '旧')).rejects.toThrow('口令错误或数据已损坏')
  })
  it('changePassphrase 保留 kekSources：prf 绑定不丢，unlockWithPrf 仍可解锁同一 DEK', async () => {
    const { security, dek } = await setupVaultEncryption(vaultJson, '口令')
    const prfOutput = randomBytes(64)
    const withPrf = await addPrfSource(security, dek, 'cred-1', prfOutput, bytesToBase64(randomBytes(32)))
    expect(withPrf.kekSources).toHaveLength(2) // password + prf

    // 换口令：wrappedDek 重包裹，但 kekSources（prf 包裹）必须原样保留
    const s2 = (await changeVaultPassphrase(withPrf, dek, '新口令')).security
    expect(s2.kekSources).toEqual(withPrf.kekSources)
    // 新口令路径正常
    expect(await unlockVaultEncryption(s2, '新口令')).toEqual(dek)
    // prf 路径不受换口令影响（wrappedDekP 与 DEK 绑定，不与口令 KEK 绑定）
    expect(await unlockWithPrf(s2, prfOutput)).toEqual(dek)
  })
  it('kdf 超钳制参数拒绝（F9 上限收紧为档位包络 262144/4/1：m=262145/t=5/p=2 均拒绝）', async () => {
    const { security } = await setupVaultEncryption(vaultJson, 'p')
    const badT = { ...security, kdf: { ...security.kdf, t: 99999 } } as typeof security
    await expect(unlockVaultEncryption(badT, 'p')).rejects.toThrow('invalid security settings')
    const badM = { ...security, kdf: { ...security.kdf, m: 262145 } } as typeof security
    const badP = { ...security, kdf: { ...security.kdf, p: 2 } } as typeof security
    await expect(unlockVaultEncryption(badM, 'p')).rejects.toThrow('invalid security settings')
    await expect(unlockVaultEncryption(badP, 'p')).rejects.toThrow('invalid security settings')
  })
  it('kdf 下限违规拒绝（m<1024/t<1/p<1；OWASP 最低推荐）', async () => {
    const { security } = await setupVaultEncryption(vaultJson, 'p')
    const badM = { ...security, kdf: { ...security.kdf, m: 512 } } as typeof security
    const badT = { ...security, kdf: { ...security.kdf, t: 0 } } as typeof security
    const badP = { ...security, kdf: { ...security.kdf, p: 0 } } as typeof security
    await expect(unlockVaultEncryption(badM, 'p')).rejects.toThrow('invalid security settings')
    await expect(unlockVaultEncryption(badT, 'p')).rejects.toThrow('invalid security settings')
    await expect(unlockVaultEncryption(badP, 'p')).rejects.toThrow('invalid security settings')
  })
  it('encrypt 对非 32B dek 抛 invalid dek；结构非法拒绝', async () => {
    await expect(encryptVaultWithDek(new Uint8Array(16), '{}')).rejects.toThrow('invalid dek')
    await expect(unlockVaultEncryption({ v: 2 } as never, 'p')).rejects.toThrow('invalid security settings')
  })
  it('decryptVaultWithDekDetailed 对非 32B dek 抛 invalid dek', async () => {
    const { encrypted } = await setupVaultEncryption(vaultJson, 'p')
    await expect(decryptVaultWithDek(new Uint8Array(16), encrypted)).rejects.toThrow('invalid dek')
  })
  it('decryptVaultWithDekDetailed：密文结构非法 → invalid encrypted vault', async () => {
    await expect(decryptVaultWithDekDetailed(new Uint8Array(32), { v: 2 } as never)).rejects.toThrow('invalid encrypted vault')
    await expect(decryptVaultWithDekDetailed(new Uint8Array(32), null as never)).rejects.toThrow('invalid encrypted vault')
  })
  it('addPrfSource：settings 结构非法 → invalid security settings', async () => {
    await expect(addPrfSource({ v: 2 } as never, new Uint8Array(32), 'cred', randomBytes(64), 'c2FsdA=='))
      .rejects.toThrow('invalid security settings')
  })
  it('两次 setup 产生不同 salt/nonce（随机性）', async () => {
    const a = await setupVaultEncryption(vaultJson, 'p')
    const b = await setupVaultEncryption(vaultJson, 'p')
    expect(a.security.kdf.salt).not.toBe(b.security.kdf.salt)
    expect(a.encrypted.ciphertext).not.toBe(b.encrypted.ciphertext)
  })
  it('M6：changeVaultPassphrase 去重 kekSources — 同 kind 重复条目仅保留首条', async () => {
    const { security, dek } = await setupVaultEncryption(vaultJson, 'p')
    const prfOutput = randomBytes(64)
    // 手工构造：1 password + 1 prf + 1 prf(同 credentialId 重复) + 1 dpapi 重复
    const baseWithPrf = await addPrfSource(security, dek, 'cred-1', prfOutput, bytesToBase64(randomBytes(32)))
    const duplicated = {
      ...baseWithPrf,
      kekSources: [
        ...(baseWithPrf.kekSources ?? []),
        { kind: 'password' as const },
        { kind: 'prf' as const, credentialId: 'cred-1', salt: 's', wrappedDekP: 'w' },
        { kind: 'prf' as const, credentialId: 'cred-2', salt: 's', wrappedDekP: 'w' },
        { kind: 'dpapi' as const, wrappedDekD: 'd' },
        { kind: 'dpapi' as const, wrappedDekD: 'd2' },
      ],
    } as typeof baseWithPrf
    const s2 = (await changeVaultPassphrase(duplicated, dek, 'new')).security
    // 期望：password×1, prf cred-1×1, prf cred-2×1, dpapi×1
    const kinds = (s2.kekSources ?? []).map((k) => (k as { kind: string }).kind)
    expect(kinds).toEqual(['password', 'prf', 'prf', 'dpapi'])
    // 唯一性验证：prf credentialId 唯一、dpapi 唯一
    const prfIds = (s2.kekSources ?? []).filter((k) => k.kind === 'prf').map((k) => (k as { credentialId: string }).credentialId)
    expect(new Set(prfIds).size).toBe(prfIds.length)
  })
})

describe('securityStore 拒绝方向补全（解锁/改密异常入参）', () => {
  /** 最小合法 SecuritySettings fixture（不经 setup，避免 argon2 开销；仅测结构校验路径） */
  const bareSecurity = (kdfPatch: Record<string, unknown> = {}): SecuritySettings =>
    ({
      v: 1,
      enabled: true,
      kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: bytesToBase64(randomBytes(16)), ...kdfPatch },
      wrapNonce: bytesToBase64(randomBytes(12)),
      wrappedDek: bytesToBase64(randomBytes(48)),
    }) as SecuritySettings

  it('unlock：security 非对象（null/标量）→ invalid security settings', async () => {
    await expect(unlockVaultEncryption(null as never, 'p')).rejects.toThrow('invalid security settings')
    await expect(unlockVaultEncryption('x' as never, 'p')).rejects.toThrow('invalid security settings')
  })
  it('unlock：kdf.salt 非字符串 → invalid security settings', async () => {
    await expect(unlockVaultEncryption(bareSecurity({ salt: 12345 }), 'p')).rejects.toThrow('invalid security settings')
  })
  it('unlock：kdf.salt base64 非法 → 派生前按结构拒绝（invalid security settings，不触发 KDF）', async () => {
    await expect(unlockVaultEncryption(bareSecurity({ salt: '!!not-base64' }), 'p')).rejects.toThrow('invalid security settings')
  })
  it('changeVaultPassphrase：dek 非 32B → invalid dek', async () => {
    await expect(changeVaultPassphrase(bareSecurity(), new Uint8Array(16), '新口令')).rejects.toThrow('invalid dek')
  })
  it('changeVaultPassphrase：security 结构非法 → invalid security settings', async () => {
    await expect(changeVaultPassphrase({ v: 2 } as never, new Uint8Array(32), '新口令')).rejects.toThrow('invalid security settings')
  })
  it('changeVaultPassphrase：kdf 参数超钳制 → 派生前拒绝（invalid security settings）', async () => {
    await expect(changeVaultPassphrase(bareSecurity({ m: 262145 }), new Uint8Array(32), '新')).rejects.toThrow('invalid security settings')
    await expect(changeVaultPassphrase(bareSecurity({ t: 0 }), new Uint8Array(32), '新')).rejects.toThrow('invalid security settings')
  })
  it('isEncryptedVault / isSecuritySettings：null 与标量 → false（类型守卫宽松侧）', () => {
    for (const bad of [null, undefined, 'str', 42, true]) {
      expect(isEncryptedVault(bad)).toBe(false)
      expect(isSecuritySettings(bad)).toBe(false)
    }
  })
})

describe('VaultRollbackError（F8 回滚拒绝错误类型，最小构造锚定）', () => {
  it('Error 子类、name 与中文消息锚定', () => {
    const e = new VaultRollbackError()
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('VaultRollbackError')
    expect(e.message).toBe('vault 回滚被拒绝：密文 rev 低于本地水位')
  })
})
