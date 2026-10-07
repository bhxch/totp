import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '@totp/core'
import { createIconStore, iconView } from '../src/iconStore'
import { getBuiltinIcons } from '@totp/core'

afterEach(() => vi.unstubAllGlobals())

describe('iconStore 防御分支补全', () => {
  it('盘上 icons 键损坏（坏 JSON）：init 按空存储处理不阻断启动', async () => {
    const adapter = {
      get: vi.fn(async (k: string) => (k === 'icons' ? '{broken json' : null)),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    }
    const s = createIconStore(adapter)
    await expect(s.init()).resolves.toBeUndefined()
    expect(s.icons).toEqual({})
  })

  it('fetch 抛非 Error 值（字符串 reject）：cors 类别 + String 兜底消息', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'mixed-content' }))
    const r = await s.fetchAndCache({ kind: 'url', id: 'x', url: 'https://x/x.png' })
    expect(r).toEqual({ ok: false, kind: 'cors', message: 'mixed-content' })
  })

  it('res.blob() 抛错 → kind=other 且消息透传', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => { throw new Error('stream dead') } })))
    const r = await s.fetchAndCache({ kind: 'url', id: 'x', url: 'https://x/x.png' })
    expect(r).toEqual({ ok: false, kind: 'other', message: 'stream dead' })
  })
})

describe('iconView 纯函数分支', () => {
  it('ref 缺省（undefined）：返回 undefined', () => {
    expect(iconView(undefined)).toBeUndefined()
  })
  it('builtin id 不在注册表：返回 undefined', () => {
    expect(iconView({ kind: 'builtin', id: 'nope' })).toBeUndefined()
  })
  it('url 引用无缓存可解析：显式 missing 标记（I69）', () => {
    const s = createIconStore(createMemoryStorage())
    expect(iconView({ kind: 'url', id: 'ghost', url: 'https://x/g.png' }, s)).toEqual({ missing: true })
  })
})

describe('iconStore fetchAndCache 落盘失败分支', () => {
  it('urlcache 落盘抛错（adapter.set 拒绝）：kind=other 且消息透传，不误报成功', async () => {
    const { createMemoryStorage } = await import('@totp/core')
    const base = createMemoryStorage()
    const adapter = {
      get: (k: string) => base.get(k),
      delete: (k: string) => base.delete(k),
      set: vi.fn(async (k: string, v: string) => {
        if (k.startsWith('icon:')) throw new Error('disk full') // 数据键落盘拒绝
        await base.set(k, v)
      }),
    }
    const s = createIconStore(adapter)
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'text/plain' }) })))
    const r = await s.fetchAndCache({ kind: 'url', id: 'logo', url: 'https://x/logo.png' })
    expect(r).toEqual({ ok: false, kind: 'other', message: 'disk full' })
  })
})

describe('iconStore notfound 与 iconView 命中分支', () => {
  it('HTTP 非 ok：kind=notfound 且消息带状态码', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const r = await s.fetchAndCache({ kind: 'url', id: 'gone', url: 'https://x/g.png' })
    expect(r).toEqual({ ok: false, kind: 'notfound', message: 'HTTP 404' })
  })

  it('iconView：builtin 命中 → html；stored 命中 → src（命中两向）', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    await s.put('gh', 'data:image/png;base64,aGk=')
    const builtin = iconView({ kind: 'builtin', id: 'github' })
    expect(builtin).toEqual({ html: `<path d="${getBuiltinIcons()['github']!.path}"></path>` })
    expect(iconView({ kind: 'stored', id: 'gh' }, s)).toEqual({ src: 'data:image/png;base64,aGk=' })
  })

  it('fetchAndCache：blobToDataUrl 链路抛非 Error 值 → String 兜底消息', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'text/plain' }) })))
    const adapterThrowsString = {
      get: async () => null,
      set: async () => { throw 'io-failure' },
      delete: async () => {},
    }
    const s2 = createIconStore(adapterThrowsString as never)
    await s2.init()
    const r2 = await s2.fetchAndCache({ kind: 'url', id: 'x2', url: 'https://x/x.png' })
    expect(r2).toEqual({ ok: false, kind: 'other', message: 'io-failure' })
  })
})

