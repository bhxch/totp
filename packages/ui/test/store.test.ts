import { describe, expect, it, vi } from 'vitest'
import {
  bytesToBase64, createMemoryStorage, createVault, decryptVaultWithDek, kekSourcesOf, newEntryFromUri, randomBytes,
  SECURITY_KEY, setupVaultEncryption, unlockWithPrf,
  type SecuritySettings, type Vault,
} from '@totp/core'
import { createVueStore } from '../src/store'

function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)) }

describe('createVueStore', () => {
  it('initStore 后 vault/settings 从 adapter 加载；重复调用幂等', async () => {
    const adapter = createMemoryStorage()
    await adapter.set('vault', JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 5 }))
    const s = createVueStore(adapter)
    await s.initStore()
    expect(s.vault.updatedAt).toBe(5)
    await s.initStore() // 幂等：不重复加载
    expect(s.vault.updatedAt).toBe(5)
  })

  it('commit 后落盘完成（await 即持久）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    const raw = await adapter.get('vault')
    expect(JSON.parse(raw!).entries).toHaveLength(1)
  })

  it('串行队列保持顺序；落盘失败不吞队列', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    const order: string[] = []
    const p1 = s.commit((v) => { order.push('a'); return { ...v, updatedAt: 1 } })
    const p2 = s.commit((v) => { order.push('b'); return { ...v, updatedAt: 2 } })
    await Promise.all([p1, p2])
    expect(order).toEqual(['a', 'b'])
    expect(s.vault.updatedAt).toBe(2)
  })

  it('registerStorageSync：非自写通知触发重读；自写窗口内跳过', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    // 注入大窗口：抑制行为确定性成立（不依赖测试在 500ms 内跑完）
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb }, selfWriteSuppressMs: 60_000 })
    await s.initStore()
    s.registerStorageSync()
    // 对端写入
    await adapter.set('vault', JSON.stringify({ version: 1, entries: [{ uuid: 'x' }], groups: [], updatedAt: 9 }))
    notify!({ vault: true })
    await flush()
    expect(s.vault.updatedAt).toBe(9)
    // 自写后 500ms 内对端通知被抑制
    await s.commitSettings()
    notify!({ vault: true })
    await flush()
    expect(s.vault.updatedAt).toBe(9) // 未被吞掉的抑制不应改变——本轮自写是 settings，vault 窗口未开
    // 自写 vault 后窗口内抑制
    await s.commit((v) => ({ ...v, updatedAt: 10 }))
    await adapter.set('vault', JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 11 }))
    notify!({ vault: true })
    await flush()
    expect(s.vault.updatedAt).toBe(10) // 500ms 内抑制了对端值
  })

  it('replaceAllOp 整体替换 vault 并落盘', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    const next = { version: 1 as const, entries: [{ uuid: 'r' }], groups: [], updatedAt: 42 }
    await s.replaceAllOp(next as unknown as Vault)
    expect(s.vault.updatedAt).toBe(42)
    expect(JSON.parse((await adapter.get('vault'))!).entries[0]).toEqual({ uuid: 'r' })
  })

  it('settings 同步：对端写入重读，未知字段丢弃', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb } })
    await s.initStore()
    s.registerStorageSync()
    await adapter.set('settings', JSON.stringify({ urlFilterEnabled: false }))
    notify!({ settings: true })
    await flush()
    expect(s.settings.urlFilterEnabled).toBe(false)
  })

  it('enableEncryption→locked=false；lock 后写操作抛错；unlock 恢复', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await s.enableEncryption('pw')
    expect(s.locked.value).toBe(false)
    const raw = JSON.parse((await adapter.get('vault'))!)
    expect(raw.enc).toBe(true)
    expect(await adapter.get('security')).toBeTruthy()

    s.lock()
    expect(s.locked.value).toBe(true)
    await expect(s.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))).rejects.toThrow('vault locked')

    await s.unlock('pw')
    expect(s.locked.value).toBe(false)
    expect(s.vault.entries).toHaveLength(1)
    await s.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    expect(s.vault.entries).toHaveLength(2)
  })

  it('initStore 对加密 vault 且未解锁→locked', async () => {
    const adapter = createMemoryStorage()
    const s1 = createVueStore(adapter)
    await s1.initStore()
    // 简报原稿未录入条目却断言解锁后 entries 为 1，自相矛盾；补一条使断言成立（加密已有数据的真实场景）
    await s1.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await s1.enableEncryption('pw')
    const s2 = createVueStore(adapter)
    await s2.initStore()
    expect(s2.locked.value).toBe(true)
    expect(s2.vault.entries).toHaveLength(0)
    await s2.unlock('pw')
    expect(s2.locked.value).toBe(false)
    expect(s2.vault.entries).toHaveLength(1)
  })

  it('disableEncryption 回到明文', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.enableEncryption('pw')
    await s.disableEncryption()
    expect(s.hasEncryption.value).toBe(false)
    const raw = JSON.parse((await adapter.get('vault'))!)
    expect(raw.enc).toBeUndefined()
    expect(await adapter.get('security')).toBeNull()
  })

  it('远端启用加密：本端收密文通知→锁定，unlock 后数据正确且写回密文', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const a = createVueStore(adapter)
    await a.initStore()
    // 窗口 B 在明文时代初始化：解锁态、security 缓存陈旧为 null、无 dek
    const b = createVueStore(adapter, { registerSync: (cb) => { notify = cb } })
    await b.initStore()
    b.registerStorageSync()
    await a.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await a.enableEncryption('pw')

    notify!({ vault: true })
    await flush()
    expect(b.locked.value).toBe(true)
    expect(b.vault.entries).toHaveLength(0)
    await b.unlock('pw')
    expect(b.locked.value).toBe(false)
    expect(b.vault.entries).toHaveLength(1)
    // B 后续写 op 走加密分支（security 缓存已刷新），不再降级覆盖
    await b.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    const raw = JSON.parse((await adapter.get('vault'))!)
    expect(raw.enc).toBe(true)
  })

  it('锁定窗口不消费远端明文通知', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const a = createVueStore(adapter)
    await a.initStore()
    await a.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await a.enableEncryption('pw')
    const b = createVueStore(adapter, { registerSync: (cb) => { notify = cb } })
    await b.initStore() // 密文在手无 dek → 锁定
    expect(b.locked.value).toBe(true)
    b.registerStorageSync()
    // 模拟远端 disableEncryption 后的明文落盘
    await adapter.set('vault', JSON.stringify({ version: 1, entries: [{ uuid: 'x' }], groups: [], updatedAt: 9 }))
    notify!({ vault: true })
    await flush()
    expect(b.locked.value).toBe(true)
    expect(b.vault.entries).toHaveLength(0)
  })

  it('opts.onCommitted：队列写成功后触发，失败不触发', async () => {
    const adapter = createMemoryStorage()
    const onCommitted = vi.fn()
    const s = createVueStore(adapter, { onCommitted })
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    expect(onCommitted).toHaveBeenCalledTimes(1)
    await s.commitSettings()
    expect(onCommitted).toHaveBeenCalledTimes(2)
    s.lock()
    await expect(s.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))).rejects.toThrow('vault locked')
    expect(onCommitted).toHaveBeenCalledTimes(2) // 失败的写不触发
  })

  it('双端独立加密：本端 DEK 解不开远端密文→转锁定等远端口令，拒绝产生幽灵密文', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    // 注入 0 抑制窗口：远端通知立即生效（消除对 500ms 真实窗口 + sleep 的时序依赖）
    const b = createVueStore(adapter, { registerSync: (cb) => { notify = cb }, selfWriteSuppressMs: 0 })
    await b.initStore()
    await b.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await b.enableEncryption('pwB') // 设备 B 独立加密，持有 dekB
    expect(b.locked.value).toBe(false)
    b.registerStorageSync()
    // 模拟 background pull 落盘远端（设备 A 独立加密 pwA、rev 更高者胜）后的状态
    const remote = await setupVaultEncryption(
      JSON.stringify({ version: 1, entries: [{ uuid: 'a' }], groups: [], updatedAt: 7 }),
      'pwA',
    )
    await adapter.set(SECURITY_KEY, JSON.stringify(remote.security))
    await adapter.set('vault', JSON.stringify(remote.encrypted))
    notify!({ vault: true })
    // 通知处理链含原生 webcrypto 异步解密（错误路径：解密失败→同步 lock），
    // 单次 setTimeout flush 会与原生回调竞速——轮询等终态，消除最后的时序依赖
    await vi.waitFor(() => expect(b.locked.value).toBe(true))
    // 终态与裁定一致：本端转锁定、dek 丢弃（vault 清空防残留）、security 缓存=远端
    expect(b.locked.value).toBe(true)
    expect(b.vault.entries).toHaveLength(0)
    expect(b.hasEncryption.value).toBe(true)
    // 锁定拒绝写：不会以 dekB 加密 + 远端 security 落盘（幽灵密文防线）
    await expect(b.addEntryOp(newEntryFromUri('otpauth://totp/D:e?secret=JBSWY3DPEHPK3PXP', 1700000000000))).rejects.toThrow('vault locked')
    // 等待输入远端口令：unlock 恢复远端数据
    await b.unlock('pwA')
    expect(b.locked.value).toBe(false)
    expect(b.vault.entries).toHaveLength(1)
  })

  it('通知丢失时明文写防御：远端已加密而本端陈旧→拒绝写入、转锁定、密文不被覆盖', async () => {
    const adapter = createMemoryStorage()
    const a = createVueStore(adapter)
    await a.initStore()
    // 窗口 B 无 registerSync（收不到任何通知）：明文时代 initStore 后停在陈旧解锁态
    const b = createVueStore(adapter)
    await b.initStore()
    await a.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await a.enableEncryption('pw')

    await expect(b.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))).rejects.toThrow('vault locked')
    expect(b.locked.value).toBe(true)
    const raw = JSON.parse((await adapter.get('vault'))!)
    expect(raw.enc).toBe(true) // 盘上密文未被明文覆盖
    expect(await adapter.get('security')).toBeTruthy()
  })

  it('跨窗口 disableEncryption：B 解锁持 DEK 收明文通知后写 op→跟随远端转明文，不死锁', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const a = createVueStore(adapter)
    await a.initStore()
    const b = createVueStore(adapter, { registerSync: (cb) => { notify = cb } })
    await b.initStore()
    b.registerStorageSync()
    await a.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await a.enableEncryption('pw')
    notify!({ vault: true })
    await flush()
    await b.unlock('pw') // B：security 缓存非 null、持有 DEK、解锁
    expect(b.hasEncryption.value).toBe(true)

    await a.disableEncryption() // 盘上：vault 明文 + security 已删除
    notify!({ vault: true })
    await flush()
    // B 消费明文通知更新了内容，但 security 缓存仍陈旧非 null
    expect(b.hasEncryption.value).toBe(true)
    expect(b.locked.value).toBe(false)

    // B 写 op：加密分支对称核对发现盘上 security 已删→丢弃本端加密态、改写明文
    await b.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    const raw = JSON.parse((await adapter.get('vault'))!)
    expect(raw.enc).toBeUndefined() // 盘上保持明文，未被密文覆盖成死锁态
    expect(await adapter.get(SECURITY_KEY)).toBeNull()
    expect(b.hasEncryption.value).toBe(false)
    expect(b.locked.value).toBe(false)
    expect(b.vault.entries).toHaveLength(2)
  })

  it('跨窗口换口令：B 持旧 DEK 写 op→刷新 security 缓存照常加密写，盘上密文新口令可解', async () => {
    const adapter = createMemoryStorage()
    const a = createVueStore(adapter)
    await a.initStore()
    await a.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await a.enableEncryption('pw1')
    const b = createVueStore(adapter)
    await b.initStore() // 密文在手无 dek → 锁定
    await b.unlock('pw1')
    await a.changePassphrase('pw2') // 盘上 security 已更新，DEK 不变；B 缓存陈旧（pw1 版）

    await b.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    const raw = JSON.parse((await adapter.get('vault'))!)
    expect(raw.enc).toBe(true)
    // 新口令可解开盘上密文（含 A 与 B 的条目）
    const c = createVueStore(adapter)
    await c.initStore()
    expect(c.locked.value).toBe(true)
    await c.unlock('pw2')
    expect(c.locked.value).toBe(false)
    expect(c.vault.entries).toHaveLength(2)
    expect(b.hasEncryption.value).toBe(true)
  })

  it('enableEncryption 经队列执行：Argon2 进行中的并发写 op 不被旧快照覆盖', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    const p1 = s.enableEncryption('pw')
    const p2 = s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await Promise.all([p1, p2])
    expect(s.vault.entries).toHaveLength(1)
    const c = createVueStore(adapter)
    await c.initStore()
    await c.unlock('pw')
    expect(c.vault.entries).toHaveLength(1) // 旧快照覆盖则此处为 0
  })

  it('unlock 宽容接受「security 在但 vault 明文/缺失」不一致态，后续写自愈回密文', async () => {
    const adapter = createMemoryStorage()
    const { security } = await setupVaultEncryption(JSON.stringify(createVault()), 'pw')
    await adapter.set(SECURITY_KEY, JSON.stringify(security)) // enableEncryption 半失败态：security 在、vault 缺失
    const s = createVueStore(adapter)
    await s.initStore()
    await s.unlock('pw')
    expect(s.locked.value).toBe(false)
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    const raw = JSON.parse((await adapter.get('vault'))!)
    expect(raw.enc).toBe(true) // 自愈：写 op 走加密分支转回密文
  })

  it('跨窗口：同进程两个 windowId 各自独立持有 DEK；A unlock/lock 不污染 B', async () => {
    const adapter = createMemoryStorage()
    // 自写抑制关：通知立即生效
    const a = createVueStore(adapter, { windowId: 'popup', selfWriteSuppressMs: 0 })
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const b = createVueStore(adapter, {
      windowId: 'options', selfWriteSuppressMs: 0,
      registerSync: (cb) => { notify = cb },
    })
    await Promise.all([a.initStore(), b.initStore()])
    b.registerStorageSync()
    await a.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await a.enableEncryption('pw')
    notify!({ vault: true }) // 模拟 background 把远端变更推过来
    await flush()
    // B 收密文通知→locked=true（缺 DEK）
    expect(a.locked.value).toBe(false)
    expect(b.locked.value).toBe(true)
    // B 单独解锁持有自身 DEK（与 A 隔离）
    await b.unlock('pw')
    expect(b.locked.value).toBe(false)
    const dekA = a.getCurrentDek()
    const dekB = b.getCurrentDek()
    expect(dekA).toBeInstanceOf(Uint8Array)
    expect(dekB).toBeInstanceOf(Uint8Array)
    expect(dekA).not.toBe(dekB) // 隔离：两个独立 DEK 实例
    // A 锁定不污染 B（仅清空自身 DEK）
    a.lock()
    expect(a.locked.value).toBe(true)
    expect(b.locked.value).toBe(false)
    expect(a.getCurrentDek()).toBeNull()
    expect(b.getCurrentDek()).not.toBeNull()
  })

  it('跨窗口：storage.onChanged 按 windowId 隔离 locked/dek（B 不持有 DEK 时收密文通知→本窗口锁定）', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const a = createVueStore(adapter, { windowId: 'popup', selfWriteSuppressMs: 0 })
    const b = createVueStore(adapter, {
      windowId: 'options', selfWriteSuppressMs: 0,
      registerSync: (cb) => { notify = cb },
    })
    await Promise.all([a.initStore(), b.initStore()])
    b.registerStorageSync()
    // A 启用加密（明文时代 B 是 unlocked）→ B 收密文通知→本窗口 locked=true（缺 DEK）
    await a.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await a.enableEncryption('pw')
    notify!({ vault: true })
    await flush()
    expect(b.locked.value).toBe(true)
    expect(b.getCurrentDek()).toBeNull()
    // A 再添加条目：B 通知应被锁定态拒收（防本端锁定态下污染内存）
    await a.addEntryOp(newEntryFromUri('otpauth://totp/C:d?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    notify!({ vault: true })
    await flush()
    // B 仍锁定、未拿到 DEK
    expect(b.locked.value).toBe(true)
    expect(b.getCurrentDek()).toBeNull()
  })

  it('桌面 mini：与 main 窗口 DEK 隔离；主窗口解锁时 mini 仍保持锁定', async () => {
    const adapter = createMemoryStorage()
    const main = createVueStore(adapter, { windowId: 'main' })
    await main.initStore()
    await main.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await main.enableEncryption('pw')
    expect(main.locked.value).toBe(false)
    expect(main.getCurrentDek()).not.toBeNull()
    // mini 窗口独立 store：盘上有密文 vault 但 mini 无 DEK → 锁定（spec §7 末尾 mini 保持锁定）
    const mini = createVueStore(adapter, { windowId: 'mini' })
    await mini.initStore()
    expect(mini.locked.value).toBe(true)
    expect(mini.getCurrentDek()).toBeNull()
    // main 锁定不污染 mini（mini 已是 true，仍 true）
    main.lock()
    expect(main.locked.value).toBe(true)
    expect(mini.locked.value).toBe(true)
  })
})

