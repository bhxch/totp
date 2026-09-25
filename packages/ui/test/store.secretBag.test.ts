import { describe, expect, it, vi } from 'vitest'
import {
  createMemoryStorage, decryptVaultWithDek, encryptVaultWithDek, newEntryFromUri, openSecretBag, randomBytes,
  sealSecretBag, SECRET_BAG_KEY, SECURITY_KEY, SECURITY_PENDING_KEY, VAULT_KEY, bytesToBase64, base64ToBytes,
  type CloudCred, type SecuritySettings, type StorageAdapter, type Vault,
} from '@totp/core'
import { createVueStore } from '../src/store'

/** DEK 保管区接线（设计 §1，plan16 T7）：remember 存保管区、凭据密封、DEK 持久化 set/clear 时机、
 *  initStore 会话内自动恢复、口令轮换全库重加密+保管区重封、遗留迁移幂等 */
describe('store secretBag', () => {
  const diskSecurity = async (adapter: ReturnType<typeof createMemoryStorage>): Promise<SecuritySettings> =>
    JSON.parse((await adapter.get(SECURITY_KEY))!) as SecuritySettings

  const diskBag = async (adapter: StorageAdapter, dek: Uint8Array) =>
    openSecretBag(dek, await adapter.get(SECRET_BAG_KEY))

  /** 计数适配器：统计 set 调用次数（迁移幂等「二次调用无写盘」断言用） */
  function countingAdapter(base: StorageAdapter): { adapter: StorageAdapter; sets: () => number } {
    let n = 0
    return {
      adapter: {
        get: (key) => base.get(key),
        set: async (key, value) => { n++; await base.set(key, value) },
        delete: (key) => base.delete(key),
      },
      sets: () => n,
    }
  }

  /** fake dekPersist（宿主会话存储）：记录调用顺序与持久化值，验证 set/clear 时机 */
  function fakeDekPersist() {
    let stored: string | null = null
    const calls: string[] = []
    return {
      calls,
      value: () => stored,
      get: async (): Promise<string | null> => stored,
      set: async (dek: Uint8Array) => { calls.push('set'); stored = bytesToBase64(dek) },
      clear: async () => { calls.push('clear'); stored = null },
    }
  }

  const webdavCred: CloudCred = { backend: 'webdav', serverUrl: 'https://d.example', username: 'u', password: 'p' }

  /** 微任务刷新：void 掉的 dekPersist.set/clear 均为即时微任务，一拍 setTimeout 足以落定 */
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0))
  }

  it('解锁后 setBackupSecret(remember=true)：adapter 出现 secretBag 键且 vault 密文解出后无 backupSecret 字段', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    const raw = await adapter.get(SECRET_BAG_KEY)
    expect(raw).not.toBeNull()
    const dek = s.getCurrentDek()!
    expect((await diskBag(adapter, dek)).backupPassword).toBe('pw')
    const enc = JSON.parse((await adapter.get('vault'))!)
    const vaultJson = JSON.parse(await decryptVaultWithDek(dek, enc)) as Record<string, unknown>
    expect(vaultJson).not.toHaveProperty('backupSecret')
  })

  it('lock→unlock 后 backupSecret 自动恢复（保管区随 DEK 解密封）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    s.lock()
    expect(s.backupSecret.value).toBeNull()
    await s.unlock('masterpw')
    expect(s.backupSecret.value).toBe('pw')
    expect(s.bagStored.value).toBe(true)
  })

  it('未启用加密 remember=true 报中文错且不落任何键；锁定态报「解锁后才能记住」', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await expect(s.setBackupSecret('pw', true)).rejects.toThrow('需先启用加密才能记住备份口令')
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull()
    await s.enableEncryption('masterpw')
    s.lock()
    await expect(s.setBackupSecret('pw', true)).rejects.toThrow('解锁后才能记住备份口令')
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull()
  })

  it('saveSourceCredOp/removeSourceCredOp：密封写盘 + credsCache 刷新 + lock 后拒绝；未启用加密报中文错', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    // 未启用加密：中文守护
    await expect(s.saveSourceCredOp('src-1', webdavCred)).rejects.toThrow('需先启用加密才能保存云凭据')
    await expect(s.removeSourceCredOp('src-1')).rejects.toThrow('需先启用加密才能保存云凭据')
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull()
    await s.enableEncryption('masterpw')
    const dek = s.getCurrentDek()!
    // 保存 → 缓存与盘上保管区同步出现
    await s.saveSourceCredOp('src-1', webdavCred)
    expect(s.credsCache.value['src-1']).toEqual(webdavCred)
    expect((await diskBag(adapter, dek)).creds['src-1']).toEqual(webdavCred)
    // 更新（覆盖语义）→ 删除
    const updated = { ...webdavCred, password: 'p2' }
    await s.saveSourceCredOp('src-1', updated)
    expect(s.credsCache.value['src-1']).toEqual(updated)
    await s.saveSourceCredOp('src-2', webdavCred)
    await s.removeSourceCredOp('src-1')
    expect(s.credsCache.value['src-1']).toBeUndefined()
    expect(s.credsCache.value['src-2']).toEqual(webdavCred)
    expect((await diskBag(adapter, dek)).creds['src-1']).toBeUndefined()
    // lock 后拒绝：保管区密文仍留盘（解锁后可再装载），但写 op 守护拦截
    s.lock()
    expect(await adapter.get(SECRET_BAG_KEY)).not.toBeNull()
    await expect(s.saveSourceCredOp('src-3', webdavCred)).rejects.toThrow('vault locked')
    await expect(s.removeSourceCredOp('src-2')).rejects.toThrow('vault locked')
  })

  it('disableEncryption：删保管区键 + credsCache/会话清空', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.saveSourceCredOp('src-1', webdavCred)
    await s.setBackupSecret('pw', true)
    expect(await adapter.get(SECRET_BAG_KEY)).not.toBeNull()
    await s.disableEncryption()
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull()
    expect(s.credsCache.value).toEqual({})
    expect(s.backupSecret.value).toBeNull()
    expect(s.bagStored.value).toBe(false)
  })

  it('changePassphrase 默认轮换：旧 DEK 解不开新密文、保管区仍可解、backupSecret 会话保留', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('bpw', true)
    await s.saveSourceCredOp('src-1', webdavCred)
    const oldDek = s.getCurrentDek()!
    await s.changePassphrase('newpw')
    const newDek = s.getCurrentDek()!
    expect(newDek).not.toBeNull()
    // 旧 DEK 解不开新 vault 密文（DEK 已轮换）
    const enc = JSON.parse((await adapter.get('vault'))!)
    await expect(decryptVaultWithDek(oldDek, enc)).rejects.toThrow()
    // 新口令可解（经盘上 security 解 wrap）→ 全库内容保留
    const b = createVueStore(adapter)
    await b.initStore()
    expect(b.locked.value).toBe(true)
    await b.unlock('newpw')
    expect(b.locked.value).toBe(false)
    expect(b.backupSecret.value).toBe('bpw') // 保管区已随新 DEK 重封，解锁装载
    expect(b.credsCache.value['src-1']).toEqual(webdavCred)
    // 本窗口会话保留：轮换不清会话
    expect(s.backupSecret.value).toBe('bpw')
    // 盘上保管区可被新 DEK 解开、旧 DEK 解不开
    const bagRaw = (await adapter.get(SECRET_BAG_KEY))!
    expect((await openSecretBag(newDek!, bagRaw)).backupPassword).toBe('bpw')
    await expect(openSecretBag(oldDek, bagRaw)).rejects.toThrow()
    // 盘上 security 已指向新口令，旧口令无法解锁
    await expect(b2Unlock(adapter)).rejects.toThrow()
    async function b2Unlock(a: ReturnType<typeof createMemoryStorage>): Promise<void> {
      const c = createVueStore(a)
      await c.initStore()
      await c.unlock('masterpw')
    }
  })

  it('changePassphrase rotateDek=false：DEK 不变仅重包裹（数据不重加密）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    const oldDek = s.getCurrentDek()!
    await s.changePassphrase('newpw', { rotateDek: false })
    expect(s.getCurrentDek()).toBe(oldDek)
    const enc = JSON.parse((await adapter.get('vault'))!)
    expect(await decryptVaultWithDek(oldDek, enc)).toBeDefined() // 旧 DEK 仍可解
  })

  it('changePassphrase 显式 rotateDek: undefined 不静默关闭轮换（默认仍 true）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    const oldDek = s.getCurrentDek()!
    await s.changePassphrase('newpw', { rotateDek: undefined, profile: undefined })
    expect(s.getCurrentDek()).not.toBe(oldDek) // DEK 已轮换
    const enc = JSON.parse((await adapter.get('vault'))!)
    await expect(decryptVaultWithDek(oldDek, enc)).rejects.toThrow() // 旧 DEK 解不开新密文
  })

  // ---- F12 回归：staged 轮换的故障注入（不变量：任一失败点，盘上要么完整旧态，要么 PENDING 在场） ----

  /** 故障注入适配器：arm(key) 后该键的下一次 set/delete 抛错（一次性），其余透传 memory 适配器 */
  function flakyAdapter(base: StorageAdapter): { adapter: StorageAdapter; arm: (key: string) => void } {
    const armed = new Set<string>()
    return {
      adapter: {
        get: (key) => base.get(key),
        set: async (key, value) => {
          if (armed.has(key)) {
            armed.delete(key)
            throw new Error(`injected io failure: ${key}`)
          }
          await base.set(key, value)
        },
        delete: async (key) => {
          if (armed.has(key)) {
            armed.delete(key)
            throw new Error(`injected io failure: ${key}`)
          }
          await base.delete(key)
        },
      },
      arm: (key) => { armed.add(key) },
    }
  }

  it('F12 回归①保管区重封失败（vault 已换新 DEK）：PENDING 保留，新口令解锁补完轮换，旧口令自此失效', async () => {
    const base = createMemoryStorage()
    const { adapter, arm } = flakyAdapter(base)
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await s.enableEncryption('oldpw')
    arm(SECRET_BAG_KEY) // 精确命中 staged ③ 保管区重封（vault 重写已成功之后）
    await expect(s.changePassphrase('newpw')).rejects.toThrow('injected io failure')
    // 不变量：vault 已重写但 SECURITY_KEY 未转正，PENDING 必须在场（清了即锁死）
    const pending = JSON.parse((await adapter.get(SECURITY_PENDING_KEY))!) as SecuritySettings
    expect(pending.wrappedDek).toBeTruthy()
    const diskSec = JSON.parse((await adapter.get(SECURITY_KEY))!) as SecuritySettings
    expect(diskSec.wrappedDek).not.toBe(pending.wrappedDek)
    // 中间态下旧口令不解 vault（已新 DEK 密文），恢复路径不得吞删 PENDING
    s.lock()
    await expect(s.unlock('oldpw')).rejects.toThrow()
    expect(await adapter.get(SECURITY_PENDING_KEY)).not.toBeNull()
    // 新口令解锁：GCM 证明通过 → 转正 + 清 PENDING + 解锁，数据完整
    await s.unlock('newpw')
    expect(s.locked.value).toBe(false)
    expect(s.vault.entries).toHaveLength(1)
    expect(await adapter.get(SECURITY_PENDING_KEY)).toBeNull()
    // 转正已落盘：新实例旧口令拒绝、新口令解锁且条目保留
    const b = createVueStore(adapter)
    await b.initStore()
    expect(b.locked.value).toBe(true)
    await expect(b.unlock('oldpw')).rejects.toThrow()
    await b.unlock('newpw')
    expect(b.locked.value).toBe(false)
    expect(b.vault.entries).toHaveLength(1)
  })

  it('F12 回归②vault 重写失败：PENDING 清除回滚完整旧态，旧口令解锁、新口令未生效', async () => {
    const base = createMemoryStorage()
    const { adapter, arm } = flakyAdapter(base)
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await s.enableEncryption('oldpw')
    arm(VAULT_KEY) // 精确命中 staged ② 全库重加密（旧 SECURITY_KEY 尚完整有效）
    await expect(s.changePassphrase('newpw')).rejects.toThrow('injected io failure')
    // 回滚不变量：vault 未被改写，PENDING 已清——盘上为完整旧态
    expect(await adapter.get(SECURITY_PENDING_KEY)).toBeNull()
    s.lock()
    await s.unlock('oldpw')
    expect(s.locked.value).toBe(false)
    expect(s.vault.entries).toHaveLength(1)
    // 新口令未生效：解锁拒绝（轮换已完整回滚）
    const b = createVueStore(adapter)
    await b.initStore()
    await expect(b.unlock('newpw')).rejects.toThrow()
    await b.unlock('oldpw')
    expect(b.vault.entries).toHaveLength(1)
  })

  it('migrateLegacySecrets 幂等：首次迁移写盘（保管区+密文剥除），二次调用零写盘', async () => {
    const base = createMemoryStorage()
    const { adapter, sets } = countingAdapter(base)
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('masterpw')
    const dek = s.getCurrentDek()!
    // 遗留密文（T2 前旧库形态：vault JSON 带 backupSecret）
    const legacyVault: Vault & { backupSecret: string } = { version: 2, entries: [], tags: [], updatedAt: 1, backupSecret: 'oldpw' }
    await adapter.set('vault', JSON.stringify(await encryptVaultWithDek(dek, JSON.stringify(legacyVault))))
    s.lock()
    const before = sets()
    await s.unlock('masterpw') // unlock 本身有写盘吗？无（只读盘），但保守记录基线
    await s.migrateLegacySecrets()
    const afterFirst = sets()
    expect(afterFirst).toBeGreaterThan(before) // 首次迁移：保管区写入 + 密文剥除落盘
    expect(s.backupSecret.value).toBe('oldpw')
    expect((await diskBag(adapter, dek)).backupPassword).toBe('oldpw')
    const enc = JSON.parse((await adapter.get('vault'))!)
    expect(JSON.parse(await decryptVaultWithDek(dek, enc))).not.toHaveProperty('backupSecret')
    // 二次调用：盘上无字段 → 两个分支均不触发 → 零写盘
    await s.migrateLegacySecrets()
    expect(sets()).toBe(afterFirst)
  })

  it('dekPersist：解锁写、锁定清；initStore 经持久化 DEK 自动恢复（含口令/保管区装载）', async () => {
    const adapter = createMemoryStorage()
    const persist = fakeDekPersist()
    const s = createVueStore(adapter, { dekPersist: persist })
    await s.initStore()
    await s.enableEncryption('masterpw')
    await s.setBackupSecret('pw', true)
    await flush()
    expect(persist.calls).toEqual(['set']) // 解锁即写
    const persistedDek = base64ToBytes(persist.value()!)
    expect(persistedDek).toEqual(s.getCurrentDek()!)
    // lock：清持久化 → 清后 get 为 null
    s.lock()
    await flush()
    expect(persist.calls).toEqual(['set', 'clear'])
    expect(persist.value()).toBeNull()
    // 重新解锁（写持久化）→ 新 store 实例 initStore 自动恢复进解锁态
    await s.unlock('masterpw')
    await flush()
    expect(persist.calls).toEqual(['set', 'clear', 'set'])
    const b = createVueStore(adapter, { dekPersist: persist })
    await b.initStore()
    expect(b.locked.value).toBe(false) // 会话内自动恢复
    expect(b.backupSecret.value).toBe('pw') // 保管区同步装载
    // 持久化 DEK 失效（换库密文）：initStore 回落锁定态并清持久化
    persist.set(randomBytes(32)) // 写入错误 DEK
    const c = createVueStore(adapter, { dekPersist: persist })
    await c.initStore()
    expect(c.locked.value).toBe(true)
    await flush()
    expect(persist.calls[persist.calls.length - 1]).toBe('clear')
  })

  it('dekPersist 轮换后更新：changePassphrase 默认轮换把新 DEK 写入持久化', async () => {
    const adapter = createMemoryStorage()
    const persist = fakeDekPersist()
    const s = createVueStore(adapter, { dekPersist: persist })
    await s.initStore()
    await s.enableEncryption('masterpw')
    await flush()
    const oldPersisted = persist.value()
    await s.changePassphrase('newpw')
    await flush()
    expect(persist.value()).not.toBeNull()
    expect(persist.value()).not.toBe(oldPersisted) // 新 DEK 已持久化
    expect(base64ToBytes(persist.value()!)).toEqual(s.getCurrentDek()!)
  })

  // ---- 审查 I7：secretBag 跨上下文变更感知 ----

  /** 多拍静置：忽略/抑制类断言前给 reload 的 crypto 异步链路充分时间被证明「未发生」 */
  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
  }

  /** 模拟远端上下文写入保管区：以 store 当前 DEK 封存一份新 bag 密文落盘（sealSecretBag 返回值即落盘原文，等价另一页写入） */
  async function writeRemoteBag(adapter: StorageAdapter, dek: Uint8Array, content: { backupPassword?: string; creds?: Record<string, CloudCred> }): Promise<void> {
    await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dek, { backupPassword: content.backupPassword ?? '', creds: content.creds ?? {} }))
  }

  it('I7-①解锁态远端变更重读生效：notify(secretBag) 后 credsCache/会话口令前进到远端内容', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { secretBag?: boolean }) => void) | null = null
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb }, selfWriteSuppressMs: 0 })
    await s.initStore()
    s.registerStorageSync()
    await s.enableEncryption('masterpw')
    await s.saveSourceCredOp('src-1', webdavCred)
    expect(s.credsCache.value['src-1']).toEqual(webdavCred)

    const dek = s.getCurrentDek()!
    const gistCred: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }
    // 远端覆盖 bag：src-1 凭据更新 + 新增 src-2 + 备份口令变化
    await writeRemoteBag(adapter, dek, { backupPassword: 'remote-pw', creds: { 'src-1': { ...webdavCred, password: 'p-remote' }, 'src-2': gistCred } })
    notify!({ secretBag: true })
    await vi.waitFor(() =>
      expect(s.credsCache.value).toEqual({ 'src-1': { ...webdavCred, password: 'p-remote' }, 'src-2': gistCred }),
    )
    expect(s.backupSecret.value).toBe('remote-pw')
    expect(s.bagStored.value).toBe(true)
  })

  it('I7-②锁定态远端变更忽略：bag 缓存保持空、会话口令不复活', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { secretBag?: boolean }) => void) | null = null
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb }, selfWriteSuppressMs: 0 })
    await s.initStore()
    s.registerStorageSync()
    await s.enableEncryption('masterpw')
    const dek = s.getCurrentDek()!
    s.lock()
    expect(s.locked.value).toBe(true)
    // 锁定后远端写入 bag 并通知：锁定态不消费（bag 缓存与 DEK 同生命周期，解锁路径重装载）
    await writeRemoteBag(adapter, dek, { backupPassword: 'remote-pw', creds: { 'src-1': webdavCred } })
    notify!({ secretBag: true })
    await settle()
    expect(s.credsCache.value).toEqual({})
    expect(s.backupSecret.value).toBeNull()
    expect(s.bagStored.value).toBe(false)
    // 解锁后经 applyDekAndUnlock 装载远端内容（远端变更不丢失）
    await s.unlock('masterpw')
    expect(s.credsCache.value['src-1']).toEqual(webdavCred)
  })

  it('I7-③自写抑制：本端写保管区后窗口内的通知不触发重读（自己刚写的内容不回读覆盖内存）', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { secretBag?: boolean }) => void) | null = null
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb }, selfWriteSuppressMs: 60_000 })
    await s.initStore()
    s.registerStorageSync()
    await s.enableEncryption('masterpw')
    await s.saveSourceCredOp('src-1', webdavCred)
    // 自写后窗口内：改盘上 bag（模拟窗口内到达的回声+他端交错写）再通知 → 被抑制，内存不被盘上内容覆盖
    const dek = s.getCurrentDek()!
    const gistCred: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }
    await writeRemoteBag(adapter, dek, { creds: { 'src-2': gistCred } })
    notify!({ secretBag: true })
    await settle()
    expect(s.credsCache.value).toEqual({ 'src-1': webdavCred }) // 未被远端内容覆盖
  })

  it('I7-④saveSourceCredOp/removeSourceCredOp/setBackupSecret(remember)/forget 写盘均开自写窗口', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { secretBag?: boolean }) => void) | null = null
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb }, selfWriteSuppressMs: 60_000 })
    await s.initStore()
    s.registerStorageSync()
    await s.enableEncryption('masterpw')
    const dek = s.getCurrentDek()!
    const gistCred: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }
    // 每个写路径后：盘上换成远端内容 → 通知应被抑制（内存保持本端状态）
    await s.setBackupSecret('bpw', true)
    await writeRemoteBag(adapter, dek, { creds: { 'src-2': gistCred } })
    notify!({ secretBag: true })
    await flush()
    expect(s.backupSecret.value).toBe('bpw') // 未被远端（无口令）覆盖
    expect(s.credsCache.value['src-2']).toBeUndefined()

    await s.saveSourceCredOp('src-1', webdavCred)
    await writeRemoteBag(adapter, dek, { creds: { 'src-9': gistCred } })
    notify!({ secretBag: true })
    await flush()
    expect(s.credsCache.value['src-9']).toBeUndefined()

    await s.removeSourceCredOp('src-1')
    await writeRemoteBag(adapter, dek, { creds: { 'src-9': gistCred } })
    notify!({ secretBag: true })
    await flush()
    expect(s.credsCache.value['src-9']).toBeUndefined()

    await s.forgetBackupSecret()
    await writeRemoteBag(adapter, dek, { backupPassword: 'remote', creds: {} })
    notify!({ secretBag: true })
    await flush()
    expect(s.backupSecret.value).toBeNull() // 未被远端口令复活
    expect(s.bagStored.value).toBe(false)
  })

  it('I7-⑤reloadBagFromDisk 直接调用：解锁态生效；未启用加密（无 DEK）忽略不抛', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    // 未启用加密：无 DEK，直接调用应安全忽略
    await expect(s.reloadBagFromDisk()).resolves.toBeUndefined()
    expect(s.credsCache.value).toEqual({})
    // 解锁态：写远端 bag 后直接调用生效
    await s.enableEncryption('masterpw')
    const dek = s.getCurrentDek()!
    const gistCred: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }
    await writeRemoteBag(adapter, dek, { creds: { 'src-2': gistCred } })
    await s.reloadBagFromDisk()
    expect(s.credsCache.value['src-2']).toEqual(gistCred)
  })
})

describe('store 双窗口惰性 ref 缓存（currentXxxRef 分支）', () => {
  it('同一 store 重复读取 locked/backupSecret：首访建缓存、再访命中同一 ref（!r 两向覆盖）', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    const locked0 = s.locked.value
    const locked0Again = s.locked.value // 第二次读取命中缓存分支
    expect(locked0Again).toBe(locked0)
    const secret0 = s.backupSecret.value
    const secret0Again = s.backupSecret.value
    expect(secret0Again).toBe(secret0)
    // 锁定后缓存 ref 被更新而非重建：视图自动跟随（响应式契约）
    s.lock()
    expect(s.locked.value).toBe(true)
    expect(s.backupSecret.value).toBeNull()
  })
})
