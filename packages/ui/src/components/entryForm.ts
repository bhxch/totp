import type { MatchRule } from '@totp/core'

export interface EntryFormData {
  type: 'totp' | 'hotp' | 'steam'
  issuer: string
  label: string
  secret: string
  note: string
  groupIds: string[]
  matchRules: MatchRule[]
}
