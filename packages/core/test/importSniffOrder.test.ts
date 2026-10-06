import { describe, expect, it } from 'vitest'
import { sniffFormat, type ImportFormat } from '../src/import/sniff'

/**
 * sniffFormat 判定顺序快照（R5 前置守卫，方案 §4 红线「R5 动手前必须先补嗅探顺序快照测试」）。
 *
 * 顺序是行为契约：sniffFormat 在各族内按优先级返回首个命中格式，顺序漂移 = 同文本判定漂移。
 * 现有覆盖散在 import.test / importApps / importMisc / importPaste 四文件、无专项顺序快照；
 * 本文件以「探针表 + 硬断言 + 全序快照」双锁定：
 * - 硬断言：每探针 [文本 → 期望格式] 逐一校验，顺序破坏立即红（不依赖快照更新纪律）；
 * - 快照：全序清单一次呈现，core 建注册表（import/registry.ts）迁移后 diff 即审查材料。
 * 探针均构造为「相邻两格式特征同现」，对族内顺序互换敏感；注册表迁移前后本文件必须同绿。
 */

const SECRET = 'JBSWY3DPEHPK3PXP'

// [说明, 文本, 期望判定]。分组顺序即判定优先顺序（对象族 → 数组族 → JSONL → 文本族 → null）。
const PROBES: Array<[string, string, ImportFormat | null]> = [
  // —— JSON 对象族：aegis → twoFas → bitwarden → proton → stratum → freeOtp → foxauth → steamGuard → generic 兜底 ——
  ['aegis 明文（db 对象）', '{"db":{"entries":[]}}', 'aegis'],
  ['aegis 明文（header 键，明文 slots 空数组）', '{"version":1,"header":{"slots":[],"params":{}}}', 'aegis'],
  ['aegis 加密（db 密文串，嗅探同判 aegis，加密区分走 sniffAegis）', '{"header":{},"db":"aGVsbG8="}', 'aegis'],
  ['twoFas 典型', `{"schemaVersion":4,"services":[{"secret":"${SECRET}"}]}`, 'twoFas'],
  ['twoFas 空 services（显式走 twoFas，importTwoFas 给「无条目」错误）', '{"services":[]}', 'twoFas'],
  ['bitwarden 明文（items + login.totp）', `{"items":[{"login":{"totp":"${SECRET}"}}]}`, 'bitwarden'],
  ['bitwarden 密码保护导出（顶层 encrypted 键）', '{"encrypted":true,"encKeyValidation_DO_NOT_EDIT":"v","data":{"items":[]}}', 'bitwarden'],
  ['proton（entries + content 对象）', '{"entries":[{"content":{}}]}', 'proton'],
  ['stratum（Authenticators 数组）', '{"Authenticators":[]}', 'stratum'],
  ['freeOtp（tokens + issuerExt + secret 字节数组）', '{"tokens":[{"issuerExt":"A","secret":[1]}]}', 'freeOtp'],
  ['foxauth（isEncrypted 布尔 + accountInfos）', '{"accountInfos":[],"isEncrypted":false}', 'foxauth'],
  ['steamGuard（shared_secret + serial_number）', '{"shared_secret":"AAAA","serial_number":"123"}', 'steamGuard'],
  ['steamGuard（SDA：shared_secret + device_id）', '{"shared_secret":"AAAA","device_id":"android-1"}', 'steamGuard'],
  // —— 对象族相邻优先级对：前格式特征命中即返回，后格式特征同现不夺判 ——
  ['对象族顺序：aegis > twoFas', '{"db":{},"services":[{"secret":"X"}]}', 'aegis'],
  ['对象族顺序：twoFas > bitwarden', `{"services":[{"secret":"${SECRET}"}],"items":[{"login":{"totp":"${SECRET}"}}]}`, 'twoFas'],
  ['对象族顺序：bitwarden > proton', '{"items":[{"login":{"totp":"X"}}],"entries":[{"content":{}}]}', 'bitwarden'],
  ['对象族顺序：proton > stratum', '{"entries":[{"content":{}}],"Authenticators":[]}', 'proton'],
  ['对象族顺序：stratum > freeOtp', '{"Authenticators":[],"tokens":[{"issuerExt":"A","secret":[1]}]}', 'stratum'],
  ['对象族顺序：freeOtp > foxauth', '{"tokens":[{"issuerExt":"A","secret":[1]}],"accountInfos":[],"isEncrypted":false}', 'freeOtp'],
  ['对象族顺序：foxauth > steamGuard', '{"accountInfos":[],"isEncrypted":false,"shared_secret":"AAAA","serial_number":"123"}', 'foxauth'],
  ['对象族兜底：仅 serial_number 无 shared_secret 不判 steamGuard → generic', '{"serial_number":"123"}', 'generic'],
  ['对象族兜底：无特征键单对象 → generic', '{"a":1}', 'generic'],
  // —— JSON 数组族：andOtp → totpAuthenticator → generic 兜底 ——
  ['andOtp（type/algorithm/label/secret 全字符串）', `[{"type":"TOTP","algorithm":"SHA1","label":"a","secret":"${SECRET}"}]`, 'andOtp'],
  ['totpAuthenticator（base 整数 + key 字符串）', `[{"base":32,"key":"${SECRET}"}]`, 'totpAuthenticator'],
  ['数组族顺序：andOtp > totpAuthenticator', `[{"type":"TOTP","algorithm":"SHA1","label":"a","secret":"${SECRET}"},{"base":32,"key":"${SECRET}"}]`, 'andOtp'],
  ['数组族兜底：无特征数组 → generic', '[{"secret":"X"}]', 'generic'],
  // —— JSONL：多行全可解析 → generic；单行标量不判 generic（无 { [ 前缀不入对象/数组族） ——
  ['JSONL 多行对象 → generic', '{"a":1}\n{"b":2}', 'generic'],
  ['JSONL 单行标量不判 generic → null', '5', null],
  // —— 文本族：winauth → freeOtpLegacy → uriBatch ——
  ['winauth（< 开头 + winauth 字样）', '<?xml version="1.0"?><WinAuth>…</WinAuth>', 'winauth'],
  ['freeOtpLegacy（tokenOrder）', '<map><string name="tokenOrder">[{}]</string></map>', 'freeOtpLegacy'],
  ['freeOtpLegacy（转义 issuerExt）', '<map><string name="0">{&quot;issuerExt&quot;:&quot;A&quot;}</string></map>', 'freeOtpLegacy'],
  ['uriBatch（含 otpauth://）', `otpauth://totp/a?secret=${SECRET}`, 'uriBatch'],
  ['文本族顺序：winauth > freeOtpLegacy', '<winauth><string name="tokenOrder">[{}]</string></winauth>', 'winauth'],
  ['文本族顺序：freeOtpLegacy > uriBatch', '<map><string name="tokenOrder">otpauth://totp/a?secret=X</string></map>', 'freeOtpLegacy'],
  // —— 对象/数组族 JSON 解析失败回落文本族 ——
  ['非法 JSON 对象含 otpauth 回落文本族 → uriBatch', '{otpauth://totp/a?secret=X}', 'uriBatch'],
  // —— null ——
  ['乱文本 → null', 'hello', null],
  ['无特征 XML → null', '<map><string name="other">x</string></map>', null],
  ['空白 → null', '   ', null],
]

describe('sniffFormat 判定顺序（R5 注册表迁移守卫）', () => {
  it('探针硬断言：族内相邻优先级、通道回退与 null 样本逐一锁定', () => {
    for (const [name, text, expected] of PROBES) {
      expect(sniffFormat(text), `探针「${name}」`).toBe(expected)
    }
  })
  it('全序快照：注册表化迁移后顺序任何变化在此显式 diff', () => {
    expect(
      PROBES.map(([name, text]) => ({ name, format: sniffFormat(text) })),
    ).toMatchSnapshot()
  })
})
