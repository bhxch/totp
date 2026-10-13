import { createApp } from 'vue'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'

// WXT 无列表页：entrypoints/unlock/index.html → 构建产物 unlock.html，manifest 零声明。
// i18n 由 App.vue 内 createAppI18n(store) 装入（options 同款，store 为本页独立实例）
createApp(App).mount('#app')
