/**
 * desktop 壳层装配与初始化编排（P4 自 App.vue 抽出，纯搬移行为不变）：
 * - createMcpPlatform / createDevtoolsPlatform / createReleasePlatform：MCP/远程调试/释放策略
 *   三个配置平台适配器（invoke 键与参数形状与 Rust 命令一一对应）；
 * - createDesktopMcpDeps：MCP 桥依赖装配（requireEntries 锁定门控/tagsOf/triggers 前置判定）；
 * - createMcpConsentFlow：首连审批三裁定函数（onApprovalAction/onToolAllow/onConsentClose）；
 * - createLegacyMigrations：旧数据迁移编排（plan16 T14，幂等可重复跑，双汇合点共用）；
 * - createDesktopShell：onMounted 初始化全编排（系统锁屏→空闲锁→失焦隐藏→store 创建→
 *   force-lock/stash-dek 监听→take_stashed_dek 回注→i18n→迁移→auto.start→主题→图标→
 *   loadError 兜底→MCP 装配）与卸载清理（dispose）。init/dispose 为普通方法（App.vue 薄壳
 *   onMounted/onScopeDispose 调用；测试可直接驱动验证启动序列/卸载清算）。
 * 行为不变关键：注册顺序、事件名/参数形状、容错边界（force-lock/stash-dek .catch(() => null)、
 * MCP 三段独立 try/catch 降级）、时序（回注先于 store.value 赋值、迁移先于 auto.start）逐字保持。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { base64ToBytes, bytesToBase64, type StorageAdapter } from '@totp/core'
import { createIconStore, createVueStore, useTheme, type DevtoolsConfigDto, type DevtoolsPlatform, type IconStore, type McpConfigWithStatusDto, type McpPlatform, type ReleasePolicyDto, type ReleasePlatform, type VueStore } from '@totp/ui'
import type { Ref, ShallowRef } from 'vue'
import type { DesktopAutoRunner } from './autoBackup'
import { createIdleLockExecutor } from './idleLock'
import { BACKUP_DIR_KEY, migrateLegacyCloudSources, migrateLegacyLocalSource } from './legacyMigrate'
import { createMcpApprovalQueue, isToolConfirmItem, type McpApprovalAction } from './mcpApprovalQueue'
import { createMcpTriggers, startMcpBridge, type McpBridgeDeps } from './mcpBridge'
import { createTauriFs } from './tauriFs'
import { legacyRetention, BACKUP_MODE_KEY, BACKUP_KEEP_N_KEY } from './desktopPrefs'

/** MCP 首连审批队列类型（createMcpApprovalQueue 返回形状） */
export type McpApprovalQueue = ReturnType<typeof createMcpApprovalQueue>

/** 首连审批队列创建（回执接 mcp_approval_response）：同 ident 10s 去重/FIFO/先弹队首再回执语义见 mcpApprovalQueue.ts */
export function createDesktopApprovalQueue(): McpApprovalQueue {
  return createMcpApprovalQueue({
    respond: async (ident, action) => {
      await invoke('mcp_approval_response', { ident, action })
    },
  })
}

// ---------- MCP 事件桥与首连审批（plan17 T10）----------
// 平台适配器：三配置命令 + 审批吊销 + 复制复用宿主 copyToClipboard（F16 暂存通道 + 自动清空与取码复制同一事实源）
export function createMcpPlatform(deps: { copyText: (value: string) => Promise<void> }): McpPlatform {
  return {
    getConfig: () => invoke('mcp_get_config') as Promise<McpConfigWithStatusDto>,
    setConfig: (cfg) => invoke('mcp_set_config', { cfg }) as Promise<void>,
    regenerateToken: () => invoke('mcp_regenerate_token') as Promise<string>,
    revokeApprovals: () => invoke('mcp_revoke_approvals') as Promise<number>,
    copyText: (value) => deps.copyText(value),
  }
}

