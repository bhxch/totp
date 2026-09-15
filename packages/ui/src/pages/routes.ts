import type { RouteRecordRaw } from 'vue-router'

/** 5 页信息架构路由表(懒加载;`/` 重定向到首页「验证码」)。 */
export const themeRoutes: RouteRecordRaw[] = [
  { path: '/', redirect: '/codes' },
  { path: '/codes', name: 'codes', component: () => import('./CodesPage.vue') },
  { path: '/import', name: 'import', component: () => import('./ImportPage.vue') },
  { path: '/sync', name: 'sync', component: () => import('./SyncPage.vue') },
  { path: '/security', name: 'security', component: () => import('./SecurityPage.vue') },
  { path: '/settings', name: 'settings', component: () => import('./SettingsPage.vue') },
]
