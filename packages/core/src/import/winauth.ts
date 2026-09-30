// WinAuth（github.com/winauth/winauth）配置文件导入。
// 口径全部对齐官方 C# 源码（master 分支），引用以「文件名 + 方法/属性名」标注：
//
// WinAuthConfig.cs / ReadXmlInternal + WriteXmlString —— XML 结构：
//   根元素 <WinAuth version="3.x.y.z">；未加密时根下直接放多个 <WinAuthAuthenticator>；
//   v3.2+ 整包加密时为 <data encrypted="y|u|m" sha1="...">HEX</data>，解出内容为
//   hex→字节→UTF-8 的内层 XML（<config> 包多个 <WinAuthAuthenticator>）；
//   旧布局（v3.0）把密文放在 <WinAuth> 根元素自身的文本中。
// WinAuthAuthenticator.cs / ReadXml + WriteXmlString —— 单条结构：
//   <WinAuthAuthenticator id type="WinAuth.GoogleAuthenticator|WinAuth.SteamAuthenticator|...">
//     <name>、<created>、<autorefresh>…<authenticatordata>（可带 encrypted 属性，
//     内容为整段加密 hex，解出后是 hex→字节→UTF-8 的 <authenticatordata> 内层 XML）。
// Authenticator.cs —— 加密负载（DecryptSequence / EncryptSequence / Decrypt / Encrypt）：
//   全程 hex 编码（非 base64）。格式 = hex("WINAUTH3") + hex(salt 8B) + hex(SHA256(salt||明文hex)) + payload；
//   SHA256 校验失败即口令错（BadPasswordException）。层解密顺序按 Machine(m)→User(u)→
//   Explicit(y)→YubiKey(a/b) 逆序（DecryptSequenceNoHash）：
//   - DPAPI 层：ProtectedData.Unprotect(hex→bytes, null, CurrentUser/LocalMachine)（无附加熵），
//     且明文恒为下一层 payload 的 hex ASCII（decode=false 路径）；
//   - 口令层 Decrypt(data, password, PBKDF2=true)：salt=payload 前 8B，
//     key=Rfc2898DeriveBytes(UTF8(password), salt, PBKDF2_ITERATIONS=2000).GetBytes(PBKDF2_KEYSIZE=256bit)
//     （.NET Rfc2898DeriveBytes 默认 HMAC-SHA1），Blowfish-ECB 解密 + ISO10126d2 去填充。
// Authenticator.cs / SecretData 属性 —— secret 存储：
//   hex(SecretKey) + "\t" + codeDigits + "\t" + SHA1|SHA256|SHA512 + "\t" + period；
//   HOTPAuthenticator.cs / SecretData 再追加 "|counter"。
// （R12 分层：Blowfish 初始 P-array/S-box 等密码原语已拆 crypto/blowfish.ts，本模块为纯格式层：
//   解密序列编排 + mini XML 读取 + 条目映射。）

import { createSHA1, pbkdf2 } from 'hash-wasm'
import { base32Encode } from '../encoding/base32'
import { bytesToBase64 } from '../crypto/aesgcm'
// R12：Blowfish 密码原语拆 crypto/blowfish.ts（先例 zipAes/authenticatorPlus 分层）
// blowfishEcbEncrypt/Decrypt 测试锚点 re-export 维持既有导入面（winauthImport.test 与 '@totp/core' 消费方不变）
import { blowfishDecipherBlock, blowfishEncipherBlock, blowfishKeySchedule, readU32be, writeU32be } from '../crypto/blowfish'
export { blowfishEcbDecrypt, blowfishEcbEncrypt } from '../crypto/blowfish'
// R12：mini XML 解析拆 import/miniXml.ts（实体反转义复用 miscApps xmlUnescape 单点）
import { child, parseXml, type MiniXmlNode } from './miniXml'
import type { ImportResult, ParsedEntry } from './types'

// 局部 hexToBytes：抛 '非法 hex'，让 failureMessage 走 MSG_PASSWORD 归类
// （统一版本返回 null 后调用方自行处理；winauth 的 catch 路径依赖错误文本识别归类，保留抛错）

// ---------- 错误分类（对应简报的逐条 failure 口径） ----------

/** 解密失败分类：password→「需要口令或口令错误」；dpapi→「请用桌面版」；yubi→「暂不支持」 */
type DecryptErrorKind = 'password' | 'dpapi' | 'yubi'

