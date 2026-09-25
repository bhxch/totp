/**
 * dekSession 单测（plan16 T12）：chrome.storage.session 以内存实现注入 globalThis.chrome，
 * 经公共 fixture test/helpers/chromeShim.ts（P0 收敛，沿用原 makeSessionArea 语义：
 * 真实 session 区行为需浏览器，编排层验证）：
 * - set/get/clear 往返（base64 存储）
 * - 坏 base64 / 非字符串值 → get 按 null（损坏即无 DEK，不向上抛）
 * - set 长度校验：非 32B 抛错（编程错误立即暴露），32B 通过
 * - chrome API 抛错容错：get → null；set/clear 吞错（环境性失败不影响解锁/锁定主流程）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@totp/core'
import { createDekSession } from '../src/dekSession'
import { installChromeShim, type ChromeShim, type StorageAreaShim } from './helpers/chromeShim'

// ext 是模块导入期快照，逐用例 globalThis.chrome 注入需经惰性桥透传（批⑧ Task 10，见 helper 注释）
vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

/** chrome.storage.session 内存实现注入：初始内容注入即落盘；data/calls 直读，API 方法可在用例内覆写注入抛错 */
function installChrome(sessionInit: Record<string, unknown> = {}): StorageAreaShim {
  const shim: ChromeShim = installChromeShim({ session: sessionInit })
  return shim.session
}

const DEK = new Uint8Array(32).fill(7)
const DEK_B64 = bytesToBase64(DEK)

beforeEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
})

describe('dekSession 往返', () => {
  it('set → get 返回同一 base64；clear → get 为 null', async () => {
    const area = installChrome()
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
    installChrome()
    const s = createDekSession()
    await s.set(DEK)
    const next = new Uint8Array(32).fill(9)
    await s.set(next)
    expect(await s.get()).toBe(bytesToBase64(next))
  })
})

describe('dekSession 容错', () => {
  it('get：坏 base64（atob 抛错）→ null', async () => {
    installChrome({ dek: '!!!not-base64###' })
    expect(await createDekSession().get()).toBeNull()
  })

  it('get：非字符串值（损坏/他端写入异型）→ null', async () => {
    installChrome({ dek: { nested: true } })
    expect(await createDekSession().get()).toBeNull()
  })

  it('get：chrome API 抛错（上下文失效等）→ null', async () => {
    const area = installChrome()
    area.get = async () => {
      throw new Error('Extension context invalidated')
    }
    expect(await createDekSession().get()).toBeNull()
  })

  it('set：非 32B 输入抛错且不写 session（31B/33B/空）', async () => {
    const area = installChrome()
    const s = createDekSession()
    await expect(s.set(new Uint8Array(31))).rejects.toThrow(/invalid DEK length/)
    await expect(s.set(new Uint8Array(33))).rejects.toThrow(/invalid DEK length/)
    await expect(s.set(new Uint8Array(0))).rejects.toThrow(/invalid DEK length/)
    expect(area.calls.set).toBe(0)
    expect('dek' in area.data).toBe(false)
  })

  it('set/clear：chrome API 抛错被吞（环境性失败不向上抛）', async () => {
    const area = installChrome()
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
