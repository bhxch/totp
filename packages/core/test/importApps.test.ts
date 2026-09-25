import { describe, expect, it } from 'vitest'
import {
  importBitwarden,
  importProton,
  importStratum,
  importTwoFas,
} from '../src/import/jsonApps'
import { importUriBatch } from '../src/import/uriBatch'
import { sniffFormat } from '../src/import/sniff'

const SECRET = 'JBSWY3DPEHPK3PXP'

// ---------- 2FAS（TwoFasImporter.java：secret 顶层，其余在 otp 子对象，issuer 取 name） ----------
const twoFasService = (otp: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  secret: SECRET,
  otp,
  ...extra,
})

describe('importTwoFas', () => {
  it('TOTP/HOTP/STEAM 正常解析：issuer 取 name 优先、label 取 otp.account、默认值、counter、steam digits=5', () => {
    const text = JSON.stringify({
      schemaVersion: 4,
      services: [
        twoFasService(
          { account: 'me@x.com', issuer: 'GitHub', digits: 8, period: 60, algorithm: 'SHA256', tokenType: 'TOTP' },
          { name: 'GitHub' },
        ),
        twoFasService({ account: 'u2', tokenType: 'HOTP', counter: 5 }, { name: 'Api' }),
        twoFasService({ account: 'steamuser', tokenType: 'STEAM', digits: 8 }, { name: 'Steam' }),
        twoFasService({ account: 'defaults' }, { name: '默认 issuer' }),
      ],
    })
    const r = importTwoFas(text)
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'me@x.com', secret: SECRET, digits: 8, period: 60, algorithm: 'SHA256',
    })
    expect(r.entries[1]).toMatchObject({ type: 'hotp', issuer: 'Api', label: 'u2', counter: 5 })
    expect(r.entries[2]).toMatchObject({ type: 'steam', digits: 5, label: 'steamuser' })
    // name 为空 → 回退 otp.issuer；digits/period 缺省 6/30
    expect(r.entries[3]).toMatchObject({ type: 'totp', issuer: '默认 issuer', label: 'defaults', digits: 6, period: 30 })
  })

  it('坏条目不阻断：缺 secret / secret 非法 base32 / 缺 otp / 未知 tokenType 进 failures', () => {
    const text = JSON.stringify({
      schemaVersion: 4,
      services: [
        { otp: { account: 'x' } },
        { secret: SECRET },
        { secret: SECRET, otp: { account: 'y', tokenType: 'WHATEVER' } },
        { secret: 'totp123', otp: { account: 'z' } },
        twoFasService({ account: 'ok' }, { name: 'Ok' }),
      ],
    })
    const r = importTwoFas(text)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: 'Ok' })
    expect(r.failures).toHaveLength(4)
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2, 3])
  })

  it('结构级错误：缺 services 数组 / servicesEncrypted 加密导出 / schemaVersion 过新 / 空 services 显式提示', () => {
    expect(() => importTwoFas('{"schemaVersion": 4}')).toThrow(/services/)
    expect(() =>
      importTwoFas(JSON.stringify({ schemaVersion: 4, servicesEncrypted: 'aaa:bbb:ccc', services: [] })),
    ).toThrow(/加密/)
    expect(() => importTwoFas('{"schemaVersion": 5, "services": []}')).toThrow(/schemaVersion/)
    // I27：空 services 数组不再静默落 generic，明确报「无条目」
    expect(() => importTwoFas('{"schemaVersion": 4, "services": []}')).toThrow(/无条目/)
  })

  it('groups[].id + service.groupId 映射为 tags', () => {
    const text = JSON.stringify({
      schemaVersion: 4,
      groups: [{ id: 'g1', name: '工作', isExpanded: true }],
      services: [
        { name: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', groupId: 'g1', otp: { account: 'me', tokenType: 'TOTP' } },
        { name: 'GitLab', secret: 'JBSWY3DPEHPK3PXP', otp: { account: 'me', tokenType: 'TOTP' } },
      ],
    })
    const res = importTwoFas(text)
    expect(res.failures).toHaveLength(0)
    expect(res.entries[0]!.tags).toEqual(['工作'])
    expect(res.entries[1]!.tags).toBeUndefined()
  })

  it('groups 表脏项（null/缺 id/空白名/非串 id）逐项跳过，合法项仍生效', () => {
    const text = JSON.stringify({
      schemaVersion: 4,
      groups: [null, { name: 'no-id' }, { id: 42, name: 'bad' }, { id: 'g1', name: '   ' }, { id: 'g2', name: '工作' }],
      services: [{ name: 'GitHub', secret: SECRET, groupId: 'g2', otp: { account: 'me' } }],
    })
    const r = importTwoFas(text)
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]!.tags).toEqual(['工作'])
  })
})

