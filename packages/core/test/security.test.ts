import { describe, expect, it } from 'vitest'
import {
  changeVaultPassphrase, decryptVaultWithDek, encryptVaultWithDek, isEncryptedVault,
  setupVaultEncryption, unlockVaultEncryption, SECURITY_KEY,
} from '../src/security/securityStore'

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
  it('kdf 超钳制参数拒绝', async () => {
    const { security } = await setupVaultEncryption(vaultJson, 'p')
    const bad = { ...security, kdf: { ...security.kdf, t: 99999 } } as typeof security
    await expect(unlockVaultEncryption(bad, 'p')).rejects.toThrow('invalid security settings')
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
