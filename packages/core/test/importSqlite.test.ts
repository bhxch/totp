import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode } from '../src/encoding/base32'
import { bytesToBase64 } from '../src/crypto/aesgcm'
import {
  authyRowsToEntries,
  duoRowsToEntries,
  importAuthy,
  importBattleNet,
  importDuo,
  msAuthRowsToEntries,
} from '../src/import/sqlite'

const SECRET = 'JBSWY3DPEHPK3PXP'
const SECRET_BYTES = base32Decode(SECRET)

// ---------- Microsoft Authenticator（MicrosoftAuthImporter.java：SQLite accounts 表） ----------
// 列：account_type(0=TOTP base32 / 1=Microsoft base64)、oath_secret_key、name=issuer、username=label；
// 非 0/1 的 type 静默跳过（Aegis 不记 error）；简报猜测的 tokens 表与 misc 密码 PBKDF2 均与源码不符
describe('msAuthRowsToEntries（MicrosoftAuthImporter accounts 表行）', () => {
  it('type0 base32 与 type1 base64：name→issuer、username→label、digits 6/8、SHA1/30', () => {
    const b64 = bytesToBase64(SECRET_BYTES)
    const r = msAuthRowsToEntries([
      { account_type: 0, oath_secret_key: SECRET, name: 'GitHub', username: 'alice' },
      { account_type: 1, oath_secret_key: b64, name: 'Microsoft', username: 'bob' },
      { account_type: 2, oath_secret_key: 'skip', name: 'Other', username: 'x' },
    ])
    expect(r.failures).toEqual([])
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'alice', secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30,
    })
    expect(r.entries[1]).toMatchObject({
      type: 'totp', issuer: 'Microsoft', label: 'bob',
      secret: base32Encode(base32Decode(SECRET)), algorithm: 'SHA1', digits: 8, period: 30,
    })
    // type1 base64 解码一致性
    expect(r.entries[1]!.secret).not.toBe(b64)
  })

  it('坏行进 failures：缺 account_type / secret 缺失或非法 / type0 空 secret；未知 type 静默跳过不计 failure', () => {
    const r = msAuthRowsToEntries([
      { oath_secret_key: SECRET, name: 'NoType', username: 'a' }, // 缺 account_type
      { account_type: 0, name: 'NoSecret', username: 'b' }, // oath_secret_key null
      { account_type: 0, oath_secret_key: '!!bad!!', name: 'BadB32', username: 'c' }, // base32 非法
      { account_type: 0, oath_secret_key: '', name: 'Empty', username: 'd' }, // 空 secret（TotpInfo 拒绝）
      { account_type: 1, oath_secret_key: '!!!', name: 'BadB64', username: 'e' }, // base64 非法
      { account_type: 7, oath_secret_key: SECRET, name: 'UnknownType', username: 'f' }, // 静默跳过
    ])
    expect(r.entries).toEqual([])
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('显式 null 与解码成功的空值：account_type null → 缺失失败；type1 空 base64 → 解码成功但 secret 为空', () => {
    const r = msAuthRowsToEntries([
      { account_type: null, oath_secret_key: SECRET, name: 'NullType', username: 'a' },
      { account_type: 1, oath_secret_key: '', name: 'EmptyB64', username: 'b' }, // atob('')='' → 空字节
      { account_type: 0, oath_secret_key: SECRET, name: null, username: null }, // 列值 null → issuer/label 空串
    ])
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: '', label: '' })
    expect(r.failures).toEqual([
      { index: 0, message: '缺少 account_type' },
      { index: 1, message: 'secret 为空' },
    ])
  })

  it('type0 secret 忽略空格与连字符后 base32 解码（GoogleAuthInfo.parseSecret 口径）', () => {
    const r = msAuthRowsToEntries([
      { account_type: 0, oath_secret_key: 'JBSW Y3DP-EHPK 3PXP', name: 'N', username: 'u' },
    ])
    expect(r.failures).toEqual([])
    expect(r.entries[0]!.secret).toBe(SECRET)
  })
})

