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
        if (k === 'icons') throw new Error('disk full') // persist 落盘拒绝
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
