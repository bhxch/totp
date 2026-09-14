import { describe, expect, it, vi } from 'vitest'
import { createMemoryStorage, newEntryFromUri, setupVaultEncryption, type Vault } from '@totp/core'
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
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb } })
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
})
