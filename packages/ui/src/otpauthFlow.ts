import { normalizeExtOtpauth, parseOtpUri, toOtpDigits, type OtpEntry } from '@totp/core'

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
        // R3 评审修复：此处保留 toOtpDigits——parseOtpUri 的 ALLOWED_DIGITS 含 5（steam URI 语义），
        // totp/hotp URI digits=5 能过解析但 toOtpDigits(5, totp/hotp)=6 非恒等，不是幂等收口；
        // 不收口则预填 digits=5 被共享 EntryForm 的 [6,7,8] 提交校验拒绝（原行为静默修正为 6）
        digits: toOtpDigits(p.digits, p.type),
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

