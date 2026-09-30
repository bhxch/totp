import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { themeRoutes } from '@totp/ui'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'
// ③ 桌面云备份出网注入：cloudFetch 走 Rust cloud_http_fetch（reqwest 无 CORS，每源 proxy 生效）
import { installTauriCloudFetch } from './cloudHttp'

installTauriCloudFetch()

// 5 页信息架构路由（hash 模式：Tauri 静态资源无服务端路由兜底）
const router = createRouter({ history: createWebHashHistory(), routes: themeRoutes })

createApp(App).use(router).mount('#app')
