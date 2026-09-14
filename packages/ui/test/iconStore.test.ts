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

  it('resolve：builtin→undefined；stored 命中→icons[id]；url 命中→icons[url:id]；undefined→undefined', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    await s.put('github', DATA_URL)
    await s.put('url:logo', DATA_URL)
    expect(s.resolve({ kind: 'builtin', id: 'github' })).toBeUndefined()
    expect(s.resolve({ kind: 'stored', id: 'github' })).toBe(DATA_URL)
    expect(s.resolve({ kind: 'stored', id: 'missing' })).toBeUndefined()
    expect(s.resolve({ kind: 'url', id: 'logo', url: 'https://x/l.png' })).toBe(DATA_URL)
    expect(s.resolve({ kind: 'url', id: 'missing', url: 'https://x/m.png' })).toBeUndefined()
    expect(s.resolve(undefined)).toBeUndefined()
  })

  it('fetchAndCache：fetch→blob→dataURL 写入 url:id 缓存并返回', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    // 最小 mock response：Node undici Response 不识别 jsdom Blob（会被字符串化），
    // 生产代码仅消费 ok/blob()，直接以 jsdom Blob 伪造即可
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['hello'], { type: 'text/plain' }) })))
    const dataUrl = await s.fetchAndCache({ kind: 'url', id: 'logo', url: 'https://x/logo.png' })
    expect(dataUrl).toBe('data:text/plain;base64,aGVsbG8=')
    expect(s.icons['url:logo']).toBe('data:text/plain;base64,aGVsbG8=')
    expect(s.resolve({ kind: 'url', id: 'logo', url: 'https://x/logo.png' })).toBe(
      'data:text/plain;base64,aGVsbG8=',
    )
  })

  it('fetchAndCache：网络失败/CORS 抛错→返回 null 不抛', async () => {
    const s = createIconStore(createMemoryStorage())
    await s.init()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(s.fetchAndCache({ kind: 'url', id: 'x', url: 'https://x/x.png' })).resolves.toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(s.fetchAndCache({ kind: 'url', id: 'y', url: 'https://x/y.png' })).resolves.toBeNull()
    expect(s.icons['url:x']).toBeUndefined()
    expect(s.icons['url:y']).toBeUndefined()
  })

  it('fetchAndCache 失败不影响既有缓存', async () => {
    const adapter: StorageAdapter = createMemoryStorage()
    const s = createIconStore(adapter)
    await s.init()
    await s.put('url:keep', DATA_URL)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('CORS') }))
    await expect(s.fetchAndCache({ kind: 'url', id: 'keep', url: 'https://x/k.png' })).resolves.toBeNull()
    expect(s.icons['url:keep']).toBe(DATA_URL)
  })
})