// ---------- Duo（DuoImporter.java：files/duokit/accounts.json，非 SQLite） ----------
// 条目 {name, otpGenerator:{otpSecret(base32), counter?}}；counter 有 → HOTP，无 → TOTP(SHA1/6/30)；
// issuer 恒 ''、label=name。简报猜测的 duo_accounts/projects/accounts_devices 表与源码不符
describe('duoRowsToEntries（DuoImporter accounts.json 行）', () => {
  it('TOTP（无 counter）与 HOTP（counter）解析：label=name、issuer=空、SHA1/6/30', () => {
    const r = duoRowsToEntries([
      { name: 'GitHub:alice', otpGenerator: { otpSecret: SECRET } },
      { name: 'HOTP one', otpGenerator: { otpSecret: SECRET.toLowerCase(), counter: 5 } },
    ])
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({
      type: 'totp', issuer: '', label: 'GitHub:alice', secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30,
    })
    expect(r.entries[1]).toMatchObject({
      type: 'hotp', issuer: '', label: 'HOTP one', secret: SECRET, digits: 6, counter: 5,
    })
  })

  it('坏条目进 failures：缺 otpGenerator / otpSecret 非法 base32 / counter 非数值', () => {
    const r = duoRowsToEntries([
      { name: 'noOtp' },
      { name: 'badB32', otpGenerator: { otpSecret: '!!' } },
      { name: 'badCounter', otpGenerator: { otpSecret: SECRET, counter: 'NaN' } },
      { name: 'ok', otpGenerator: { otpSecret: SECRET } },
    ])
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ label: 'ok' })
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2])
  })

  it('行数组含 null 元素 → 单条失败「条目非对象」不阻断', () => {
    const r = duoRowsToEntries([null as unknown as Record<string, unknown>, { name: 'ok', otpGenerator: { otpSecret: SECRET } }])
    expect(r.entries).toHaveLength(1)
    expect(r.failures).toEqual([{ index: 0, message: '条目非对象' }])
  })

  it('otpGenerator 缺 otpSecret / 空 otpSecret → 逐条失败', () => {
    const r = duoRowsToEntries([
      { name: 'noSecret', otpGenerator: {} },
      { name: 'emptySecret', otpGenerator: { otpSecret: '' } },
    ])
    expect(r.entries).toHaveLength(0)
    expect(r.failures.map((f) => f.message)).toEqual([
      '缺少 secret（otpSecret）',
      'otpSecret 解码失败（非法 base32）',
    ])
  })

  it('importDuo：顶层非 JSON / 非 JSON 数组 → 结构级报错；空数组 → 空结果', () => {
    expect(() => importDuo('not json')).toThrow(/Duo/)
    expect(() => importDuo('{"name": "x"}')).toThrow(/Duo/)
    expect(importDuo('[]')).toEqual({ entries: [], failures: [] })
  })
})

