import type { Vault } from '../model'
import { buildOtpUri } from '../otp/uri'

/** 批① §2.1：每行一条 otpauth URI。HOTP 恒带 counter（buildOtpUri 已保证）；steam 走 otpauth://steam/；yandex 走 otpauth://yaotp/ 且携带 pin */
export function exportOtpauthText(v: Vault): string {
  return v.entries
    .map((e) => buildOtpUri({ type: e.type, issuer: e.issuer, label: e.label, secret: e.secret, algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter, pin: e.pin }))
    .join('\n')
}
