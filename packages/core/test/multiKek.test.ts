import { describe, expect, it } from 'vitest'
import { aesGcmEncrypt, bytesToBase64, randomBytes } from '../src/crypto/aesgcm'
import { addPrfSource, setupVaultEncryption, unlockVaultEncryption } from '../src/security/securityStore'
import type { SecuritySettings } from '../src/security/securityStore'
import {
  kekSourcesOf, withPrfSource, withDpapiSource, removeKekSource, unlockWithPrf,
} from '../src/security/multiKek'

// 手工构造最小 SecuritySettings（kekSources 归一/增删不涉及口令解锁，无需跑 argon2）
function bareSettings(): SecuritySettings {
  return {
    v: 1,
    enabled: true,
    kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: bytesToBase64(randomBytes(16)) },
    wrapNonce: bytesToBase64(randomBytes(12)),
    wrappedDek: bytesToBase64(randomBytes(48)),
  }
}

const prfSource = (credentialId: string) => ({
  kind: 'prf' as const,
  credentialId,
  salt: bytesToBase64(randomBytes(32)),
  wrappedDekP: bytesToBase64(randomBytes(60)),
})

// wrappedDekP fixture：base64(nonce(12B) ‖ AES-GCM 密文)，KEK=prfOutput 前 32B
async function wrapWithPrf(dek: Uint8Array, prfOutput: Uint8Array): Promise<string> {
  const nonce = randomBytes(12)
  const ct = await aesGcmEncrypt(prfOutput.subarray(0, 32), dek, nonce)
  const blob = new Uint8Array(12 + ct.length)
  blob.set(nonce, 0)
  blob.set(ct, 12)
  return bytesToBase64(blob)
}

describe('kekSourcesOf 归一化', () => {
  it('缺省 kekSources → [{kind:"password"}]', () => {
    expect(kekSourcesOf(bareSettings())).toEqual([{ kind: 'password' }])
  })
  it('空数组 → [{kind:"password"}]', () => {
    const s = { ...bareSettings(), kekSources: [] }
    expect(kekSourcesOf(s)).toEqual([{ kind: 'password' }])
  })
  it('字段存在且过滤后非空 → 按条目返回，不补 password', () => {
    const s = { ...bareSettings(), kekSources: [prfSource('c1'), { junk: true } as never] }
    const out = kekSourcesOf(s)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'prf', credentialId: 'c1' })
    expect(out.some((x) => x.kind === 'password')).toBe(false)
  })
  it('全部条目非法（或缺字段）→ [{kind:"password"}]', () => {
    const s = { ...bareSettings(), kekSources: [{ kind: 'bogus' }, { kind: 'prf', credentialId: 'x' }] as never }
    expect(kekSourcesOf(s)).toEqual([{ kind: 'password' }])
  })
})

describe('withPrfSource / withDpapiSource 添加来源', () => {
  it('缺省 settings 添加 prf：password+prf 并存，原对象不变', () => {
    const s = bareSettings()
    const s2 = withPrfSource(s, 'cred-1', 'c2FsdA==', 'd3JhcA==')
    expect(s.kekSources).toBeUndefined()
    expect(s2.kekSources).toEqual([
      { kind: 'password' },
      { kind: 'prf', credentialId: 'cred-1', salt: 'c2FsdA==', wrappedDekP: 'd3JhcA==' },
    ])
  })
  it('添加 dpapi：password+dpapi 并存', () => {
    const s2 = withDpapiSource(bareSettings(), 'ZHdhcmE=')
    expect(s2.kekSources).toEqual([{ kind: 'password' }, { kind: 'dpapi', wrappedDekD: 'ZHdhcmE=' }])
  })
})

