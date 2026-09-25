import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { loadVault, saveVault, validateVaultObject, VAULT_KEY } from '../src/storage/vaultStore'
import { addEntry, createVault } from '../src/vault'
import { newEntryFromUri } from '../src/vault'

describe('memory storage', () => {
  it('set/get/delete', async () => {
    const s = createMemoryStorage()
    expect(await s.get('k')).toBeNull()
    await s.set('k', 'v1')
    expect(await s.get('k')).toBe('v1')
    await s.delete('k')
    expect(await s.get('k')).toBeNull()
  })
})

describe('vaultStore', () => {
  it('空存储返回全新 vault', async () => {
    expect(await loadVault(createMemoryStorage())).toEqual(createVault())
  })

  it('save 后 load 往返一致', async () => {
    const s = createMemoryStorage()
    const v = addEntry(createVault(), newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP'))
    await saveVault(s, v)
    expect(await loadVault(s)).toEqual(v)
    expect(JSON.parse((await s.get(VAULT_KEY))!).version).toBe(2)
  })

  it('损坏数据抛 vault corrupted', async () => {
    const s = createMemoryStorage()
    await s.set(VAULT_KEY, '{oops')
    await expect(loadVault(s)).rejects.toThrow('vault corrupted')
  })
})

describe('validateVaultObject / loadVault 结构校验（F6）', () => {
  /** EntryForm/CodesPage 可落库的最小 hotp 形状（空 secret 为受支持的 INVALID 渲染态）——砖化回归锚点 */
  const emptySecretHotp = {
    uuid: 'u1', type: 'hotp', issuer: 'X', label: 'y', secret: '', algorithm: 'SHA1', digits: 6,
    period: 30, tagIds: [], order: 0, createdAt: 123,
  }
  const validVault = (overrides: Record<string, unknown> = {}, entries: unknown[] = []) => ({
    version: 2, entries, tags: [], updatedAt: 1, ...overrides,
  })

  it('应用自身写出的形状全部通过（含空 secret hotp、小数 counter、period<1、缺 counter、未知字段、icon 三形态）', () => {
    expect(() => validateVaultObject(validVault())).not.toThrow()
    expect(() => validateVaultObject(validVault({
      rev: 7,
      tags: [{ id: 't1', name: ' 工作 ' }],
      entries: [
        emptySecretHotp,
        { uuid: 'u2', type: 'totp', issuer: '', label: '', secret: 'not-base32!!', algorithm: 'SHA256', digits: 8,
          period: 0.5, counter: 1.5, tagIds: [], order: 1, createdAt: 2, note: '', pinned: true,
          icon: { kind: 'url', id: 'i1', url: 'https://x/y.png' },
          matchRules: [{ strategy: 'baseDomain', pattern: 'example.com' }] },
        { uuid: 'u3', type: 'totp', issuer: '', label: '', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6,
          period: 30, tagIds: [], order: 2, createdAt: 3, icon: { kind: 'builtin', id: 'github' } },
      ],
      anythingElse: { ignored: true },
    }))).not.toThrow()
  })

  it('save 后 load 往返一致（合法库不受校验影响）', async () => {
    const s = createMemoryStorage()
    const v = validVault({}, [emptySecretHotp])
    await s.set(VAULT_KEY, JSON.stringify(v))
    expect(await loadVault(s)).toEqual(v)
  })

  it.each([
    ['version 非 2', { version: 1 }],
    ['entries 非数组', { entries: { uuid: 'x' } }],
    ['tags 非数组', { tags: 'x' }],
    ['updatedAt 缺失', { updatedAt: undefined }],
    ['rev 负数', { rev: -1 }],
    ['tag 缺 name', { tags: [{ id: 't1' }] }],
  ])('vault 级违规拒绝：%s', async (_name, overrides) => {
    const s = createMemoryStorage()
    await s.set(VAULT_KEY, JSON.stringify(validVault(overrides)))
    await expect(loadVault(s)).rejects.toThrow('vault corrupted')
  })

  it('entries / tags 数组元素为 null → 整记录拒绝', async () => {
    const s = createMemoryStorage()
    await s.set(VAULT_KEY, JSON.stringify(validVault({}, [null])))
    await expect(loadVault(s)).rejects.toThrow('vault corrupted')
    await s.set(VAULT_KEY, JSON.stringify(validVault({ tags: [null] })))
    await expect(loadVault(s)).rejects.toThrow('vault corrupted')
  })

  it.each([
    ['note 非字符串', { note: 123 }],
    ['pinned 非布尔', { pinned: 'yes' }],
    ['pin 非字符串', { pin: 1234 }],
    ['icon 非对象（字符串）', { icon: 'builtin:github' }],
    ['icon 为 null', { icon: null }],
    ['icon.id 非字符串', { icon: { kind: 'builtin', id: 1 } }],
    ['kind=url 缺 url', { icon: { kind: 'url', id: 'i1' } }],
    ['yandex digits≠8', { type: 'yandex', digits: 6 }],
    ['issuer 非字符串', { issuer: 1 }],
    ['label 非字符串', { label: 2 }],
    ['secret 非字符串', { secret: 3 }],
    ['matchRules 元素非对象', { matchRules: ['host'] }],
  ])('条目级违规拒绝（未测方向补全）：%s', async (_name, patch) => {
    const s = createMemoryStorage()
    await s.set(VAULT_KEY, JSON.stringify(validVault({}, [{ ...emptySecretHotp, ...patch }])))
    await expect(loadVault(s)).rejects.toThrow('vault corrupted')
  })

  it.each([
    ['uuid 非字符串', { uuid: 1 }],
    ['type 非法', { type: 'otp' }],
    ['algorithm 非法', { algorithm: 'MD5' }],
    ['digits 越枚举', { digits: 9 }],
    ['steam digits 非 5', { type: 'steam', digits: 6 }],
    ['period 非正数', { period: 0 }],
    ['counter 负数', { counter: -1 }],
    ['tagIds 含非字符串', { tagIds: [1] }],
    ['icon 坏 kind', { icon: { kind: 'remote', id: 'i' } }],
    ['matchRules 非数组', { matchRules: 'x' }],
    ['matchRules 超 8 条', { matchRules: Array.from({ length: 9 }, () => ({ strategy: 'host', pattern: 'a' })) }],
    ['matchRules 坏 strategy', { matchRules: [{ strategy: 'regexx', pattern: 'a' }] }],
    ['matchRules pattern 超长', { matchRules: [{ strategy: 'host', pattern: 'a'.repeat(257) }] }],
  ])('条目级违规拒绝：%s', async (_name, patch) => {
    const s = createMemoryStorage()
    await s.set(VAULT_KEY, JSON.stringify(validVault({}, [{ ...emptySecretHotp, ...patch }])))
    await expect(loadVault(s)).rejects.toThrow('vault corrupted')
  })
})
