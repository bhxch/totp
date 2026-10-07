import { describe, expect, it } from 'vitest'
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
