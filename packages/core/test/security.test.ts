import { describe, expect, it } from 'vitest'
import {
  addPrfSource, changeVaultPassphrase, decryptVaultWithDek, encryptVaultWithDek, isEncryptedVault,
  setupVaultEncryption, unlockVaultEncryption, SECURITY_KEY,
} from '../src/security/securityStore'
import { unlockWithPrf } from '../src/security/multiKek'
import { bytesToBase64, randomBytes } from '../src/crypto/aesgcm'

const vaultJson = JSON.stringify({ version: 1, entries: [{ uuid: 'a' }], groups: [], updatedAt: 1 })

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
  it('setupVaultEncryption 忽略外部 params 注入：永远用默认 65536/3/1，防止注入极弱 KDF', async () => {
    // 故意注入极弱参数，期望被忽略（写入仍为默认 65536/3/1），unlock 用同参数风格不受影响
    const { security } = await setupVaultEncryption(vaultJson, 'p', { m: 1e9, t: 1, p: 1 } as any)
    expect(security.kdf.m).toBe(65536)
    expect(security.kdf.t).toBe(3)
    expect(security.kdf.p).toBe(1)
  })
  it('口令错误报中文错误', async () => {
    const { security } = await setupVaultEncryption(vaultJson, '对')
    await expect(unlockVaultEncryption(security, '错')).rejects.toThrow('口令错误或数据已损坏')
  })
  it('changePassphrase 后新口令可解、旧口令不可', async () => {
    const { security, dek } = await setupVaultEncryption(vaultJson, '旧')
    const s2 = await changeVaultPassphrase(security, dek, '新')
    expect(s2.kdf.salt).not.toBe(security.kdf.salt)
    const dek2 = await unlockVaultEncryption(s2, '新')
    expect(dek2).toEqual(dek) // 同一 DEK：数据无需重加密
    await expect(unlockVaultEncryption(s2, '旧')).rejects.toThrow('口令错误或数据已损坏')
  })
  it('changePassphrase 保留 kekSources：prf 绑定不丢，unlockWithPrf 仍可解锁同一 DEK', async () => {
    const { security, dek } = await setupVaultEncryption(vaultJson, '口令')
    const prfOutput = randomBytes(64)
    const withPrf = await addPrfSource(security, dek, 'cred-1', prfOutput, bytesToBase64(randomBytes(32)))
    expect(withPrf.kekSources).toHaveLength(2) // password + prf

    // 换口令：wrappedDek 重包裹，但 kekSources（prf 包裹）必须原样保留
    const s2 = await changeVaultPassphrase(withPrf, dek, '新口令')
    expect(s2.kekSources).toEqual(withPrf.kekSources)
    // 新口令路径正常
    expect(await unlockVaultEncryption(s2, '新口令')).toEqual(dek)
    // prf 路径不受换口令影响（wrappedDekP 与 DEK 绑定，不与口令 KEK 绑定）
    expect(await unlockWithPrf(s2, prfOutput)).toEqual(dek)
  })
  it('kdf 超钳制参数拒绝', async () => {
    const { security } = await setupVaultEncryption(vaultJson, 'p')
    const bad = { ...security, kdf: { ...security.kdf, t: 99999 } } as typeof security
    await expect(unlockVaultEncryption(bad, 'p')).rejects.toThrow('invalid security settings')
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
  it('两次 setup 产生不同 salt/nonce（随机性）', async () => {
    const a = await setupVaultEncryption(vaultJson, 'p')
    const b = await setupVaultEncryption(vaultJson, 'p')
    expect(a.security.kdf.salt).not.toBe(b.security.kdf.salt)
    expect(a.encrypted.ciphertext).not.toBe(b.encrypted.ciphertext)
  })
})
