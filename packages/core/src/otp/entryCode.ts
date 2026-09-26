import { TYPE_PROFILES, type CodeComputeInput } from './typeProfiles'
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
 * R3：类型特化算法/参数经 typeProfiles.compute 查表，本函数只统一 period/remaining 组装与
 * unknown 类型守卫。直接从具体模块导入而非 '../index'，避免 index ↔ entryCode 循环依赖。
 */
export async function computeEntryCode(e: CodeComputeInput, nowMs: number): Promise<EntryCode> {
  const profile = TYPE_PROFILES[e.type]
  if (!profile) throw new Error(`不支持的 OTP 类型: ${(e as { type: unknown }).type}`)
  const period = e.period || 30
  const remaining = period - (Math.floor(nowMs / 1000) % period)
  const r = await profile.compute(e, nowMs, period)
  return {
    code: r.code,
    remaining,
    period,
    ...(r.counter !== undefined ? { counter: r.counter } : {}),
  }
}
