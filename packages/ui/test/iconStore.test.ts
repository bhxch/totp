import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStorage, type StorageAdapter } from '@totp/core'
import { createIconStore } from '../src/iconStore'

const DATA_URL = 'data:image/svg+xml;base64,PHN2Zy8+'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createIconStore', () => {
  it('init 空存储：icons 为空，resolve stored/url 未命中 undefined', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    expect(Object.keys(s.icons)).toHaveLength(0)
    expect(s.resolve({ kind: 'stored', id: 'github' })).toBeUndefined()
    expect(s.resolve({ kind: 'url', id: 'logo', url: 'https://x/l.png' })).toBeUndefined()
  })

  it('init 幂等：重复调用不重置不重复加载', async () => {
    const adapter = createMemoryStorage()
    const get = vi.spyOn(adapter, 'get')
    const s = createIconStore(adapter)
    await s.init()
    await s.init()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('put/remove 落盘；新 store init 往返恢复', async () => {
    const adapter = createMemoryStorage()
    const a = createIconStore(adapter)
    await a.init()
    await a.put('github', DATA_URL)
    expect(a.icons['github']).toBe(DATA_URL)
    expect(JSON.parse((await adapter.get('icons'))!).github).toBe(DATA_URL)

    await a.remove('github')
    expect(a.icons['github']).toBeUndefined()
    expect(JSON.parse((await adapter.get('icons'))!).github).toBeUndefined()

    await a.put('gitlab', DATA_URL)
    const b = createIconStore(adapter)
    await b.init()
    expect(b.icons['gitlab']).toBe(DATA_URL)
    expect(b.icons['github']).toBeUndefined()
  })

  it('putMany 批量合并写入且只落盘一次；新 store init 往返恢复', async () => {
    const adapter = createMemoryStorage()
    const set = vi.spyOn(adapter, 'set')
    const s = createIconStore(adapter)
    await s.init()
    set.mockClear()
    await s.putMany({ a: DATA_URL, b: DATA_URL })
    expect(set).toHaveBeenCalledTimes(1)
    expect(s.icons['a']).toBe(DATA_URL)
    expect(s.icons['b']).toBe(DATA_URL)
    expect(JSON.parse((await adapter.get('icons'))!)).toEqual({ a: DATA_URL, b: DATA_URL })
    const b = createIconStore(adapter)
    await b.init()
    expect(b.icons).toEqual({ a: DATA_URL, b: DATA_URL })
  })

  it('resolve：builtin→undefined；stored 命中→icons[id]；url 命中→icons[urlcache:id]；undefined→undefined', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    await s.put('github', DATA_URL)
    await s.put('urlcache:logo', DATA_URL)
    expect(s.resolve({ kind: 'builtin', id: 'github' })).toBeUndefined()
    expect(s.resolve({ kind: 'stored', id: 'github' })).toBe(DATA_URL)
    expect(s.resolve({ kind: 'stored', id: 'missing' })).toBeUndefined()
    expect(s.resolve({ kind: 'url', id: 'logo', url: 'https://x/l.png' })).toBe(DATA_URL)
    expect(s.resolve({ kind: 'url', id: 'missing', url: 'https://x/m.png' })).toBeUndefined()
    expect(s.resolve(undefined)).toBeUndefined()
  })

  it('fetchAndCache：fetch→blob→dataURL 写入 urlcache:id 缓存并返回 ok=true', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    // 最小 mock response：Node undici Response 不识别 jsdom Blob（会被字符串化），
    // 生产代码仅消费 ok/blob()，直接以 jsdom Blob 伪造即可
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['hello'], { type: 'text/plain' }) })))
    const result = await s.fetchAndCache({ kind: 'url', id: 'logo', url: 'https://x/logo.png' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.dataUrl).toBe('data:text/plain;base64,aGVsbG8=')
    // I58：URL 缓存键以 urlcache: 前缀，与图标 id 物理隔离
    expect(s.icons['urlcache:logo']).toBe('data:text/plain;base64,aGVsbG8=')
    expect(s.resolve({ kind: 'url', id: 'logo', url: 'https://x/logo.png' })).toBe(
      'data:text/plain;base64,aGVsbG8=',
    )
  })

  it('I59：fetchAndCache 网络/CORS 抛错 → 失败细分 kind=cors', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const result = await s.fetchAndCache({ kind: 'url', id: 'x', url: 'https://x/x.png' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('cors')
      expect(result.message).toContain('Failed to fetch')
    }
  })

  it('I59：HTTP 非 2xx → 失败细分 kind=notfound', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const result = await s.fetchAndCache({ kind: 'url', id: 'y', url: 'https://x/y.png' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('notfound')
      expect(result.message).toContain('404')
    }
    expect(s.icons['urlcache:y']).toBeUndefined()
  })

  it('I59：超 200KB 上限 → 失败细分 kind=toolarge', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob([new ArrayBuffer(200 * 1024 + 1)]) })))
    const result = await s.fetchAndCache({ kind: 'url', id: 'big', url: 'https://x/big.png' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('toolarge')
    expect(s.icons['urlcache:big']).toBeUndefined()
  })

  it('I58：remove(id) 只删图标 id，不触碰 urlcache: 命名空间', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    await s.put('github', DATA_URL)
    await s.put('urlcache:github', DATA_URL) // 故意同名键（理论不会发生，但应保持隔离）
    await s.remove('github')
    expect(s.icons['github']).toBeUndefined()
    expect(s.icons['urlcache:github']).toBe(DATA_URL)
  })

  it('I69：iconView URL 引用但缓存丢失 → 返回 { missing: true }', async () => {
    const { iconView } = await import('../src/iconStore')
    const ref: { kind: 'url'; id: 'lost'; url: 'https://x/x.png' } = { kind: 'url', id: 'lost', url: 'https://x/x.png' }
    const empty = createIconStore(createMemoryStorage())
    await empty.init()
    const v = iconView(ref, empty)
    expect(v).toBeDefined()
    expect(v?.missing).toBe(true)
    expect(v?.src).toBeUndefined()
  })
})
