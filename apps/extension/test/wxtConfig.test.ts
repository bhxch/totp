/**
 * wxt.config.ts manifest 断言（P3a，盘点 B6-29/30）：双渠道 MV3 差异零守护是发布风险——
 * - chrome 追加 offscreen 权限（clipboard 清空的后台承载前提）；firefox 无此权限（未知权限告警+无 API）
 * - firefox：gecko 稳定 id（AMO 一经发布不可改）、strict_min_version 140（2025 ESR 基线）、
 *   protocol_handlers ext+otpauth → /popup.html?uri=%s（协议回调入口）
 * - 顶层 manifestVersion: 3（WXT 0.19 会忽略 manifest 回调里的 manifest_version，只能顶层指定，
 *   该设置实际生效于 firefox）
 * - offscreen HTML entrypoint 以 manifest.include 仅对 chrome 产出（构建期排除 firefox 死文件）
 *
 * defineConfig 为 identity 直通，manifest 回调是纯函数——按 CLI -b 目标传 env 直调断言。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../wxt.config'

type ManifestEnv = { browser: 'chrome' | 'firefox' }
type Manifest = Record<string, unknown>

/** 直调 manifest 回调（生产由 WXT 按 -b chrome/firefox 注入 env） */
function manifestOf(browser: ManifestEnv['browser']): Manifest {
  return (config.manifest as (env: ManifestEnv) => Manifest)({ browser })
}

describe('wxt.config manifest 双渠道差异（B6-29/30）', () => {
  it('顶层统一 manifestVersion: 3 与基础信息', () => {
    expect(config.manifestVersion).toBe(3)
    expect(manifestOf('chrome').name).toBe('TOTP 验证码工具')
    expect(manifestOf('firefox').name).toBe('TOTP 验证码工具')
  })

  it('chrome：permissions 含 offscreen（后台清剪贴板前提）与双端共用权限', () => {
    const permissions = manifestOf('chrome').permissions as string[]
    expect(permissions).toContain('offscreen')
    for (const p of ['storage', 'unlimitedStorage', 'clipboardWrite', 'clipboardRead', 'activeTab', 'alarms', 'notifications', 'contextMenus', 'idle']) {
      expect(permissions).toContain(p)
    }
  })

  it('firefox：permissions 不含 offscreen（运行时经 canOffscreen 降级不调度）', () => {
    const permissions = manifestOf('firefox').permissions as string[]
    expect(permissions).not.toContain('offscreen')
    expect(permissions).toContain('clipboardRead') // 双端共用的手动粘贴导入
  })

  it('firefox：gecko 稳定 id + strict_min_version 140 + ext+otpauth 协议回调', () => {
    const gecko = (manifestOf('firefox').browser_specific_settings as { gecko?: Record<string, unknown> })?.gecko
    expect(gecko).toMatchObject({ id: 'totp@bhxch.github.io', strict_min_version: '140.0' })

    const handlers = manifestOf('firefox').protocol_handlers as Array<Record<string, unknown>>
    expect(handlers).toEqual([
      { protocol: 'ext+otpauth', name: 'TOTP 验证码工具', uriTemplate: '/popup.html?uri=%s' },
    ])
  })

  it('chrome：不携带 firefox 专属配置（gecko/protocol_handlers）', () => {
    const manifest = manifestOf('chrome')
    expect(manifest.browser_specific_settings).toBeUndefined()
    expect(manifest.protocol_handlers).toBeUndefined()
  })

  it('offscreen HTML entrypoint 标记 manifest.include 仅 chrome（构建期对 firefox 排除）', () => {
    const html = readFileSync(fileURLToPath(new URL('../entrypoints/offscreen/index.html', import.meta.url)), 'utf-8')
    expect(html).toContain(`<meta name="manifest.include" content='["chrome"]' />`)
  })
})
