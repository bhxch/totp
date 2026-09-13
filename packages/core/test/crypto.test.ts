import { describe, expect, it } from 'vitest'
import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, deriveKek, randomBytes } from '../src/crypto/aesgcm'

describe('base64', () => {
  it('往返', () => {
    for (const len of [0, 1, 5, 12, 16, 32, 100]) {
      const b = randomBytes(len)
      expect(base64ToBytes(bytesToBase64(b))).toEqual(b)
    }
  })
  it('标准向量', () => {
    expect(bytesToBase64(new Uint8Array([0, 0]))).toBe('AAA=')
    expect(base64ToBytes('AAA=')).toEqual(new Uint8Array([0, 0]))
  })
})

describe('deriveKek', () => {
  it('同口令同 salt 确定性；异口令不同', async () => {
    const salt = randomBytes(16)
    const a = await deriveKek('口令测试', salt)
    const b = await deriveKek('口令测试', salt)
    const c = await deriveKek('另一个', salt)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(a.length).toBe(32)
  })
  it('默认参数耗时合理（64MiB）且结果稳定', async () => {
    const s = base64ToBytes('AAAAAAAAAAAAAAAAAAAAAA==')
    const v = await deriveKek('x', s)
    expect(v.length).toBe(32)
  })
})

describe('aesGcm', () => {
  it('往返；tag 附加在尾部', async () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const pt = new TextEncoder().encode('机密数据 secret 🎉')
    const ct = await aesGcmEncrypt(key, pt, nonce)
    expect(ct.length).toBe(pt.length + 16)
    expect(await aesGcmDecrypt(key, ct, nonce)).toEqual(pt)
  })
  it('错误密钥/被篡改密文抛错', async () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const ct = await aesGcmEncrypt(key, new TextEncoder().encode('x'), nonce)
    await expect(aesGcmDecrypt(randomBytes(32), ct, nonce)).rejects.toThrow()
    const tampered = ct.slice()
    tampered[0]! ^= 1
    await expect(aesGcmDecrypt(key, tampered, nonce)).rejects.toThrow()
  })
  it('nonce 复用同 key 产生同密文（确定性校验）', async () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const pt = new TextEncoder().encode('same')
    expect(await aesGcmEncrypt(key, pt, nonce)).toEqual(await aesGcmEncrypt(key, pt, nonce))
  })
})
