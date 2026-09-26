<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { StorageAdapter } from '@totp/core'
import { createAppI18n, LockScreen, NavigationShell, type IconStore, type VueStore } from '@totp/ui'
import { computed, getCurrentInstance, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { createDesktopAutoChannels } from './autoBackup'
import { createBackupPlatform, createImportSchemesApi } from './backupPlatform'
import { createCloudPlatform, createDesktopCloudSync } from './cloudPlatforms'
import { createDesktopCopy } from './desktopCopy'
import {
  createDesktopApprovalQueue, createDesktopMcpDeps, createDesktopShell, createDevtoolsPlatform, createLegacyMigrations,
  createMcpConsentFlow, createMcpPlatform, createReleasePlatform,
} from './desktopShell'
import { createSecurityPlatform } from './securityPlatform'
import { desktopUaFlags, unlockNamingFor } from './unlockNaming'

// store 必须浅包装（T14 审查根修）：深 ref 会对值做 reactive 深代理，代理 get 对嵌套
// ref/computed 成员自动解包——闭包 `store.value.locked.value` / 组件 prop `props.store.X.value`
// 在深 ref 下全部得 undefined/TypeError（探针 storeWrap.test 实证），曾致自动备份/云同步恒跳过、
// creds/kdfProfile/锁定判定全族失效。shallowRef 下 .value 即原始对象，成员保持真 ref 语义；
// vault/settings 自身是 reactive，响应式不受影响。模板顶层解包只解一层，locked 经下方 computed 暴露。
// P4 拆分后本组件为薄壳：模板消费的响应式宿主 + i18n 胶水 + 各工厂装配 + 壳层编排挂载。
const store = shallowRef<VueStore | null>(null)
/** 模板锁定态（shallowRef 嵌套成员不再被模板隐式解包，显式顶层暴露） */
const locked = computed(() => store.value?.locked.value ?? false)
const icons = ref<IconStore | null>(null)
const loadError = ref('')
// D1 i18n 挂载（store 就绪后装入，见 mountI18n）：app 引用必须在 setup 同步段获取
// （onMounted await 之后 instance 上下文已失效）；本组件 store 仅在挂载时创建一次
const appForI18n = getCurrentInstance()?.appContext.app
let i18nInstalled = false
// D2 抽串：壳层 t() 走捕获的 i18n 实例（本组件 script setup 内 useI18n 注入不可用，沿 options 页口径）。
// 未装入（初始化失败等）时兜底回原文 key
const i18nRef = shallowRef<ReturnType<typeof createAppI18n> | null>(null)
function tr(key: string, params: Record<string, unknown> = {}): string {
  return i18nRef.value ? i18nRef.value.global.t(key, params) : key
}
function mountI18n(s: VueStore): void {
  if (appForI18n && !i18nInstalled) {
    const i18nInst = createAppI18n(s)
    appForI18n.use(i18nInst)
    i18nRef.value = i18nInst
    i18nInstalled = true
  }
}

// ---------- 共享闭包（各平台工厂的单一事实源）----------
// adapter 在壳层 init（createTauriFs）就绪后经 setAdapter 赋值；工厂闭包实时读取
// （旧单页 仅在 store 就绪后渲染，不会读到 null）
let fsAdapter: StorageAdapter | null = null
const getAdapter = (): StorageAdapter | null => fsAdapter
const getStore = (): VueStore | null => store.value

// ---------- 平台与 runner 装配（各工厂模块，setup 期一次性装配）----------
// 导入映射方案存取（坏 JSON → 空表容错）与备份平台 18 成员（含 lastImportPick 成对缓存、
// 对话框过滤器调用时取词）抽至 backupPlatform.ts
const schemesApi = createImportSchemesApi({ getAdapter })
const backupPlatform = createBackupPlatform({ getStore, getAdapter, tr })
// 云平台与自动云 runner（revSeal 三态/retentionNotes 拼接后清空内聚工厂）抽至 cloudPlatforms.ts
const cloudPlatform = createCloudPlatform({ getStore, getAdapter, tr })
const cloudSync = createDesktopCloudSync({ getStore, getAdapter, tr })
// 自动备份双通道装配抽至 autoBackup.ts：store 未就绪时 isLocked 兜底 true → decideAutoRun skip，
// 保证锁定态/未初始化永不自动写
const auto = createDesktopAutoChannels({ getStore, getAdapter, doCloudSync: () => cloudSync.run() })
// 安全平台（dpapi 通道/F3 迁移/UA 命名）抽至 securityPlatform.ts + unlockNaming.ts；
// naming 保持「调用时求值」：computed 求值与 label getter 读取均在 i18n 装入后，
// 经 tr 内部 locale ref 建立响应依赖（locale 切换联动）
const ua = navigator.userAgent
const uaFlags = desktopUaFlags(ua)
const unlockNaming = () => unlockNamingFor(uaFlags, tr)
const securityFactory = createSecurityPlatform({ getStore, tr, naming: unlockNaming, flags: uaFlags, ua })
const dpapiOps = securityFactory.dpapi
const securityPlatform = securityFactory.platform
const migrateDekWrapToEntropyBound = securityFactory.migrateDekWrapToEntropyBound
// 旧数据迁移编排（双汇合点：壳层 initStore 后 + LockScreen @unlocked）抽至 desktopShell.ts
const runLegacyMigrations = createLegacyMigrations({ getStore, getAdapter, migrateDekWrapToEntropyBound })

// ---------- 复制编排 / 审批队列 / 配置平台 ----------
// 复制失败横幅（stage 拒绝 3s）与 30s 清剪贴板武装抽至 desktopCopy.ts；Rust 边界在此接线
const { copyFailed, copyToClipboard } = createDesktopCopy({
  isEnabled: () => store.value?.settings.clipboardClearEnabled === true,
  stage: (value) => invoke('stage_clipboard_write', { value }).then(() => {}),
  clearIfStaged: () => invoke('clipboard_clear_if_staged').then(() => {}),
})
// 首连审批队列（原单槽位 approval 的并发根修，见 mcpApprovalQueue.ts）。审批窗独立于锁定态
// （锁定时取码在桥内报 vault locked，属预期）；队列创建与回执接线抽至 desktopShell.ts
const approvalQueue = createDesktopApprovalQueue()
/** 模板消费的队首待审批；null=无待审批 */
const approval = approvalQueue.current
const { onApprovalAction, onToolAllow, onConsentClose } = createMcpConsentFlow(approvalQueue)
// MCP/远程调试/释放策略配置平台适配器抽至 desktopShell.ts
const mcpPlatform = createMcpPlatform({ copyText: (value) => copyToClipboard(value) })
const devtoolsPlatform = createDevtoolsPlatform()
const releasePlatform = createReleasePlatform()
// MCP 桥依赖（requireEntries 锁定门控/tagsOf/triggers 前置判定）抽至 desktopShell.ts
const mcpDeps = createDesktopMcpDeps({
  getStore,
  runSync: () => cloudSync.run('manual'),
  runBackup: () => auto.runBackupNow(),
})

// ---------- 壳层编排（onMounted 初始化全编排 + 卸载清理，时序=行为契约）----------
const shell = createDesktopShell({
  store,
  icons,
  loadError,
  setAdapter: (a) => { fsAdapter = a },
  auto,
  mountI18n,
  runLegacyMigrations,
  approvalQueue,
  mcpDeps,
})
onMounted(() => { void shell.init() })
onScopeDispose(() => shell.dispose())

/** Rail 底部「隐藏到托盘」：原 header 按钮迁移为 Shell 动作（失焦自动隐藏开关迁至设置页）。
 *  label 用 getter 读取时取词（Shell 渲染期晚于 i18n 装入，随 locale 联动） */
const railActions = [{ get label() { return tr('desktop.hideToTray') }, onClick: () => void getCurrentWindow().hide() }]
</script>
<template>
  <div v-if="copyFailed" class="copy-failed" role="alert">{{ tr('desktop.copyFailed') }}</div>
  <div v-if="loadError && !store" class="error">{{ tr('desktop.loadFailed', { message: loadError }) }}</div>
  <!-- 解锁成功回调补跑迁移（plan16 T14，幂等）：口令/PRF 解锁各路径在 LockScreen 内 emit unlocked -->
  <LockScreen v-else-if="store && locked" :store="store" :dpapi="dpapiOps" @unlocked="runLegacyMigrations" />
  <NavigationShell v-else-if="store" :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :cloud-platform="cloudPlatform" :icons="icons" :schemes-api="schemesApi" :rail-actions="railActions" :mcp-platform="mcpPlatform" :devtools-platform="devtoolsPlatform" :release-platform="releasePlatform" @copy="copyToClipboard" />
  <!-- MCP 首连审批/工具确认独立于上方 v-if 链：锁定态也要能弹（plan17 T10）；t 走壳层 tr（desktop 无 useI18n 注入） -->
  <!-- 关闭（Esc/遮罩/工具 Deny）按通道分流 deny：首连回执进 60s 冷却，工具确认回 result:false（逐次即焚）——
       否则 "approval pending" 诱导 AI 每 10s 重试、对话框反复重开抢焦点 -->
  <McpConsentDialog :open="approval !== null" :request="approval" :t="tr" @resolve="onApprovalAction" @allow="onToolAllow" @close="onConsentClose" />
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.error { color: var(--md-sys-color-error); padding: 16px; }
.copy-failed { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 1000; color: var(--md-sys-color-error); background: var(--md-sys-color-error-container); border-radius: 8px; padding: 8px 16px; font-size: var(--md-sys-typescale-body-medium); box-shadow: 0 1px 3px var(--md-sys-color-shadow); }
</style>