// ---------- Authy（AuthyImporter.java：shared_prefs XML 内 JSON 令牌数组，非 SQLite） ----------
// 明文条目：authenticator（decryptedSecret base32）与 authy（secretSeed hex，period=10、issuer=name、label=''）；
// 加密条目（encryptedSecret+salt）：PBKDF2WithHmacSHA1(1000, 256bit) + AES-CBC(IV=0)。
// 简报猜测的 accounts 表 original_name/dec_secret 与源码不符
describe('authyRowsToEntries（AuthyImporter 令牌数组行）', () => {
  it('authenticator 条目 sanitize 规则：originalIssuer 优先 → originalName 冒号拆分 → name " - " 拆分 → accountType 首字母大写', async () => {
    const r = await authyRowsToEntries([
      {
        accountType: 'UNKNOWN', originalIssuer: 'ACME Corp', originalName: 'alice@acme.com',
        name: 'ACME Corp: alice@acme.com', digits: 6, decryptedSecret: SECRET,
      },
      { accountType: null, originalIssuer: null, originalName: 'Foo:bar', name: 'Foo:bar', digits: 7, decryptedSecret: SECRET },
      { accountType: null, originalIssuer: null, originalName: null, name: 'Biz - baz', digits: 8, decryptedSecret: SECRET },
      { accountType: 'steamWish', originalIssuer: null, originalName: null, name: 'plain', digits: 6, decryptedSecret: SECRET },
    ])
    expect(r.failures).toEqual([])
    // originalIssuer 存在 → issuer=originalIssuer，name 去掉 issuer 前缀后以 ": " 开头再剥 2 字符
    expect(r.entries[0]).toMatchObject({ issuer: 'ACME Corp', label: 'alice@acme.com', digits: 6, period: 30 })
    // originalName 含 ":" → issuer=冒号前段、separator=":"
    expect(r.entries[1]).toMatchObject({ issuer: 'Foo', label: 'bar', digits: 7 })
    // name 含 " - " → issuer=前段、separator=" - "
    expect(r.entries[2]).toMatchObject({ issuer: 'Biz', label: 'baz', digits: 8 })
    // 兜底：issuer=capitalize(accountType)，name 原样
    expect(r.entries[3]).toMatchObject({ issuer: 'SteamWish', label: 'plain' })
  })

  it('authy 条目（secretSeed hex）：period=10、issuer=name、label=空；坏行进 failures', async () => {
    const seed = Array.from(SECRET_BYTES, (b) => b.toString(16).padStart(2, '0')).join('')
    const r = await authyRowsToEntries([
      { name: 'Authy Diamond', digits: 6, secretSeed: seed },
      { name: 'noDigits', secretSeed: seed }, // 缺 digits（getInt 必需）
      { name: 'nullDigits', secretSeed: seed, digits: null }, // 显式 null 同口径
      { name: 'noSecret', digits: 6, secretSeed: null }, // getString(null) 抛 → 单条失败（has() 为 true，不触发加密判定）
      { name: 'badSeed', digits: 6, secretSeed: 'xyz' }, // hex 非法
    ])
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({
      type: 'totp', issuer: 'Authy Diamond', label: '', secret: SECRET, algorithm: 'SHA1', digits: 6, period: 10,
    })
    expect(r.failures.map((f) => f.index)).toEqual([1, 2, 3, 4])
  })

  it('sanitize 兜底链走尽：originalIssuer/originalName 均缺、name 无分隔、accountType null → 单条失败', async () => {
    const r = await authyRowsToEntries([
      { accountType: null, originalIssuer: null, originalName: null, name: 'plain', digits: 6, decryptedSecret: SECRET },
    ])
    expect(r.entries).toHaveLength(0)
    expect(r.failures).toEqual([{ index: 0, message: '缺少 accountType' }])
  })

  it('明文条目 secret 脏形态：decryptedSecret 非串 / 空串 → 单条失败', async () => {
    const r = await authyRowsToEntries([
      { name: 'nullSecret', digits: 6, decryptedSecret: null },
      { name: 'emptySecret', digits: 6, decryptedSecret: '' },
      { name: 'ok', digits: 6, accountType: 'y', decryptedSecret: SECRET },
    ])
    expect(r.entries).toHaveLength(1)
    expect(r.failures.map((f) => f.message)).toEqual([
      '缺少 secret（decryptedSecret）',
      'secret 解码失败',
    ])
  })

  it('加密条目（encryptedSecret+salt）：PBKDF2-HMAC-SHA1(1000/256bit)+AES-CBC(IV=0) 解密后转换', async () => {
    // 向量：password='test-password'、salt='SALT-STRING'（UTF-8）、明文=JBSWY3DPEHPK3PXP
    const r = await authyRowsToEntries(
      [
        {
          accountType: 'github', originalIssuer: null, originalName: null, name: 'X', digits: 6,
          encryptedSecret: '0Rdt6VuDJ1L/MXhfZ0dF/jUsW8ZOf2jf+b0po1qt8Rc=', salt: 'SALT-STRING',
        },
      ],
      'test-password',
    )
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'Github', label: 'X', secret: SECRET, digits: 6, period: 30 })
  })

  it('加密条目：无口令 → 结构级报错引导口令；口令错误 → 报错；无加密条目时口令忽略', async () => {
    const encrypted = [
      {
        accountType: 'github', name: 'X', digits: 6,
        encryptedSecret: '0Rdt6VuDJ1L/MXhfZ0dF/jUsW8ZOf2jf+b0po1qt8Rc=', salt: 'SALT-STRING',
      },
    ]
    await expect(authyRowsToEntries(encrypted)).rejects.toThrow(/口令/)
    await expect(authyRowsToEntries(encrypted, 'wrong')).rejects.toThrow(/口令错误或文件已损坏/)
    // 明文条目不因传入口令而受影响
    const r = await authyRowsToEntries([{ name: 'Y', digits: 6, accountType: 'y', decryptedSecret: SECRET }])
    expect(r.entries[0]!.secret).toBe(SECRET)
  })

  it('加密条目缺 salt → 结构级报错（EncryptedState.decrypt 的 getString("salt") 抛错口径）', async () => {
    await expect(authyRowsToEntries(
      [{ accountType: 'github', name: 'X', digits: 6, encryptedSecret: '0Rdt6VuDJ1L/MXhfZ0dF/jUsW8ZOf2jf+b0po1qt8Rc=' }],
      'pw',
    )).rejects.toThrow('Authy 文件结构非法：加密条目缺少 salt')
  })

  it('混合态：已含 decryptedSecret 的行在加密模式下原样透传，仅解密加密行', async () => {
    const r = await authyRowsToEntries(
      [
        { accountType: 'github', originalIssuer: 'ACME', originalName: 'a', name: 'ACME: a', digits: 6, decryptedSecret: SECRET },
        {
          accountType: 'github', name: 'X', digits: 6,
          encryptedSecret: '0Rdt6VuDJ1L/MXhfZ0dF/jUsW8ZOf2jf+b0po1qt8Rc=', salt: 'SALT-STRING',
        },
      ],
      'test-password',
    )
    expect(r.failures).toEqual([])
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({ issuer: 'ACME', label: 'a' })
    expect(r.entries[1]).toMatchObject({ issuer: 'Github', secret: SECRET })
  })

  it('encryptedSecret 非合法 base64 → 口令错误或文件已损坏', async () => {
    await expect(authyRowsToEntries(
      [{ accountType: 'github', name: 'X', digits: 6, encryptedSecret: '!!!not-b64!!!', salt: 'SALT' }],
      'pw',
    )).rejects.toThrow('Authy 口令错误或文件已损坏')
  })

  it('importAuthy：shared_prefs XML 提取 .key 值（实体转义 JSON 数组）后按行转换', async () => {
    const tokens = [{ accountType: null, originalIssuer: 'ACME', originalName: 'a', name: 'ACME: a', digits: 6, decryptedSecret: SECRET }]
    const xml = `<map>\n  <string name="com.authy.storage.tokens.authenticator.key">${JSON.stringify(tokens)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</string>\n</map>`
    const r = await importAuthy(xml)
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({ issuer: 'ACME', label: 'a', secret: SECRET })
    // 无 .key 键 → 空结果（Aegis read(InputStream) 口径：JSONArray 保持空）
    expect(await importAuthy('<map><string name="other">1</string></map>')).toEqual({ entries: [], failures: [] })
  })

  it('importAuthy：.key 值非 JSON / 非 JSON 数组 → 结构级报错', async () => {
    const xml = (value: string): string => `<map><string name="com.authy.storage.tokens.authenticator.key">${value}</string></map>`
    await expect(importAuthy(xml('{oops'))).rejects.toThrow('Authy 文件结构非法：令牌值不是合法 JSON')
    await expect(importAuthy(xml('{"a": 1}'))).rejects.toThrow('Authy 文件结构非法：令牌值不是 JSON 数组')
  })

  it('importAuthy：tokens.authy.key（Authy Authenticator 专用键）同样被识别', async () => {
    const tokens = [{ name: 'Authy Diamond', digits: 6, secretSeed: Array.from(SECRET_BYTES, (b) => b.toString(16).padStart(2, '0')).join('') }]
    const xml = `<map><string name="com.authy.storage.tokens.authy.key">${JSON.stringify(tokens)}</string></map>`
    const r = await importAuthy(xml)
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({ issuer: 'Authy Diamond', period: 10 })
  })
})

