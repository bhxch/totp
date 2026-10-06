import { importSteamGuard, parsePastedText, sniffFormat } from '@totp/core'
import { describe, expect, it } from 'vitest'

describe('parsePastedText', () => {
  it('多行 otpauth URI 走 uriBatch', () => {
    const r = parsePastedText('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP\notpauth://totp/G:b?secret=JBSWY3DPEHPK3PXP')
    expect('unsupported' in r).toBe(false)
    if (!('unsupported' in r)) expect(r.entries).toHaveLength(2)
  })
  it('Aegis 明文 JSON 走 aegis 解析', () => {
    const json = JSON.stringify({ version: 1, header: { slots: [], params: {} }, db: { entries: [{ type: 'totp', uuid: 'u', name: 'G:a', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30 } }], groups: [] } })
    const r = parsePastedText(json)
    if (!('unsupported' in r)) expect(r.entries).toHaveLength(1)
    else expect.unreachable()
  })
  it('FoxAuth 明文备份走同步明文解析', () => {
    const json = JSON.stringify({
      accountInfos: [
        { localIssuer: 'GitHub', localAccountName: 'a@b.c', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Time based', localOTPDigits: '6', localOTPPeriod: '30' },
      ],
      isEncrypted: false,
    })
    const r = parsePastedText(json)
    expect('unsupported' in r).toBe(false)
    if (!('unsupported' in r)) {
      expect(r.entries).toHaveLength(1)
      expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'a@b.c', secret: 'JBSWY3DPEHPK3PXP' })
    }
  })
  it('FoxAuth 加密备份（整串密文形态）引导导入页文件通道：粘贴通道无解密能力不进明文解析', () => {
    const r = parsePastedText(JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: true, passwordInfo: {} }))
    expect(r).toEqual({ unsupported: '检测到加密 FoxAuth 备份，请通过导入页选择文件导入（将自动解密）' })
  })
  it('FoxAuth 加密备份（数组形态：仅三字段密文）同样命中引导，不散落「secret 非法 base32」单条错误', () => {
    const json = JSON.stringify({
      accountInfos: [
        { localIssuer: 'GitHub', localAccountName: 'a@b.c', localSecretToken: 'c2lsbHljaXBoZXJ0b2tlbg==' },
      ],
      isEncrypted: true,
      passwordInfo: { encryptPassword: btoa('pw'), encryptIV: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    })
    const r = parsePastedText(json)
    expect(r).toEqual({ unsupported: '检测到加密 FoxAuth 备份，请通过导入页选择文件导入（将自动解密）' })
  })
  it('Aegis 加密 vault（db 为密文 Base64 串）拦截引导至导入页口令通道，不走明文解析', () => {
    // 结构对齐真实加密导出：header 带 slots/params、顶层 db 为 Base64 密文字符串（sniffAegis.encrypted=true）
    const encrypted = JSON.stringify({
      version: 1,
      header: { slots: [{ type: 1, uuid: 's', key: 'ab', key_params: { nonce: 'cd', tag: 'ef' }, salt: '01', n: 16384, r: 8, p: 1 }], params: { nonce: 'aa'.repeat(12), tag: 'bb'.repeat(16) } },
      db: 'aGVsbG8=',
    })
    const r = parsePastedText(encrypted)
    expect(r).toEqual({ unsupported: '加密 Aegis 文件请走导入页（需输入口令）' })
  })
  it('WinAuth XML 拦截：文件惯例不走粘贴强解，提示选择文件导入', () => {
    const r = parsePastedText('<?xml version="1.0"?><WinAuth version="3.6.4.2"></WinAuth>')
    expect(r).toEqual({ unsupported: 'WinAuth 请在导入页选择文件导入' })
  })
  it('通用 JSON 提示走导入页', () => {
    const r = parsePastedText('{"foo": 1}')
    expect(r).toEqual({ unsupported: expect.stringContaining('导入页') })
  })
  it('乱文本无法识别', () => {
    expect(parsePastedText('hello world')).toHaveProperty('unsupported')
  })
})

describe('steamGuard：SteamGuard/SDA 明文 JSON 粘贴', () => {
  // shared_secret = 20 字节全零的标准 base64（'A'×27 + '='）→ 160 bit = 32×5bit，
  // STEAM_ALPHABET base32 恰为 32 个 '2'（无填充）。brief 原文案 22 个 'A'+'==' 实为 16 字节，
  // 与其自身断言「32 个 '2'」矛盾，按断言意图修正夹具字节数。
  const SHARED_SECRET_B64 = `${'A'.repeat(27)}=`
  const SG_JSON = JSON.stringify({
    shared_secret: SHARED_SECRET_B64,
    serial_number: '12345678901',
    revocation_code: 'R12345',
    steamid: '76561190000000000',
  })
  const SDA_JSON = JSON.stringify({
    account_name: 'steamuser',
    device_id: 'android:1234abcd-5678',
    shared_secret: SHARED_SECRET_B64,
    serial_number: '12345678901',
    uri: `otpauth://totp/Steam:steamuser?secret=${encodeURIComponent(SHARED_SECRET_B64)}`,
  })

  it('sniffFormat 判 steamGuard（shared_secret + serial_number/device_id）', () => {
    expect(sniffFormat(SG_JSON)).toBe('steamGuard')
    expect(sniffFormat(SDA_JSON)).toBe('steamGuard')
  })

  it('SteamGuard JSON → steam 条目：secret=STEAM_ALPHABET base32，note 收 serial/revocation', () => {
    const r = parsePastedText(SG_JSON)
    if (!('entries' in r)) throw new Error('expected entries')
    expect(r.entries).toHaveLength(1)
    const e = r.entries[0]!
    expect(e.type).toBe('steam')
    expect(e.issuer).toBe('Steam')
    expect(e.label).toBe('76561190000000000') // 无 account_name 回退 steamid
    expect(e.secret).toBe('2'.repeat(32))
    expect(e.digits).toBe(5)
    expect(e.period).toBe(30)
    expect(e.algorithm).toBe('SHA1')
    expect(e.note).toBe('12345678901 / R12345')
  })

  it('SDA maFile 明文 JSON：label 取 account_name，device_id 入 note', () => {
    const r = parsePastedText(SDA_JSON)
    if (!('entries' in r)) throw new Error('expected entries')
    expect(r.entries[0]!.label).toBe('steamuser')
    expect(r.entries[0]!.note).toContain('android:1234abcd-5678')
  })

  it('缺 shared_secret / 非 JSON → 引导而非抛异常（嗅探不命中走 unsupported，直解走 failures）', () => {
    // 嗅探不命中（无 shared_secret → generic 兜底；非 JSON → null）→ parsePastedText 引导文案，不抛异常
    expect(parsePastedText(JSON.stringify({ serial_number: '123' }))).toEqual({ unsupported: expect.stringContaining('导入页') })
    expect(parsePastedText('not json {')).toHaveProperty('unsupported')
    // steamGuard 直解入口对同输入给 failures 引导（不抛异常）
    const noSecret = importSteamGuard(JSON.stringify({ serial_number: '123' }))
    expect(noSecret.entries).toHaveLength(0)
    expect(noSecret.failures).toHaveLength(1)
    const bad = importSteamGuard('not json {')
    expect(bad.entries).toHaveLength(0)
    expect(bad.failures).toHaveLength(1)
  })

  it('嗅探不误伤：2FAS/aegis/bitwarden 等既有对象格式不受新键影响（既有用例回归保底）', () => {
    expect(sniffFormat('{"services":[{"secret":"JBSWY3DPEHPK3PXP"}]}')).toBe('twoFas')
  })
})
