import { pbkdf2Sha1, zipAesCtrDecrypt } from '@totp/core'
import { hexToBytes } from '@totp/core'
import { describe, expect, it } from 'vitest'

const hex = (s: string) => hexToBytes(s)!
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
// RFC 6070 的 P/S 是 ASCII 字节串（"salt" 非法 hex，不能走 hexToBytes）
const ascii = (s: string) => new TextEncoder().encode(s)

describe('pbkdf2Sha1（RFC 6070 权威向量）', () => {
  it.each([
    ['password', 'salt', 1, '0c60c80f961f0e71f3a9b524af6012062fe037a6'],
    ['password', 'salt', 2, 'ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957'],
    ['password', 'salt', 4096, '4b007901b765489abead49d926f721d065a429c1'],
  ])('P=%s S=%s c=%i → 20B', async (p, s, c, expected) => {
    const out = await pbkdf2Sha1(p, ascii(s), c, 20)
    expect(toHex(out)).toBe(expected)
  })
})

describe('zipAesCtrDecrypt（NIST SP 800-38A F.5.1 CTR-AES128.Encrypt）', () => {
  it('块1：6bc1bee2… → 874d6191…', async () => {
    const key = hex('2b7e151628aed2a6abf7158809cf4f3c')!
    const counter = hex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff')!
    const plain = hex('6bc1bee22e409f96e93d7e117393172a')!
    const ct = await zipAesCtrDecrypt(key, plain, counter) // CTR 加解对称
    expect(toHex(ct)).toBe('874d6191b620e3261bef6864990db6ce')
  })
  it('跨块计数递增：两块明文整体加解一致', async () => {
    const key = hex('2b7e151628aed2a6abf7158809cf4f3c')!
    const counter = hex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff')!
    const plain = hex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51')!
    const ct = await zipAesCtrDecrypt(key, plain, counter)
    expect(toHex(ct)).toBe('874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff')
    const back = await zipAesCtrDecrypt(key, ct, counter)
    expect(toHex(back)).toBe(toHex(plain))
  })
})
