import { describe, expect, it } from 'vitest'
import { randomBytes } from '../src/crypto/aesgcm'
import { openSecretBag, sealSecretBag, SECRET_BAG_KEY, emptyBag } from '../src/backup/secretBag'

describe('DEK 保管区', () => {
  it('密封→开启往返（backupPassword + creds）', async () => {
    const dek = randomBytes(32)
    const sealed = await sealSecretBag(dek, { backupPassword: '口令A', creds: { s1: { backend: 'webdav', serverUrl: 'https://x', username: 'u', password: 'p' } } })
    const opened = await openSecretBag(dek, sealed)
    expect(opened.backupPassword).toBe('口令A')
    expect(opened.creds['s1']?.backend).toBe('webdav')
  })
  it('每次密封 nonce 不同（同内容不同密文）', async () => {
    const dek = randomBytes(32)
    const c = { backupPassword: 'x', creds: {} }
    expect(await sealSecretBag(dek, c)).not.toBe(await sealSecretBag(dek, c))
  })
  it('错 DEK 解密抛错', async () => {
    const sealed = await sealSecretBag(randomBytes(32), { backupPassword: 'x', creds: {} })
    await expect(openSecretBag(randomBytes(32), sealed)).rejects.toThrow()
  })
  it('null/坏 JSON/结构非法 → 空保管区（不抛）', async () => {
    const dek = randomBytes(32)
    await expect(openSecretBag(dek, null)).resolves.toEqual(emptyBag())
    await expect(openSecretBag(dek, 'not json')).resolves.toEqual(emptyBag())
    await expect(openSecretBag(dek, JSON.stringify({ v: 1, nonce: '!!', ciphertext: '!!' }))).resolves.toEqual(emptyBag())
  })
  it('emptyBag 形状', () => {
    expect(emptyBag()).toEqual({ backupPassword: '', creds: {} })
  })
  it('SECRET_BAG_KEY 常量', () => {
    expect(SECRET_BAG_KEY).toBe('secretBag')
  })
})