// ---------- Bitwarden（BitwardenImporter.java：items[].login.totp 为 otpauth URI；本工具扩展裸 base32 secret） ----------
describe('importBitwarden', () => {
  it('URI 条目 + 裸 base32 secret 条目：name→issuer、username→label、notes→note', () => {
    const text = JSON.stringify({
      items: [
        {
          name: 'GitHub',
          notes: 'n1',
          login: { username: 'me@x.com', totp: `otpauth://totp/GitHub:me@x.com?secret=${SECRET}&digits=8` },
        },
        { name: 'Bare', login: { username: 'u2', totp: SECRET.toLowerCase() } },
      ],
    })
    const r = importBitwarden(text)
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'me@x.com', secret: SECRET, digits: 8, note: 'n1',
    })
    expect(r.entries[1]).toMatchObject({ issuer: 'Bare', label: 'u2', secret: SECRET, digits: 6, period: 30 })
  })

  it('坏条目不阻断：非法 totp / 缺 login / 非对象；steam:// 前缀按 Steam 解析', () => {
    const text = JSON.stringify({
      items: [
        { name: 'Bad', login: { username: 'u', totp: 'totp123' } },
        { name: 'NoLogin' },
        null,
        { name: 'SteamGame', login: { username: 's', totp: `steam://${SECRET}` } },
        { name: 'Ok', login: { username: 'ok', totp: `otpauth://totp/ok?secret=${SECRET}` } },
      ],
    })
    const r = importBitwarden(text)
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({ type: 'steam', issuer: 'Steam', secret: SECRET, digits: 5 })
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2])
  })

  it('结构级错误：缺 items 数组 / 非法 JSON / 密码保护导出（encrypted:true）', () => {
    expect(() => importBitwarden('{"folders": []}')).toThrow(/items/)
    expect(() => importBitwarden('not json')).toThrow(/Bitwarden/)
    // 真实密码保护导出形态：顶层无 items
    expect(() =>
      importBitwarden(
        JSON.stringify({ encrypted: true, encKeyValidation_DO_NOT_EDIT: 'v', data: { items: [] } }),
      ),
    ).toThrow(/已加密/)
  })

  it('folders[].id + item.folderId 映射为 tags', () => {
    const text = JSON.stringify({
      folders: [{ id: 'f1', name: '工作' }],
      items: [
        { name: 'GitHub', folderId: 'f1', login: { totp: 'JBSWY3DPEHPK3PXP' } },
        { name: 'GitLab', login: { totp: 'JBSWY3DPEHPK3PXP' } },
      ],
    })
    const res = importBitwarden(text)
    expect(res.failures).toHaveLength(0)
    expect(res.entries[0]!.tags).toEqual(['工作'])
    expect(res.entries[1]!.tags).toBeUndefined()
  })

  it('login.totp 纯空白串（trim 后为空）按缺失单条失败，不误入裸 base32 分支', () => {
    const r = importBitwarden(JSON.stringify({
      items: [
        { name: 'Blank', login: { username: 'u', totp: '   ' } },
        { name: 'Ok', login: { username: 'u', totp: 'JBSWY3DPEHPK3PXP' } },
      ],
    }))
    expect(r.entries).toHaveLength(1)
    expect(r.failures).toEqual([{ index: 0, message: '条目 0 缺少 login.totp' }])
  })
})

