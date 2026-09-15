import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { themeRoutes } from '@totp/ui'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'

// 5 页信息架构路由（hash 模式：Tauri 静态资源无服务端路由兜底）
const router = createRouter({ history: createWebHashHistory(), routes: themeRoutes })

createApp(App).use(router).mount('#app')
