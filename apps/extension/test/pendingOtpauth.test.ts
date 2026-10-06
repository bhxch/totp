/**
 * pendingOtpauth 信封单测（P5）：写盘值从裸 URI 字符串升级为带版本/kind 的 JSON 信封——
 * - encodePending/decodePending 往返保真（uri / pasted 两 kind）；
 * - 旧裸 URI（非 JSON）decodePending 返回 null：调用方按 { kind:'uri', text: raw } 兼容解释
 *   （兼容规则归调用方，本文件只锁 decodePending 的 null 语义）；
 * - 坏 JSON / 形状不符（版本、kind、text 任一不合法）→ null。
 */
import { describe, expect, it } from 'vitest'
import { PENDING_OTPAUTH_KEY, decodePending, encodePending } from '../src/pendingOtpauth'

const URI_PENDING = { v: 1 as const, kind: 'uri' as const, text: 'otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP' }
const PASTED_PENDING = { v: 1 as const, kind: 'pasted' as const, text: '{"shared_secret":"abcd","serial_number":"1"}' }

describe('pendingOtpauth 信封（P5）', () => {
  it('PENDING_OTPAUTH_KEY 常量不变（旧存储键兼容，popup 消费端按同键读取）', () => {
    expect(PENDING_OTPAUTH_KEY).toBe('pendingOtpauth')
  })

  it('encodePending/decodePending 往返保真：uri 与 pasted 两 kind', () => {
    expect(decodePending(encodePending(URI_PENDING))).toEqual(URI_PENDING)
    expect(decodePending(encodePending(PASTED_PENDING))).toEqual(PASTED_PENDING)
    // 写盘值是合法 JSON 文本（旧版消费者按字符串读取时会看到 JSON——由 Task 2 分派承担兼容）
    expect(JSON.parse(encodePending(URI_PENDING))).toEqual(URI_PENDING)
  })

  it('旧格式裸 URI：decodePending 返回 null（非空即视为旧裸 URI 的兼容依据）', () => {
    expect(decodePending('otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP')).toBeNull()
  })

  it('坏 JSON → null', () => {
    expect(decodePending('not json {')).toBeNull()
    expect(decodePending('')).toBeNull()
    expect(decodePending('otpauth://totp/bad')).toBeNull()
  })

  it('JSON 合法但形状不符 → null（含 JSON.parse 结果为原始类型的退化形态）', () => {
    expect(decodePending('null')).toBeNull()
    expect(decodePending('123')).toBeNull()
    expect(decodePending('"str"')).toBeNull()
    expect(decodePending('[]')).toBeNull()
    expect(decodePending('{}')).toBeNull()
    expect(decodePending(JSON.stringify({ v: 1, kind: 'pasted' }))).toBeNull() // 缺 text
    expect(decodePending(JSON.stringify({ v: 1, kind: 'other', text: 'x' }))).toBeNull() // kind 越界
    expect(decodePending(JSON.stringify({ v: 2, kind: 'uri', text: 'x' }))).toBeNull() // 版本不识别
    expect(decodePending(JSON.stringify({ v: 1, kind: 'uri', text: 42 }))).toBeNull() // text 非字符串
  })
})