// ---------- Ente（EnteAuthImporter.java 委托 GoogleAuthUriImporter：明文导出即 otpauth URI 行，由 uriBatch 覆盖） ----------
describe('importUriBatch（Ente 明文/加密导出）', () => {
  it('URI 行文本逐条解析，空行跳过', () => {
    const r = importUriBatch(
      `otpauth://totp/GitHub:me@x.com?secret=${SECRET}\n\notpauth://hotp/Api:u?secret=${SECRET}&counter=3`,
    )
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'me@x.com' })
    expect(r.entries[1]).toMatchObject({ type: 'hotp', counter: 3 })
  })

  it('坏行不阻断；Ente 加密导出 JSON（encryptedData+kdfParams 特征键）抛结构级错误', () => {
    const r = importUriBatch(`otpauth://totp/a?secret=${SECRET}\nnot a uri`)
    expect(r.entries).toHaveLength(1)
    expect(r.failures).toHaveLength(1)
    expect(() =>
      importUriBatch(JSON.stringify({ version: 1, kdfParams: {}, encryptedData: 'x', encryptionNonce: 'y' })),
    ).toThrow(/加密/)
  })

  it('截断的加密 JSON（含 kdfParams 字面量但解析失败）→ 明确报加密不支持，不再静默落入 URI 行解析', () => {
    // 模拟用户复制粘贴半截加密导出、或二进制密文被文本管道读入导致的非完整 JSON
    const truncated = '{"version":1,"kdfParams":{"mem":67108864},"encryptedData":"AAAA==","encryptionNonce"'
    expect(() => importUriBatch(truncated)).toThrow(/加密/)
    // 不带加密特征字段的截断 JSON（普通坏文本）→ 落入 URI 行解析，无 entries 全 failures
    const broken = '{this is not valid json at all'
    const r = importUriBatch(broken)
    expect(r.entries).toHaveLength(0)
    expect(r.failures.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------- Proton（ProtonAuthenticatorImporter.java：entries[].content.{name,uri}，issuer 取 URI、label 取 name） ----------
describe('importProton', () => {
  it('otpauth URI 与 steam URI：label 取 content.name、issuer 取 URI issuer', () => {
    const text = JSON.stringify({
      entries: [
        { content: { name: 'me@x.com', uri: `otpauth://totp/GitHub:ignored?secret=${SECRET}&period=60` } },
        { content: { name: 'steamacc', uri: `steam://${SECRET}` } },
      ],
    })
    const r = importProton(text)
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'me@x.com', secret: SECRET, period: 60,
    })
    expect(r.entries[1]).toMatchObject({ type: 'steam', issuer: 'Steam', label: 'steamacc', digits: 5 })
  })

  it('坏条目不阻断：缺 content / 缺 uri / uri 非法', () => {
    const text = JSON.stringify({
      entries: [{ content: { name: 'n' } }, { name: 'x' }, { content: { name: 'b', uri: 'totp123' } }, { content: { name: 'ok', uri: `otpauth://totp/ok?secret=${SECRET}` } }],
    })
    const r = importProton(text)
    expect(r.entries).toHaveLength(1)
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2])
  })

  it('结构级错误：缺 entries / 加密导出（salt+content）', () => {
    expect(() => importProton('{"foo": 1}')).toThrow(/entries/)
    expect(() => importProton(JSON.stringify({ version: 1, salt: 's', content: 'c' }))).toThrow(/加密/)
  })
})