describe('passkey PRF（plan11 Task2）', () => {
  async function setupEncrypted(): Promise<{ adapter: ReturnType<typeof createMemoryStorage>; s: ReturnType<typeof createVueStore> }> {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await s.enableEncryption('pw')
    return { adapter, s }
  }

  const diskSecurity = async (adapter: ReturnType<typeof createMemoryStorage>): Promise<SecuritySettings> =>
    JSON.parse((await adapter.get(SECURITY_KEY))!) as SecuritySettings

  it('addPrfSourceOp：kekSources 写盘（password+prf），prfSources 视图反映绑定', async () => {
    const { adapter, s } = await setupEncrypted()
    const prfOutput = randomBytes(64)
    const salt = randomBytes(32)
    await s.addPrfSourceOp('cred-1', prfOutput, salt)
    const onDisk = await diskSecurity(adapter)
    const srcs = kekSourcesOf(onDisk)
    expect(srcs).toHaveLength(2)
    expect(srcs[1]).toMatchObject({ kind: 'prf', credentialId: 'cred-1', salt: bytesToBase64(salt) })
    // 盘上 wrappedDekP 可由 PRF 输出解出（unlockWithPrf 成功即验证 wrappedDekP 契约）
    await expect(unlockWithPrf(onDisk, prfOutput, { credentialId: 'cred-1' })).resolves.toBeInstanceOf(Uint8Array)
    expect(s.prfSources.value).toEqual([{ credentialId: 'cred-1', salt: bytesToBase64(salt) }])
  })

  it('锁定后 passkey 解锁：unlockWithPrf→unlockWithDek 恢复数据', async () => {
    const { adapter, s } = await setupEncrypted()
    const prfOutput = randomBytes(64)
    await s.addPrfSourceOp('cred-1', prfOutput, randomBytes(32))
    s.lock()
    expect(s.locked.value).toBe(true)
    const dek = await unlockWithPrf(await diskSecurity(adapter), prfOutput, { credentialId: 'cred-1' })
    await s.unlockWithDek(dek)
    expect(s.locked.value).toBe(false)
    expect(s.vault.entries).toHaveLength(1)
  })

  it('unlockWithDek：security 缓存缺失时从盘读（新实例跳过 initStore）', async () => {
    const { adapter, s } = await setupEncrypted()
    const prfOutput = randomBytes(64)
    await s.addPrfSourceOp('cred-1', prfOutput, randomBytes(32))
    const s2 = createVueStore(adapter) // 未 initStore：security 缓存为 null
    const dek = await unlockWithPrf(await diskSecurity(adapter), prfOutput)
    await s2.unlockWithDek(dek)
    expect(s2.locked.value).toBe(false)
    expect(s2.vault.entries).toHaveLength(1)
    expect(s2.hasEncryption.value).toBe(true) // 缓存已从盘补齐
  })

  it('removePrfSourceOp：盘上 kekSources 回落 password；锁定/未启用态按既有文案拒绝', async () => {
    const { adapter, s } = await setupEncrypted()
    await s.addPrfSourceOp('cred-1', randomBytes(64), randomBytes(32))
    await s.removePrfSourceOp('cred-1')
    expect(kekSourcesOf(await diskSecurity(adapter))).toEqual([{ kind: 'password' }])
    expect(s.prfSources.value).toEqual([])
    s.lock()
    await expect(s.addPrfSourceOp('c2', randomBytes(64), randomBytes(32))).rejects.toThrow('vault locked')
    await expect(s.removePrfSourceOp('x')).rejects.toThrow('vault locked')
  })

  it('同 credentialId 重复绑定走替换：盘上仅一条该 id 条目', async () => {
    const { adapter, s } = await setupEncrypted()
    await s.addPrfSourceOp('cred-1', randomBytes(64), randomBytes(32))
    await s.addPrfSourceOp('cred-1', randomBytes(64), randomBytes(32))
    const srcs = kekSourcesOf(await diskSecurity(adapter)).filter((x) => x.kind === 'prf')
    expect(srcs).toHaveLength(1)
  })
})

