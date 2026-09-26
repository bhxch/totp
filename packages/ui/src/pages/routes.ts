import type { RouteRecordRaw } from 'vue-router'
import type { BackupPlatform } from '../components/backupPlatform'
import type { CloudPlatform } from '../components/cloudPlatform'
import type { DevtoolsPlatform } from '../components/devtoolsPlatform'
import type { ImportSchemesApi } from '../components/importPlatform'
import type { McpPlatform } from '../components/mcpCard'
import type { ReleasePlatform } from '../components/releasePlatform'
import type { SecurityPlatform } from '../components/securityPlatform'
import type { SyncPlatform } from '../components/syncPlatform'
import type { IconStore } from '../iconStore'
import type { VueStore } from '../store'

/** 5 页信息架构路由表(懒加载;`/` 重定向到首页「验证码」)。
 *  R16③ 单点:导航目的地、navItems、pageProps 三份知识都由本表派生,新增页面只改这里 */
export const themeRoutes: RouteRecordRaw[] = [
  { path: '/', redirect: '/codes' },
  { path: '/codes', name: 'codes', component: () => import('./CodesPage.vue') },
  { path: '/import', name: 'import', component: () => import('./ImportPage.vue') },
  { path: '/sync', name: 'sync', component: () => import('./SyncPage.vue') },
  { path: '/security', name: 'security', component: () => import('./SecurityPage.vue') },
  { path: '/settings', name: 'settings', component: () => import('./SettingsPage.vue') },
  // 审查 Minor：catch-all 兜底——错误 hash 深链（如 #/setings）回首页「验证码」，防空白页
  { path: '/:pathMatch(.*)*', redirect: '/codes' },
]

/** 导航页登记（R16③ 派生）：themeRoutes 中带 name+component 的条目即 Rail/Tabs 目的地
 *  （redirect 与 catch-all 兜底不进 nav）；顺序随路由表。label/icon 由 NavigationShell 按
 *  nav.<name> / NAV_ICONS[name] 填充，本表不持文案 */
function isNavRoute(r: RouteRecordRaw): r is RouteRecordRaw & { name: string; path: string } {
  return typeof r.name === 'string' && typeof r.path === 'string' && 'component' in r && r.component !== undefined
}
export const navRoutes = themeRoutes.flatMap((r) =>
  isNavRoute(r) ? [{ name: r.name as keyof PagePropsByName, path: r.path }] : [],
)

/** 壳层可供分发的 props（NavigationShell withDefaults 后的形状；类型单一来源） */
export interface PagePropsDeps {
  store: VueStore | null
  platform: BackupPlatform | null
  securityPlatform: SecurityPlatform | null
  syncPlatform: SyncPlatform | null
  cloudPlatform: CloudPlatform | null
  cloudAuthFailed: boolean
  icons: IconStore | null
  schemesApi: ImportSchemesApi | null
  railActions?: { label: string; onClick: () => void }[]
  mcpPlatform: McpPlatform | null
  devtoolsPlatform: DevtoolsPlatform | null
  releasePlatform: ReleasePlatform | null
}

/** 路由名 → 页面 props 映射（R16③）：pageProps 装配表的值类型逐页锁定，恢复此前
 *  Record<string, unknown> switch 丢失的类型检查；与各页 defineProps 的分发面一一对应 */
export interface PagePropsByName {
  codes: { store: VueStore | null; icons: IconStore | null; saveImage?: (name: string, dataUrl: string) => Promise<boolean> }
  import: { store: VueStore | null; platform: BackupPlatform | null; schemesApi: ImportSchemesApi | null }
  sync: { store: VueStore | null; platform: BackupPlatform | null; cloudPlatform: CloudPlatform | null; syncPlatform: SyncPlatform | null; cloudAuthFailed: boolean }
  security: { securityPlatform: SecurityPlatform | null }
  settings: { store: VueStore | null; securityPlatform: SecurityPlatform | null; showDesktop: boolean; showExtension: boolean; mcpPlatform: McpPlatform | null; devtoolsPlatform: DevtoolsPlatform | null; releasePlatform: ReleasePlatform | null }
}

/** 页面 props 装配表（映射类型：每键的返回形状由 PagePropsByName[N] 单独核对，键完整性
 *  由 PageName 编译期锁定）。saveImage 绑定时机=分发时（宿主未实现 → undefined，页面隐藏入口） */
export const pagePropsBuilders: { [N in keyof PagePropsByName]: (p: PagePropsDeps) => PagePropsByName[N] } = {
  codes: (p) => ({ store: p.store, icons: p.icons, saveImage: p.platform?.saveImageFile?.bind(p.platform) }),
  import: (p) => ({ store: p.store, platform: p.platform, schemesApi: p.schemesApi }),
  sync: (p) => ({ store: p.store, platform: p.platform, cloudPlatform: p.cloudPlatform, syncPlatform: p.syncPlatform, cloudAuthFailed: p.cloudAuthFailed }),
  security: (p) => ({ securityPlatform: p.securityPlatform }),
  settings: (p) => ({ store: p.store, securityPlatform: p.securityPlatform, showDesktop: (p.railActions?.length ?? 0) > 0, showExtension: p.syncPlatform != null, mcpPlatform: p.mcpPlatform ?? null, devtoolsPlatform: p.devtoolsPlatform ?? null, releasePlatform: p.releasePlatform ?? null }),
}
