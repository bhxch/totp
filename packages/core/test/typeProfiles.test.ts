import { describe, expect, it } from 'vitest'
import {
  TYPE_PROFILES, defaultDigitsFor, otpTypeForHost, toOtpDigits,
} from '../src/otp/typeProfiles'
import { normalizeType } from '../src/import/normalize'
import { parseOtpUri, buildOtpUri } from '../src/otp/uri'
import type { EntryType, OtpDigits } from '../src/model'

// R3 守卫测试:OTP 类型注册表（typeProfiles）是 uri/entryCode/normalize 的单一事实源。
// 本文件锁定四类型描述符值与派生函数行为——重构前该知识散落 uri/entryCode/normalize 三文件十余分支,
// 新增类型只需加一个 descriptor;描述符值或归一优先序变化时在此显式 diff。

const TYPES: EntryType[] = ['totp', 'hotp', 'steam', 'yandex']

/** 挑选描述符中非函数字段（compute 为行为,由 entryCode.test.ts 向量锁定） */
function specOf(t: EntryType) {
  const { compute: _compute, buildUriDefaults: _b, ...rest } = TYPE_PROFILES[t]!
  return rest
}

describe('TypeProfile 注册表完整性', () => {
  it('四类型全覆盖,缺一不可（Record<EntryType, TypeProfile> 编译期保证+运行时复核）', () => {
    expect(Object.keys(TYPE_PROFILES).sort()).toEqual([...TYPES].sort())
  })

  it('描述符不变量:hostAliases[0] 规范 host 全局单射;defaultAlgorithm 在白名单内;forcedDigits∈OtpDigits', () => {
    const canonicalHosts = new Set<string>()
    for (const t of TYPES) {
      const p = TYPE_PROFILES[t]!
      expect(p.hostAliases.length).toBeGreaterThan(0)
      expect(canonicalHosts.has(p.hostAliases[0]!)).toBe(false)
      canonicalHosts.add(p.hostAliases[0]!)
      expect(p.supportedAlgorithms).toContain(p.defaultAlgorithm)
      expect([5, 6, 7, 8] as OtpDigits[]).toContain(p.defaultDigits)
      if (p.forcedDigits !== null) {
        expect([5, 6, 7, 8] as OtpDigits[]).toContain(p.forcedDigits)
        expect(p.defaultDigits).toBe(p.forcedDigits) // 强制类型默认=强制值
      }
    }
  })

  it('buildUriDefaults 派生自 defaultAlgorithm/defaultDigits(单一事实源,防双写漂移)', () => {
    for (const t of TYPES) {
      const p = TYPE_PROFILES[t]!
      expect(p.buildUriDefaults).toEqual({ algorithm: p.defaultAlgorithm, digits: p.defaultDigits })
    }
  })

  it('四类型特化值快照(host/算法/digits/pin/counter/名称提示)', () => {
    expect(specOf('totp')).toEqual({
      hostAliases: ['totp'], defaultAlgorithm: 'SHA1', supportedAlgorithms: ['SHA1', 'SHA256', 'SHA512'],
      forcedDigits: null, defaultDigits: 6, digitsMutable: true,
      supportsPin: false, alwaysWriteCounter: false, nameHints: [],
    })
    expect(specOf('hotp')).toEqual({
      hostAliases: ['hotp'], defaultAlgorithm: 'SHA1', supportedAlgorithms: ['SHA1', 'SHA256', 'SHA512'],
      forcedDigits: null, defaultDigits: 6, digitsMutable: true,
      supportsPin: false, alwaysWriteCounter: true, nameHints: ['hotp'],
    })
    expect(specOf('steam')).toEqual({
      hostAliases: ['steam'], defaultAlgorithm: 'SHA1', supportedAlgorithms: ['SHA1'],
      forcedDigits: 5, defaultDigits: 5, digitsMutable: false,
      supportsPin: false, alwaysWriteCounter: false, nameHints: ['steam'],
    })
    expect(specOf('yandex')).toEqual({
      hostAliases: ['yaotp'], defaultAlgorithm: 'SHA256', supportedAlgorithms: ['SHA1', 'SHA256', 'SHA512'],
      forcedDigits: 8, defaultDigits: 8, digitsMutable: true,
      supportsPin: true, alwaysWriteCounter: false, nameHints: ['yandex'],
    })
  })
})

