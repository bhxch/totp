import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'TOTP 验证码工具',
    description: '纯前端 TOTP 验证码管理',
    permissions: ['storage', 'clipboardWrite'],
  },
})
