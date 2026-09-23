import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  // 双目标统一 MV3（spec 批⑧ §1）。WXT 0.19 会删除并警告忽略 manifest 回调里的
  // manifest_version，只能用顶层 manifestVersion 选项指定（chrome 默认即 3，此设置实际生效于 firefox）；
  // firefox MV3 的 background 由 WXT 产出为 scripts（event page）——代码已按事件驱动编写
  manifestVersion: 3,
  // manifest 按目标浏览器差异化：env.browser 来自 CLI -b/--browser（默认 chrome）。
  manifest: ({ browser }) => ({
    name: 'TOTP 验证码工具',
    description: '纯前端 TOTP 验证码管理',
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
    // offscreen 仅 Chrome MV3 合法（Firefox 未知权限会告警，且无该 API——运行时降级见 capabilities）；
    // clipboardRead：手动表单「从剪贴板导入」（双端）；其余权限说明见 git history
    permissions: [
      'storage', 'unlimitedStorage', 'clipboardWrite', 'activeTab', 'alarms', 'notifications', 'contextMenus', 'idle',
      ...(browser === 'chrome' ? ['offscreen'] : []),
      'clipboardRead',
    ],
    ...(browser === 'firefox'
      ? {
          // 稳定 ID（AMO 一经发布不可改）：email 形式合规且表达 GitHub 归属；
          // min_version 140（2025 ESR 基线，MV3 所需 API 全齐：storage.session 115+/event page/SW 121+）
          browser_specific_settings: { gecko: { id: 'totp@bhxch.github.io', strict_min_version: '140.0' } },
          protocol_handlers: [
            { protocol: 'ext+otpauth', name: 'TOTP 验证码工具', uriTemplate: '/popup.html?uri=%s' },
          ],
        }
      : {}),
  }),
})
