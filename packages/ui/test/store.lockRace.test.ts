import { describe, expect, it, vi } from 'vitest'
import { bytesToBase64, createMemoryStorage, newEntryFromUri, SECURITY_KEY, VAULT_KEY } from '@totp/core'
import { createVueStore } from '../src/store'

// F7 竞态测试：core 的 Argon2 派生函数无注入缝，经 vi.mock 包一层可闸停的透传，
// 让 lock() 能精确插进「派生 await 窗口」——未闸停时完全透传，其余 core 导出原样保留
const gates = vi.hoisted(() => {
  function makeGate() {
    let open: Promise<void> = Promise.resolve()
    let release: () => void = () => {}
    return {
      hold(): void { open = new Promise<void>((r) => { release = r }) },
      pass(): void { release() },
      wait: () => open,
    }
  }
  return { setup: makeGate(), change: makeGate(), unlock: makeGate() }
})

vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  const gated = <A extends unknown[], R>(gate: { wait: () => Promise<void> }, real: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await gate.wait()
      return real(...args)
    }
  return {
    ...actual,
    setupVaultEncryption: gated(gates.setup, actual.setupVaultEncryption),
    changeVaultPassphrase: gated(gates.change, actual.changeVaultPassphrase),
    unlockVaultEncryption: gated(gates.unlock, actual.unlockVaultEncryption),
  }
})

function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)) }

/** 会话级 DEK 持久化测试替身（dekPersist 宿主契约：get/set/clear，与 chrome.storage.session 同形） */
function makeDekPersist() {
  let value: string | null = null
  return {
    get: async () => value,
    set: async (dek: Uint8Array) => { value = bytesToBase64(dek) },
    clear: async () => { value = null },
  }
}

const URI = 'otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP'

describe('锁定代数（F7）：lock() 插进长 await 窗口时续延必须中止', () => {
  it('enableEncryption：Argon2 await 期间 lock() → 抛错中止，security/密文均未写盘，DEK 未持久化，保持锁定', async () => {
    const adapter = createMemoryStorage()
    const persist = makeDekPersist()
    const s = createVueStore(adapter, { dekPersist: persist })
    await s.initStore()
    await s.addEntryOp(newEntryFromUri(URI, 1700000000000))
    gates.setup.hold()
    const p = s.enableEncryption('pw')
    await flush() // enableEncryption 已进入被闸住的派生 await
    s.lock()
    gates.setup.pass()
    await expect(p).rejects.toThrow('vault locked during operation')
    expect(s.locked.value).toBe(true)
    expect(await adapter.get(SECURITY_KEY)).toBeNull() // security 未写盘
    const raw = JSON.parse((await adapter.get(VAULT_KEY))!)
    expect(raw.enc).toBeUndefined() // vault 仍明文，未被密文覆盖
    expect(await persist.get()).toBeNull() // DEK 未持久化
  })

  it('changePassphrase：派生 await 期间 lock() → 抛错中止，盘上无半迁移（旧 security/旧密文原样），旧口令仍可解锁', async () => {
    const adapter = createMemoryStorage()
    const persist = makeDekPersist()
    const s = createVueStore(adapter, { dekPersist: persist })
    await s.initStore()
    await s.addEntryOp(newEntryFromUri(URI, 1700000000000))
    await s.enableEncryption('old')
    const securityBefore = await adapter.get(SECURITY_KEY)
    const vaultBefore = await adapter.get(VAULT_KEY)
    gates.change.hold()
    const p = s.changePassphrase('new')
    await flush()
    s.lock()
    gates.change.pass()
    await expect(p).rejects.toThrow('vault locked during operation')
    expect(s.locked.value).toBe(true)
    expect(await adapter.get(SECURITY_KEY)).toBe(securityBefore) // 新 security 未落盘
    expect(await adapter.get(VAULT_KEY)).toBe(vaultBefore) // 新 DEK 密文未落盘
    expect(await persist.get()).toBeNull() // lock 已清持久化，中止续延未重写
    await s.unlock('old') // 旧口令仍解锁且数据完整 → 无半迁移
    expect(s.locked.value).toBe(false)
    expect(s.vault.entries).toHaveLength(1)
  })

  it('unlock：派生 await 期间再次 lock() → 抛错中止，不重挂 DEK、不持久化、保持锁定', async () => {
    const adapter = createMemoryStorage()
    const persist = makeDekPersist()
    const s = createVueStore(adapter, { dekPersist: persist })
    await s.initStore()
    await s.addEntryOp(newEntryFromUri(URI, 1700000000000))
    await s.enableEncryption('pw')
    s.lock()
    gates.unlock.hold()
    const p = s.unlock('pw')
    await flush()
    s.lock() // 解锁进行中被再次锁定（自动锁定/远端变更等触发方）
    gates.unlock.pass()
    await expect(p).rejects.toThrow('vault locked during operation')
    expect(s.locked.value).toBe(true)
    expect(s.vault.entries).toHaveLength(0) // lock 已清空，中止续延未回填明文
    expect(await persist.get()).toBeNull() // 未重挂持久化
    expect(await adapter.get(SECURITY_KEY)).toBeTruthy() // security 数据未受影响（LockScreen 仍可渲染）
  })

  it('无并发锁定：enable → changePassphrase(轮换) → lock → unlock 全链路行为不变（代数未动）', async () => {
    const adapter = createMemoryStorage()
    const persist = makeDekPersist()
    const s = createVueStore(adapter, { dekPersist: persist })
    await s.initStore()
    await s.addEntryOp(newEntryFromUri(URI, 1700000000000))
    await s.enableEncryption('old')
    expect(s.locked.value).toBe(false)
    const dekAfterEnable = await persist.get()
    await s.changePassphrase('new') // 缺省 rotateDek：DEK 轮换 → 持久化同步更新
    const dekAfterChange = await persist.get()
    expect(dekAfterChange).not.toBeNull()
    expect(dekAfterChange).not.toEqual(dekAfterEnable)
    expect(s.locked.value).toBe(false)
    s.lock()
    expect(s.locked.value).toBe(true)
    expect(await persist.get()).toBeNull()
    await s.unlock('new')
    expect(s.locked.value).toBe(false)
    expect(s.vault.entries).toHaveLength(1)
    expect(await persist.get()).toEqual(dekAfterChange)
  })
})