class WinauthDecryptError extends Error {
  constructor(public kind: DecryptErrorKind) {
    super(kind)
  }
}

const MSG_PASSWORD = '需要口令或口令错误'
const MSG_DPAPI = '该 WinAuth 备份使用 Windows 加密，请用桌面版导入'
const MSG_YUBI = '该 WinAuth 条目使用 YubiKey 加密，暂不支持'

// ---------- hex / utf8 工具 ----------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('非法 hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

// R12/R15③ 协调：本模块原私有一份 sha256Hex（全仓第 4 处定义）——改导入 canonical.ts 单点实现
import { sha256Hex } from '../cloud/canonical'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// ---------- 口令层原语（Authenticator.cs Decrypt(data, password, PBKDF2=true)） ----------

export const PBKDF2_ITERATIONS = 2000 // Authenticator.cs: private const int PBKDF2_ITERATIONS = 2000
// Authenticator.cs L70: private const int PBKDF2_KEYSIZE = 256 —— 配合 L1266/L1208 的
// kg.GetBytes(PBKDF2_KEYSIZE)：.NET DeriveBytes.GetBytes(int cb) 参数是「字节数」，
// 故实际派生 256 字节 Blowfish 密钥（BC 1.7.0 BlowfishEngine 无 56 字节上限，全 key 循环异或）。
export const PBKDF2_KEY_BYTES = 256

/**
 * 口令层密钥派生：Rfc2898DeriveBytes（默认 HMAC-SHA1）。
 * length/iterations 参数化仅为对齐 RFC 6070 测试向量；WinAuth 固定 2000 次 × 256 字节。
 */
export async function deriveExplicitKey(
  password: string,
  salt: Uint8Array,
  length: number,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  return (await pbkdf2({
    password: textEncoder.encode(password),
    salt,
    iterations,
    hashLength: length,
    hashFunction: createSHA1(), // hash-wasm 4.x 要求 IHasher 实例；SHA1 对齐 .NET Rfc2898DeriveBytes 默认
    outputType: 'binary',
  })) as Uint8Array
}

/** Blowfish-ECB 解密 + ISO10126d2 去填充；填充非法（口令错）抛 'password' 类错误 */
function blowfishDecryptIso10126(key: Uint8Array, cipher: Uint8Array): Uint8Array {
  if (cipher.length === 0 || cipher.length % 8 !== 0) throw new WinauthDecryptError('password')
  const ctx = blowfishKeySchedule(key)
  const out = new Uint8Array(cipher.length)
  for (let off = 0; off < cipher.length; off += 8) {
    const [l, r] = blowfishDecipherBlock(ctx, readU32be(cipher, off), readU32be(cipher, off + 4))
    writeU32be(out, off, l)
    writeU32be(out, off + 4, r)
  }
  // ISO10126d2：末字节 = 填充长度；BC 1.7.0 ISO10126d2Padding.PadCount 仅在
  // count > 可用长度时抛「pad block corrupted」（pad=0 合法=不去填充，官方 Decrypt
  // 的口令错最终由 DecryptSequence 的 SHA256 校验兜底）
  const pad = out[out.length - 1]!
  if (pad > out.length) throw new WinauthDecryptError('password')
  return out.slice(0, out.length - pad)
}

// ---------- DecryptSequence 移植（Authenticator.cs） ----------

const ENCRYPTION_HEADER = bytesToHex(textEncoder.encode('WINAUTH3')).toUpperCase()
// Authenticator.cs L75：ENCRYPTION_HEADER = ByteArrayToString(UTF8("WINAUTH3"))，
// ByteArrayToString（L934-937）经 BitConverter.ToString 输出大写 hex——真实 .wauth 密文整串全大写
const SALT_HEX_LEN = 8 * 2 // Authenticator.cs SALT_LENGTH = 8
const SHA256_HEX_LEN = 32 * 2 // SafeHasher("SHA256").HashSize/8*2

/** encrypted 属性串（Authenticator.cs DecodePasswordTypes）：y=Explicit、u=User(DPAPI)、m=Machine(DPAPI)、a/b=YubiKey */
interface PasswordTypes {
  explicit: boolean
  user: boolean
  machine: boolean
  yubi: boolean
}

function decodePasswordTypes(encrypted: string | undefined): PasswordTypes {
  const s = encrypted ?? ''
  return {
    explicit: s.includes('y'),
    user: s.includes('u'),
    machine: s.includes('m'),
    yubi: s.includes('a') || s.includes('b'),
  }
}

