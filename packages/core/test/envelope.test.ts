import { describe, expect, it } from 'vitest'
import { createBackupEnvelope, createSyncEnvelope, isBackupEnvelope, isSyncEnvelope, KDF_PROFILES, openBackupEnvelope, readSyncHeader } from '../src/backup/envelope'
import { base64ToBytes, bytesToBase64 } from '../src/crypto/aesgcm'

const vaultJson = JSON.stringify({ version: 2, entries: [{ uuid: 'a' }], tags: [], updatedAt: 1 })

describe('envelope v2', () => {
  it('创建→口令正确解开原文（v2 结构往返）', async () => {
    const env = await createBackupEnvelope(vaultJson, '口令123')
    expect(env.v).toBe(2)
    expect(env.aead).toBe('aes-256-gcm')
    expect(env.kdf.alg).toBe('argon2id')
    expect(env.kdf.profile).toBe('balanced')
    expect(env.kdf.m).toBe(65536)
    expect(isBackupEnvelope(env)).toBe(true)
    expect(await openBackupEnvelope(env, '口令123')).toBe(vaultJson)
  })
  it('v2 结构：profile 展开参数与 aead 字段落盘', async () => {
    const env = await createBackupEnvelope('{"x":1}', '口令', 'fast')
    expect(env.v).toBe(2)
    expect(env.aead).toBe('aes-256-gcm')
    expect(env.kdf.profile).toBe('fast')
    expect(env.kdf.m).toBe(KDF_PROFILES.fast.m)
    expect(env.kdf.t).toBe(KDF_PROFILES.fast.t)
    expect(env.kdf.p).toBe(KDF_PROFILES.fast.p)
    // 展开参数落盘后可解开（读端按展开值派生）
    expect(await openBackupEnvelope(env, '口令')).toBe('{"x":1}')
  })
  it('缺省档位 balanced（65536/3/1）', async () => {
    const env = await createBackupEnvelope('{}', '口令')
    expect(env.kdf.profile).toBe('balanced')
    expect(env.kdf.m).toBe(65536)
    expect(env.kdf.t).toBe(3)
    expect(env.kdf.p).toBe(1)
  })
  it('v1 信封拒绝（v!==2 → invalid backup envelope）', async () => {
    await expect(openBackupEnvelope({ v: 1, kdf: {}, wrapNonce: '', wrappedDek: '', dataNonce: '', ciphertext: '' }, 'x')).rejects.toThrow('invalid backup envelope')
    // v1 旧对象也不被 isBackupEnvelope 认可（缺 aead/profile）
    expect(isBackupEnvelope({ v: 1, kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: '' }, wrapNonce: '', wrappedDek: '', dataNonce: '', ciphertext: '' })).toBe(false)
  })
  it('口令错误抛 bad password', async () => {
    const env = await createBackupEnvelope(vaultJson, '对')
    await expect(openBackupEnvelope(env, '错')).rejects.toThrow('bad password or corrupted backup')
  })
  it('密文被篡改抛 bad password', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p')
    const bytes = base64ToBytes(env.ciphertext)
    bytes[0]! ^= 1
    await expect(openBackupEnvelope({ ...env, ciphertext: bytesToBase64(bytes) }, 'p')).rejects.toThrow('bad password or corrupted backup')
  })
  it('结构非法抛 invalid backup envelope', async () => {
    await expect(openBackupEnvelope({ v: 2 }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope('not json', 'p')).rejects.toThrow('invalid backup envelope')
    // 缺 aead / aead 非法 → invalid（本实现只认 aes-256-gcm）
    const env = await createBackupEnvelope(vaultJson, 'p')
    await expect(openBackupEnvelope({ ...env, aead: undefined }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, aead: 'chacha20-poly1305' }, 'p')).rejects.toThrow('invalid backup envelope')
  })
  it('KDF 参数钳制沿用：声明超大 m 拒绝', async () => {
    const env = await createBackupEnvelope('{}', '口令')
    const evil = { ...env, kdf: { ...env.kdf, m: 2 ** 30 } }
    await expect(openBackupEnvelope(evil, '口令')).rejects.toThrow('invalid backup envelope')
  })
  it('salt 非法 base64 → invalid backup envelope（deriveKek 前置失败路径）', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, salt: '!!' } }, 'p')).rejects.toThrow('invalid backup envelope')
  })
  it('kdf 参数超限抛 invalid backup envelope（防恶意 envelope 资源耗尽；F9 上限收紧为档位包络 262144/4/1）', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, t: 99999 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, t: 5 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 2 ** 21 + 1 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 262145 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, p: 2 } }, 'p')).rejects.toThrow('invalid backup envelope')
  })
  it('最重档 paranoid（262144/4/1）恰好等于钳制上限：放行并正常解开', async () => {
    const env = await createBackupEnvelope(vaultJson, '口令', 'paranoid')
    expect(env.kdf.m).toBe(262144)
    expect(env.kdf.t).toBe(4)
    expect(env.kdf.p).toBe(1)
    expect(await openBackupEnvelope(env, '口令')).toBe(vaultJson)
  })
  it('kdf 参数下限违规抛 invalid backup envelope（m<1024/t<1/p<1 拒绝；OWASP 最低推荐）', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p')
    // m 下限：m=512/1023/0/负数/小数/非数字 全部拒绝
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 512 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 1023 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 0 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: -1 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 1023.5 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: '1024' as unknown as number } }, 'p')).rejects.toThrow('invalid backup envelope')
    // t 下限：t=0/负数/小数 拒绝
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, t: 0 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, t: -3 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, t: 0.5 } }, 'p')).rejects.toThrow('invalid backup envelope')
    // p 下限：p=0/负数/小数 拒绝
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, p: 0 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, p: -1 } }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, p: 0.5 } }, 'p')).rejects.toThrow('invalid backup envelope')
    // 组合违规：m/t/p 同时越界仍抛错（不被单一字段短路掩盖）
    await expect(openBackupEnvelope({ ...env, kdf: { ...env.kdf, m: 8, t: 0, p: 0 } }, 'p')).rejects.toThrow('invalid backup envelope')
  })
  it('非法档位名回落 balanced（防调用方传脏值崩溃）', async () => {
    const env = await createBackupEnvelope('{}', '口令', 'bogus' as never)
    expect(env.kdf.profile).toBe('balanced')
    expect(env.kdf.m).toBe(65536)
  })
  it('同口令两次创建产生不同 salt/nonce（随机性）', async () => {
    const a = await createBackupEnvelope(vaultJson, 'p')
    const b = await createBackupEnvelope(vaultJson, 'p')
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.wrapNonce).not.toBe(b.wrapNonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })
  it('isBackupEnvelope 拒绝任意对象', () => {
    expect(isBackupEnvelope({})).toBe(false)
    expect(isBackupEnvelope(null)).toBe(false)
  })
})