describe('removeKekSource 移除守护', () => {
  it('仅口令（缺省字段）移除 password → 抛「至少保留一种解锁方式」', () => {
    expect(() => removeKekSource(bareSettings(), 'password')).toThrow('至少保留一种解锁方式')
  })
  it('password+prf 移除 password → 仅剩 prf；再次归一不补 password', () => {
    const s = { ...bareSettings(), kekSources: [{ kind: 'password' as const }, prfSource('c1')] }
    const s2 = removeKekSource(s, 'password')
    expect(s2.kekSources).toHaveLength(1)
    expect(s2.kekSources![0]).toMatchObject({ kind: 'prf', credentialId: 'c1' })
    expect(kekSourcesOf(s2).some((x) => x.kind === 'password')).toBe(false)
  })
  it('password+prf 移除 prf → 仅剩 password', () => {
    const s = { ...bareSettings(), kekSources: [{ kind: 'password' as const }, prfSource('c1')] }
    expect(removeKekSource(s, 'prf').kekSources).toEqual([{ kind: 'password' }])
  })
  it('password+dpapi 移除 dpapi → 仅剩 password', () => {
    const s = { ...bareSettings(), kekSources: [{ kind: 'password' as const }, { kind: 'dpapi' as const, wrappedDekD: 'eA==' }] }
    expect(removeKekSource(s, 'dpapi').kekSources).toEqual([{ kind: 'password' }])
  })
  it('按 credentialId 精确移除 prf，其余 prf 保留', () => {
    const s = { ...bareSettings(), kekSources: [{ kind: 'password' as const }, prfSource('a'), prfSource('b')] }
    const s2 = removeKekSource(s, 'prf', { credentialId: 'a' })
    expect(s2.kekSources).toHaveLength(2)
    expect(s2.kekSources!.some((x) => x.kind === 'prf' && (x as { credentialId: string }).credentialId === 'a')).toBe(false)
    expect(s2.kekSources!.some((x) => x.kind === 'prf' && (x as { credentialId: string }).credentialId === 'b')).toBe(true)
  })
  it('移除后来源为空 → 抛「至少保留一种解锁方式」', () => {
    const s = { ...bareSettings(), kekSources: [prfSource('c1')] }
    expect(() => removeKekSource(s, 'prf')).toThrow('至少保留一种解锁方式')
  })
  it('移除不存在的 kind：不抛，归一化写回', () => {
    const s2 = removeKekSource(bareSettings(), 'prf')
    expect(s2.kekSources).toEqual([{ kind: 'password' }])
  })
})

describe('addPrfSource（securityStore 帮助函数）', () => {
  it('缺省 settings 添加 prf：password+prf 并存，unlockWithPrf 解出原 DEK', async () => {
    const { security, dek } = await setupVaultEncryption('{"v":1}', 'p')
    const prfOutput = randomBytes(64)
    const salt = bytesToBase64(randomBytes(32))
    const s2 = await addPrfSource(security, dek, 'cred-1', prfOutput, salt)
    expect(kekSourcesOf(s2)).toHaveLength(2)
    expect(kekSourcesOf(s2)[1]).toMatchObject({ kind: 'prf', credentialId: 'cred-1', salt })
    // wrappedDekP 契约 base64(nonce(12B)‖ct)：unlockWithPrf 走该解码路径成功即验证
    expect(await unlockWithPrf(s2, prfOutput)).toEqual(dek)
    // 口令路径不受影响
    expect(await unlockVaultEncryption(s2, 'p')).toEqual(dek)
    // 原对象不被修改
    expect(security.kekSources).toBeUndefined()
  })
  it('同 credentialId 替换语义：旧条目被移除，旧 prfOutput 失效、新 prfOutput 可解', async () => {
    const { security, dek } = await setupVaultEncryption('{"v":1}', 'p')
    const oldPrf = randomBytes(64)
    const s1 = await addPrfSource(security, dek, 'cred-1', oldPrf, 'c2FsdA==')
    const newPrf = randomBytes(64)
    const s2 = await addPrfSource(s1, dek, 'cred-1', newPrf, 'c2FsdEI=')
    const prfEntries = kekSourcesOf(s2).filter((x) => x.kind === 'prf')
    expect(prfEntries).toHaveLength(1)
    expect(prfEntries[0]).toMatchObject({ kind: 'prf', credentialId: 'cred-1', salt: 'c2FsdEI=' })
    expect(await unlockWithPrf(s2, newPrf)).toEqual(dek)
    await expect(unlockWithPrf(s2, oldPrf)).rejects.toThrow('passkey 解锁失败')
  })
  it('不同 credentialId 并存：两个 prf 源均可用', async () => {
    const { security, dek } = await setupVaultEncryption('{"v":1}', 'p')
    const prfA = randomBytes(64)
    const prfB = randomBytes(64)
    const s1 = await addPrfSource(security, dek, 'cred-a', prfA, 'c2FsdEE=')
    const s2 = await addPrfSource(s1, dek, 'cred-b', prfB, 'c2FsdEI=')
    expect(kekSourcesOf(s2).filter((x) => x.kind === 'prf')).toHaveLength(2)
    expect(await unlockWithPrf(s2, prfA, { credentialId: 'cred-a' })).toEqual(dek)
    expect(await unlockWithPrf(s2, prfB, { credentialId: 'cred-b' })).toEqual(dek)
  })
  it('prfOutput 不足 32B 或 dek 非 32B → 抛错', async () => {
    const { security, dek } = await setupVaultEncryption('{"v":1}', 'p')
    await expect(addPrfSource(security, dek, 'c', randomBytes(16), 'c2FsdA==')).rejects.toThrow('invalid prf output')
    await expect(addPrfSource(security, new Uint8Array(16), 'c', randomBytes(64), 'c2FsdA==')).rejects.toThrow('invalid dek')
  })
})