interface DecryptOptions {
  password?: string
  decryptDpapi?: (b64: string) => Promise<string>
}

/** DPAPI 层：hex 载荷 → base64 交桌面 CryptUnprotectData → 明文（恒为 hex ASCII）转回 hex */
async function dpapiLayer(dataHex: string, opts: DecryptOptions): Promise<string> {
  if (!opts.decryptDpapi) throw new WinauthDecryptError('dpapi')
  const plainText = await opts.decryptDpapi(bytesToBase64(hexToBytes(dataHex)))
  return bytesToHex(textEncoder.encode(plainText))
}

/** 口令层（Authenticator.cs Decrypt(data, password, PBKDF2=true)，L1250-1309） */
async function explicitLayer(dataHex: string, opts: DecryptOptions): Promise<string> {
  if (!opts.password) throw new WinauthDecryptError('password')
  const salt = hexToBytes(dataHex.slice(0, SALT_HEX_LEN))
  // L1264-1266：GetBytes(PBKDF2_KEYSIZE=256) → 256 字节密钥（非 256 bit）
  const key = await deriveExplicitKey(opts.password, salt, PBKDF2_KEY_BYTES)
  const plain = blowfishDecryptIso10126(key, hexToBytes(dataHex.slice(SALT_HEX_LEN)))
  return bytesToHex(plain)
}

/** Authenticator.cs DecryptSequenceNoHash：按 Machine→User→Explicit→Yubi 逆序解层 */
async function decryptSequenceNoHash(dataHex: string, types: PasswordTypes, opts: DecryptOptions): Promise<string> {
  let data = dataHex.trim()
  if (types.machine) data = await dpapiLayer(data, opts)
  if (types.user) data = await dpapiLayer(data, opts)
  if (types.explicit) data = await explicitLayer(data, opts)
  if (types.yubi) throw new WinauthDecryptError('yubi')
  return data
}

/** Authenticator.cs DecryptSequence（L948-980）：剥 WINAUTH3 头 + salt + SHA256，解层后校验哈希（口令错判定点） */
async function decryptSequence(dataHex: string, encrypted: string | undefined, opts: DecryptOptions): Promise<string> {
  const types = decodePasswordTypes(encrypted)
  const data = dataHex.trim()
  // 大小写不敏感剥头：真实文件密文整串大写（BitConverter），小写输入（历史 fixture/手构造）同样接受；
  // 不匹配走 v2 无头路径（ReadXmlv2 的旧 secretdata）
  if (data.slice(0, ENCRYPTION_HEADER.length).toUpperCase() !== ENCRYPTION_HEADER) {
    return decryptSequenceNoHash(data, types, opts)
  }
  const salt = data.slice(ENCRYPTION_HEADER.length, ENCRYPTION_HEADER.length + SALT_HEX_LEN)
  const hashStart = ENCRYPTION_HEADER.length + SALT_HEX_LEN
  const hash = data.slice(hashStart, hashStart + SHA256_HEX_LEN)
  const payload = data.slice(hashStart + SHA256_HEX_LEN)
  const decrypted = await decryptSequenceNoHash(payload, types, opts)
  // 哈希 = SHA256(hex_decode(salt + 解密结果 hex))；不匹配即口令错（BadPasswordException）
  const compare = await sha256Hex(hexToBytes(salt + decrypted))
  if (compare.toUpperCase() !== hash.toUpperCase()) throw new WinauthDecryptError('password')
  return decrypted
}

/**
 * 按 EncryptSequence（Authenticator.cs L1114-1184）布局构造密文序列（无 DPAPI/YubiKey 层，测试构造 fixture 用）：
 * HEADER + hex(salt 8B) + hex(SHA256(salt‖明文hex)) + payload，payload 按 encrypted 串做口令层
 * （L1192-1211 Encrypt(plain, password)：hex(salt)+hex(Blowfish(ISO10126 填充))；
 * 密钥 = L1266 GetBytes(PBKDF2_KEYSIZE=256) → 256 字节）。
 * 盐/填充随机位取 0；序列整体大写（对齐真实文件 ByteArrayToString 输出），保证测试走大写剥头路径。
 */
