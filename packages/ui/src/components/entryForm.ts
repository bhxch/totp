import { hasNestedQuantifierRisk, MAX_MATCH_PATTERN_LENGTH, type HashAlgorithm, type IconRef, type MatchRule } from '@totp/core'

export interface EntryFormData {
  type: 'totp' | 'hotp' | 'steam' | 'yandex'
  issuer: string
  label: string
  secret: string
  /** 哈希算法；缺省表示沿用服务端默认（SHA1），避免编辑既有条目时隐式重置 */
  algorithm?: HashAlgorithm
  /** 验证码位数；缺省表示沿用服务端默认（totp/hotp=6，steam=5，yandex=8） */
  digits?: number
  /** TOTP 周期（秒）；缺省 30 */
  period?: number
  /** HOTP 计数器（仅 hotp 类型有效） */
  counter?: number
  /** Yandex（yaotp）的 PIN，可选；仅 yandex 类型提交（缺省/空串按无 PIN 计算） */
  pin?: string
  note: string
  tagIds: string[]
  matchRules: MatchRule[]
  /** 图标引用：builtin/stored/url；未设置时缺省 */
  icon?: IconRef
}

/**
 * I51：URL 匹配规则中 strategy=regex 的客户端预校验。
 * - 空串视为合法（前端过滤后忽略）；非空时必须能编译为 RegExp。
 * - F13：与恢复校验对齐——超长（>256）与嵌套量词回溯形态（如 (a+)+）同样拒绝，
 *   避免表单创建出恢复路径会拒收的规则。
 * - 不接受 /flag 之外的特殊字符限制；保留 i/m 常用旗标。
 */
export function validateRegex(pattern: string): string | null {
  const p = pattern.trim()
  if (!p) return null
  // RegExp 构造只接受 g/i/m/s/u/y 旗标，其余（d 等 v8 私有）可能不被旧宿主支持
  try {
    // eslint-disable-next-line no-new
    new RegExp(p)
  } catch (e) {
    return e instanceof Error ? e.message : '正则表达式非法'
  }
  if (p.length > MAX_MATCH_PATTERN_LENGTH) return `正则长度超过 ${MAX_MATCH_PATTERN_LENGTH} 字符上限`
  if (hasNestedQuantifierRisk(p)) return '正则含嵌套量词（如 (a+)+），存在灾难性回溯风险'
  return null
}
