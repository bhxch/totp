// packages/ui/test/fullIcons.test.ts
// 模块级单例（ready 标志 + in-flight promise）：每用例 vi.resetModules + 动态 import
// 取全新实例，避免跨用例状态污染；fetch 用 vi.stubGlobal 注入。
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function fresh() {
  vi.resetModules()
  return import('../src/fullIcons')
}

const okJson = () =>
  new Response(JSON.stringify({ icons: { zzzfull: { id: 'zzzfull', title: 'Full Test', path: 'M0 0' } } }), {
    status: 200,
  })

describe('ensureFullIcons', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('首次调用 fetch 资产并注册进 core 注册表，置 ready', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson())
    vi.stubGlobal('fetch', fetchMock)
    const mod = await fresh()
    await mod.ensureFullIcons()
    expect(mod.fullIconsReady.value).toBe(true)
    expect(mod.fullIconsError.value).toBe(false)
    const { getBuiltinIcons } = await import('@totp/core')
    expect(getBuiltinIcons()['zzzfull']?.title).toBe('Full Test')
  })

  it('ready 后短路：不再发起 fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson())
    vi.stubGlobal('fetch', fetchMock)
    const mod = await fresh()
    await mod.ensureFullIcons()
    await mod.ensureFullIcons()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('失败置 error、清 in-flight，重试可成功', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(okJson())
    vi.stubGlobal('fetch', fetchMock)
    const mod = await fresh()
    await expect(mod.ensureFullIcons()).rejects.toThrow('boom')
    expect(mod.fullIconsError.value).toBe(true)
    await mod.ensureFullIcons()
    expect(mod.fullIconsReady.value).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('HTTP 非 2xx 视为失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 404 })))
    const mod = await fresh()
    await expect(mod.ensureFullIcons()).rejects.toThrow('HTTP 404')
    expect(mod.fullIconsReady.value).toBe(false)
  })
})
