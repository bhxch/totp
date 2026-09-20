import { bytesToBase64 } from '@totp/core'
import { describe, expect, it } from 'vitest'
import { isEntropyBoundDekWrap } from './tauriSecurity'

// F3：v2 包裹格式版本前缀（与 Rust lib.rs DEK_WRAP_MARKER 逐字对齐）
const MARKER = new TextEncoder().encode('TOTPDEK1')

/** 构造 v2 帧：TOTPDEK1 ‖ 随机 DPAPI 密文位（本测试只关心前缀帧形状） */
function v2Frame(cipherLen = 200): string {
  const raw = new Uint8Array(MARKER.length + cipherLen)
  raw.set(MARKER, 0)
  crypto.getRandomValues(raw.subarray(MARKER.length))
  return bytesToBase64(raw)
}

describe('isEntropyBoundDekWrap（F3 迁移判定）', () => {
  it('v2 帧（TOTPDEK1 前缀 + 密文）识别为已迁移', () => {
    expect(isEntropyBoundDekWrap(v2Frame())).toBe(true)
  })

  it('旧格式（无前缀的裸 DPAPI 密文）识别为待迁移', () => {
    const raw = new Uint8Array(200)
    raw[0] = 0 // 任何与 'T' 不同的首字节即非 v2
    expect(isEntropyBoundDekWrap(bytesToBase64(raw))).toBe(false)
  })

  it('恰为前缀本身 / 空串 / 非法 base64 → 按旧格式对待（不抛错）', () => {
    expect(isEntropyBoundDekWrap(bytesToBase64(MARKER))).toBe(false)
    expect(isEntropyBoundDekWrap('')).toBe(false)
    expect(isEntropyBoundDekWrap('not-base64!!!')).toBe(false)
  })
})
