<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import MdNavigationRail from '../components/md/MdNavigationRail.vue'
import MdTabs from '../components/md/MdTabs.vue'
import type { BackupPlatform } from '../components/backupPlatform'
import type { CloudPlatform } from '../components/cloudPlatform'
import type { DevtoolsPlatform } from '../components/devtoolsPlatform'
import type { ImportSchemesApi } from '../components/importPlatform'
import type { McpPlatform } from '../components/mcpCard'
import type { SecurityPlatform } from '../components/securityPlatform'
import type { SyncPlatform } from '../components/syncPlatform'
import type { IconStore } from '../iconStore'
import type { VueStore } from '../store'
import { NAV_ICONS } from './navIcons'

/** 窄窗断点查询串（<600px）：isNarrow 初值测量与 change 监听共用同一 Media Query */
const NARROW_MQ = '(max-width: 599px)'

// props = 旧单页 全量(旧单页 的 enableCopy 属列表行为,不属于壳)+
// railActions;均可缺省,popup 等窄宿主零影响。
const props = withDefaults(defineProps<{
  /** 全局响应式 store;Task 9-11 页面真实现按 pageProps 消费 */
  store?: VueStore | null
  /** 备份平台实现;null/缺省 import 页仅展示 store 相关区 */
  platform?: BackupPlatform | null
  /** 安全平台实现;null/缺省 security/settings 相关区不渲染 */
  securityPlatform?: SecurityPlatform | null
  /** 浏览器同步平台实现;null/缺省时 settings 页 showExtension=false */
  syncPlatform?: SyncPlatform | null
  /** 云同步平台实现 */
  cloudPlatform?: CloudPlatform | null
  /** 云凭据失效标志（跨端同步 T4）；true 时 sync 页 SyncCard 渲染重授权警示 */
  cloudAuthFailed?: boolean
  /** 图标存储 */
  icons?: IconStore | null
  /** 导入映射方案存取 */
  schemesApi?: ImportSchemesApi | null
  /** Rail 底部附加动作(桌面端如「打开托盘」);非空时 settings 页 showDesktop=true */
  railActions?: { label: string; onClick: () => void }[]
  /** MCP 平台实现(桌面端);null/缺省 settings 页 MCP 卡不渲染 */
  mcpPlatform?: McpPlatform | null
  /** 开发者平台实现(桌面端 devtools_* 命令);null/缺省 settings 页开发者卡不渲染 */
  devtoolsPlatform?: DevtoolsPlatform | null
}>(), { store: null, platform: null, securityPlatform: null, syncPlatform: null, cloudPlatform: null, cloudAuthFailed: false, icons: null, schemesApi: null, mcpPlatform: null, devtoolsPlatform: null })

const route = useRoute()
const router = useRouter()
// D1 抽串示范：导航项文案走 i18n（nav.*）。computed 保持 locale 切换后 Rail/Tabs 文案联动
const { t } = useI18n()

// 宿主剪贴板链路：仅 /codes 路由挂 copy 监听（其余页面未声明 copy emit，
// 恒挂会经 attrs 落到根元素变成原生 copy(DOM 事件) 监听，误传 ClipboardEvent）
const emit = defineEmits<{ copy: [code: string] }>()
const pageListeners = computed(() =>
  route.name === 'codes' ? { copy: (code: string) => emit('copy', code) } : {},
)

const navItems = computed<{ name: string; label: string; icon: string; to: string }[]>(() => [
  { name: 'codes', label: t('nav.codes'), icon: NAV_ICONS.codes, to: '/codes' },
  { name: 'import', label: t('nav.import'), icon: NAV_ICONS.import, to: '/import' },
  { name: 'sync', label: t('nav.sync'), icon: NAV_ICONS.sync, to: '/sync' },
  { name: 'security', label: t('nav.security'), icon: NAV_ICONS.security, to: '/security' },
  { name: 'settings', label: t('nav.settings'), icon: NAV_ICONS.settings, to: '/settings' },
])

const active = computed(() => String(route.name ?? ''))

/** 窄窗(<600px)用顶部 Tabs。审查 Minor：setup 同步测量初值（原 onMounted 才测，窄窗首帧
 *  先渲染 Rail 再闪变 Tabs）；本组件纯 CSR，缺 matchMedia 的环境兜底宽窗渲染 Rail */
const isNarrow = ref(
  typeof window.matchMedia === 'function' && window.matchMedia(NARROW_MQ).matches,
)
let mql: MediaQueryList | null = null
const onMqlChange = (e: MediaQueryListEvent) => { isNarrow.value = e.matches }
onMounted(() => {
  if (typeof window.matchMedia !== 'function') return
  mql = window.matchMedia(NARROW_MQ)
  mql.addEventListener('change', onMqlChange)
})
onBeforeUnmount(() => { mql?.removeEventListener('change', onMqlChange); mql = null })

function onSelect(name: string) {
  const item = navItems.value.find((i) => i.name === name)
  if (item) void router.push(item.to)
}

/** 按路由名精确分发页面 props(与 Task 9-11 各页真实现的 prop 签名一一对应) */
const pageProps = computed<Record<string, unknown>>(() => {
  const p = props
  switch (route.name) {
    // saveImageFile（批① §2.5 多选拼版保存）随备份平台分发到 codes 页；宿主未实现时 undefined → CodesPage 隐藏「保存图片」
    case 'codes': return { store: p.store, icons: p.icons, saveImage: p.platform?.saveImageFile?.bind(p.platform) }
    case 'import': return { store: p.store, platform: p.platform, schemesApi: p.schemesApi }
    case 'sync': return { store: p.store, platform: p.platform, cloudPlatform: p.cloudPlatform, syncPlatform: p.syncPlatform, cloudAuthFailed: p.cloudAuthFailed }
    case 'security': return { securityPlatform: p.securityPlatform }
    case 'settings': return { store: p.store, securityPlatform: p.securityPlatform, showDesktop: (p.railActions?.length ?? 0) > 0, showExtension: p.syncPlatform != null, mcpPlatform: p.mcpPlatform ?? null, devtoolsPlatform: p.devtoolsPlatform ?? null }
    default: return {}
  }
})
</script>
<template>
  <div class="nav-shell" :class="{ 'nav-shell--narrow': isNarrow }">
    <MdNavigationRail v-if="!isNarrow" :items="navItems" :active="active" @select="onSelect">
      <template #actions>
        <button v-for="a in railActions" :key="a.label" type="button" class="nav-shell__rail-action"
          @click="a.onClick">{{ a.label }}</button>
      </template>
    </MdNavigationRail>
    <MdTabs v-else :items="navItems" :active="active" @select="onSelect" />
    <main class="nav-shell__main">
      <router-view v-slot="{ Component }">
        <component :is="Component" v-bind="pageProps" v-on="pageListeners" />
      </router-view>
    </main>
  </div>
</template>
<style scoped>
/* 壳层锁高：rail 固定、内容区内部滚动（spec 批⑧ §4）；窄屏顶部 Tabs 布局维持文档流整页滚动 */
.nav-shell { display: flex; height: 100dvh; overflow: hidden; }
.nav-shell--narrow { flex-direction: column; height: auto; overflow: visible; }
.nav-shell__main { flex: 1; min-width: 0; overflow-y: auto; }
.nav-shell__rail-action { border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-on-surface-variant); padding: 8px 4px; border-radius: 8px;
  transition: background-color .15s; }
.nav-shell__rail-action:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.nav-shell__rail-action:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