export async function buildWinauthSequence(payloadHex: string, encrypted: string, password?: string): Promise<string> {
  const types = decodePasswordTypes(encrypted)
  // 官方 EncryptSequence 顺序：先对 (salt + 明文 hex) 计算 SHA256，再对各层加密
  const salt = new Uint8Array(8) // fixture 专用零盐
  const saltHex = bytesToHex(salt)
  const hash = await sha256Hex(hexToBytes(saltHex + payloadHex))
  let payload = payloadHex
  if (types.explicit) {
    if (!password) throw new Error('buildWinauthSequence: explicit 层需要口令')
    const innerSalt = new Uint8Array(8)
    const key = await deriveExplicitKey(password, innerSalt, PBKDF2_KEY_BYTES)
    const plain = hexToBytes(payload)
    const padLen = 8 - (plain.length % 8)
    const padded = new Uint8Array(plain.length + padLen)
    padded.set(plain)
    padded[plain.length + padLen - 1] = padLen
    const out = new Uint8Array(padded.length)
    const ctx = blowfishKeySchedule(key)
    for (let off = 0; off < padded.length; off += 8) {
      const [l, r] = blowfishEncipherBlock(ctx, readU32be(padded, off), readU32be(padded, off + 4))
      writeU32be(out, off, l)
      writeU32be(out, off + 4, r)
    }
    payload = bytesToHex(innerSalt) + bytesToHex(out)
  }
  return (ENCRYPTION_HEADER + saltHex + hash + payload).toUpperCase()
}

// ---------- 条目映射（WinAuth JSON/secretdata → ParsedEntry） ----------

function normalizeTypeAttr(typeAttr: string | undefined): ParsedEntry['type'] {
  const t = typeAttr ?? ''
  if (t.includes('SteamAuthenticator')) return 'steam'
  if (t.includes('HOTPAuthenticator')) return 'hotp'
  return 'totp'
}

/**
 * SecretData → ParsedEntry（Authenticator.cs SecretData / HOTPAuthenticator.cs SecretData）。
 * 返回 ParsedEntry 或错误消息。
 */
function mapSecretData(secretDataText: string, name: string, typeAttr: string | undefined): ParsedEntry | { error: string } {
  const text = secretDataText.trim()
  const pipeParts = text.split('|')
  const fields = pipeParts[0]!.split('\t')
  let secretBytes: Uint8Array
  try {
    secretBytes = hexToBytes(fields[0] ?? '')
  } catch {
    return { error: 'secretdata 非法' }
  }
  if (secretBytes.length === 0) return { error: '缺少 secret' }

  const type = normalizeTypeAttr(typeAttr)
  // name 拆 issuer:label（与 Aegis/URI 导入口径一致：首个冒号）；WinAuth XML 无独立
  // 服务名字段（仅 <name> 一个显示名），name 无服务前缀（无冒号/前缀为空）时
  // issuer 兜底同 label，避免导入后列表服务名主行空白
  const sep = name.indexOf(':')
  const label = sep >= 0 ? name.slice(sep + 1) : name
  const parsed: ParsedEntry = {
    type,
    issuer: sep > 0 ? name.slice(0, sep) : label,
    label,
    // 统一存储口径：secret 还原为字节后 base32（RFC4648 大写）——见简报与 base32Encode
    secret: base32Encode(secretBytes),
    algorithm: fields[2] === 'SHA256' || fields[2] === 'SHA512' ? fields[2] : 'SHA1',
    digits: type === 'steam' ? 5 : Number.parseInt(fields[1] ?? '', 10) > 0 ? Number.parseInt(fields[1]!, 10) : 6,
    period: Number.parseInt(fields[3] ?? '', 10) > 0 ? Number.parseInt(fields[3]!, 10) : 30,
  }
  if (pipeParts.length > 1) {
    const counter = Number.parseInt(pipeParts[1]!, 10)
    if (Number.isFinite(counter) && counter >= 0) parsed.counter = counter
  }
  return parsed
}

function failureMessage(e: unknown): string {
  if (e instanceof WinauthDecryptError) {
    if (e.kind === 'dpapi') return MSG_DPAPI
    if (e.kind === 'yubi') return MSG_YUBI
    return MSG_PASSWORD
  }
  if (e instanceof Error && e.message === '非法 hex') return MSG_PASSWORD // hex 损坏多因口令错/文件损坏
  return '条目解析失败'
}

// ---------- 主流程 ----------

interface ImportContext extends DecryptOptions {
  result: ImportResult
  ordinal: number
}

