import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { themeRoutes } from '@totp/ui'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'
// ③ 桌面云备份出网注入：cloudFetch 走 Rust cloud_http_fetch（reqwest 无 CORS，每源 proxy 生效）
import { installTauriCloudFetch } from './cloudHttp'
// R2-I1：主窗已禁用 drag-drop handler（lib.rs），文件拖入未 preventDefault 区域会导航 file://
import { installDragDropGuard } from './dragDropGuard'

installTauriCloudFetch()
installDragDropGuard()

// 5 页信息架构路由（hash 模式：Tauri 静态资源无服务端路由兜底）
const router = createRouter({ history: createWebHashHistory(), routes: themeRoutes })

createApp(App).use(router).mount('#app')
