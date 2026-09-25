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
  it('密文 < 16B（缺 GCM tag）直接抛 "ciphertext too short"，不让底层 subtle 静默通过', async () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    for (const len of [0, 1, 8, 15]) {
      await expect(aesGcmDecrypt(key, new Uint8Array(len), nonce)).rejects.toThrow('ciphertext too short')
    }
  })
  it('nonce 非 12B：encrypt 侧显式拒绝（nonce must be 12 bytes）', async () => {
    const key = randomBytes(32)
    for (const len of [0, 11, 13, 16]) {
      await expect(aesGcmEncrypt(key, new TextEncoder().encode('x'), new Uint8Array(len)))
        .rejects.toThrow('nonce must be 12 bytes')
    }
  })
  it('nonce 非 12B：decrypt 侧显式拒绝（nonce must be 12 bytes）', async () => {
    const key = randomBytes(32)
    for (const len of [0, 11, 13, 16]) {
      await expect(aesGcmDecrypt(key, new Uint8Array(32), new Uint8Array(len)))
        .rejects.toThrow('nonce must be 12 bytes')
    }
  })
  it('key 非 32B 直调原语：AES-256 key must be 32 bytes（加/解两向，早于 GCM 调用）', async () => {
    const nonce = randomBytes(12)
    for (const len of [0, 16, 24, 31, 64]) {
      await expect(aesGcmEncrypt(new Uint8Array(len), new TextEncoder().encode('x'), nonce))
        .rejects.toThrow('AES-256 key must be 32 bytes')
      await expect(aesGcmDecrypt(new Uint8Array(len), new Uint8Array(32), nonce))
        .rejects.toThrow('AES-256 key must be 32 bytes')
    }
  })
})
