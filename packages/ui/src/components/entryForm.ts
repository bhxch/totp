import type { HashAlgorithm, IconRef, MatchRule } from '@totp/core'

export interface EntryFormData {
  type: 'totp' | 'hotp' | 'steam'
  issuer: string
  label: string
  secret: string
  /** 哈希算法；缺省表示沿用服务端默认（SHA1），避免编辑既有条目时隐式重置 */
  algorithm?: HashAlgorithm
  /** 验证码位数；缺省表示沿用服务端默认（totp/hotp=6，steam=5） */
  digits?: number
  /** TOTP 周期（秒）；缺省 30 */
  period?: number
  /** HOTP 计数器（仅 hotp 类型有效） */
  counter?: number
  note: string
  tagIds: string[]
  matchRules: MatchRule[]
  /** 图标引用：builtin/stored/url；未设置时缺省 */
  icon?: IconRef
}

/**
 * I51：URL 匹配规则中 strategy=regex 的客户端预校验。
 * - 空串视为合法（前端过滤后忽略）；非空时必须能编译为 RegExp。
 * - 编译失败 → 返回中文错误消息（提交时阻止保存并展示）；成功 → null。
 * - 不接受 /flag 之外的特殊字符限制；保留 i/m 常用旗标。
 */
export function validateRegex(pattern: string): string | null {
  const p = pattern.trim()
  if (!p) return null
  // RegExp 构造只接受 g/i/m/s/u/y 旗标，其余（d 等 v8 私有）可能不被旧宿主支持
  try {
    // eslint-disable-next-line no-new
    new RegExp(p)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : '正则表达式非法'
  }
}
