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
  groupIds: string[]
  matchRules: MatchRule[]
  /** 图标引用：builtin/stored/url；未设置时缺省 */
  icon?: IconRef
}
