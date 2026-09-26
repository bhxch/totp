/**
 * tauriFs adapter 全测（P3b / P0 安全语义）：createTauriFs 启动 mkdir、get/set/delete 三操作接线、
 * settings.json 读改写合并（保 Rust 四组外来键）、tmp+rename 原子写调用序、plugin-fs 抛错向上传播。
 * why：settings.json 由前端与 Rust（shortcutToggleMini/devtools/releasePolicy/mcp）共写，
 * 整文件覆盖会抹掉 Rust 配置——adapter.set('settings') 是该互踩语义的最终防线（盘点 B11 38-39）。
 * 纯函数 mergeSettingsPreservingForeign 的合并矩阵见 tauriFsSettings.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tauriMock } from './mocks/tauri'
import { createTauriFs } from '../src/tauriFs'
import { rustKeys } from './helpers/settingsFixture'

vi.mock('@tauri-apps/plugin-fs', async () => (await import('./mocks/tauri')).fsModule())

/** 原子写序断言：先写 tmp 再 rename（写一半崩溃不得损坏目标文件） */
function expectTmpBeforeRename(): void {
  const [writeOrder] = tauriMock.fs.writeTextFile.mock.invocationCallOrder
  const [renameOrder] = tauriMock.fs.rename.mock.invocationCallOrder
  expect(writeOrder).toBeLessThan(renameOrder)
}

beforeEach(() => {
  tauriMock.reset()
})

describe('createTauriFs（StorageAdapter 装配）', () => {
  it('启动即 mkdir AppData recursive（AppData 目录可能尚不存在）', async () => {
    await createTauriFs()
    expect(tauriMock.fs.mkdir).toHaveBeenCalledOnce()
    expect(tauriMock.fs.mkdir).toHaveBeenCalledWith('', { baseDir: 'AppData', recursive: true })
  })
})

describe('adapter.get', () => {
  it('文件不存在 → null（不触发读文本）', async () => {
    const adapter = await createTauriFs() // 默认 exists=false
    expect(await adapter.get('vault')).toBeNull()
    expect(tauriMock.fs.readTextFile).not.toHaveBeenCalled()
  })

  it('文件存在 → 读文本并返回', async () => {
    tauriMock.fs.exists.mockResolvedValue(true)
    tauriMock.fs.readTextFile.mockResolvedValue('{"v":1}')
    const adapter = await createTauriFs()
    expect(await adapter.get('vault')).toBe('{"v":1}')
    expect(tauriMock.fs.exists).toHaveBeenCalledWith('vault.json', { baseDir: 'AppData' })
    expect(tauriMock.fs.readTextFile).toHaveBeenCalledWith('vault.json', { baseDir: 'AppData' })
  })
})

describe('adapter.set（settings 读改写合并 + 原子写）', () => {
  it('盘上有旧文本：合并保留 Rust 四组外来键，新值优先；tmp+rename 原子写调用序', async () => {
    tauriMock.fs.exists.mockResolvedValue(true)
    tauriMock.fs.readTextFile.mockResolvedValue(JSON.stringify({ ...rustKeys, theme: 'light' }))
    const adapter = await createTauriFs()
    await adapter.set('settings', JSON.stringify({ theme: 'dark', locale: 'zh' }))

    // 先读盘上旧文本
    expect(tauriMock.fs.readTextFile).toHaveBeenCalledWith('settings.json', { baseDir: 'AppData' })
    // 落盘内容 = {...盘上对象, ...新值}：新值优先、外来键保留
    expect(tauriMock.fs.writeTextFile).toHaveBeenCalledOnce()
    const [tmpPath, payload, opts] = tauriMock.fs.writeTextFile.mock.calls[0] as unknown as [string, string, unknown]
    expect(tmpPath).toBe('settings.json.tmp')
    expect(JSON.parse(payload)).toEqual({ ...rustKeys, theme: 'dark', locale: 'zh' })
    expect(opts).toEqual({ baseDir: 'AppData' })
    // 原子写：tmp → rename 覆盖，且调用序先写后改名
    expect(tauriMock.fs.rename).toHaveBeenCalledOnce()
    expect(tauriMock.fs.rename).toHaveBeenCalledWith(
      'settings.json.tmp', 'settings.json',
      { oldPathBaseDir: 'AppData', newPathBaseDir: 'AppData' },
    )
    expectTmpBeforeRename()
  })

  it('盘上无文件：不读旧文本，纯新值原子写', async () => {
    const adapter = await createTauriFs() // 默认 exists=false
    await adapter.set('settings', '{"theme":"dark"}')
    expect(tauriMock.fs.readTextFile).not.toHaveBeenCalled()
    const payload = tauriMock.fs.writeTextFile.mock.calls[0]?.[1]
    expect(payload).toBe('{"theme":"dark"}')
    expectTmpBeforeRename()
  })

  it('旧文本读失败（exists true 但 IO 抛错）按无文件处理：回退纯新值，不阻塞保存', async () => {
    tauriMock.fs.exists.mockResolvedValue(true)
    tauriMock.fs.readTextFile.mockRejectedValue(new Error('io error'))
    const adapter = await createTauriFs()
    await adapter.set('settings', '{"theme":"dark"}')
    const payload = JSON.parse(tauriMock.fs.writeTextFile.mock.calls[0]?.[1] as string) as Record<string, unknown>
    expect(payload).toEqual({ theme: 'dark' })
  })

  it('旧文本损坏（非法 JSON / 数组根）：回退纯新值（等价旧整文件覆盖行为）', async () => {
    tauriMock.fs.exists.mockResolvedValue(true)
    const adapter = await createTauriFs()
    for (const bad of ['not json{', '[1,2]']) {
      tauriMock.fs.readTextFile.mockResolvedValue(bad)
      tauriMock.fs.writeTextFile.mockClear()
      await adapter.set('settings', '{"theme":"dark"}')
      const payload = JSON.parse(tauriMock.fs.writeTextFile.mock.calls[0]?.[1] as string) as Record<string, unknown>
      expect(payload).toEqual({ theme: 'dark' })
    }
  })
})

