import { describe, expect, it } from 'vitest'
import {
  VAULT_RECORD_AAD, VAULT_REV_WATERMARK_KEY, dekFingerprint, decryptVaultWithDek, decryptVaultWithDekDetailed,
  encryptVaultWithDek, setupVaultEncryption,
} from '../src/security/securityStore'
import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, randomBytes } from '../src/crypto/aesgcm'

const vaultJson = JSON.stringify({ version: 2, entries: [{ uuid: 'a' }], tags: [], updatedAt: 1 })

describe('securityStore vault AEAD AAD 绑定（F8）', () => {
  it('新写入密文按记录身份 AAD 绑定：往返一致且 legacy=false', async () => {
    const { dek, encrypted } = await setupVaultEncryption(vaultJson, '口令')
    const r = await decryptVaultWithDekDetailed(dek, encrypted)
    expect(r.legacy).toBe(false)
    expect(r.json).toBe(vaultJson)
    // 既有字符串入口行为不变
    expect(await decryptVaultWithDek(dek, encrypted)).toBe(vaultJson)
  })

  it('旧格式（无 AAD）历史密文经回退解出并标记 legacy（写路径全量重加密即自动迁移）', async () => {
    const dek = randomBytes(32)
    const nonce = randomBytes(12)
    const legacy = {
      v: 1 as const,
      enc: true as const,
      dataNonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(await aesGcmEncrypt(dek, new TextEncoder().encode(vaultJson), nonce)),
    }
    const r = await decryptVaultWithDekDetailed(dek, legacy)
    expect(r.legacy).toBe(true)
    expect(r.json).toBe(vaultJson)
  })

  it('异记录身份 AAD 不匹配拒绝：跨记录密文移植在 GCM 校验层失败', async () => {
    const { dek, encrypted } = await setupVaultEncryption(vaultJson, '口令')
    expect(VAULT_RECORD_AAD).toBe('totp-vault:v1')
    const wrong = new TextEncoder().encode('totp-vault:v2')
    await expect(
      aesGcmDecrypt(dek, base64ToBytes(encrypted.ciphertext), base64ToBytes(encrypted.dataNonce), wrong),
    ).rejects.toThrow()
  })

  it('dekFingerprint：确定性、不同 DEK 指纹不同、不泄漏 DEK 本体', async () => {
    const a = randomBytes(32)
    expect(await dekFingerprint(a)).toBe(await dekFingerprint(a))
    expect(await dekFingerprint(a)).not.toBe(await dekFingerprint(randomBytes(32)))
    expect(await dekFingerprint(a)).not.toBe(bytesToBase64(a))
  })

  it('水位键名固定 vault_rev_watermark（与 vault/security 键分离的独立存储键）', () => {
    expect(VAULT_REV_WATERMARK_KEY).toBe('vault_rev_watermark')
  })
})
