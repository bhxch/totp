import type { HashAlgorithm } from './otp/hotp'
import type { MatchRule } from './match/engine'
import type { IconRef } from './icons/registry'

export type EntryType = 'totp' | 'hotp' | 'steam'

export interface OtpEntry {
  uuid: string
  type: EntryType
  issuer: string
  label: string
  secret: string
  algorithm: HashAlgorithm
  digits: number
  period: number
  counter?: number
  note?: string
  icon?: IconRef
  matchRules?: MatchRule[]
  groupIds: string[]
  order: number
  createdAt: number
  /** 是否置顶：列表渲染时优先；缺省 false（向后兼容旧 vault） */
  pinned?: boolean
}

export interface Group {
  id: string
  name: string
  order: number
}

export interface Vault {
  version: 1
  entries: OtpEntry[]
  groups: Group[]
  updatedAt: number
}
