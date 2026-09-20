import type { HashAlgorithm } from './otp/hotp'
import type { MatchRule } from './match/engine'
import type { IconRef } from './icons/registry'

export type EntryType = 'totp' | 'hotp' | 'steam' | 'yandex'
/** spec §4：digits 支持 5/6/7/8——5 为 Steam 专用（URI 解析/导入/表单层强制），6/7/8 对应 RFC 6238 */
export type OtpDigits = 5 | 6 | 7 | 8

export interface OtpEntry {
  uuid: string
  type: EntryType
  issuer: string
  label: string
  secret: string
  algorithm: HashAlgorithm
  digits: OtpDigits
  period: number
  counter?: number
  note?: string
  icon?: IconRef
  matchRules?: MatchRule[]
  tagIds: string[]
  order: number
  createdAt: number
  /** 是否置顶：列表渲染时优先；缺省 false（向后兼容旧 vault） */
  pinned?: boolean
  /** Yandex（yaotp）的 PIN，可选；缺省/空串按无 PIN 计算（空 pin 亦是合法输入）。不参与 Vault.version 语义 */
  pin?: string
}

export interface Tag {
  id: string
  name: string
}

export interface Vault {
  version: 2
  entries: OtpEntry[]
  tags: Tag[]
  updatedAt: number
  /** F8 单调版本号（新鲜性水位）：加密写路径推进、随密文明文落盘，采纳时与存储侧水位键比对防回滚。
   *  旧数据缺省视为 0；明文库同样携带以保持谱系连续（明文形态下无防篡改意义） */
  rev?: number
}
