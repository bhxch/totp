import { describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '@totp/core'
import { createIconStore } from '../src/iconStore'

describe('iconStore per-icon 键布局与迁移', () => {
  it('旧单键 icons 首次 init 迁移：拆写 icon:<id> + iconindex，删除旧键，幂等', async () => {
    const adapter = createMemoryStorage()
    await adapter.set('icons', JSON.stringify({ github: 'data:image/png;base64,AA', 'urlcache:foo': 'data:image/png;base64,BB' }))
    const icons = createIconStore(adapter)
    await icons.init()
    expect(icons.icons['github']).toBe('data:image/png;base64,AA')
    expect(icons.icons['urlcache:foo']).toBe('data:image/png;base64,BB')
    expect(JSON.parse((await adapter.get('iconindex'))!)).toEqual(['github', 'urlcache:foo'])
    expect(await adapter.get('icon:github')).toBe('data:image/png;base64,AA')
    expect(await adapter.get('icons')).toBeNull()
    // 幂等：二次 init 不重复迁移也不丢数据
    const icons2 = createIconStore(adapter)
    await icons2.init()
    expect(icons2.icons['github']).toBe('data:image/png;base64,AA')
  })

  it('R4-M2 混合状态（旧 icons 键与 iconindex 并存）：索引并集合并，已迁移键不丢', async () => {
    const adapter = createMemoryStorage()
    // 上次迁移中断形态：icon:b 已落盘且在索引中，icons 旧键尚存（只含 a）
    await adapter.set('icon:b', 'BB')
    await adapter.set('iconindex', JSON.stringify(['b']))
    await adapter.set('icons', JSON.stringify({ a: 'AA' }))
    const icons = createIconStore(adapter)
    await icons.init()
    expect(icons.icons['a']).toBe('AA')
    expect(icons.icons['b']).toBe('BB') // 覆盖写口径下 b 会被挤出索引成孤儿
    expect(JSON.parse((await adapter.get('iconindex'))!)).toEqual(['a', 'b'])
    expect(await adapter.get('icons')).toBeNull()
  })

  it('R4-C1 迁移 per-key 容错：单键 set 失败不放大为 init 抛错，旧键保留、重试收敛', async () => {
    const base = createMemoryStorage()
    await base.set('icons', JSON.stringify({ good: 'AA', bad: 'BB' }))
    const adapter = {
      get: (k: string) => base.get(k),
      delete: (k: string) => base.delete(k),
      set: vi.fn(async (k: string, v: string) => {
        if (k === 'icon:bad') throw new Error('EINVAL: invalid path')
        await base.set(k, v)
      }),
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const icons = createIconStore(adapter)
      await expect(icons.init()).resolves.toBeUndefined() // 失败被吞掉，不触发整屏 loadError
      expect(err).toHaveBeenCalledWith(expect.stringContaining('icon:bad'), expect.any(Error))
      expect(icons.icons['good']).toBe('AA') // 成功键本会话入内存可用
      expect(icons.icons['bad']).toBeUndefined()
      expect(await base.get('icons')).not.toBeNull() // 旧键保留（部分失败不删，幂等重试）
    } finally {
      err.mockRestore()
    }
    // 重试（故障消失）：迁移收敛——全部键就位、索引并集、旧键删除
    const icons2 = createIconStore(base)
    await icons2.init()
    expect(icons2.icons['good']).toBe('AA')
    expect(icons2.icons['bad']).toBe('BB')
    expect(await base.get('icons')).toBeNull()
    expect(JSON.parse((await base.get('iconindex'))!)).toEqual(['good', 'bad'])
  })

  it('legacy 值非字符串（脏数据/手改存储）：跳过不落新键、不入索引，合法键照常迁移', async () => {
    const adapter = createMemoryStorage()
    await adapter.set('icons', JSON.stringify({
      github: 'data:image/png;base64,AA',
      badnum: 42 as unknown as string,
      badobj: { nested: true } as unknown as string,
    }))
    const icons = createIconStore(adapter)
    await icons.init()
    expect(icons.icons['github']).toBe('data:image/png;base64,AA')
    expect(icons.icons['badnum']).toBeUndefined()
    expect(icons.icons['badobj']).toBeUndefined()
    expect(JSON.parse((await adapter.get('iconindex'))!)).toEqual(['github'])
    expect(await adapter.get('icon:badnum')).toBeNull()
    expect(await adapter.get('icon:badobj')).toBeNull()
  })

  it('put/remove 落盘形态：数据键独立写，索引仅集合变化时写', async () => {
    const adapter = createMemoryStorage()
    const icons = createIconStore(adapter)
    await icons.init()
    await icons.put('github', 'data:image/png;base64,AA')
    expect(await adapter.get('icon:github')).toBe('data:image/png;base64,AA')
    expect(JSON.parse((await adapter.get('iconindex'))!)).toEqual(['github'])
    await icons.remove('github')
    expect(await adapter.get('icon:github')).toBeNull()
    expect(JSON.parse((await adapter.get('iconindex'))!)).toEqual([])
  })
})