describe('sync envelope v3', () => {
  const sync = { rev: 7, deviceId: 'dev-a', baseRev: 6, baseContentHash: 'ab12' }
  it('create→isSyncEnvelope→open 往返', async () => {
    const env = await createSyncEnvelope('{"a":1}', 'pw', 'balanced', sync)
    expect(isSyncEnvelope(env)).toBe(true)
    expect(await openBackupEnvelope(JSON.parse(JSON.stringify(env)), 'pw')).toBe('{"a":1}')
  })
  it('isBackupEnvelope 对 v2 仍真、对 v3 假', async () => {
    const v2 = await createBackupEnvelope('{}', 'pw')
    expect(isBackupEnvelope(v2)).toBe(true)
    const v3 = await createSyncEnvelope('{}', 'pw', 'balanced', sync)
    expect(isBackupEnvelope(v3)).toBe(false)
  })
  it('readSyncHeader：v3 返回 sync；v2/垃圾返回 null', async () => {
    const v3 = await createSyncEnvelope('{}', 'pw', 'balanced', sync)
    expect(readSyncHeader(v3)).toEqual(sync)
    expect(readSyncHeader(await createBackupEnvelope('{}', 'pw'))).toBeNull()
    expect(readSyncHeader({ v: 3 })).toBeNull()
  })
  it('openBackupEnvelope 接受 v3', async () => {
    const v3 = await createSyncEnvelope('{"k":2}', 'pw', 'balanced', sync)
    expect(await openBackupEnvelope(JSON.parse(JSON.stringify(v3)), 'pw')).toBe('{"k":2}')
  })
})
