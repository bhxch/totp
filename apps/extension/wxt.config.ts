import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  // 双目标统一 MV3（spec 批⑧ §1）。WXT 0.19 会删除并警告忽略 manifest 回调里的
  // manifest_version，只能用顶层 manifestVersion 选项指定（chrome 默认即 3，此设置实际生效于 firefox）；
  // firefox MV3 的 background 由 WXT 产出为 scripts（event page）——代码已按事件驱动编写
  manifestVersion: 3,
  // manifest 按目标浏览器差异化：env.browser 来自 CLI -b/--browser（默认 chrome）。
  manifest: ({ browser }) => ({
    // 商店列表/浏览器展示面本地化（__MSG_ 由浏览器按 UI 语言替换，Chrome/Firefox 均支持）：
    // 英文商店审核员此前看到中文硬编码名；消息表在 public/_locales/{zh_CN,en}/messages.json，
    // background 菜单/通知经 chrome.i18n.getMessage 复用同一套。default_locale 为 Chrome
    // 携 _locales 时的必填项（未命中 locale 的回退语言）
    default_locale: 'zh_CN',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
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
    // 云同步（WebDAV/S3 等）请求全部经 background SW 出网：SW 携 host_permissions 时
    // fetch 不受页面 CORS 限制，页面层 setCloudFetch 注入 background 代理（cloudFetchProxy）
    host_permissions: ['http://*/*', 'https://*/*'],
    // hash-wasm（argon2id/scrypt，安全页加密与备份信封的 KDF）运行时 WebAssembly 编译
    // 内嵌 WASM：MV3 默认 CSP `script-src 'self'` 会将其拦截（安全页设密报 CSP 违例、
    // 从文件恢复在 openBackupEnvelope 内被吞成 invalid envelope）。MV3 仅放行
    // 'wasm-unsafe-eval'（chrome 88+/firefox 102+ 均支持，仍禁止 eval/远程代码），
    // 其余保持各渠道默认口径：object-src 'self' + upgrade-insecure-requests
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; upgrade-insecure-requests",
    },
    ...(browser === 'firefox'
      ? {
          // 稳定 ID（AMO 一经发布不可改）：email 形式合规且表达 GitHub 归属；
          // min_version 140（2025 ESR 基线，MV3 所需 API 全齐：storage.session 115+/event page/SW 121+）；
          // 数据收集声明（AMO 2025 起新版必填，缺失上报 MISSING_DATA_COLLECTION_PERMISSIONS）：
          // 纯前端离线工具不出网收集任何数据，按政策口径申报 required: ['none']；
          // 该键 Android 端 142 才支持，gecko_android 平台最小版本单独抬高（桌面 140 不动），
          // 否则 addons-linter 报 KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION
          browser_specific_settings: {
            gecko: {
              id: 'totp@bhxch.github.io',
              strict_min_version: '140.0',
              data_collection_permissions: { required: ['none'] },
            },
            gecko_android: { strict_min_version: '142.0' },
          },
          // protocol_handlers.name 不走 __MSG_：该字段的本地下化支持在浏览器间不一致，
          // 未替换时会以裸 "__MSG_extName__" 出现在 Firefox 协议注册提示框——保留字面量
          protocol_handlers: [
            { protocol: 'ext+otpauth', name: 'TOTP 验证码工具', uriTemplate: '/popup.html?uri=%s' },
          ],
        }
      : {}),
  }),
})
