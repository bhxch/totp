import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveZipAesKeys, importAuthenticatorPlus, zipAesCtrDecrypt } from '@totp/core'
import { describe, expect, it } from 'vitest'

// Authenticator Plus 导入集成测试。无现成权威加密样本：
// ① 手工构造 WinZip AE-2 zip（字段按 WinZip AES 规范/brief 偏移表，7z 与 zip4j 同遵）作端到端覆盖（CI 可跑）；
// ② 7-Zip 生成的 AE-2（AES-256）zip 对拍（SEVEN_ZIP 不存在时整组 skip，CI 不红）；
// ③ AP_EXTERNAL_SAMPLE 环境变量指向真实 AP 导出文件时追加真样本用例（有则跑）。

const SEVEN_ZIP = ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'].find(existsSync)

const URIS = [
  'otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
  'otpauth://totp/Example:bob@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example',
].join('\r\n')

const encoder = new TextEncoder()

// ---------- zip 构造 helpers（little-endian；仅测试内使用） ----------

function u16(v: number): Uint8Array {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, v, true)
  return b
}
function u32(v: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v, true)
  return b
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** WinZip AES 加密条目数据：salt(ks/2) || verifier(2) || ciphertext || authCode(10)；AE-2（version=2） */
async function ae2Encrypt(
  data: Uint8Array,
  password: string,
  opts: { tamper?: 'verifier' | 'auth' } = {},
): Promise<Uint8Array> {
  const ks = 32 as const
  const salt = crypto.getRandomValues(new Uint8Array(ks / 2))
  const { encKey, authKey, verifier } = await deriveZipAesKeys(password, salt, ks)
  const ct = await zipAesCtrDecrypt(encKey, data, new Uint8Array(16))
  const hmacKey = await crypto.subtle.importKey('raw', authKey as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const auth = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, ct as BufferSource)).slice(0, 10)
  if (opts.tamper === 'verifier') verifier[0] = verifier[0]! ^ 0xff
  if (opts.tamper === 'auth') auth[0] = auth[0]! ^ 0xff
  return concat(salt, verifier, ct, auth)
}

/** 单条目 zip：method 99 + AES extra field 0x9901（AE-2/strength 3/real method 8 deflate）或明文 deflate */
async function buildZip(name: string, plain: Uint8Array, password?: string, opts: { tamper?: 'verifier' | 'auth' } = {}): Promise<Uint8Array> {
  const compressed = password ? await ae2Encrypt(deflateRawSync(plain), password, opts) : deflateRawSync(plain)
  const nameBytes = encoder.encode(name)
  const aesExtra = password ? concat(u16(0x9901), u16(7), u16(2), encoder.encode('AE'), new Uint8Array([3]), u16(8)) : new Uint8Array(0)
  const method = password ? 99 : 8
  const flags = password ? 1 : 0
  const loc = concat(
    u32(0x04034b50), u16(51), u16(flags), u16(method), u16(0), u16(0), u32(0),
    u32(compressed.length), u32(plain.length), u16(nameBytes.length), u16(aesExtra.length),
    nameBytes, aesExtra, compressed,
  )
  const cen = concat(
    u32(0x02014b50), u16(51), u16(51), u16(flags), u16(method), u16(0), u16(0), u32(0),
    u32(compressed.length), u32(plain.length), u16(nameBytes.length), u16(aesExtra.length),
    u16(0), u16(0), u16(0), u32(0), u32(0), nameBytes, aesExtra,
  )
  return concat(loc, cen, u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(cen.length), u32(loc.length), u16(0))
}

// ---------- ① 手工构造 AE-2 zip 端到端 ----------

describe('importAuthenticatorPlus（手工构造 WinZip AE-2 zip）', () => {
  it('解密解压出 Accounts.txt 并经 uriBatch 解析出 2 条', async () => {
    const zip = await buildZip('Accounts.txt', encoder.encode(URIS), 'secret123')
    const r = await importAuthenticatorPlus(zip, 'secret123')
    expect(r.failures).toEqual([])
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'alice@example.com', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 })
    expect(r.entries[1]).toMatchObject({ type: 'totp', issuer: 'Example', label: 'bob@example.com' })
  })

  it('口令错误（verifier 不匹配）rejects', async () => {
    const zip = await buildZip('Accounts.txt', encoder.encode(URIS), 'secret123')
    await expect(importAuthenticatorPlus(zip, 'wrong-pass')).rejects.toThrow('口令错误')
  })

  it('authCode 被篡改 → 完整性校验失败 rejects', async () => {
    const zip = await buildZip('Accounts.txt', encoder.encode(URIS), 'secret123', { tamper: 'auth' })
    await expect(importAuthenticatorPlus(zip, 'secret123')).rejects.toThrow('完整性校验失败')
  })

  it('无 Accounts.txt → 明确报错', async () => {
    const zip = await buildZip('other.txt', encoder.encode(URIS), 'secret123')
    await expect(importAuthenticatorPlus(zip, 'secret123')).rejects.toThrow('Accounts.txt')
  })

  it('未加密 deflate zip（无 AES extra field）同样可读', async () => {
    const zip = await buildZip('Accounts.txt', encoder.encode(URIS))
    const r = await importAuthenticatorPlus(zip, '')
    expect(r.entries).toHaveLength(2)
  })
})

// ---------- ② 7-Zip AE-2 对拍（SEVEN_ZIP 不存在时整组 skip） ----------

describe.skipIf(!SEVEN_ZIP)('importAuthenticatorPlus（7-Zip AE-2 AES-256 对拍）', () => {
  it('解出 7z 生成的加密 zip', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ap-'))
    try {
      const txt = join(tmp, 'Accounts.txt')
      writeFileSync(txt, URIS, 'utf8')
      const zipPath = join(tmp, 'ap.zip')
      execFileSync(SEVEN_ZIP!, ['a', '-tzip', '-mem=AES256', '-psecret123', zipPath, txt], { stdio: 'ignore' })
      const zip = new Uint8Array(readFileSync(zipPath))
      const r = importAuthenticatorPlus(zip, 'secret123')
      return r.then((res) => {
        expect(res.failures).toEqual([])
        expect(res.entries).toHaveLength(2)
        expect(res.entries[0]).toMatchObject({ issuer: 'GitHub', label: 'alice@example.com' })
        return expect(importAuthenticatorPlus(zip, 'wrong-pass')).rejects.toThrow('口令错误')
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------- ③ 真实 AP 导出样本（设置 AP_EXTERNAL_SAMPLE 时追加） ----------

const external = process.env.AP_EXTERNAL_SAMPLE
const describeExternal = external && existsSync(external) ? describe : describe.skip

describeExternal('importAuthenticatorPlus（真实 AP 导出样本）', () => {
  it('解出真样本中的 Accounts.txt', async () => {
    const zip = new Uint8Array(readFileSync(external!))
    const r = await importAuthenticatorPlus(zip, process.env.AP_EXTERNAL_PASSWORD ?? '')
    expect(r.entries.length + r.failures.length).toBeGreaterThan(0)
  })
})
