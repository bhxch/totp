import { describe, expect, it, vi } from 'vitest'

// F9：解密侧 KDF 钳制必须在 deriveKek（argon2id，即口令验证）之前完成。
// mock hash-wasm 只记录调用不做真实 KDF，从而可断言「拒绝发生在 argon2id 之前」；
// 固定返回 32B KEK 使 AES-GCM 包裹/解开链路真实可用（webcrypto 不受 mock 影响）。
const mockArgon2id = vi.hoisted(() => vi.fn(async (_params: Record<string, unknown>) => new Uint8Array(32).fill(7)))
vi.mock('hash-wasm', () => ({ argon2id: mockArgon2id }))

import { createBackupEnvelope, openBackupEnvelope } from '../src/backup/envelope'
import { setupVaultEncryption, unlockVaultEncryption } from '../src/security/securityStore'
import { KDF_DECRYPT_CLAMP, KDF_PROFILES } from '../src/crypto/kdfProfile'

const vaultJson = JSON.stringify({ version: 2, entries: [{ uuid: 'a' }], tags: [], updatedAt: 1 })

describe('KDF 解密侧钳制（F9）：上限=写侧最重档，超限在 argon2id 之前拒绝', () => {
  it('钳制上限与 KDF_PROFILES 最重档（paranoid）同源、不漂移', () => {
    expect(KDF_DECRYPT_CLAMP.maxM).toBe(Math.max(...Object.values(KDF_PROFILES).map((v) => v.m)))
    expect(KDF_DECRYPT_CLAMP.maxT).toBe(Math.max(...Object.values(KDF_PROFILES).map((v) => v.t)))
    expect(KDF_DECRYPT_CLAMP.maxP).toBe(Math.max(...Object.values(KDF_PROFILES).map((v) => v.p)))
    expect(KDF_DECRYPT_CLAMP.maxM).toBe(262144)
    expect(KDF_DECRYPT_CLAMP.maxT).toBe(4)
    expect(KDF_DECRYPT_CLAMP.maxP).toBe(1)
  })

  it('envelope：m=262145/t=5/p=2 在 argon2id 调用前按结构非法拒绝', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p')
    mockArgon2id.mockClear()
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 262145 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, t: 5 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, p: 2 } }, 'p')).rejects.toThrow('invalid backup envelope')
    expect(mockArgon2id).not.toHaveBeenCalled()
  })

  it('envelope：最重档 paranoid（262144/4/1）恰好放行并进入 argon2id', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p', 'paranoid')
    expect(env.kdf).toMatchObject({ m: 262144, t: 4, p: 1 })
    mockArgon2id.mockClear()
    await expect(openBackupEnvelope(env, 'p')).resolves.toBe(vaultJson)
    expect(mockArgon2id).toHaveBeenCalledTimes(1)
    expect(mockArgon2id.mock.calls[0]![0]).toMatchObject({ memorySize: 262144, iterations: 4, parallelism: 1 })
  })

  it('securityStore：unlock 对 m=262145/t=5/p=2 在 argon2id 调用前按结构非法拒绝', async () => {
    const { security } = await setupVaultEncryption(vaultJson, 'p')
    mockArgon2id.mockClear()
    const badM = { ...security, kdf: { ...security.kdf, m: 262145 } } as typeof security
    const badT = { ...security, kdf: { ...security.kdf, t: 5 } } as typeof security
    const badP = { ...security, kdf: { ...security.kdf, p: 2 } } as typeof security
    await expect(unlockVaultEncryption(badM, 'p')).rejects.toThrow('invalid security settings')
    await expect(unlockVaultEncryption(badT, 'p')).rejects.toThrow('invalid security settings')
    await expect(unlockVaultEncryption(badP, 'p')).rejects.toThrow('invalid security settings')
    expect(mockArgon2id).not.toHaveBeenCalled()
  })

  it('securityStore：paranoid 档 setup→unlock 恰好放行（等于上限不误拒合法数据）', async () => {
    const { security, dek } = await setupVaultEncryption(vaultJson, '口令', { profile: 'paranoid' })
    expect(security.kdf).toMatchObject({ m: 262144, t: 4, p: 1 })
    mockArgon2id.mockClear()
    await expect(unlockVaultEncryption(security, '口令')).resolves.toEqual(dek)
    expect(mockArgon2id).toHaveBeenCalledTimes(1)
    expect(mockArgon2id.mock.calls[0]![0]).toMatchObject({ memorySize: 262144, iterations: 4, parallelism: 1 })
  })
})
