import { describe, expect, it } from 'vitest'
import { aesGcmEncrypt, bytesToBase64, randomBytes } from '../src/crypto/aesgcm'
import { openSecretBag, sealSecretBag, SECRET_BAG_KEY, emptyBag } from '../src/backup/secretBag'

/** 手工封装任意明文为保管区信封（构造「解密成功但明文坏 JSON/字段坏」 fixture 用） */
async function sealRawPlaintext(dek: Uint8Array, plaintext: string): Promise<string> {
  const nonce = randomBytes(12)
  const ct = await aesGcmEncrypt(dek, new TextEncoder().encode(plaintext), nonce)
  return JSON.stringify({ v: 1, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ct) })
}

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
  it("raw='' → 空保管区（不抛）", async () => {
    await expect(openSecretBag(randomBytes(32), '')).resolves.toEqual(emptyBag())
  })
  it('dek 非 32B：seal 与 open 双向均抛 invalid dek（先于内容校验）', async () => {
    const dek16 = new Uint8Array(16)
    await expect(sealSecretBag(dek16, { backupPassword: 'x', creds: {} })).rejects.toThrow('invalid dek')
    await expect(openSecretBag(dek16, null)).rejects.toThrow('invalid dek')
    await expect(
      openSecretBag(dek16, JSON.stringify({ v: 1, nonce: 'AAAAAAAAAAAAAAAAAAAAAA==', ciphertext: 'AAAA' })),
    ).rejects.toThrow('invalid dek')
  })
  it('解密成功但明文非 JSON → 空保管区（不抛，损坏一律回落语义）', async () => {
    const dek = randomBytes(32)
    const raw = await sealRawPlaintext(dek, '{{{not json')
    await expect(openSecretBag(dek, raw)).resolves.toEqual(emptyBag())
  })
  it('明文 JSON 但字段形态不符 → 逐字段回落：backupPassword 非串→空串、creds 缺失→空对象', async () => {
    const dek = randomBytes(32)
    await expect(openSecretBag(dek, await sealRawPlaintext(dek, '{"backupPassword":123}')))
      .resolves.toEqual(emptyBag())
    await expect(openSecretBag(dek, await sealRawPlaintext(dek, '{"backupPassword":"keep"}')))
      .resolves.toEqual({ backupPassword: 'keep', creds: {} })
  })
  it('emptyBag 形状', () => {
    expect(emptyBag()).toEqual({ backupPassword: '', creds: {} })
  })
  it('SECRET_BAG_KEY 常量', () => {
    expect(SECRET_BAG_KEY).toBe('secretBag')
  })
})