describe('otpTypeForHost(host 别名归一,parseOtpUri 白名单来源)', () => {
  it('规范 host 归一到自身;yaotp 归一为 yandex', () => {
    expect(otpTypeForHost('totp')).toBe('totp')
    expect(otpTypeForHost('hotp')).toBe('hotp')
    expect(otpTypeForHost('steam')).toBe('steam')
    expect(otpTypeForHost('yaotp')).toBe('yandex')
  })
  it('未知 host → null(由 parseOtpUri 拒绝)', () => {
    expect(otpTypeForHost('zzz')).toBeNull()
  })
})

describe('toOtpDigits(上移为 descriptor.forcedDigits,normalize 同步 re-export)', () => {
  it('强制类型忽略输入恒取 forcedDigits', () => {
    expect(toOtpDigits(6, 'steam')).toBe(5)
    expect(toOtpDigits(8, 'steam')).toBe(5)
    expect(toOtpDigits(6, 'yandex')).toBe(8)
    expect(toOtpDigits(7, 'yandex')).toBe(8)
  })
  it('非强制类型 6/7/8 恒等、其余(含 NaN/越界)回落 defaultDigits', () => {
    expect(toOtpDigits(6, 'totp')).toBe(6)
    expect(toOtpDigits(7, 'hotp')).toBe(7)
    expect(toOtpDigits(8, 'totp')).toBe(8)
    expect(toOtpDigits(5, 'totp')).toBe(6)
    expect(toOtpDigits(9, 'hotp')).toBe(6)
    expect(toOtpDigits(Number.NaN, 'totp')).toBe(6)
  })
  it('normalize.ts re-export 与 typeProfiles 同一实现(同函数引用,消除 vault→import 边后出口不变)', async () => {
    const { toOtpDigits: fromNormalize } = await import('../src/import/normalize')
    expect(fromNormalize).toBe(toOtpDigits)
  })
})

describe('defaultDigitsFor(表单层 type 默认 digits 查询,popup/CodesPage 切换 type 重算用)', () => {
  it('totp/hotp=6,steam=5,yandex=8', () => {
    expect(defaultDigitsFor('totp')).toBe(6)
    expect(defaultDigitsFor('hotp')).toBe(6)
    expect(defaultDigitsFor('steam')).toBe(5)
    expect(defaultDigitsFor('yandex')).toBe(8)
  })
})

describe('normalizeType 查表等价(表定义序=归一优先级)', () => {
  it('包含匹配词命中各类型;多关键词串按表序先匹配先赢(yandex 先于 steam,沿用原 if 链)', () => {
    expect(normalizeType('My Yandex 邮箱')).toBe('yandex')
    expect(normalizeType('Steam 游戏令牌')).toBe('steam')
    expect(normalizeType('authenticator-hotp')).toBe('hotp')
    expect(normalizeType('whatever')).toBe('totp')
    expect(normalizeType('SteamYandex')).toBe('yandex')
  })
})

describe('parseOtpUri/buildOtpUri 查表行为不变(uri.test.ts 全量锚点之外的注册表直查口径)', () => {
  it('steam query 写 algorithm/digits 均被强制值覆盖', () => {
    const p = parseOtpUri('otpauth://steam/u:s?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512&digits=8')
    expect(p.algorithm).toBe('SHA1')
    expect(p.digits).toBe(5)
  })
  it('yandex query 的 digits 被忽略(强制 8),显式白名单 algorithm 仍覆盖', () => {
    const p = parseOtpUri('otpauth://yaotp/y:s?secret=JBSWY3DPEHPK3PXP&digits=6&algorithm=SHA512')
    expect(p.digits).toBe(8)
    expect(p.algorithm).toBe('SHA512')
  })
  it('build:steam 恒省略 algorithm/digits,yandex 非默认 algorithm 写出、默认 digits 省略', () => {
    const steam = buildOtpUri({ type: 'steam', issuer: 'S', label: 'u', secret: 'AB', algorithm: 'SHA512', digits: 5, period: 30 })
    expect(steam).not.toContain('algorithm=')
    expect(steam).not.toContain('digits=')
    const yandex = buildOtpUri({ type: 'yandex', issuer: 'Y', label: 'u', secret: 'AB', algorithm: 'SHA512', digits: 8, period: 30 })
    expect(yandex).toContain('algorithm=SHA512')
    expect(yandex).not.toContain('digits=')
    expect(yandex.startsWith('otpauth://yaotp/')).toBe(true)
  })
})
