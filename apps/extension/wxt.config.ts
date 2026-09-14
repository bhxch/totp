import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'TOTP 验证码工具',
    description: '纯前端 TOTP 验证码管理',
    // offscreen：popup 关闭后由 background 经 offscreen document 清剪贴板；alarms：30s 定时触发
    permissions: ['storage', 'clipboardWrite', 'activeTab', 'alarms', 'offscreen'],
  },
})