// ---------- Battle.net（BattleNetImporter.java：SharedPreferences XML + XOR 掩码，非 SQLite） ----------
// 键：AUTHENTICATOR_SERIAL / AUTHENTICATOR_DEVICE_SECRET；值 hex(XOR(明文, 硬编码 60B key))；
// secret=hex.decode(unmask(secret))，TotpInfo(SHA1, 8 digits, 30)，issuer 恒 "Battle.net"，label=unmask(serial)。
// 简报猜测的 SQLite 表与源码不符
describe('importBattleNet（BattleNetImporter SharedPreferences XML）', () => {
  // 向量：serial 明文 US-1234-5678；secret 明文 hex 串 → 23 字节
  const SERIAL_STORED = '6CDD0ACD62145E48555387DD'
  const SECRET_STORED =
    '0FEF11C967145D56575086D011C5F45E30F5254D1D52EF4B8F97FE9AE50F38E3AE3B1F84B150450696FA901E22A9'
  const SECRET_PLAIN_HEX = '6a65737375654142435859a1b2c3d4e5f60718293a4b5c'
  const xml = (serial?: string, secret?: string): string =>
    `<map>\n${serial ? `  <string name="com.blizzard.messenger.AUTHENTICATOR_SERIAL">${serial}</string>\n` : ''}${
      secret ? `  <string name="com.blizzard.messenger.AUTHENTICATOR_DEVICE_SECRET">${secret}</string>\n` : ''}</map>`

  it('XOR 掩码还原：serial→label、issuer=Battle.net、digits=8、period=30', () => {
    const r = importBattleNet(xml(SERIAL_STORED, SECRET_STORED))
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({
      type: 'totp', issuer: 'Battle.net', label: 'US-1234-5678', secret: 'NJSXG43VMVAUEQ2YLGQ3FQ6U4X3AOGBJHJFVY===',
      algorithm: 'SHA1', digits: 8, period: 30,
    })
  })

  it('serial 缺失 → label 空串（Aegis serial 默认 ""，不 unmask）；缺失 DEVICE_SECRET → 结构级报错', () => {
    const r = importBattleNet(xml(undefined, SECRET_STORED))
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({ label: '', issuer: 'Battle.net' })
    expect(() => importBattleNet(xml(SERIAL_STORED))).toThrow(/AUTHENTICATOR_DEVICE_SECRET/)
  })

  it('坏值进 failures：secret 掩码非 hex / unmask 结果非 hex / 超出掩码 key 长度', () => {
    // 61 字节掩码值（> 60B key）→ Java AIOOBE 口径单条失败
    const overlong = 'AB'.repeat(61)
    expect(importBattleNet(xml(SERIAL_STORED, overlong)).failures).toHaveLength(1)
    // 掩码值非 hex
    expect(importBattleNet(xml(SERIAL_STORED, 'ZZ')).failures).toHaveLength(1)
    // unmask 后不是合法 hex（还原为 "gg"，非 hex 字符）
    const key = Array.from({ length: 30 }, (_, i) => i)
    const plain = 'gg'
    const masked = Array.from(Buffer.from(plain, 'utf8'))
      .map((b, i) => (b ^ key[i]!).toString(16).padStart(2, '0'))
      .join('')
    expect(importBattleNet(xml(SERIAL_STORED, masked.toUpperCase())).failures[0]!.message).toMatch(/secret/)
  })
})
