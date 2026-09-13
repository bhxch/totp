import { describe, expect, it } from 'vitest'
import { createBackupEnvelope, isBackupEnvelope, openBackupEnvelope } from '../src/backup/envelope'
import { base64ToBytes, bytesToBase64 } from '../src/crypto/aesgcm'

const vaultJson = JSON.stringify({ version: 1, entries: [{ uuid: 'a' }], groups: [], updatedAt: 1 })

describe('envelope', () => {
  it('创建→口令正确解开原文', async () => {
    const env = await createBackupEnvelope(vaultJson, '口令123')
    expect(env.v).toBe(1)
    expect(env.kdf.alg).toBe('argon2id')
    expect(env.kdf.m).toBe(65536)
    expect(isBackupEnvelope(env)).toBe(true)
    expect(await openBackupEnvelope(env, '口令123')).toBe(vaultJson)
  })
  it('口令错误抛 bad password', async () => {
    const env = await createBackupEnvelope(vaultJson, '对')
    await expect(openBackupEnvelope(env, '错')).rejects.toThrow('bad password or corrupted backup')
  })
  it('密文被篡改抛 bad password', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p')
    const bytes = base64ToBytes(env.ciphertext)
    bytes[0]! ^= 1
    await expect(openBackupEnvelope({ ...env, ciphertext: bytesToBase64(bytes) }, 'p')).rejects.toThrow('bad password or corrupted backup')
  })
  it('结构非法抛 invalid backup envelope', async () => {
    await expect(openBackupEnvelope({ v: 2 }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope('not json', 'p')).rejects.toThrow('invalid backup envelope')
  })
  it('kdf 参数超限抛 invalid backup envelope（防恶意 envelope 资源耗尽）', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, t: 99999 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 2 ** 21 + 1 } }, 'p')).rejects.toThrow('invalid backup envelope')
  })
  it('同口令两次创建产生不同 salt/nonce（随机性）', async () => {
    const a = await createBackupEnvelope(vaultJson, 'p')
    const b = await createBackupEnvelope(vaultJson, 'p')
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.wrapNonce).not.toBe(b.wrapNonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })
  it('isBackupEnvelope 拒绝任意对象', () => {
    expect(isBackupEnvelope({})).toBe(false)
    expect(isBackupEnvelope(null)).toBe(false)
  })
})