describe('unlockWithPrf', () => {
  it('prf 解锁成功：返回原 DEK，且与口令路径并存', async () => {
    const { security, dek } = await setupVaultEncryption('{"v":1}', '口令123')
    const prfOutput = randomBytes(64) // KEK_prf = 前 32B
    const wrappedDekP = await wrapWithPrf(dek, prfOutput)
    const s2 = withPrfSource(security, 'cred-1', bytesToBase64(randomBytes(32)), wrappedDekP)
    expect(await unlockWithPrf(s2, prfOutput)).toEqual(dek)
    // 口令路径不受影响（多绑）
    expect(await unlockVaultEncryption(security, '口令123')).toEqual(dek)
  })
  it('无 prf 来源 → passkey 解锁失败', async () => {
    const { security } = await setupVaultEncryption('{"v":1}', 'p')
    await expect(unlockWithPrf(security, randomBytes(64))).rejects.toThrow('passkey 解锁失败')
  })
  it('prfOutput 错误 → passkey 解锁失败', async () => {
    const { security, dek } = await setupVaultEncryption('{"v":1}', 'p')
    const wrappedDekP = await wrapWithPrf(dek, randomBytes(64))
    const s2 = withPrfSource(security, 'cred-1', 'c2FsdA==', wrappedDekP)
    await expect(unlockWithPrf(s2, randomBytes(64))).rejects.toThrow('passkey 解锁失败')
  })
  it('wrappedDekP 被篡改 → passkey 解锁失败', async () => {
    const { security, dek } = await setupVaultEncryption('{"v":1}', 'p')
    const wrappedDekP = await wrapWithPrf(dek, randomBytes(64))
    const tampered = wrappedDekP.slice(0, -4) + 'AAAA'
    const s2 = withPrfSource(security, 'cred-1', 'c2FsdA==', tampered)
    await expect(unlockWithPrf(s2, randomBytes(64))).rejects.toThrow('passkey 解锁失败')
  })
  it('credentialId 过滤：匹配的来源可解锁，不匹配报错', async () => {
    const { security, dek } = await setupVaultEncryption('{"v":1}', 'p')
    const prfOutputA = randomBytes(64)
    const s2 = withPrfSource(security, 'cred-a', 'c2FsdA==', await wrapWithPrf(dek, prfOutputA))
    expect(await unlockWithPrf(s2, prfOutputA, { credentialId: 'cred-a' })).toEqual(dek)
    await expect(unlockWithPrf(s2, prfOutputA, { credentialId: 'cred-b' })).rejects.toThrow('passkey 解锁失败')
  })
  it('C1：prfOutput 不足 32B → 直接抛错，不静默忽略', async () => {
    const { security } = await setupVaultEncryption('{"v":1}', 'p')
    await expect(unlockWithPrf(security, randomBytes(16))).rejects.toThrow('invalid prf output')
  })
  it('C1：wrappedDekP 解密得到非 32B 数据 → 抛长度错误，不静默返回', async () => {
    // 用 16B KEK + 16B 密文（< 16B 是 GCM tag 失败，但更短密文+nonce 可能解密成短数据；
    // 这里改用「直接手工写 wrappedDekP 为空密文让 AES-GCM 解出空串」
    const { security } = await setupVaultEncryption('{"v":1}', 'p')
    // 手工构造 wrappedDekP = base64(nonce(12B) ‖ AES-GCM(KEK, ""))——KEK=prfOutput前32B
    const prfOutput = randomBytes(64)
    const kek = prfOutput.subarray(0, 32)
    const nonce = randomBytes(12)
    const ct = await aesGcmEncrypt(kek, new Uint8Array(0), nonce) // 空串密文，tag 16B
    const blob = new Uint8Array(12 + ct.length)
    blob.set(nonce, 0)
    blob.set(ct, 12)
    const wrapped = bytesToBase64(blob)
    const s2 = withPrfSource(security, 'cred-1', 'c2FsdA==', wrapped)
    await expect(unlockWithPrf(s2, prfOutput, { credentialId: 'cred-1' })).rejects.toThrow('invalid DEK length from PRF unwrap')
  })
})