/** authenticatordata 节点（可能已解密）→ 条目或失败 */
function parseAuthenticatorData(data: MiniXmlNode, name: string, typeAttr: string | undefined, ctx: ImportContext): void {
  const index = ctx.ordinal++
  const secretNode = child(data, 'secretdata')
  if (!secretNode) {
    ctx.result.failures.push({ index, message: '缺少 secret' })
    return
  }
  const mapped = mapSecretData(secretNode.text, name, typeAttr)
  if ('error' in mapped) ctx.result.failures.push({ index, message: mapped.error })
  else ctx.result.entries.push(mapped)
}

/** WinAuthAuthenticator 节点 → 条目或失败；authenticatordata 加密时按层解密 */
async function readWinauthAuthenticator(el: MiniXmlNode, ctx: ImportContext): Promise<void> {
  const index = ctx.ordinal++
  const name = child(el, 'name')?.text ?? ''
  const typeAttr = el.attrs.type
  const authData = child(el, 'authenticatordata')
  if (!authData) {
    ctx.result.failures.push({ index, message: '缺少 authenticatordata' })
    return
  }
  const encrypted = authData.attrs.encrypted
  if (!encrypted) {
    ctx.ordinal-- // 未消耗失败位：交由 parseAuthenticatorData 统一编号
    parseAuthenticatorData(authData, name, typeAttr, ctx)
    return
  }
  try {
    const innerHex = await decryptSequence(authData.text, encrypted, ctx)
    const inner = parseXml(textDecoder.decode(hexToBytes(innerHex)))
    ctx.ordinal--
    parseAuthenticatorData(inner, name, typeAttr, ctx)
  } catch (e) {
    ctx.result.failures.push({ index, message: failureMessage(e) })
  }
}

/**
 * 配置容器（<WinAuth> 根 / 解密出的 <config> / 解密出的 <WinAuth>）：
 * WinAuthConfig.cs ReadXmlInternal 的读取分派。
 */
async function readConfigContainer(el: MiniXmlNode, ctx: ImportContext): Promise<void> {
  // 旧布局：密文直接是 <WinAuth> 根元素文本（WinAuthConfig.cs ReadXmlInternal 根节点 encrypted 分支）
  if (el.attrs.encrypted && el.text.trim() !== '') {
    const dataEl: MiniXmlNode = { name: 'data', attrs: { encrypted: el.attrs.encrypted }, text: el.text, children: [] }
    await readDataElement(dataEl, ctx)
  }
  for (const c of el.children) {
    switch (c.name) {
      case 'config':
      case 'WinAuth':
        await readConfigContainer(c, ctx)
        break
      case 'data':
        await readDataElement(c, ctx)
        break
      case 'WinAuthAuthenticator':
        await readWinauthAuthenticator(c, ctx)
        break
      default:
        break // alwaysontop/usetrayicon/settings 等应用设置忽略
    }
  }
}

/** <data encrypted="..."> 整包加密（v3.2+）：解出内层 XML 后按容器继续读 */
async function readDataElement(el: MiniXmlNode, ctx: ImportContext): Promise<void> {
  if (!el.attrs.encrypted) return // 官方读取端对无 encrypted 的 data 节点不做处理
  try {
    const innerHex = await decryptSequence(el.text, el.attrs.encrypted, ctx)
    const inner = parseXml(textDecoder.decode(hexToBytes(innerHex)))
    await readConfigContainer(inner, ctx)
  } catch (e) {
    // 整包失败无法逐条拆分：记一条 failure（index 0），消息按分类
    ctx.result.failures.push({ index: 0, message: failureMessage(e) })
  }
}

/**
 * WinAuth 配置导入：解析 <WinAuth> XML，支持明文条目、条目级 authenticatordata 加密
 * 与整包 <data> 加密；口令层用官方算法（PBKDF2-HMAC-SHA1×2000 + Blowfish/ISO10126），
 * DPAPI 层通过 opts.decryptDpapi 回调（桌面端 Rust CryptUnprotectData），插件端不提供
 * 则逐条 failure「请用桌面版导入」。
 */
export async function importWinauth(text: string, opts: { password?: string; decryptDpapi?: (b64: string) => Promise<string> } = {}): Promise<ImportResult> {
  let root: MiniXmlNode
  try {
    root = parseXml(text)
  } catch {
    throw new Error('WinAuth 文件结构非法：不是合法 XML')
  }
  const ctx: ImportContext = { ...opts, result: { entries: [], failures: [] }, ordinal: 0 }
  await readConfigContainer(root, ctx)
  return ctx.result
}
