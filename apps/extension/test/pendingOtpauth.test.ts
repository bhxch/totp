/**
 * pendingOtpauth 信封单测（P5；R5-I3 增补 ts 过期面）：写盘值从裸 URI 字符串升级为带版本/kind
 * 的 JSON 信封——
 * - encodePending/decodePending 往返保真（uri / pasted 两 kind），encodePending 自动盖章 ts；
 * - 旧裸 URI（非 JSON）decodePending 返回 null：调用方按 { kind:'uri', text: raw } 兼容解释
 *   （兼容规则归调用方，本文件只锁 decodePending 的 null 语义）；
 * - 坏 JSON / 形状不符（版本、kind、text 任一不合法；ts 存在但非数字）→ null；
 * - R5-I3：isPendingExpired——无 ts 容忍不过期（升级兼容）、带 ts 超 PENDING_TTL_MS 判过期。
 */
import { describe, expect, it } from 'vitest'
import { PENDING_OTPAUTH_KEY, PENDING_TTL_MS, decodePending, encodePending, isPendingExpired } from '../src/pendingOtpauth'

const URI_PENDING = { v: 1 as const, kind: 'uri' as const, text: 'otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP' }
const PASTED_PENDING = { v: 1 as const, kind: 'pasted' as const, text: '{"shared_secret":"abcd","serial_number":"1"}' }

describe('pendingOtpauth 信封（P5）', () => {
  it('PENDING_OTPAUTH_KEY 常量不变（旧存储键兼容，popup 消费端按同键读取）', () => {
    expect(PENDING_OTPAUTH_KEY).toBe('pendingOtpauth')
  })

  it('encodePending/decodePending 往返保真：uri 与 pasted 两 kind，写入自动盖章 ts（R5-I3）', () => {
    expect(decodePending(encodePending(URI_PENDING))).toEqual({ ...URI_PENDING, ts: expect.any(Number) })
    expect(decodePending(encodePending(PASTED_PENDING))).toEqual({ ...PASTED_PENDING, ts: expect.any(Number) })
    // 写盘值是合法 JSON 文本（旧版消费者按字符串读取时会看到 JSON——由 Task 2 分派承担兼容）
    expect(JSON.parse(encodePending(URI_PENDING))).toMatchObject(URI_PENDING)
    expect(typeof JSON.parse(encodePending(URI_PENDING)).ts).toBe('number')
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
    expect(decodePending(JSON.stringify({ ...URI_PENDING, ts: 'soon' }))).toBeNull() // ts 非数字（R5-I3）
  })

  it('无 ts 的 v1 信封容忍（升级兼容，R5-I3）：decode 成功且不过期', () => {
    const raw = JSON.stringify({ v: 1, kind: 'pasted', text: 'x' })
    const decoded = decodePending(raw)
    expect(decoded).toEqual({ v: 1, kind: 'pasted', text: 'x' })
    expect(isPendingExpired(decoded!)).toBe(false) // 新纪元远晚于任意真实 ts，仍不过期=无 ts 不参与判定
  })
})

describe('isPendingExpired（R5-I3 信封 TTL）', () => {
  it('带 ts 未过期：距写入不超过 PENDING_TTL_MS', () => {
    const now = 1_000_000
    expect(isPendingExpired({ ...URI_PENDING, ts: now - PENDING_TTL_MS }, now)).toBe(false) // 恰在边界内
    expect(isPendingExpired({ ...URI_PENDING, ts: now - 1 }, now)).toBe(false)
    expect(isPendingExpired({ ...URI_PENDING, ts: now }, now)).toBe(false)
  })

  it('带 ts 超过 PENDING_TTL_MS：判过期（含未来时间戳不误判）', () => {
    const now = 1_000_000
    expect(isPendingExpired({ ...URI_PENDING, ts: now - PENDING_TTL_MS - 1 }, now)).toBe(true)
    expect(isPendingExpired({ ...URI_PENDING, ts: now - PENDING_TTL_MS * 10 }, now)).toBe(true)
    expect(isPendingExpired({ ...URI_PENDING, ts: now + 60_000 }, now)).toBe(false) // 时钟回拨容忍
  })
})
