import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  // manifest 按目标浏览器差异化：env.browser 来自 CLI -b/--browser（默认 chrome）
  manifest: ({ browser }) => ({
    name: 'TOTP 验证码工具',
    description: '纯前端 TOTP 验证码管理',
    // 图标由 scripts/gen-app-icons.ps1 生成到 public/icon/<size>.png（WXT 不会从 icon.png 自动生成 icons 字段）
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
    // offscreen：popup 关闭后由 background 经 offscreen document 清剪贴板；alarms：30s 定时触发；
    // unlimitedStorage：图标包导入的 dataUrl 存 chrome.storage.local，不受 10MB 配额限制；
    // notifications：右键菜单导入选中文本非 otpauth 时提示；
    // contextMenus：右键菜单 otpauth-add 注册（Chromium 下无此权限 API 不可用、菜单静默不显示）
    permissions: ['storage', 'unlimitedStorage', 'clipboardWrite', 'activeTab', 'alarms', 'offscreen', 'notifications', 'contextMenus'],
    // 仅 Firefox 目标注册协议处理器：
    // - Firefox schema（extension_protocol_handlers.json）仅允许白名单 scheme 或 ext+/web+ 前缀，
    //   裸 otpauth 会被硬校验拒绝导致扩展装不上，故注册 ext+otpauth（popup 端还原为 otpauth:// 预填）
    // - Chrome 扩展不支持该字段（对未知字段仅告警），不注入保持 chrome 产物干净
    ...(browser === 'firefox'
      ? {
          // 稳定 ID：Firefox 临时加载与协议处理器注册需要固定扩展身份
          browser_specific_settings: { gecko: { id: 'totp-tools@example.local' } },
          protocol_handlers: [
            // WXT 将 entrypoints/popup/index.html 输出为根目录 popup.html，uriTemplate 必须指向实际产物路径
            { protocol: 'ext+otpauth', name: 'TOTP 验证码工具', uriTemplate: '/popup.html?uri=%s' },
          ],
        }
      : {}),
  }),
})