describe('adapter.set（非 settings 键）', () => {
  it('不需要合并：payload 原样原子写，且不触碰 exists/readTextFile', async () => {
    const adapter = await createTauriFs()
    await adapter.set('vault', '{"secret":1}')
    expect(tauriMock.fs.exists).not.toHaveBeenCalled()
    expect(tauriMock.fs.readTextFile).not.toHaveBeenCalled()
    expect(tauriMock.fs.writeTextFile).toHaveBeenCalledWith('vault.json.tmp', '{"secret":1}', { baseDir: 'AppData' })
    expect(tauriMock.fs.rename).toHaveBeenCalledWith(
      'vault.json.tmp', 'vault.json',
      { oldPathBaseDir: 'AppData', newPathBaseDir: 'AppData' },
    )
  })
})

describe('adapter.delete（幂等删除）', () => {
  it('不存在 → 不 remove；存在 → remove', async () => {
    const adapter = await createTauriFs()
    await adapter.delete('vault')
    expect(tauriMock.fs.remove).not.toHaveBeenCalled()

    tauriMock.fs.exists.mockResolvedValue(true)
    await adapter.delete('vault')
    expect(tauriMock.fs.remove).toHaveBeenCalledOnce()
    expect(tauriMock.fs.remove).toHaveBeenCalledWith('vault.json', { baseDir: 'AppData' })
  })
})

describe('plugin-fs 抛错向上传播（宿主兜底行为：保存失败可见，不静默丢数据）', () => {
  it('get 的 exists 抛错 → get 拒绝', async () => {
    tauriMock.fs.exists.mockRejectedValue(new Error('fs down'))
    const adapter = await createTauriFs()
    await expect(adapter.get('vault')).rejects.toThrow('fs down')
  })

  it('set 的 writeTextFile 抛错 → set 拒绝且不 rename（tmp 残留不覆盖目标）', async () => {
    tauriMock.fs.writeTextFile.mockRejectedValue(new Error('disk full'))
    const adapter = await createTauriFs()
    await expect(adapter.set('vault', '{"v":1}')).rejects.toThrow('disk full')
    expect(tauriMock.fs.rename).not.toHaveBeenCalled()
  })

  it('set 的 rename 抛错 → set 拒绝', async () => {
    tauriMock.fs.rename.mockRejectedValue(new Error('rename failed'))
    const adapter = await createTauriFs()
    await expect(adapter.set('vault', '{"v":1}')).rejects.toThrow('rename failed')
  })

  it('set(settings) 读旧文本抛错已被吞（按无文件），写盘抛错仍传播', async () => {
    tauriMock.fs.exists.mockResolvedValue(true)
    tauriMock.fs.readTextFile.mockRejectedValue(new Error('read io error'))
    tauriMock.fs.writeTextFile.mockRejectedValue(new Error('write io error'))
    const adapter = await createTauriFs()
    await expect(adapter.set('settings', '{"theme":"dark"}')).rejects.toThrow('write io error')
  })

  it('delete 的 exists 抛错 → delete 拒绝', async () => {
    tauriMock.fs.exists.mockRejectedValue(new Error('fs down'))
    const adapter = await createTauriFs()
    await expect(adapter.delete('vault')).rejects.toThrow('fs down')
  })
})
