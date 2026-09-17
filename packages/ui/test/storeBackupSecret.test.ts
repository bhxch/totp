import { describe, expect, it } from 'vitest'
import {
  createMemoryStorage, decryptVaultWithDek, encryptVaultWithDek, openSecretBag, randomBytes, SECRET_BAG_KEY,
  SECURITY_KEY, unlockWithPrf,
  type SecuritySettings, type StorageAdapter,
} from '@totp/core'
import { createVueStore } from '../src/store'

/** 会话备份口令（设计 §1 保管区语义）：remember 存保管区键而非 vault 密文；锁定清空、解锁自动装载；
 *  关加密删保管区键；旧 vault.backupSecret 经迁移 op 搬入保管区并从密文剥除（幂等） */
describe('store backupSecret（保管区）', () => {
  const diskSecurity = async (adapter: ReturnType<typeof createMemoryStorage>): Promise<SecuritySettings> =>
    JSON.parse((await adapter.get(SECURITY_KEY))!) as SecuritySettings

  /** 解开盘上 vault 密文（断言遗留字段不落盘用） */
  const diskVaultJson = async (adapter: StorageAdapter, dek: Uint8Array): Promise<Record<string, unknown>> => {
    const enc = JSON.parse((await adapter.get('vault'))!)
    return JSON.parse(await decryptVaultWithDek(dek, enc)) as Record<string, unknown>
  }

  /** 解开保管区密文 */
  const diskBag = async (adapter: StorageAdapter, dek: Uint8Array) =>
    openSecretBag(dek, await adapter.get(SECRET_BAG_KEY))

  it('空串/全空白 setBackupSecret 抛「备份口令不能为空」且会话不变；正常值 trim 后存', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await expect(s.setBackupSecret('', false)).rejects.toThrow('备份口令不能为空')
    await expect(s.setBackupSecret('   ', false)).rejects.toThrow('备份口令不能为空')
    expect(s.backupSecret.value).toBeNull()
    await s.setBackupSecret('  pw  ', false)
    expect(s.backupSecret.value).toBe('pw')
  })

  it('未启用加密 + remember=true：抛「需先启用加密」；会话生效但不落保管区键', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await expect(s.setBackupSecret('pw', true)).rejects.toThrow('需先启用加密才能记住备份口令')
    expect(s.backupSecret.value).toBe('pw') // 会话已置（无论 remember）
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull() // 未触发保管区落盘
  })

  it('锁定 + remember=true：抛「解锁后才能记住」；解锁后盘上保管区无口令', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    s.lock()
    await expect(s.setBackupSecret('pw', true)).rejects.toThrow('解锁后才能记住备份口令')
    expect(s.backupSecret.value).toBe('pw') // 会话已置
    await s.unlock('masterpw')
    expect(s.bagStored.value).toBe(false)
    expect((await diskBag(adapter, s.getCurrentDek()!)).backupPassword).toBe('')
  })

  it('remember=true 存保管区而非 vault 密文；forget 后保管区口令清空（凭据键不受影响）；lock→unlock 自动装载', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    expect(s.backupSecret.value).toBe('pw')
    expect(s.bagStored.value).toBe(true)
    const dek = s.getCurrentDek()!
    expect((await diskBag(adapter, dek)).backupPassword).toBe('pw') // 保管区密文落盘
    expect(await diskVaultJson(adapter, dek)).not.toHaveProperty('backupSecret') // vault 密文无该字段
    // forget：保管区口令清空并重封
    await s.forgetBackupSecret()
    expect(s.backupSecret.value).toBeNull()
    expect(s.bagStored.value).toBe(false)
    expect((await diskBag(adapter, dek)).backupPassword).toBe('')
    // 重新记住 → lock→unlock 后从保管区自动装载
    await s.setBackupSecret('pw', true)
    s.lock()
    expect(s.backupSecret.value).toBeNull()
    expect(s.bagStored.value).toBe(false)
    await s.unlock('masterpw')
    expect(s.backupSecret.value).toBe('pw') // 解锁自动装载
    expect(s.bagStored.value).toBe(true)
  })

  it('remember=false：仅会话生效，盘上保管区无口令', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', false)
    expect(s.backupSecret.value).toBe('pw')
    expect(s.bagStored.value).toBe(false)
    expect((await diskBag(adapter, s.getCurrentDek()!)).backupPassword).toBe('')
  })

  it('lock 清会话与保管区视图', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    s.lock()
    expect(s.backupSecret.value).toBeNull()
    expect(s.bagStored.value).toBe(false)
    expect(s.credsCache.value).toEqual({})
  })

  it('disableEncryption：删保管区键 + 清会话/视图（先记住后关 / 会话有值 两态均清）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    // 态 1：先记住后关加密
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    await s.disableEncryption()
    expect(s.backupSecret.value).toBeNull()
    expect(s.bagStored.value).toBe(false)
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull() // 保管区键已删
    expect(JSON.parse((await adapter.get('vault'))!).enc).toBeUndefined() // 已回明文
    // 态 2：会话有值（未记住）后关加密
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw2', false)
    await s.disableEncryption()
    expect(s.backupSecret.value).toBeNull()
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull()
  })

  it('unlockWithDek（PRF）路径解锁后同样自动装载保管区口令', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    const prfOutput = randomBytes(64)
    await s.addPrfSourceOp('cred-1', prfOutput, randomBytes(32))
    await s.setBackupSecret('pw', true)
    s.lock()
    const dek = await unlockWithPrf(await diskSecurity(adapter), prfOutput, { credentialId: 'cred-1' })
    await s.unlockWithDek(dek)
    expect(s.locked.value).toBe(false)
    expect(s.backupSecret.value).toBe('pw')
  })

  it('initStore 重建（同窗口已持 DEK，如刷新/重建 store）：直接解密填充并装载保管区口令', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    // 重建 store（同盘）：先经 unlockWithDek 持 DEK（initStore 未跑），再 initStore 走「已持 DEK」分支
    const b = createVueStore(adapter)
    await b.unlockWithDek(s.getCurrentDek()!)
    await b.initStore()
    expect(b.locked.value).toBe(false)
    expect(b.backupSecret.value).toBe('pw') // 解密填充时同步装载保管区口令
    expect(b.vault.groups).toEqual(s.vault.groups)
  })

  it('migrateLegacySecrets：旧 vault 密文 backupSecret → 保管区 + 从密文剥除；bag 已有口令时仅剥除', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    const dek = s.getCurrentDek()!
    // 盘上放置遗留密文（vault JSON 带 backupSecret 字段，T2 前旧库形态）
    const legacyVault = { version: 1, entries: [], groups: [], updatedAt: 1, backupSecret: 'oldpw' }
    await adapter.set('vault', JSON.stringify(await encryptVaultWithDek(dek, JSON.stringify(legacyVault))))
    s.lock()
    await s.unlock('masterpw') // replaceVault 自然丢弃遗留字段（内存无残留）
    expect(s.backupSecret.value).toBeNull() // 保管区尚未迁移
    await s.migrateLegacySecrets()
    expect(s.backupSecret.value).toBe('oldpw') // 先写新：口令入保管区
    expect(s.bagStored.value).toBe(true)
    expect((await diskBag(adapter, dek)).backupPassword).toBe('oldpw')
    expect(await diskVaultJson(adapter, dek)).not.toHaveProperty('backupSecret') // 后删旧：密文重写剥除
    // bag 已有口令时仅剥除：再放一份带字段密文，迁移不改保管区口令
    await adapter.set('vault', JSON.stringify(await encryptVaultWithDek(dek, JSON.stringify({ ...legacyVault, backupSecret: 'other' }))))
    await s.migrateLegacySecrets()
    expect(s.backupSecret.value).toBe('oldpw')
    expect((await diskBag(adapter, dek)).backupPassword).toBe('oldpw')
    expect(await diskVaultJson(adapter, dek)).not.toHaveProperty('backupSecret')
  })

  it('migrateLegacySecrets：明文库/未启用加密/锁定态直接跳过不报错', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await expect(s.migrateLegacySecrets()).resolves.toBeUndefined() // 未启用加密
    await s.enableEncryption('masterpw')
    s.lock()
    await expect(s.migrateLegacySecrets()).resolves.toBeUndefined() // 锁定态
  })
})