describe('R4-I3 批量写失败回滚（mock adapter 部分失败 → 内存回滚、状态不变）', () => {
  /** 有状态底座 + 拒绝指定数据键写入/删除的 adapter：base 可注入（与外层共享盘面），failSet/failDelete 触发 EINVAL */
  function failingAdapter(opts: { failSet?: string; failDelete?: string; base?: ReturnType<typeof createMemoryStorage> }) {
    const base = opts.base ?? createMemoryStorage()
    return {
      base,
      adapter: {
        get: (k: string) => base.get(k),
        delete: vi.fn(async (k: string) => {
          if (k === opts.failDelete) throw new Error('EINVAL: invalid path')
          await base.delete(k)
        }),
        set: vi.fn(async (k: string, v: string) => {
          if (k === opts.failSet) throw new Error('EINVAL: invalid path')
          await base.set(k, v)
        }),
      },
    }
  }

  it('putMany 部分失败：新增键从内存移除、覆盖键还原旧值，索引不写、错误向上传播', async () => {
    const { base, adapter } = failingAdapter({ failSet: 'icon:new1' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = createIconStore(adapter)
    await s.init()
    await s.put('exist', 'OLD') // 覆盖键先就位（base.iconindex=['exist']）

    try {
      await expect(s.putMany({ exist: 'NEW', new1: 'A', new2: 'B' })).rejects.toThrow('EINVAL')
      expect(err).toHaveBeenCalledWith(expect.stringContaining('putMany'), expect.any(Error))
      expect(s.icons['exist']).toBe('OLD') // 覆盖键还原（不提前生效）
      expect(s.icons['new1']).toBeUndefined() // 新增键不成幽灵
      expect(s.icons['new2']).toBeUndefined()
      // 索引未写：iconindex 不含 new1/new2（new2 的盘面孤儿键对 init 无害）
      expect(JSON.parse((await base.get('iconindex'))!)).toEqual(['exist'])
    } finally {
      err.mockRestore()
    }

    // 故障消失后重写收敛（盘面最终一致）
    adapter.set.mockImplementation(async (k: string, v: string) => { await base.set(k, v) })
    await s.putMany({ new1: 'A' })
    expect(s.icons['new1']).toBe('A')
    expect(JSON.parse((await base.get('iconindex'))!)).toEqual(['exist', 'new1'])
  })

  it('removeMany 失败：内存删除回滚，盘面无变化（部分成功残留的孤儿键由 init 的 null 过滤兜底）', async () => {
    const base = createMemoryStorage()
    const s = createIconStore(base)
    await s.init()
    await s.putMany({ a: 'A', b: 'B' })
    const { adapter } = failingAdapter({ failDelete: 'icon:a', base }) // 并行写语义下以「a 拒绝」注入失败
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s2 = createIconStore(adapter)
    await s2.init()
    try {
      await expect(s2.removeMany(['a', 'b'])).rejects.toThrow('EINVAL')
      expect(err).toHaveBeenCalledWith(expect.stringContaining('removeMany'), expect.any(Error))
      expect(s2.icons['a']).toBe('A') // 内存回滚
      expect(s2.icons['b']).toBe('B')
      expect(await base.get('icon:a')).toBe('A') // 失败键盘面未删
    } finally {
      err.mockRestore()
    }
  })

  it('removePack 失败：icons 与 packs 条目整体回滚，不出现半删态', async () => {
    const base = createMemoryStorage()
    const s = createIconStore(base)
    await s.init()
    await s.putMany({ x: 'X', y: 'Y' })
    await s.upsertPack('testpack', { name: '测试包', iconIds: ['x', 'y'] })
    const { adapter } = failingAdapter({ failDelete: 'icon:y', base })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s2 = createIconStore(adapter)
    await s2.init()
    try {
      await expect(s2.removePack('testpack')).rejects.toThrow('EINVAL')
      expect(err).toHaveBeenCalledWith(expect.stringContaining('removePack'), expect.any(Error))
      expect(s2.icons['x']).toBe('X')
      expect(s2.icons['y']).toBe('Y')
      expect(s2.packs['testpack']).toEqual({ name: '测试包', iconIds: ['x', 'y'] }) // 注册表条目还原
      expect(await base.get('iconpacks')).not.toBeNull() // 盘面注册表未动
    } finally {
      err.mockRestore()
    }
  })
})
