/**
 * dekSession 单测（plan16 T12）：chrome.storage.session 以内存实现注入 globalThis.chrome，
 * 沿用 syncEngine.test.ts 既有 shim 模式（真实 session 区行为需浏览器，编排层验证）：
 * - set/get/clear 往返（base64 存储）
 * - 坏 base64 / 非字符串值 → get 按 null（损坏即无 DEK，不向上抛）
 * - set 长度校验：非 32B 抛错（编程错误立即暴露），32B 通过
 * - chrome API 抛错容错：get → null；set/clear 吞错（环境性失败不影响解锁/锁定主流程）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@totp/core'
import { createDekSession } from '../src/dekSession'

// ext 是模块导入期快照，逐用例 globalThis.chrome 注入需经惰性桥透传（批⑧ Task 10，见 helper 注释）
vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

type Store = Record<string, unknown>

/** chrome.storage.session 内存实现（get 接受单键字符串/键数组） */
function makeSessionArea(initial: Store = {}) {
  const data: Store = { ...initial }
  const calls = { get: 0, set: 0, remove: 0 }
  return {
    data,
    calls,
    async get(keys: string | string[]): Promise<Store> {
      calls.get++
      const list = typeof keys === 'string' ? [keys] : keys
      const out: Store = {}
      for (const k of list) if (k in data) out[k] = data[k]
      return out
    },
    async set(obj: Store): Promise<void> {
      calls.set++
      Object.assign(data, obj)
    },
    async remove(keys: string | string[]): Promise<void> {
      calls.remove++
      for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k]
    },
  }
}

function installChrome(session: ReturnType<typeof makeSessionArea>): void {
  ;(globalThis as unknown as { chrome: unknown }).chrome = { storage: { session } }
}

const DEK = new Uint8Array(32).fill(7)
const DEK_B64 = bytesToBase64(DEK)

beforeEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
})

describe('dekSession 往返', () => {
  it('set → get 返回同一 base64；clear → get 为 null', async () => {
    const area = makeSessionArea()
    installChrome(area)
    const s = createDekSession()

    expect(await s.get()).toBeNull() // 初始无 DEK
    await s.set(DEK)
    expect(area.data['dek']).toBe(DEK_B64) // session 区以 base64 存储
    expect(await s.get()).toBe(DEK_B64)

    await s.clear()
    expect('dek' in area.data).toBe(false)
    expect(await s.get()).toBeNull()
  })

  it('set 覆盖旧值（如换口令轮换 DEK 后重写）', async () => {
    installChrome(makeSessionArea())
    const s = createDekSession()
    await s.set(DEK)
    const next = new Uint8Array(32).fill(9)
    await s.set(next)
    expect(await s.get()).toBe(bytesToBase64(next))
  })
})

describe('dekSession 容错', () => {
  it('get：坏 base64（atob 抛错）→ null', async () => {
    installChrome(makeSessionArea({ dek: '!!!not-base64###' }))
    expect(await createDekSession().get()).toBeNull()
  })

  it('get：非字符串值（损坏/他端写入异型）→ null', async () => {
    installChrome(makeSessionArea({ dek: { nested: true } }))
    expect(await createDekSession().get()).toBeNull()
  })

  it('get：chrome API 抛错（上下文失效等）→ null', async () => {
    installChrome(makeSessionArea())
    const area = (globalThis as unknown as { chrome: { storage: { session: ReturnType<typeof makeSessionArea> } } }).chrome.storage.session
    area.get = async () => {
      throw new Error('Extension context invalidated')
    }
    expect(await createDekSession().get()).toBeNull()
  })

  it('set：非 32B 输入抛错且不写 session（31B/33B/空）', async () => {
    const area = makeSessionArea()
    installChrome(area)
    const s = createDekSession()
    await expect(s.set(new Uint8Array(31))).rejects.toThrow(/invalid DEK length/)
    await expect(s.set(new Uint8Array(33))).rejects.toThrow(/invalid DEK length/)
    await expect(s.set(new Uint8Array(0))).rejects.toThrow(/invalid DEK length/)
    expect(area.calls.set).toBe(0)
    expect('dek' in area.data).toBe(false)
  })

  it('set/clear：chrome API 抛错被吞（环境性失败不向上抛）', async () => {
    installChrome(makeSessionArea())
    const area = (globalThis as unknown as { chrome: { storage: { session: ReturnType<typeof makeSessionArea> } } }).chrome.storage.session
    area.set = async () => {
      throw new Error('QUOTA_BYTES exceeded')
    }
    area.remove = async () => {
      throw new Error('Extension context invalidated')
    }
    const s = createDekSession()
    await expect(s.set(DEK)).resolves.toBeUndefined() // 长度校验通过、存储失败吞掉
    await expect(s.clear()).resolves.toBeUndefined()
  })
})