// 验收条目4：开发者平台适配器（WebView 远程调试设置读写）；改配置后重启，由 run() 最早期 apply_devtools_env 注入生效
export function createDevtoolsPlatform(): DevtoolsPlatform {
  return {
    getConfig: () => invoke('devtools_get_config') as Promise<DevtoolsConfigDto>,
    setConfig: (enabled, port) => invoke('devtools_set_config', { enabled, port }) as Promise<void>,
  }
}

// 释放策略平台适配器（spec 批⑧ §7.5）：桥接 release_policy_get/set（Rust 侧 snake_case 参数 +
// rename_all="camelCase"，invoke 键即 pauseMinutes/destroyMinutes/lockOnPause/lockOnDestroy）
export function createReleasePlatform(): ReleasePlatform {
  return {
    getConfig: () => invoke('release_policy_get') as Promise<ReleasePolicyDto>,
    setConfig: (cfg) => invoke('release_policy_set', {
      pauseMinutes: cfg.pauseMinutes, destroyMinutes: cfg.destroyMinutes, lockOnPause: cfg.lockOnPause, lockOnDestroy: cfg.lockOnDestroy,
    }) as Promise<void>,
  }
}

export interface DesktopMcpDepsInput {
  getStore(): VueStore | null
  /** 手动云同步（trigger_sync 执行体） */
  runSync(): Promise<unknown>
  /** 手动备份（trigger_backup 执行体；绕偏好门，守护照常） */
  runBackup(): Promise<void>
}

/** MCP 桥依赖装配：requireEntries 锁定门控（'vault locked' 文案直达 AI 客户端）、tagsOf
 *  （vault.tags 名称解析）、触发器前置判定（spec §6.1；终审 I2 受理即返回） */
export function createDesktopMcpDeps(deps: DesktopMcpDepsInput): McpBridgeDeps {
  return {
    requireEntries: () => {
      const st = deps.getStore()
      if (!st || st.locked.value) throw new Error('vault locked')
      return st.vault.entries
    },
    tagsOf: (e) => {
      const tags = deps.getStore()?.vault.tags ?? []
      return e.tagIds.map((id) => tags.find((t) => t.id === id)?.name).filter((n): n is string => !!n)
    },
    // 触发器装配（spec §6.1；终审 I2 受理即返回）：前置同步判定回结构化 reason，触发通道
    // 启动但不等待（bridge_call 固定 5s 超时，慢同步/备份若 await 会把「仍在后台执行」误报
    // 成 app busy）；no enabled sources / no primary target 类原因由 runner recordStatus 记录、
    // 此处不重复判定——triggered=true 语义为「已受理执行」，业务结果经状态行呈现，绝不返回
    // vault 数据
    ...createMcpTriggers({
      guard: () => {
        const s = deps.getStore()
        if (!s || s.locked.value) return { triggered: false, reason: 'vault locked' }
        if (s.backupSecret.value === null) return { triggered: false, reason: 'no backup secret' }
        return null
      },
      runSync: deps.runSync,
      runBackup: deps.runBackup,
    }),
  }
}

/** 首连审批裁定（三键与关闭同路径）：队列先弹出队首再回执（清窗防连点重复回执）；审批无会话无 TTL，
 *  deny 后 Rust 侧 DENY_COOLDOWN 60s 冷却自然退避；回执失败仅告警不中断
 *  （客户端重试会再次弹审批窗，用户可再裁定）。队首为工具确认时不响应（通道分流，防误弹） */
