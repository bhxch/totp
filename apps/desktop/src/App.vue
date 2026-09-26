<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { base64ToBytes, bytesToBase64, type StorageAdapter } from '@totp/core'
import { createAppI18n, createClipboardClearer, createIconStore, createVueStore, LockScreen, NavigationShell, useTheme, type DevtoolsConfigDto, type DevtoolsPlatform, type IconStore, type McpConfigWithStatusDto, type McpPlatform, type ReleasePolicyDto, type ReleasePlatform, type VueStore } from '@totp/ui'
import { computed, getCurrentInstance, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { createDesktopAutoChannels } from './autoBackup'
import { createBackupPlatform, createImportSchemesApi } from './backupPlatform'
import { createCloudPlatform, createDesktopCloudSync } from './cloudPlatforms'
import { BACKUP_KEEP_N_KEY, BACKUP_MODE_KEY, legacyRetention } from './desktopPrefs'
import { createIdleLockExecutor } from './idleLock'
import { BACKUP_DIR_KEY, migrateLegacyCloudSources, migrateLegacyLocalSource } from './legacyMigrate'
import { createMcpApprovalQueue, isToolConfirmItem, type McpApprovalAction } from './mcpApprovalQueue'
import { createMcpTriggers, startMcpBridge, type McpBridgeDeps } from './mcpBridge'
import McpConsentDialog from './McpConsentDialog.vue'
import { createSecurityPlatform } from './securityPlatform'
import { createTauriFs } from './tauriFs'
import { desktopUaFlags, unlockNamingFor } from './unlockNaming'

// store 必须浅包装（T14 审查根修）：深 ref 会对值做 reactive 深代理，代理 get 对嵌套
// ref/computed 成员自动解包——闭包 `store.value.locked.value` / 组件 prop `props.store.X.value`
// 在深 ref 下全部得 undefined/TypeError（探针 storeWrap.test 实证），曾致自动备份/云同步恒跳过、
// creds/kdfProfile/锁定判定全族失效。shallowRef 下 .value 即原始对象，成员保持真 ref 语义；
// vault/settings 自身是 reactive，响应式不受影响。模板顶层解包只解一层，locked 经下方 computed 暴露
const store = shallowRef<VueStore | null>(null)
/** 模板锁定态（shallowRef 嵌套成员不再被模板隐式解包，显式顶层暴露） */
const locked = computed(() => store.value?.locked.value ?? false)
const icons = ref<IconStore | null>(null)
const loadError = ref('')
let unlistenFocus: (() => void) | null = null
// 释放策略联动监听（Task 14）：force-lock=暂停/销毁锁库；stash-dek-request=销毁不锁库路径先上报 DEK
let unlistenForceLock: (() => void) | null = null
let unlistenStashDek: (() => void) | null = null
// D1 i18n 挂载（store 就绪后装入，见 onMounted 内 mountI18n）：app 引用必须在 setup 同步段获取
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

/** platform 工厂与迁移共用的就绪断言：store/adapter 未就绪时统一中文报错（卡片展示） */
function requireStore(): VueStore {
  const s = store.value
  if (!s) throw new Error('数据尚未就绪')
  return s
}

// ---------- 导入映射方案存取 ----------
// adapter 在 onMounted 就绪后赋值；schemesApi/backupPlatform 工厂闭包实时读取（旧单页 仅在 store 就绪后渲染，不会读到 null）
let fsAdapter: StorageAdapter | null = null
const getAdapter = (): StorageAdapter | null => fsAdapter
const getStore = (): VueStore | null => store.value

function requireAdapter(): StorageAdapter {
  if (!fsAdapter) throw new Error('数据尚未就绪')
  return fsAdapter
}

// 导入映射方案存取（坏 JSON → 空表容错）与备份平台 18 成员抽至 backupPlatform.ts 工厂
// （含 lastImportPick 成对缓存与对话框过滤器调用时取词）
const schemesApi = createImportSchemesApi({ getAdapter })

const backupPlatform = createBackupPlatform({ getStore, getAdapter, tr })

// 自动备份双通道装配（runner 本体与 deps 接线）抽至 autoBackup.ts createDesktopAutoChannels：
// store 未就绪时 isLocked 兜底 true → decideAutoRun skip，保证锁定态/未初始化永不自动写
const auto = createDesktopAutoChannels({ getStore, getAdapter, doCloudSync: () => cloudSync.run() })

/**
 * 云同步平台与自动云 runner 装配抽至 cloudPlatforms.ts（createCloudPlatform/
 * createDesktopCloudSync/revSeal）：retentionNotes 拼接后清空与 cloudSourceNames 缓存内聚工厂，
 * rev 基线 seal 三态（锁定态拒落明文）可直测；saveConflictBackup 接线形状
 * (key, bytes) => saveConflictBackupToDir(bytes, null, key) 逐字保持（cloudSyncConflict 探针口径）。
 */
const cloudPlatform = createCloudPlatform({ getStore, getAdapter, tr })
const cloudSync = createDesktopCloudSync({ getStore, getAdapter, tr })

/** F3 迁移、dpapi 通道与安全平台装配抽至 securityPlatform.ts（createSecurityPlatform 工厂）；
 *  UA 判定抽至 unlockNaming.ts。naming 保持「调用时求值」：computed 求值与 label getter 读取
 *  均在 i18n 装入后，经 tr 内部 locale ref 建立响应依赖（locale 切换联动） */
const ua = navigator.userAgent
const uaFlags = desktopUaFlags(ua)
const unlockNaming = () => unlockNamingFor(uaFlags, tr)
const securityFactory = createSecurityPlatform({ getStore: () => store.value, tr, naming: unlockNaming, flags: uaFlags, ua })
const dpapiOps = securityFactory.dpapi
const securityPlatform = securityFactory.platform
const migrateDekWrapToEntropyBound = securityFactory.migrateDekWrapToEntropyBound


/**
 * 旧数据迁移编排（plan16 T14，幂等可重复跑）：历史 wrappedDekD → v2 应用熵绑定重包（F3，
 * 需 DEK 在手）→ vault.backupSecret → 保管区（store op）→ localStorage 备份偏好 + AppData
 * backupDir → 默认本地源 → 旧云多目标键 → 源模型 + 保管区凭据。
 * locked 短路（保管区写入需 DEK）；未启用加密时 saveCred 守护抛错 → 云旧键保留（先写新后删旧），
 * 待启用加密后任一次重跑自愈。汇合点两处：onMounted initStore 后（含 DPAPI/会话恢复态）与
 * LockScreen @unlocked（口令/PRF 解锁成功回调）。
 */
async function runLegacyMigrations(): Promise<void> {
  const s = store.value
  if (!s || s.locked.value) return
  try {
    // F3：DPAPI 静默解锁成功（或会话恢复）后第一时间把旧格式 wrappedDekD 重包为应用熵绑定格式
    await migrateDekWrapToEntropyBound()
    await s.migrateLegacySecrets()
    // localStorage backupMode/backupKeepN + AppData backupDir → 默认本地源（backupSources 键已存在则跳过）
    let legacyDir: string | null = null
    try {
      legacyDir = (await requireAdapter().get(BACKUP_DIR_KEY)) || null // 空串按无目录
    } catch { /* 读失败按无目录 */ }
    const local = await migrateLegacyLocalSource(requireAdapter(), { retention: legacyRetention(), dir: legacyDir })
    if (local === 'migrated') {
      try {
        localStorage.removeItem(BACKUP_MODE_KEY)
        localStorage.removeItem(BACKUP_KEEP_N_KEY)
      } catch { /* localStorage 不可用不影响迁移本身 */ }
    }
    const n = await migrateLegacyCloudSources(requireAdapter(), { saveCred: (id, cred) => requireStore().saveSourceCredOp(id, cred) })
    if (n > 0) console.info(`[migrate] 已迁移 ${n} 个云目标到新模型`)
  } catch (e) {
    console.warn('[migrate] 旧数据迁移失败（旧键保留，解锁后重试）', e)
  }
}

// ---------- 锁定策略执行（plan16 T15，设计 §1 四触发器的桌面端执行面）----------
// 系统锁屏：Rust lock_events 模块（Windows WTS）广播 system-lock（mac/Linux 挂账，事件恒不触发
// 自然降级）；回调实时读 settings（不缓存快照），开关变更即时生效；store.lock() 幂等。
let unlistenSystemLock: (() => void) | null = null

// 空闲超时：与 extension lockEnforcer（chrome.idle 版）语义一致的原生实现——document 级
// pointerdown/keydown 节流刷新活动时间戳，30s tick 用 core shouldLockNow 判定（idleLock.ts）；
// deps 每 tick 现读 settings；store 未就绪时 isLocked 兜底 true（与 autoRunner 同口径）恒不动作。
const idleLock = createIdleLockExecutor({
  getIdleMinutes: () => store.value?.settings.lockIdleMinutes ?? 0,
  isLocked: () => store.value?.locked.value ?? true,
  lock: () => store.value?.lock(),
  now: () => Date.now(),
})
const onUserActivity = (): void => idleLock.notifyActivity()

// ---------- MCP 事件桥与首连审批（plan17 T10）----------
// 平台适配器：三配置命令 + 审批吊销 + 复制复用 copyToClipboard（F16 暂存通道 + 自动清空与取码复制同一事实源）
const mcpPlatform: McpPlatform = {
  getConfig: () => invoke('mcp_get_config') as Promise<McpConfigWithStatusDto>,
  setConfig: (cfg) => invoke('mcp_set_config', { cfg }) as Promise<void>,
  regenerateToken: () => invoke('mcp_regenerate_token') as Promise<string>,
  revokeApprovals: () => invoke('mcp_revoke_approvals') as Promise<number>,
  copyText: (value) => copyToClipboard(value),
}

// 验收条目4：开发者平台适配器（WebView 远程调试设置读写）；改配置后重启，由 run() 最早期 apply_devtools_env 注入生效
const devtoolsPlatform: DevtoolsPlatform = {
  getConfig: () => invoke('devtools_get_config') as Promise<DevtoolsConfigDto>,
  setConfig: (enabled, port) => invoke('devtools_set_config', { enabled, port }) as Promise<void>,
}

// 释放策略平台适配器（spec 批⑧ §7.5）：桥接 release_policy_get/set（Rust 侧 snake_case 参数 +
// rename_all="camelCase"，invoke 键即 pauseMinutes/destroyMinutes/lockOnPause/lockOnDestroy）
const releasePlatform: ReleasePlatform = {
  getConfig: () => invoke('release_policy_get') as Promise<ReleasePolicyDto>,
  setConfig: (cfg) => invoke('release_policy_set', {
    pauseMinutes: cfg.pauseMinutes, destroyMinutes: cfg.destroyMinutes, lockOnPause: cfg.lockOnPause, lockOnDestroy: cfg.lockOnDestroy,
  }) as Promise<void>,
}

let mcpStop: (() => void) | null = null
// 首连审批队列（原单槽位 approval 的并发根修：对话框打开期间不同 ident 事件互相覆盖、
// 弹窗乒乓，见 mcpApprovalQueue.ts）。审批窗独立于锁定态（锁定时取码在桥内报 vault locked，属预期）
const approvalQueue = createMcpApprovalQueue({
  respond: async (ident, action) => {
    await invoke('mcp_approval_response', { ident, action })
  },
})
/** 模板消费的队首待审批；null=无待审批 */
const approval = approvalQueue.current
let unlistenApproval: (() => void) | null = null
// 工具级确认事件监听（T7）：与首连审批监听同风格独立容错注册
let unlistenToolApproval: (() => void) | null = null

/** 首连审批裁定（三键与关闭同路径）：队列先弹出队首再回执（清窗防连点重复回执）；审批无会话无 TTL，
 *  deny 后 Rust 侧 DENY_COOLDOWN 60s 冷却自然退避；回执失败仅告警不中断
 *  （客户端重试会再次弹审批窗，用户可再裁定）。队首为工具确认时不响应（通道分流，防误弹） */
function onApprovalAction(action: McpApprovalAction): void {
  const head = approvalQueue.current.value
  if (head && !isToolConfirmItem(head)) approvalQueue.resolve(head.ident, action)
}

/** 工具确认 Allow（T7）：逐次即焚无记忆授权，裁定即弹出并由 onDecide 回执 mcp_respond */
function onToolAllow(): void {
  const head = approvalQueue.current.value
  if (head && isToolConfirmItem(head)) approvalQueue.resolveTool(head.id, true)
}

/** 对话框关闭（Esc/遮罩/工具确认 Deny 键）：按队首通道分流 deny——首连审批回执 deny 进 60s
 *  冷却（「关掉=别再问了」）；工具确认回 result:false（拒绝统一 false，ok:false 留给异常） */
function onConsentClose(): void {
  const head = approvalQueue.current.value
  if (!head) return
  if (isToolConfirmItem(head)) approvalQueue.resolveTool(head.id, false)
  else approvalQueue.resolve(head.ident, 'deny')
}

onMounted(async () => {
  // 系统锁屏事件（plan16 T15）：WTS_SESSION_LOCK → system-lock 广播 → 按设置锁定
  unlistenSystemLock = await listen('system-lock', () => {
    if (store.value?.settings.lockOnSystemLock) store.value?.lock()
  })
  // 空闲锁定执行器：活动监听 + 30s tick（锁定延迟最长一个 tick 粒度）
  document.addEventListener('pointerdown', onUserActivity, { passive: true })
  document.addEventListener('keydown', onUserActivity)
  idleLock.start()
  // 主窗口失焦自动隐藏：仅注册一次，回调内实时读取开关值（勿在 watch 里叠加监听）
  const win = getCurrentWindow()
  const un = await win.onFocusChanged(({ payload: focused }) => {
    if (!focused && store.value?.settings.blurHideEnabled && win.label === 'main') void win.hide()
  })
  unlistenFocus = un
  try {
    const adapter = await createTauriFs()
    fsAdapter = adapter
    // spec §7 末尾：主窗口独立解锁——windowId='main' 与 mini 隔离 DEK；
    // onCommitted：任何经队列的写 op 成功后触发自动备份变更检测（锁定态由 runner 内 decideAutoRun 挡下）；
    // onLocked：手动/空闲/系统锁库走纯前端 lock()，经此同步清 Rust DEK 暂存槽（best-effort，失败不阻断锁定）
    const s = createVueStore(adapter, {
      windowId: 'main',
      onCommitted: () => auto.notifyChanged(),
      onLocked: () => { void invoke('clear_stashed_dek').catch(() => {}) },
    })
    await s.initStore()
    // 释放策略联动（spec 批⑧ §7.4-7.5，Task 14）：锁库事件 + 不锁库路径的 DEK 暂存回注。
    // 监听容错注册（失败仅该联动降级，不放大为整屏 loadError）
    unlistenForceLock = await listen('force-lock', () => {
      store.value?.lock()
    }).catch(() => null)
    unlistenStashDek = await listen('stash-dek-request', () => {
      // getCurrentDek：解锁态返回本窗口 DEK，锁定/未启用返回 null（锁库路径自然不上报）
      const dek = store.value?.getCurrentDek()
      if (dek) void invoke('stash_dek', { dek: bytesToBase64(dek) }).catch(() => {})
    }).catch(() => null)
    // 重建/冷启动回注（store 初始化后、首个页面渲染前）：有暂存 DEK 则恢复解锁态
    // （store.unlockWithDek 等价解锁后状态：写 dekByWin/dekPersist + 刷新 vault + 退出锁定 + 重装载保管区）；
    // 锁库路径无暂存（锁库时 Rust 侧清槽），DEK 失效（换库/损坏）抛错保持锁定页，自然兜底
    const stashed = await invoke<string | null>('take_stashed_dek').catch(() => null)
    if (stashed) {
      try {
        await s.unlockWithDek(base64ToBytes(stashed))
      } catch (e) {
        console.warn('[release] 暂存 DEK 回注失败，保持锁定', e)
      }
    }
    store.value = s
    // D1 i18n 挂载：设置已从盘载入（含 locale），装入 i18n 供组件树 useI18n/$t
    mountI18n(s)
    // 旧数据迁移（plan16 T14）：initStore 已完成解锁态判定，解锁态在此直接跑（幂等）；
    // 第二汇合点在模板 LockScreen @unlocked（口令/PRF 解锁成功后补跑）
    await runLegacyMigrations()
    auto.start()
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(s)
    const iconStore = createIconStore(adapter)
    await iconStore.init()
    icons.value = iconStore
  } catch (e) {
    // D2 抽串：前缀文案移至模板 tr()（i18n 可能未装入——initStore 失败先于 mountI18n），此处只存原始消息
    loadError.value = e instanceof Error ? e.message : String(e)
  }
  // MCP 装配（plan17 T10，可选增强功能）：独立 try/catch——MCP 故障只降级告警，绝不放大为
  // 整屏 loadError，也不阻断上方关键初始化与后续迁移/主题/图标；放在主 try 之外，
  // 关键初始化失败时 MCP 仍可装配（requireEntries 闭包惰性读 store，未就绪报 vault locked）
  try {
    // 只主窗口装配（本文件即 main；mini 另案）；锁定门控在 requireEntries 抛错（'vault locked' 文案直达 AI 客户端）
    const mcpDeps: McpBridgeDeps = {
      requireEntries: () => {
        const st = store.value
        if (!st || st.locked.value) throw new Error('vault locked')
        return st.vault.entries
      },
      tagsOf: (e) => {
        const tags = store.value?.vault.tags ?? []
        return e.tagIds.map((id) => tags.find((t) => t.id === id)?.name).filter((n): n is string => !!n)
      },
      // 触发器装配（spec §6.1；终审 I2 受理即返回）：前置同步判定回结构化 reason，触发通道
      // 启动但不等待（bridge_call 固定 5s 超时，慢同步/备份若 await 会把「仍在后台执行」误报
      // 成 app busy）；no enabled sources / no primary target 类原因由 runner recordStatus 记录、
      // 此处不重复判定——triggered=true 语义为「已受理执行」，业务结果经状态行呈现，绝不返回
      // vault 数据
      ...createMcpTriggers({
        guard: () => {
          const s = store.value
          if (!s || s.locked.value) return { triggered: false, reason: 'vault locked' }
          if (s.backupSecret.value === null) return { triggered: false, reason: 'no backup secret' }
          return null
        },
        runSync: () => cloudSync.run('manual'),
        runBackup: () => auto.runBackupNow(),
      }),
    }
    mcpStop = await startMcpBridge(mcpDeps, { listen, invoke: (c, a) => invoke(c, a as never).then(() => {}) })
  } catch (e) {
    console.warn('[mcp] MCP 桥装配失败，已降级跳过（不影响应用主流程）', e)
  }
  // 首连审批事件监听注册同理单独容错：事件入审批队列（同 ident 10s 去重见 mcpApprovalQueue.ts）
  try {
    unlistenApproval = await listen<{ ident: string; tool: string }>('mcp://approval', (e) => {
      approvalQueue.enqueue(e.payload)
    })
  } catch (e) {
    console.warn('[mcp] MCP 审批监听注册失败，已降级跳过（不影响应用主流程）', e)
  }
  // 工具级确认事件（spec §6.2，T7）：入同一审批队列弹「允许执行 <tool>？」（无 trust/once 梯度）；
  // 裁定后经既有 mcp_respond 回 {id, ok:true, result:allow, error:null}（allow=result true，
  // 拒绝统一 result:false）。60s 无响应由 Rust 侧超时兜底 fail-closed，回执失败仅告警
  try {
    unlistenToolApproval = await listen<{ id: number; ident: string; tool: string }>('mcp://tool-approval', (e) => {
      approvalQueue.queueToolConfirmation(e.payload, (allow) => {
        void invoke('mcp_respond', { id: e.payload.id, ok: true, result: allow, error: null }).catch((err) =>
          console.warn('[mcp] mcp_respond(tool confirm) failed', err),
        )
      })
    })
  } catch (e) {
    console.warn('[mcp] MCP 工具确认监听注册失败，已降级跳过（不影响应用主流程）', e)
  }
})

onScopeDispose(() => {
  auto.stop()
  mcpStop?.()
  unlistenApproval?.()
  unlistenToolApproval?.()
  unlistenFocus?.()
  unlistenSystemLock?.()
  unlistenForceLock?.()
  unlistenStashDek?.()
  idleLock.stop()
  // 卸载清算（T7）：未决工具确认立即回 result:false（Rust oneshot 不悬挂等 60s 超时兜底）
  approvalQueue.dispose()
  document.removeEventListener('pointerdown', onUserActivity)
  document.removeEventListener('keydown', onUserActivity)
})

/** 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup 作用域销自动 dispose；
 *  store 未就绪时读不到开关视为关闭）。
 *  F16：清除经 Rust clipboard_clear_if_staged 读回比对（仍为本应用复制内容才清空），dispose 欠清除补清、
 *  失败重试上报；托盘退出另有原生兜底。剪贴板读取只在 Rust 侧，webview JS 无读取能力 */
const clearer = createClipboardClearer(
  () => store.value?.settings.clipboardClearEnabled === true,
  () => invoke('clipboard_clear_if_staged').then(() => {}),
)

const copyFailed = ref(false) // 复制失败横幅（真机发现：剪贴板被第三方进程独占时 stage 命令拒绝，原实现静默无提示）
let copyFailedTimer: ReturnType<typeof setTimeout> | null = null

async function copyToClipboard(code: string) {
  // F16：复制经 Rust stage 命令登记暂存值（退出兜底比对的事实源）
  try {
    await invoke('stage_clipboard_write', { value: code })
  } catch {
    copyFailed.value = true
    if (copyFailedTimer) clearTimeout(copyFailedTimer)
    copyFailedTimer = setTimeout(() => (copyFailed.value = false), 3000)
    return
  }
  clearer.notifyCopied()
}

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