// ---------- Stratum（StratumImporter.java：Authenticators 数组、大写键、Type 1/2/4、Algorithm 序号） ----------
describe('importStratum', () => {
  it('TOTP/HOTP/Steam：Username null→空串、Algorithm 序号映射、counter', () => {
    const text = JSON.stringify({
      Authenticators: [
        { Type: 2, Issuer: 'GitHub', Username: 'me@x.com', Secret: SECRET, Algorithm: 1, Digits: 8, Period: 60, Counter: 0 },
        { Type: 1, Issuer: 'Api', Username: null, Secret: SECRET, Algorithm: 0, Digits: 6, Period: 30, Counter: 7 },
        { Type: 4, Issuer: 'Steam', Username: 's', Secret: SECRET, Algorithm: 0, Digits: 8, Period: 30, Counter: 0 },
      ],
    })
    const r = importStratum(text)
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'me@x.com', secret: SECRET, algorithm: 'SHA256', digits: 8, period: 60,
    })
    expect(r.entries[1]).toMatchObject({ type: 'hotp', issuer: 'Api', label: '', counter: 7 })
    expect(r.entries[2]).toMatchObject({ type: 'steam', digits: 5 })
  })

  it('坏条目不阻断：未知 Type / 非法 Secret / 非法 Algorithm / 缺字段', () => {
    const text = JSON.stringify({
      Authenticators: [
        { Type: 3, Issuer: 'x', Username: null, Secret: SECRET, Algorithm: 0, Digits: 6, Period: 30, Counter: 0 },
        { Type: 2, Issuer: 'x', Username: null, Secret: 'totp123', Algorithm: 0, Digits: 6, Period: 30, Counter: 0 },
        { Type: 2, Issuer: 'x', Username: null, Secret: SECRET, Algorithm: 9, Digits: 6, Period: 30, Counter: 0 },
        { Issuer: 'x', Username: null, Secret: SECRET, Algorithm: 0, Digits: 6, Period: 30, Counter: 0 },
        { Type: 2, Issuer: 'ok', Username: null, Secret: SECRET, Algorithm: 2, Digits: 6, Period: 30, Counter: 0 },
      ],
    })
    const r = importStratum(text)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: 'ok', algorithm: 'SHA512' })
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2, 3])
  })

  it('结构级错误：缺 Authenticators / 非法 JSON（含二进制加密导出）', () => {
    expect(() => importStratum('{"db": {}}')).toThrow(/Authenticators/)
    expect(() => importStratum('AUTHENTICATORPRO-binary-blob')).toThrow(/Stratum/)
  })
})

// ---------- sniffFormat 扩展（判定顺序文档化于 sniff.ts 注释） ----------
describe('sniffFormat app 格式扩展', () => {
  it('2FAS/Bitwarden/Proton/Stratum 特征键判定', () => {
    expect(sniffFormat(JSON.stringify({ schemaVersion: 4, services: [{ secret: SECRET, otp: {} }] }))).toBe('twoFas')
    // 明文导出：items + login.totp
    expect(sniffFormat(JSON.stringify({ items: [{ login: { totp: SECRET } }] }))).toBe('bitwarden')
    // 密码保护导出真实形态：顶层无 items，encrypted 键判定
    expect(
      sniffFormat(JSON.stringify({ encrypted: true, encKeyValidation_DO_NOT_EDIT: 'v', data: { items: [] } })),
    ).toBe('bitwarden')
    expect(sniffFormat(JSON.stringify({ entries: [{ content: { uri: 'otpauth://totp/a?secret=X' } }] }))).toBe('proton')
    expect(sniffFormat(JSON.stringify({ Authenticators: [] }))).toBe('stratum')
  })

  it('无特征键的单对象仍归 generic（不回退既有判定）；Ente URI 行归 uriBatch', () => {
    expect(sniffFormat('{"a": 1}')).toBe('generic')
    expect(sniffFormat('{"db": {"entries": []}}')).toBe('aegis')
    expect(sniffFormat(`otpauth://totp/a?secret=${SECRET}`)).toBe('uriBatch')
    // I27：services 存在但条目无 secret → 仍按 twoFas 走（importTwoFas 抛「无条目」错误），不再静默落 generic
    expect(sniffFormat(JSON.stringify({ services: [{ name: 'x' }] }))).toBe('twoFas')
  })
})