export function createMcpConsentFlow(queue: McpApprovalQueue): {
  onApprovalAction(action: McpApprovalAction): void
  onToolAllow(): void
  onConsentClose(): void
} {
  function onApprovalAction(action: McpApprovalAction): void {
    const head = queue.current.value
    if (head && !isToolConfirmItem(head)) queue.resolve(head.ident, action)
  }

  /** 工具确认 Allow（T7）：逐次即焚无记忆授权，裁定即弹出并由 onDecide 回执 mcp_respond */
  function onToolAllow(): void {
    const head = queue.current.value
    if (head && isToolConfirmItem(head)) queue.resolveTool(head.id, true)
  }

  /** 对话框关闭（Esc/遮罩/工具确认 Deny 键）：按队首通道分流 deny——首连审批回执 deny 进 60s
   *  冷却（「关掉=别再问了」）；工具确认回 result:false（拒绝统一 false，ok:false 留给异常） */
  function onConsentClose(): void {
    const head = queue.current.value
    if (!head) return
    if (isToolConfirmItem(head)) queue.resolveTool(head.id, false)
    else queue.resolve(head.ident, 'deny')
  }

  return { onApprovalAction, onToolAllow, onConsentClose }
}

export interface LegacyMigrationsDeps {
  getStore(): VueStore | null
  getAdapter(): StorageAdapter | null
  /** F3 DEK 包裹升级（需 DEK 在手；securityPlatform 工厂产物） */
  migrateDekWrapToEntropyBound(): Promise<void>
}

/**
 * 旧数据迁移编排工厂（plan16 T14，幂等可重复跑）：历史 wrappedDekD → v2 应用熵绑定重包（F3，
 * 需 DEK 在手）→ vault.backupSecret → 保管区（store op）→ localStorage 备份偏好 + AppData
 * backupDir → 默认本地源 → 旧云多目标键 → 源模型 + 保管区凭据。
 * locked 短路（保管区写入需 DEK）；未启用加密时 saveCred 守护抛错 → 云旧键保留（先写新后删旧），
 * 待启用加密后任一次重跑自愈。汇合点两处：壳层 initStore 后（含 DPAPI/会话恢复态）与
 * LockScreen @unlocked（口令/PRF 解锁成功回调）。
 */
