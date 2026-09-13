// 生成 Aegis 加密 vault 测试 fixture（packages/core/test/fixtures/aegis-encrypted.json）
// 布局严格对齐 Aegis 官方源码（beemdevelopment/Aegis master）：
// - crypto/CryptoUtils.java：encrypt 时 JCE doFinal 输出 ct||tag，手动拆分为 ct 与 tag(16B)，
//   decrypt 时重新拼接 ct||tag；nonce 12B、tag 128bit、AES/GCM/NoPadding
// - crypto/CryptParameters.java：nonce/tag 以十六进制编码分开存放 {"nonce": "<hex>", "tag": "<hex>"}
// - vault/slots/Slot.java：slot JSON 字段 type/uuid/key/key_params；key 为 hex 编码的密文（不含 tag）
// - vault/slots/PasswordSlot.java（type=1）：scrypt 参数在 slot 级字段 n/r/p，salt 为 hex 编码
// - vault/VaultFile.java：{version, header:{slots, params}, db}；db 为 base64(密文)，不含 nonce/tag
// - crypto/MasterKey.java + vault/VaultFileCredentials.java：KEK 解 slot 得 master key，
//   再用 header.params 的 nonce/tag 解 db
// 注意：与 Aegis 不同的是本脚本用固定 uuid 以便 fixture diff 稳定（官方允许 uuid 缺失自动生成）
import { scryptSync, randomBytes, createCipheriv } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hex = (b) => Buffer.from(b).toString('hex')
const b64 = (b) => Buffer.from(b).toString('base64')

const TAG_LEN = 16

/** Aegis 加密：返回 ct（不含 tag）、nonce、tag（对齐 CryptoUtils.encrypt 的拆分行为） */
function encryptToParts(key, plaintext) {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ctAndTag = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
  return {
    ct: ctAndTag.subarray(0, ctAndTag.length - TAG_LEN),
    nonce,
    tag: ctAndTag.subarray(ctAndTag.length - TAG_LEN),
  }
}

const password = 'test1234'
const N = 16384
const r = 8
const p = 1
const slotSalt = randomBytes(32)
const kek = scryptSync(password, slotSalt, 32, { N, r, p })
const masterKey = randomBytes(32)

const slotEnc = encryptToParts(kek, masterKey)
const slot = {
  type: 1, // PasswordSlot TYPE_ID = 1
  uuid: '7df9d064-30aa-4a71-ae2e-6d0fa1e8e4a1',
  key: hex(slotEnc.ct),
  key_params: { nonce: hex(slotEnc.nonce), tag: hex(slotEnc.tag) },
  n: N,
  r,
  p,
  salt: hex(slotSalt),
}

const dbJson = JSON.stringify({
  version: 1,
  entries: [
    {
      type: 'totp',
      uuid: 'c7f81c98-1d2f-4a0f-9c9f-3c6a5f9b0d02',
      name: 'GitHub:me@x.com',
      note: '',
      info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30, origin: 'manual' },
    },
  ],
})
const dbEnc = encryptToParts(masterKey, Buffer.from(dbJson, 'utf8'))

const vault = {
  version: 1,
  header: {
    slots: [slot],
    params: { nonce: hex(dbEnc.nonce), tag: hex(dbEnc.tag) },
  },
  db: b64(dbEnc.ct),
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/core/test/fixtures/aegis-encrypted.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(vault, null, 2) + '\n')
console.log(`fixture written: ${outPath} (password=${password})`)
