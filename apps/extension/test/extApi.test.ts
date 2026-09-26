/**
 * extApi 直测（盘点 B5-26）：ext = browser ?? chrome 统一通道是导入期快照——逐用例注入
 * globalThis 后 vi.resetModules 动态加载，覆盖四能力探测（canOffscreen/canIdle/canSetBadge/
 * canOpenPopup）在 chrome/browser 两形态与成员缺失形态下的真值。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type Host = Record<string, unknown>
const g = globalThis as unknown as { browser?: Host; chrome?: Host }
const originalBrowser = g.browser
const originalChrome = g.chrome

/** 注入宿主形态 → 重置模块注册表 → 动态加载（快照在导入期固化，必须晚于注入） */
async function loadExtApi(host: { browser?: Host; chrome?: Host }) {
  delete g.browser
  delete g.chrome
  if (host.browser) g.browser = host.browser
  if (host.chrome) g.chrome = host.chrome
  vi.resetModules()
  return await import('../src/extApi')
}

afterEach(() => {
  delete g.browser
  delete g.chrome
  if (originalBrowser !== undefined) g.browser = originalBrowser
  if (originalChrome !== undefined) g.chrome = originalChrome
})

describe('ext 统一通道与四能力探测（B5-26）', () => {
  it('无扩展宿主（桌面/测试环境）：ext undefined，四探测全 false', async () => {
    const { ext, canOffscreen, canIdle, canSetBadge, canOpenPopup } = await loadExtApi({})
    expect(ext).toBeUndefined()
    expect(canOffscreen()).toBe(false)
    expect(canIdle()).toBe(false)
    expect(canSetBadge()).toBe(false)
    expect(canOpenPopup()).toBe(false)
  })

  it('chrome 完整形态：offscreen/idle.queryState/action.setBadgeText/action.openPopup 全探测 true', async () => {
    const chrome = {
      offscreen: {},
      idle: { queryState: () => {} },
      action: { setBadgeText: () => {}, openPopup: () => {} },
    }
    const { ext, canOffscreen, canIdle, canSetBadge, canOpenPopup } = await loadExtApi({ chrome })
    expect(ext).toBe(chrome)
    expect(canOffscreen()).toBe(true)
    expect(canIdle()).toBe(true)
    expect(canSetBadge()).toBe(true)
    expect(canOpenPopup()).toBe(true)
  })

  it('browser 优先（Firefox Promise 风格全局）：ext 取 browser 而非 chrome', async () => {
    const browser = { storage: {} }
    const chrome = { storage: {} }
    const { ext } = await loadExtApi({ browser, chrome })
    expect(ext).toBe(browser)
  })

  it('成员缺失形态：无 offscreen / idle 缺 queryState / action 缺 setBadgeText·openPopup 各自 false', async () => {
    const chrome = {
      idle: {}, // 无 queryState（宿主无 idle 权限降级形态）
      action: { setBadgeText: () => {} }, // 无 openPopup（openPopup 仅部分 Chromium）
    }
    const { canOffscreen, canIdle, canSetBadge, canOpenPopup } = await loadExtApi({ chrome })
    expect(canOffscreen()).toBe(false)
    expect(canIdle()).toBe(false)
    expect(canSetBadge()).toBe(true)
    expect(canOpenPopup()).toBe(false)
  })
})
