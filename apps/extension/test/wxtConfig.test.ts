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
  it('顶层统一 manifestVersion: 3 与基础信息（name/description 经 _locales 本地化）', () => {
    expect(config.manifestVersion).toBe(3)
    // __MSG_ 由浏览器按 UI 语言替换（Chrome/Firefox 均支持）：英文商店审核员不再见中文硬编码名；
    // protocol_handlers.name 保留字面量（该字段本地化支持不一致，未替换会裸显 token）
    expect(manifestOf('chrome').name).toBe('__MSG_extName__')
    expect(manifestOf('firefox').name).toBe('__MSG_extName__')
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
    const bss = manifestOf('firefox').browser_specific_settings as {
      gecko?: Record<string, unknown>
      gecko_android?: Record<string, unknown>
    }
    // data_collection_permissions：AMO 新版必填（纯前端不出网 → required ['none']）；
    // gecko_android 142：该键 Android 端 142 才支持，平台最小版本单独抬高，
    // 否则 addons-linter 报 KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION
    expect(bss.gecko).toMatchObject({
      id: 'totp@bhxch.github.io',
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    })
    expect(bss.gecko_android).toMatchObject({ strict_min_version: '142.0' })

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

  it('双渠道：extension_pages CSP 放行 wasm-unsafe-eval（hash-wasm KDF 的 WASM 编译前提），不放松 eval/远程源', () => {
    // 事故背景：MV3 默认 CSP `script-src 'self'` 拦截 WebAssembly.compile——安全页设密直接报
    // CSP 违例，从文件恢复在 openBackupEnvelope 吞错后表现为「口令正确仍恢复失败」
    for (const browser of ['chrome', 'firefox'] as const) {
      const csp = (manifestOf(browser).content_security_policy as { extension_pages?: string } | undefined)?.extension_pages ?? ''
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
      expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval/) // 仅 wasm-unsafe-eval，禁止整段 unsafe-eval
      expect(csp).not.toMatch(/script-src[^;]*(http|https|blob:|data:)/)
      expect(csp).toContain("object-src 'self'")
    }
  })

  it('offscreen HTML entrypoint 标记 manifest.include 仅 chrome（构建期对 firefox 排除）', () => {
    const html = readFileSync(fileURLToPath(new URL('../entrypoints/offscreen/index.html', import.meta.url)), 'utf-8')
    expect(html).toContain(`<meta name="manifest.include" content='["chrome"]' />`)
  })
})
