<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MdNavigationRail from '../components/md/MdNavigationRail.vue'
import MdTabs from '../components/md/MdTabs.vue'
import type { BackupPlatform } from '../components/backupPlatform'
import type { CloudPlatform } from '../components/cloudPlatform'
import type { ImportSchemesApi } from '../components/importPlatform'
import type { SecurityPlatform } from '../components/securityPlatform'
import type { SyncPlatform } from '../components/syncPlatform'
import type { IconStore } from '../iconStore'
import type { VueStore } from '../store'
import { NAV_ICONS } from './navIcons'

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
  /** 图标存储 */
  icons?: IconStore | null
  /** 导入映射方案存取 */
  schemesApi?: ImportSchemesApi | null
  /** Rail 底部附加动作(桌面端如「打开托盘」);非空时 settings 页 showDesktop=true */
  railActions?: { label: string; onClick: () => void }[]
}>(), { store: null, platform: null, securityPlatform: null, syncPlatform: null, cloudPlatform: null, icons: null, schemesApi: null })

const route = useRoute()
const router = useRouter()

// 宿主剪贴板链路：仅 /codes 路由挂 copy 监听（其余页面未声明 copy emit，
// 恒挂会经 attrs 落到根元素变成原生 copy(DOM 事件) 监听，误传 ClipboardEvent）
const emit = defineEmits<{ copy: [code: string] }>()
const pageListeners = computed(() =>
  route.name === 'codes' ? { copy: (code: string) => emit('copy', code) } : {},
)

const navItems: { name: string; label: string; icon: string; to: string }[] = [
  { name: 'codes', label: '验证码', icon: NAV_ICONS.codes, to: '/codes' },
  { name: 'import', label: '导入', icon: NAV_ICONS.import, to: '/import' },
  { name: 'sync', label: '同步', icon: NAV_ICONS.sync, to: '/sync' },
  { name: 'security', label: '安全', icon: NAV_ICONS.security, to: '/security' },
  { name: 'settings', label: '设置', icon: NAV_ICONS.settings, to: '/settings' },
]

const active = computed(() => String(route.name ?? ''))

/** 窄窗(<600px)用顶部 Tabs;缺 matchMedia(SSR/测试)按宽窗渲染 Rail */
const isNarrow = ref(false)
let mql: MediaQueryList | null = null
const onMqlChange = (e: MediaQueryListEvent) => { isNarrow.value = e.matches }
onMounted(() => {
  if (typeof window.matchMedia !== 'function') return
  mql = window.matchMedia('(max-width: 599px)')
  isNarrow.value = mql.matches
  mql.addEventListener('change', onMqlChange)
})
onBeforeUnmount(() => { mql?.removeEventListener('change', onMqlChange); mql = null })

function onSelect(name: string) {
  const item = navItems.find((i) => i.name === name)
  if (item) void router.push(item.to)
}

/** 按路由名精确分发页面 props(与 Task 9-11 各页真实现的 prop 签名一一对应) */
const pageProps = computed<Record<string, unknown>>(() => {
  const p = props
  switch (route.name) {
    case 'codes': return { store: p.store, icons: p.icons }
    case 'import': return { store: p.store, platform: p.platform, schemesApi: p.schemesApi }
    case 'sync': return { store: p.store, platform: p.platform, cloudPlatform: p.cloudPlatform, syncPlatform: p.syncPlatform }
    case 'security': return { securityPlatform: p.securityPlatform }
    case 'settings': return { store: p.store, securityPlatform: p.securityPlatform, showDesktop: (p.railActions?.length ?? 0) > 0, showExtension: p.syncPlatform != null }
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
.nav-shell { display: flex; min-height: 100dvh; }
.nav-shell--narrow { flex-direction: column; }
.nav-shell__main { flex: 1; min-width: 0; }
.nav-shell__rail-action { border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-on-surface-variant); padding: 8px 4px; border-radius: 8px;
  transition: background-color .15s; }
.nav-shell__rail-action:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.nav-shell__rail-action:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
