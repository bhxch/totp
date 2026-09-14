import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'TOTP 验证码工具',
    description: '纯前端 TOTP 验证码管理',
    // 图标由 scripts/gen-app-icons.ps1 生成到 public/icon/<size>.png（WXT 不会从 icon.png 自动生成 icons 字段）
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
    // offscreen：popup 关闭后由 background 经 offscreen document 清剪贴板；alarms：30s 定时触发
    permissions: ['storage', 'clipboardWrite', 'activeTab', 'alarms', 'offscreen'],
  },
})
