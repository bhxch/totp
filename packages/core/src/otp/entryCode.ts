import { base32Decode } from '../encoding/base32'
import { hotp } from './hotp'
import { totp } from './totp'
import { steamCode } from './steam'
import { yandexCode } from './yandex'
import type { OtpEntry } from '../model'

export interface EntryCode {
  code: string
  /** 剩余秒数（hotp 无周期语义时按 period 字段照算，仅供展示） */
  remaining: number
  period: number
  /** hotp 专有：窥视的当前 counter（不推进） */
  counter?: number
}

/**
 * 四类型取码统一分发（plan17 MCP 事件桥与列表 UI 共用）；secret 非法由底层抛错，调用方 catch。
 * 注：直接从具体模块导入而非 '../index'，避免 index ↔ entryCode 循环依赖。
 */
export async function computeEntryCode(
  e: Pick<OtpEntry, 'type' | 'secret' | 'algorithm' | 'digits' | 'period' | 'counter' | 'pin'>,
  nowMs: number,
): Promise<EntryCode> {
  const period = e.period || 30
  const remaining = period - (Math.floor(nowMs / 1000) % period)
  if (e.type === 'steam') return { code: await steamCode(base32Decode(e.secret), nowMs), remaining, period }
  if (e.type === 'yandex')
    return { code: await yandexCode(e.secret, e.pin ?? '', nowMs, period, e.digits), remaining, period }
  if (e.type === 'hotp')
    return {
      code: await hotp(base32Decode(e.secret), e.counter ?? 0, { algorithm: e.algorithm, digits: e.digits }),
      remaining,
      period,
      counter: e.counter ?? 0,
    }
  if (e.type === 'totp')
    return { code: await totp(base32Decode(e.secret), nowMs, { algorithm: e.algorithm, digits: e.digits, period }), remaining, period }
  throw new Error(`不支持的 OTP 类型: ${(e as { type: unknown }).type}`)
}