export function createLegacyMigrations(deps: LegacyMigrationsDeps): () => Promise<void> {
  function requireAdapter(): StorageAdapter {
    const a = deps.getAdapter()
    if (!a) throw new Error('数据尚未就绪')
    return a
  }
  function requireStore(): VueStore {
    const s = deps.getStore()
    if (!s) throw new Error('数据尚未就绪')
    return s
  }
  return async function runLegacyMigrations(): Promise<void> {
    const s = deps.getStore()
    if (!s || s.locked.value) return
    try {
      // F3：DPAPI 静默解锁成功（或会话恢复）后第一时间把旧格式 wrappedDekD 重包为应用熵绑定格式
      await deps.migrateDekWrapToEntropyBound()
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
}

export interface DesktopShellDeps {
  /** App.vue 模板 v-if 链消费的 store 浅包装（回调经此动态解引用） */
  store: ShallowRef<VueStore | null>
  /** 图标仓（模板消费） */
  icons: Ref<IconStore | null>
  /** 关键初始化失败兜底（模板「加载失败」横幅原始消息） */
  loadError: Ref<string>
  /** adapter 登记处（平台工厂闭包实时读取；createTauriFs 就绪后赋值） */
  setAdapter(a: StorageAdapter): void
  /** 自动备份双通道 runner（onCommitted 变更检测 / auto.start / 卸载 stop） */
  auto: DesktopAutoRunner
  /** D1 i18n 挂载（App.vue setup 捕获 app 实例后闭包装配） */
  mountI18n(s: VueStore): void
  /** 旧数据迁移编排（createLegacyMigrations 工厂产物） */
  runLegacyMigrations(): Promise<void>
  /** 首连审批队列（宿主创建：模板对话框消费 current，dispose 归壳层） */
  approvalQueue: McpApprovalQueue
  /** MCP 桥依赖（createDesktopMcpDeps 装配） */
  mcpDeps: McpBridgeDeps
}

export interface DesktopShellController {
  /** 初始化全编排（原 onMounted 函数体逐字搬移；调用次序=行为契约） */
  init(): Promise<void>
  /** 卸载清理（原 onScopeDispose 函数体逐字搬移） */
  dispose(): void
}

export function createDesktopShell(deps: DesktopShellDeps): DesktopShellController {
  // 释放策略联动监听（Task 14）：force-lock=暂停/销毁锁库；stash-dek-request=销毁不锁库路径先上报 DEK
  let unlistenFocus: (() => void) | null = null
  let unlistenForceLock: (() => void) | null = null
  let unlistenStashDek: (() => void) | null = null
  let unlistenApproval: (() => void) | null = null
  let unlistenToolApproval: (() => void) | null = null
  let mcpStop: (() => void) | null = null
  // 系统锁屏：Rust lock_events 模块（Windows WTS）广播 system-lock（mac/Linux 挂账，事件恒不触发
  // 自然降级）；回调实时读 settings（不缓存快照），开关变更即时生效；store.lock() 幂等。
  let unlistenSystemLock: (() => void) | null = null

  // 空闲超时：与 extension lockEnforcer（chrome.idle 版）语义一致的原生实现——document 级
  // pointerdown/keydown 节流刷新活动时间戳，30s tick 用 core shouldLockNow 判定（idleLock.ts）；
  // deps 每 tick 现读 settings；store 未就绪时 isLocked 兜底 true（与 autoRunner 同口径）恒不动作。
  const idleLock = createIdleLockExecutor({
    getIdleMinutes: () => deps.store.value?.settings.lockIdleMinutes ?? 0,
    isLocked: () => deps.store.value?.locked.value ?? true,
    lock: () => deps.store.value?.lock(),
    now: () => Date.now(),
  })
  const onUserActivity = (): void => idleLock.notifyActivity()

  async function init(): Promise<void> {
    // 系统锁屏事件（plan16 T15）：WTS_SESSION_LOCK → system-lock 广播 → 按设置锁定
    unlistenSystemLock = await listen('system-lock', () => {
      if (deps.store.value?.settings.lockOnSystemLock) deps.store.value?.lock()
    })
    // 空闲锁定执行器：活动监听 + 30s tick（锁定延迟最长一个 tick 粒度）
    document.addEventListener('pointerdown', onUserActivity, { passive: true })
    document.addEventListener('keydown', onUserActivity)
    idleLock.start()
    // 主窗口失焦自动隐藏：仅注册一次，回调内实时读取开关值（勿在 watch 里叠加监听）
    const win = getCurrentWindow()
    const un = await win.onFocusChanged(({ payload: focused }) => {
      if (!focused && deps.store.value?.settings.blurHideEnabled && win.label === 'main') void win.hide()
    })
    unlistenFocus = un
    try {
      const adapter = await createTauriFs()
      deps.setAdapter(adapter)
      // spec §7 末尾：主窗口独立解锁——windowId='main' 与 mini 隔离 DEK；
      // onCommitted：任何经队列的写 op 成功后触发自动备份变更检测（锁定态由 runner 内 decideAutoRun 挡下）；
      // onLocked：手动/空闲/系统锁库走纯前端 lock()，经此同步清 Rust DEK 暂存槽（best-effort，失败不阻断锁定）
      const s = createVueStore(adapter, {
        windowId: 'main',
        onCommitted: () => deps.auto.notifyChanged(),
        onLocked: () => { void invoke('clear_stashed_dek').catch(() => {}) },
      })
      await s.initStore()
      // 释放策略联动（spec 批⑧ §7.4-7.5，Task 14）：锁库事件 + 不锁库路径的 DEK 暂存回注。
      // 监听容错注册（失败仅该联动降级，不放大为整屏 loadError）
      unlistenForceLock = await listen('force-lock', () => {
        deps.store.value?.lock()
      }).catch(() => null)
      unlistenStashDek = await listen('stash-dek-request', () => {
        // getCurrentDek：解锁态返回本窗口 DEK，锁定/未启用返回 null（锁库路径自然不上报）
        const dek = deps.store.value?.getCurrentDek()
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
      deps.store.value = s
      // D1 i18n 挂载：设置已从盘载入（含 locale），装入 i18n 供组件树 useI18n/$t
      deps.mountI18n(s)
      // 旧数据迁移（plan16 T14）：initStore 已完成解锁态判定，解锁态在此直接跑（幂等）；
      // 第二汇合点在模板 LockScreen @unlocked（口令/PRF 解锁成功后补跑）
      await deps.runLegacyMigrations()
      deps.auto.start()
      // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
      useTheme(s)
      const iconStore = createIconStore(adapter)
      await iconStore.init()
      deps.icons.value = iconStore
    } catch (e) {
      // D2 抽串：前缀文案移至模板 tr()（i18n 可能未装入——initStore 失败先于 mountI18n），此处只存原始消息
      deps.loadError.value = e instanceof Error ? e.message : String(e)
    }
    // MCP 装配（plan17 T10，可选增强功能）：独立 try/catch——MCP 故障只降级告警，绝不放大为
    // 整屏 loadError，也不阻断上方关键初始化与后续迁移/主题/图标；放在主 try 之外，
    // 关键初始化失败时 MCP 仍可装配（requireEntries 闭包惰性读 store，未就绪报 vault locked）
    try {
      // 只主窗口装配（本文件即 main；mini 另案）；锁定门控在 requireEntries 抛错（'vault locked' 文案直达 AI 客户端）
      mcpStop = await startMcpBridge(deps.mcpDeps, { listen, invoke: (c, a) => invoke(c, a as never).then(() => {}) })
    } catch (e) {
      console.warn('[mcp] MCP 桥装配失败，已降级跳过（不影响应用主流程）', e)
    }
    // 首连审批事件监听注册同理单独容错：事件入审批队列（同 ident 10s 去重见 mcpApprovalQueue.ts）
    try {
      unlistenApproval = await listen<{ ident: string; tool: string }>('mcp://approval', (e) => {
        deps.approvalQueue.enqueue(e.payload)
      })
    } catch (e) {
      console.warn('[mcp] MCP 审批监听注册失败，已降级跳过（不影响应用主流程）', e)
    }
    // 工具级确认事件（spec §6.2，T7）：入同一审批队列弹「允许执行 <tool>？」（无 trust/once 梯度）；
    // 裁定后经既有 mcp_respond 回 {id, ok:true, result:allow, error:null}（allow=result true，
    // 拒绝统一 result:false）。60s 无响应由 Rust 侧超时兜底 fail-closed，回执失败仅告警
    try {
      unlistenToolApproval = await listen<{ id: number; ident: string; tool: string }>('mcp://tool-approval', (e) => {
        deps.approvalQueue.queueToolConfirmation(e.payload, (allow) => {
          void invoke('mcp_respond', { id: e.payload.id, ok: true, result: allow, error: null }).catch((err) =>
            console.warn('[mcp] mcp_respond(tool confirm) failed', err),
          )
        })
      })
    } catch (e) {
      console.warn('[mcp] MCP 工具确认监听注册失败，已降级跳过（不影响应用主流程）', e)
    }
  }

  function dispose(): void {
    deps.auto.stop()
    mcpStop?.()
    unlistenApproval?.()
    unlistenToolApproval?.()
    unlistenFocus?.()
    unlistenSystemLock?.()
    unlistenForceLock?.()
    unlistenStashDek?.()
    idleLock.stop()
    // 卸载清算（T7）：未决工具确认立即回 result:false（Rust oneshot 不悬挂等 60s 超时兜底）
    deps.approvalQueue.dispose()
    document.removeEventListener('pointerdown', onUserActivity)
    document.removeEventListener('keydown', onUserActivity)
  }

  return { init, dispose }
}