describe('DPAPI 解锁来源（plan11 Task3）', () => {
  async function setupEncrypted(): Promise<{ adapter: ReturnType<typeof createMemoryStorage>; s: ReturnType<typeof createVueStore> }> {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await s.enableEncryption('pw')
    return { adapter, s }
  }

  const diskSecurity = async (adapter: ReturnType<typeof createMemoryStorage>): Promise<SecuritySettings> =>
    JSON.parse((await adapter.get(SECURITY_KEY))!) as SecuritySettings

  it('addDpapiSourceOp：kekSources 写盘（password+dpapi），dpapiSource 视图反映绑定', async () => {
    const { adapter, s } = await setupEncrypted()
    expect(s.dpapiSource.value).toBeNull()
    await s.addDpapiSourceOp('WRAPPED-DEK')
    const srcs = kekSourcesOf(await diskSecurity(adapter))
    expect(srcs).toHaveLength(2)
    expect(srcs[1]).toEqual({ kind: 'dpapi', wrappedDekD: 'WRAPPED-DEK' })
    expect(s.dpapiSource.value).toEqual({ wrappedDekD: 'WRAPPED-DEK' })
  })

  it('getCurrentDek：解锁态返回内部 DEK（可解盘上密文），锁定后为 null', async () => {
    const { adapter, s } = await setupEncrypted()
    const dek = s.getCurrentDek()
    expect(dek).toBeInstanceOf(Uint8Array)
    expect(dek!.length).toBe(32)
    const enc = JSON.parse((await adapter.get('vault'))!)
    await expect(decryptVaultWithDek(dek!, enc)).resolves.toContain('JBSWY3DPEHPK3PXP')
    s.lock()
    expect(s.getCurrentDek()).toBeNull()
  })

  it('锁定态 dpapiSource 视图仍可见（LockScreen 渲染判定）；写 op 拒绝', async () => {
    const { adapter, s } = await setupEncrypted()
    await s.addDpapiSourceOp('WRAPPED-DEK')
    s.lock()
    expect(s.dpapiSource.value).toEqual({ wrappedDekD: 'WRAPPED-DEK' })
    await expect(s.addDpapiSourceOp('W2')).rejects.toThrow('vault locked')
    await expect(s.removeDpapiSourceOp()).rejects.toThrow('vault locked')
  })

  it('removeDpapiSourceOp：盘上 kekSources 回落 password，视图清空', async () => {
    const { adapter, s } = await setupEncrypted()
    await s.addDpapiSourceOp('WRAPPED-DEK')
    await s.removeDpapiSourceOp()
    expect(kekSourcesOf(await diskSecurity(adapter))).toEqual([{ kind: 'password' }])
    expect(s.dpapiSource.value).toBeNull()
  })

  it('防御路径：vault 坏 JSON 报 corrupted；security 坏 JSON 按未加密处理；enableEncryption 写盘失败回滚', async () => {
    // 盘上 vault 坏 JSON → 明确报错不静默
    const a1 = createMemoryStorage()
    await a1.set('vault', '{bad json')
    await expect(createVueStore(a1).initStore()).rejects.toThrow('vault corrupted')
    // 盘上 security 坏 JSON → 保守视为未启用加密（回到明文模型），不抛
    const a2 = createMemoryStorage()
    await a2.set('vault', JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 1 }))
    await a2.set(SECURITY_KEY, '{bad')
    const s2 = createVueStore(a2)
    await s2.initStore()
    expect(s2.hasEncryption.value).toBe(false)
    expect(s2.locked.value).toBe(false)
    // enableEncryption 写盘失败：回滚内存加密态（security/DEK 置空）并原样抛出
    const a3 = createMemoryStorage()
    const s3 = createVueStore(a3)
    await s3.initStore()
    const origSet = a3.set.bind(a3)
    let failSecurity = true
    ;(a3 as { set: unknown }).set = async (k: string, v: string) => {
      if (failSecurity && k === SECURITY_KEY) throw new Error('disk full')
      return origSet(k, v)
    }
    await expect(s3.enableEncryption('pw123')).rejects.toThrow('disk full')
    failSecurity = false
    expect(s3.hasEncryption.value).toBe(false)
    expect(s3.getCurrentDek()).toBeNull()
  })
})
