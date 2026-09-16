import { describe, expect, it } from 'vitest'
import {
  createMemoryStorage, decryptVaultWithDek, randomBytes, SECURITY_KEY, unlockWithPrf,
  type SecuritySettings,
} from '@totp/core'
import { createVueStore } from '../src/store'

/** 会话备份口令（设计 D1）：会话态按窗口隔离、remember 守护入库、解锁自动装载、replaceVault 字段保留 */
describe('store backupSecret（D1）', () => {
  const diskSecurity = async (adapter: ReturnType<typeof createMemoryStorage>): Promise<SecuritySettings> =>
    JSON.parse((await adapter.get(SECURITY_KEY))!) as SecuritySettings

  /** 加密库上盘断言：解开盘上密文校验 backupSecret 字段 */
  const diskBackupSecret = async (
    adapter: ReturnType<typeof createMemoryStorage>,
    dek: Uint8Array,
  ): Promise<string | undefined> => {
    const enc = JSON.parse((await adapter.get('vault'))!)
    return JSON.parse(await decryptVaultWithDek(dek, enc)).backupSecret
  }

  it('replaceVault 保留 backupSecret 字段（commit 写入不清空）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.commit((v) => ({ ...v, backupSecret: 'pw' }))
    expect(s.vault.backupSecret).toBe('pw')
  })

  it('replaceVault 清除语义：源无字段（显式 undefined）时目标字段被删除且盘上无残留', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.commit((v) => ({ ...v, backupSecret: 'pw' }))
    // 注：{ ...v } 展开 reactive vault 会带上既有字段，「源无字段」须显式置 undefined
    await s.commit((v) => ({ ...v, backupSecret: undefined }))
    expect(s.vault.backupSecret).toBeUndefined()
    expect(JSON.parse((await adapter.get('vault'))!).backupSecret).toBeUndefined()
  })

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

  it('未启用加密 + remember=true：抛「需先启用加密」；会话生效但不入库', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await expect(s.setBackupSecret('pw', true)).rejects.toThrow('需先启用加密才能记住备份口令')
    expect(s.backupSecret.value).toBe('pw') // 会话已置（无论 remember）
    expect(s.vault.backupSecret).toBeUndefined()
    expect(await adapter.get('vault')).toBeNull() // 未触发任何落盘
  })

  it('锁定 + remember=true：抛「解锁后才能记住」；会话生效但不入库', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    s.lock()
    await expect(s.setBackupSecret('pw', true)).rejects.toThrow('解锁后才能记住备份口令')
    expect(s.backupSecret.value).toBe('pw') // 会话已置
    await s.unlock('masterpw') // 解锁装载盘上 vault：其中不该有字段
    expect(s.vault.backupSecret).toBeUndefined()
  })

  it('启用+解锁 remember=true：vault 有字段且随密文落盘；lock→unlock 后会话自动装载', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    expect(s.backupSecret.value).toBe('pw')
    expect(s.vault.backupSecret).toBe('pw')
    expect(await diskBackupSecret(adapter, s.getCurrentDek()!)).toBe('pw') // 随 DEK 密文落盘
    s.lock()
    expect(s.backupSecret.value).toBeNull()
    await s.unlock('masterpw')
    expect(s.backupSecret.value).toBe('pw') // 解锁自动装载
    expect(s.vault.backupSecret).toBe('pw')
  })

  it('remember=false：会话生效、内存与盘上 vault 均无字段', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', false)
    expect(s.backupSecret.value).toBe('pw')
    expect(s.vault.backupSecret).toBeUndefined()
    expect(await diskBackupSecret(adapter, s.getCurrentDek()!)).toBeUndefined()
  })

  it('forgetBackupSecret：清会话 + 清库内字段（盘上密文同步清除）；锁定态只清会话不报错', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    await s.forgetBackupSecret()
    expect(s.backupSecret.value).toBeNull()
    expect(s.vault.backupSecret).toBeUndefined()
    expect(await diskBackupSecret(adapter, s.getCurrentDek()!)).toBeUndefined()
    // 锁定态：只清会话，不抛错
    s.lock()
    await s.setBackupSecret('x', false)
    await s.forgetBackupSecret()
    expect(s.backupSecret.value).toBeNull()
  })

  it('lock 清会话', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.setBackupSecret('pw', false)
    expect(s.backupSecret.value).toBe('pw')
    s.lock()
    expect(s.backupSecret.value).toBeNull()
  })

  it('disableEncryption：明文库禁存口令（先记住后关 / 会话有值但库无字段 两态均清会话）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    // 态 1：先记住后关加密
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    await s.disableEncryption()
    expect(s.backupSecret.value).toBeNull()
    expect(s.vault.backupSecret).toBeUndefined()
    const raw = JSON.parse((await adapter.get('vault'))!)
    expect(raw.enc).toBeUndefined() // 已回明文
    expect(raw.backupSecret).toBeUndefined() // 明文库无字段
    // 态 2：会话有值但库无字段（remember=false 后关加密）
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw2', false)
    await s.disableEncryption()
    expect(s.backupSecret.value).toBeNull()
    expect(JSON.parse((await adapter.get('vault'))!).backupSecret).toBeUndefined()
  })

  it('unlockWithDek（PRF）路径解锁后同样自动装载', async () => {
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

  it('initStore 重建（同窗口已持 DEK，如刷新/重建 store）：直接解密填充并装载会话口令', async () => {
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
    expect(b.backupSecret.value).toBe('pw') // 解密填充时同步装载库内口令
    expect(b.vault.groups).toEqual(s.vault.groups)
  })
})
