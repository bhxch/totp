import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '@totp/core'
import { createIconStore } from '../src/iconStore'
// fake adapter 沿用 iconStore.test.ts 既有写法：createMemoryStorage()（该文件未导出 fakeAdapter）

describe('iconStore 包注册表', () => {
  it('upsertPack 写入并持久化；新实例 init 装载', async () => {
    const adapter = createMemoryStorage()
    const store = createIconStore(adapter)
    await store.put('icon-a', 'data:image/png;base64,AA')
    await store.upsertPack('testpack', { name: 'Test Pack', iconIds: ['icon-a'] })
    const store2 = createIconStore(adapter)
    await store2.init()
    expect(store2.packs['testpack']).toEqual({ name: 'Test Pack', iconIds: ['icon-a'] })
  })

  it('upsert 同 normKey 覆盖显示名与 iconIds', async () => {
    const store = createIconStore(createMemoryStorage())
    await store.upsertPack('k', { name: 'Old', iconIds: ['a'] })
    await store.upsertPack('k', { name: 'New', iconIds: ['b'] })
    expect(store.packs['k']).toEqual({ name: 'New', iconIds: ['b'] })
  })

  it('removePack 删除包图标与注册表条目；包不存在 no-op', async () => {
    const adapter = createMemoryStorage()
    const store = createIconStore(adapter)
    await store.put('a', 'data:image/png;base64,AA')
    await store.put('keep', 'data:image/png;base64,AA')
    await store.upsertPack('k', { name: 'K', iconIds: ['a'] })
    await store.removePack('k')
    expect(store.icons['a']).toBeUndefined()
    expect(store.icons['keep']).toBeDefined()
    expect(store.packs['k']).toBeUndefined()
    await store.removePack('missing') // 不抛错
    const store2 = createIconStore(adapter)
    await store2.init()
    expect(store2.icons['a']).toBeUndefined()
    expect(store2.packs['k']).toBeUndefined()
  })

  it('removeMany 批量删除且单次落盘', async () => {
    const adapter = createMemoryStorage()
    const store = createIconStore(adapter)
    await store.putMany({ a: 'x', b: 'y', c: 'z' })
    await store.removeMany(['a', 'b'])
    expect(store.icons['a']).toBeUndefined()
    expect(store.icons['c']).toBe('z')
    const store2 = createIconStore(adapter)
    await store2.init()
    expect(store2.icons['c']).toBe('z')
  })
})
