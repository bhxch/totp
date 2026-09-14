import { parseOtpUri, type OtpEntry } from '@totp/core'

/**
 * otpauth URI → EntryForm 预填数据。
 * 成功返回 OtpEntry 完整形状（可直接作 EntryForm initial），uuid/order/createdAt 为哑值，保存时由宿主覆盖；
 * 失败返回中文错误消息（包装 parseOtpUri 异常）。
 */
export type ParseUriResult = { data: OtpEntry } | { error: string }

export function parseUriToEntryData(uri: string): ParseUriResult {
  try {
    const p = parseOtpUri(uri)
    return {
      data: {
        uuid: '',
        type: p.type,
        issuer: p.issuer,
        label: p.label,
        secret: p.secret,
        algorithm: p.algorithm,
        digits: p.digits,
        period: p.period,
        ...(p.counter !== undefined ? { counter: p.counter } : {}),
        note: '',
        groupIds: [],
        matchRules: [],
        order: 0,
        createdAt: 0,
      },
    }
  } catch {
    return { error: '不是有效的 otpauth 链接' }
  }
}

/**
 * Firefox protocol_handlers 注册的 ext+otpauth scheme（裸 otpauth 被 Firefox schema 白名单硬校验拒绝）
 * → 还原为 otpauth://。可选吃掉回调里的 `//`（ext+otpauth://… 常见 href 写法），
 * 避免还原出 otpauth:////…（host 空）被 parseOtpUri 拒绝。
 */
export function normalizeExtOtpauth(uri: string): string {
  return uri.replace(/^ext\+otpauth:(?:\/\/)?/i, 'otpauth://')
}
