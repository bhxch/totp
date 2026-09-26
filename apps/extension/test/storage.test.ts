/**
 * storage.ts 直测（盘点 B5-25）：ext.storage.local → StorageAdapter 适配层。
 * - ext undefined（桌面/测试环境）短路：get null、set/delete no-op（兜底防崩）；
 * - 有宿主：缺键 null、往返、删除幂等（与 chromeShim 内存区对拍）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installChromeShim, type ChromeShim } from './helpers/chromeShim'

vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

import { createChromeStorage } from '../src/storage'

let shim: ChromeShim

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  shim?.restore()
})

describe('createChromeStorage（B5-25）', () => {
  it('ext undefined 短路：get 恒 null、set/delete no-op 不抛', async () => {
    const adapter = createChromeStorage()
    await expect(adapter.get('vault')).resolves.toBeNull()
    await expect(adapter.set('vault', '{}')).resolves.toBeUndefined()
    await expect(adapter.delete('vault')).resolves.toBeUndefined()
  })

  it('有宿主：缺键 null、set/get 往返、delete 幂等', async () => {
    shim = installChromeShim()
    const adapter = createChromeStorage()

    await expect(adapter.get('missing')).resolves.toBeNull()

    await adapter.set('vault', '{"v":2}')
    expect(shim.local.data['vault']).toBe('{"v":2}') // 直写 local 区（键值字符串形态）
    await expect(adapter.get('vault')).resolves.toBe('{"v":2}')

    await adapter.delete('vault')
    await expect(adapter.get('vault')).resolves.toBeNull()
    await adapter.delete('vault') // 幂等
    expect(shim.local.calls.remove).toBe(2)
  })
})
