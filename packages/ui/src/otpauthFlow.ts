import { normalizeExtOtpauth, parseOtpUri, type OtpEntry } from '@totp/core'

export { normalizeExtOtpauth }

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
        // R3：parseOtpUri 已按 typeProfile 收口并校验（OtpUriParams.digits 类型即 OtpDigits），无需前置收口
        digits: p.digits,
        period: p.period,
        ...(p.counter !== undefined ? { counter: p.counter } : {}),
        ...(p.pin !== undefined ? { pin: p.pin } : {}),
        note: '',
        tagIds: [],
        matchRules: [],
        order: 0,
        createdAt: 0,
      },
    }
  } catch {
    return { error: '不是有效的 otpauth 链接' }
  }
}

