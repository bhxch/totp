import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { themeRoutes } from '@totp/ui'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'

// 与桌面同构的 5 页信息架构路由(hash 模式:静态页无服务端路由兜底,且 popup 深链 #/settings 依赖 hash)
const router = createRouter({ history: createWebHashHistory(), routes: themeRoutes })

createApp(App).use(router).mount('#app')
