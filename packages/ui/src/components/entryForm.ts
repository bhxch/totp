import type { IconRef, MatchRule } from '@totp/core'

export interface EntryFormData {
  type: 'totp' | 'hotp' | 'steam'
  issuer: string
  label: string
  secret: string
  note: string
  groupIds: string[]
  matchRules: MatchRule[]
  /** 图标引用：builtin/stored/url；未设置时缺省 */
  icon?: IconRef
}
