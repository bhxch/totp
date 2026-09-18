/**
 * extension store 注册层单测（审查 I7）：chrome.storage.onChanged → registerStorageSync
 * payload 映射的透传验证。chrome.storage.local / onChanged / runtime.sendMessage 以内存实现
 * 注入 globalThis.chrome（沿用 dekSession.test 既有 shim 模式）：
 * - secretBag 键变更 → 透传触发 ui store 的 reloadBagFromDisk（跨上下文保管区感知）
 * - 仅 vault/settings 键变更 → 不触碰 bag（credsCache 不被无谓重读）
 * - area !== 'local'（如 session 区 DEK 写入）→ 整体忽略
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sealSecretBag, SECRET_BAG_KEY, type CloudCred } from '@totp/core'
import { createExtensionStore } from '../src/store'

type Store = Record<string, unknown>
type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void

/** chrome.storage（local + onChanged）与 runtime 内存实现；emit 模拟浏览器派发 onChanged */
function installChrome() {
  const local = new Map<string, string>()
  const listeners: Listener[] = []
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string): Promise<Store> {
          return local.has(key) ? { [key]: local.get(key) } : {}
        },
        async set(obj: Store): Promise<void> {
          for (const [k, v] of Object.entries(obj)) local.set(k, v as string)
        },
        async remove(key: string): Promise<void> {
          local.delete(key)
        },
      },
      onChanged: {
        addListener(cb: Listener): void {
          listeners.push(cb)
        },
      },
    },
    runtime: { sendMessage: async () => {} }, // sync-push 调度通道（无关本测试，静默吞）
  }
  return {
    local,
    emit: (changes: Record<string, { newValue?: unknown }>, area = 'local') => {
      for (const l of listeners) l(changes, area)
    },
  }
}

const WEBDAV: CloudCred = { backend: 'webdav', serverUrl: 'https://d.example', username: 'u', password: 'p' }
const GIST: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

/** 多拍静置：忽略类断言前给 reload 的 crypto 异步链路充分时间被证明「未发生」 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
})

describe('extension store op 导出（Tag 13 换名收口）', () => {
  it('导出 addTagOp/renameTagOp/removeTagOp', async () => {
    const ops = await import('../src/store')
    expect(typeof ops.addTagOp).toBe('function')
    expect(typeof ops.renameTagOp).toBe('function')
    expect(typeof ops.removeTagOp).toBe('function')
  })
})

describe('extension store registerSync 映射（审查 I7）', () => {
  it('onChanged 含 secretBag 键 → 透传触发 reloadBagFromDisk，credsCache 前进到远端内容', async () => {
    const c = installChrome()
    const s = createExtensionStore('test', { selfWriteSuppressMs: 0 }) // 注入 0：远端通知即时生效（否则自写回声窗口吞掉测试内紧随的 emit）
    await s.initStore()
    s.registerStorageSync()
    await s.enableEncryption('masterpw')
    await s.saveSourceCredOp('src-1', WEBDAV)
    expect(s.credsCache.value['src-1']).toEqual(WEBDAV)

    // 模拟另一上下文（popup/options）写保管区：以同 DEK 封存含 src-2 的新 bag 落盘
    const dek = s.getCurrentDek()!
    await c.local.set(SECRET_BAG_KEY, await sealSecretBag(dek, { backupPassword: '', creds: { 'src-1': WEBDAV, 'src-2': GIST } }))
    c.emit({ secretBag: { newValue: '...' } })
    await vi.waitFor(() => expect(s.credsCache.value['src-2']).toEqual(GIST)) // 远端变更已感知（轮询等 crypto 链路）
  })

  it('仅 vault/settings 键变更 → 不触碰 bag；session 区变更 → 整体忽略', async () => {
    const c = installChrome()
    const s = createExtensionStore('test', { selfWriteSuppressMs: 0 })
    await s.initStore()
    s.registerStorageSync()
    await s.enableEncryption('masterpw')
    await s.saveSourceCredOp('src-1', WEBDAV)
    const dek = s.getCurrentDek()!
    await c.local.set(SECRET_BAG_KEY, await sealSecretBag(dek, { backupPassword: '', creds: { 'src-2': GIST } }))

    // vault/settings 通知不触发 bag 重读
    c.emit({ vault: { newValue: '...' }, settings: { newValue: '...' } })
    await settle()
    expect(s.credsCache.value['src-2']).toBeUndefined()

    // 非 local 区（如 session 区 DEK 写入派发的 onChanged）整体忽略
    c.emit({ secretBag: { newValue: '...' } }, 'session')
    await settle()
    expect(s.credsCache.value['src-2']).toBeUndefined()
  })

  it('锁定态远端 bag 变更被忽略（reloadBagFromDisk 守护），credsCache 保持锁定空态', async () => {
    const c = installChrome()
    const s = createExtensionStore('test')
    await s.initStore()
    s.registerStorageSync()
    await s.enableEncryption('masterpw')
    const dek = s.getCurrentDek()!
    s.lock()
    await c.local.set(SECRET_BAG_KEY, await sealSecretBag(dek, { backupPassword: '', creds: { 'src-2': GIST } }))
    c.emit({ secretBag: { newValue: '...' } })
    await settle()
    expect(s.locked.value).toBe(true)
    expect(s.credsCache.value).toEqual({})
  })
})
