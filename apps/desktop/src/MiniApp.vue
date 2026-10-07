<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { filterByTags, type TagFilterMode } from '@totp/core'
import { PersistErrorBanner, QuickCodesPanel, ToastHost, createIconStore, searchEntries, useOtpCodes, useTheme, useToast, type IconStore, type VueStore } from '@totp/ui'
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { createTauriFs } from './tauriFs'
import { bootDesktopStore, persistFailed, useDesktopI18n } from './desktopShell'
import { createCopyAutoHide } from './miniAutoHide'
import { sortMiniEntries } from './miniSort'
import { createDesktopCopy } from './desktopCopy'

// store 浅包装（T14 审查根修，与 App.vue 同款）：深 ref 会对嵌套 ref/computed 成员自动解包，
// 模板 `store.locked` 的布尔判断在深 ref 下靠「解包后恰为 boolean」侥幸正确，shallowRef 下
// locked 是 ComputedRef（布尔上下文恒真会永远显示不可用）——经下方 locked computed 顶层暴露
const store = shallowRef<VueStore | null>(null)
/** 模板锁定态（mini 未就绪/未加密库显示条目，锁定显示不可用） */
const locked = computed(() => store.value?.locked.value ?? false)
const icons = ref<IconStore | null>(null)
/** 搜索行渲染门控（spec §1.2）：SearchBar 内部 useI18n()，须等 i18n 插件装入后才可渲染 */
const i18nReady = ref(false)
/** 搜索词（spec §1.2） */
const query = ref('')
/** load 失败横幅（spec §2.2）：boot 失败不再静默；聚焦重载成功（store 置位）后自然消失 */
const loadFailed = ref(false)
// i18n 胶水收敛至 desktopShell.useDesktopI18n（R13，与主窗同款实现）：app 引用在 setup 同步段
// 捕获；mini 的 store 在每次聚焦重载时重建（既有模式，useTheme 同样重新接线）——i18n 插件只能
// 装入一次，mountI18n 内部仅首次生效，重载为 no-op；tr 兜底回原文 key 仅极端时序可见
const { tr, mountI18n } = useDesktopI18n()

async function load() {
  try {
    const adapter = await createTauriFs()
    // ① mini 跟随主窗解锁态：槽 peek + mini-session 事件（2026-09-30 设计）——boot 注入 dekPersist.get=peek_mini_dek，
    // 槽有 DEK（主窗已解锁）即 initStore 自动恢复；set/clear 恒 no-op——槽由主窗写清（publishMiniUnlock/publishMiniLock），
    // mini 只读。store 初值 locked=false（未加密库 mini 直接可读）；加密库槽无 DEK 时 initStore 置 locked=true，
    // 等 mini-session locked:false 通知重载（store.commit 拒绝 locked 态写，spec 要求 mini 与 App 交互一致）。
    // onLocked：mini 的锁库路径（force-lock/mini-session locked:true 联动）同样清 Rust DEK 暂存槽，保证
    // 「锁库后不再回注」语义闭环（boot 序列收敛至 desktopShell.bootDesktopStore，R13）
    // Minor-1（2026-09-30 终审）：在途 load 期间主窗可能已锁定（清槽+发事件早于本 load 完成，
    // locked:true 只锁到旧 store）——本次若经槽恢复了解锁，赋值后复查槽：已空（peek 失败视为
    // 不确定，保守不动等事件/聚焦）则立即锁本窗，闭合「主窗已锁 mini 仍持明文」窄窗；
    // 明文库主窗从不 set 槽，restoredFromSlot 恒 false 不受影响
    let restoredFromSlot = false
    const s = await bootDesktopStore(adapter, {
      windowId: 'mini',
      onLocked: () => { void invoke('clear_stashed_dek').catch(() => {}) },
      // R16⑤（评审 A2 方案 a）：落盘失败置 persistFailed，模板常驻告警条
      onPersistError: (e) => {
        console.error('[store] persist failed:', e)
        persistFailed.value = true
      },
      // ① mini 跟随主窗解锁：槽有 DEK（主窗已解锁）即自动恢复；set/clear no-op——槽由主窗写清
      dekPersist: {
        get: async () => {
          const v = await invoke<string | null>('peek_mini_dek').catch(() => null)
          restoredFromSlot = restoredFromSlot || v !== null
          return v
        },
        set: async () => {},
        clear: async () => {},
      },
    })
    // i18n 先于 store 置位挂载（D1：设置已从盘载入含 locale；仅首次生效，重载不再装入）：
    // SearchBar（useI18n）在 store 触发的重渲染时已可用（spec §1.2）
    mountI18n(s)
    i18nReady.value = true
    store.value = s
    if (restoredFromSlot && !s.locked.value) {
      const dekStillThere = await invoke<string | null>('peek_mini_dek').catch(() => 'gone')
      if (dekStillThere === null) s.lock()
    }
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(s)
    const iconStore = createIconStore(adapter)
    await iconStore.init()
    icons.value = iconStore
  } catch (e) {
    // spec §2.2：不再静默——全栈进 console + 横幅上屏；下次聚焦 onFocusChanged 自动重载恢复
    console.error('[mini] load failed:', e)
    // 兜底 i18n：boot 失败读不到设置、mountI18n(s) 未达——不装兜底实例则横幅 tr 回原文 key。
    // null=仅建实例供 tr 取词（locale 固定 zh，fallbackLocale 同口径），不装 app 不置 installed，
    // 成功重载的 mountI18n(s) 仍全量装入设置驱动实例
    mountI18n(null)
    loadFailed.value = true
  }
}

// 释放策略联动（spec 批⑧ §7.4）：force-lock=暂停/销毁锁库。只注册一次，回调动态解引用
// store（mini 聚焦即重建 store 实例）；不监听 stash-dek-request（mini 只读无回注路径，backlog），
// 但锁库本身经 onLocked 清 Rust 暂存槽（见 load 内注入）
let unlistenForceLock: (() => void) | null = null
// ① mini 跟随主窗解锁：主窗解锁/锁库广播（desktopShell.publishMiniUnlock/publishMiniLock → miniSession）
let unlistenMiniSession: (() => void) | null = null

onMounted(async () => {
  // I2 审查修复（2026-10-01）：锁定联动监听注册先于首次 load()——首 boot 的 load 内隔着
  // mountI18n/useTheme/iconStore.init() 等多个 await，期间主窗锁定（清槽 + emit locked:true）
  // 的事件若在监听注册前到达即丢失，mini webview 持明文直到下次聚焦才收敛。两回调本就动态
  // 解引用 store（?. 与 store.value 判空），store 未就绪时安全 no-op：在途 boot 期的锁库由
  // load 内 0d9c8fe 复查兜底；locked:false 在未就绪时跳过属失败安全方向（主窗解锁、mini 滞留
  // 锁定，下次聚焦重建收敛），不操作未初始化的 store。容错注册，失败仅该联动降级
  unlistenForceLock = await listen('force-lock', () => {
    store.value?.lock()
  }).catch(() => null)
  // ① 跟随主窗解锁态：locked:true 跟随锁库（onLocked 清 Rust 暂存槽）；locked:false 且当前锁定 →
  // 整链重建（槽可能已有主窗解锁写入的 DEK，load 内 dekPersist.get=peek 自动恢复）
  unlistenMiniSession = await listen<{ locked: boolean }>('mini-session', (e) => {
    if (e.payload.locked) store.value?.lock()
    else if (store.value && locked.value) void load()
  }).catch(() => null)
  // mini pin 初值（spec §1.5）：读 Rust 缓存（mini_pin_get），失败降级未 pin——自动隐藏保持缺省行为
  pinned.value = await invoke<boolean>('mini_pin_get').catch(() => false)
  await load()
  // spec §2.4：首屏就绪信号（成败都发）——Rust 重建路径收到后再 show，消除冷启动空白窗口
  await emit('mini-ready').catch(() => {})
  // mini 常驻隐藏，重新显示时从盘重载（initStore 幂等不刷新内存，故重建 store）。
  // 修复真实 bug：@tauri-apps/api v2 Window 无 onVisibleChanged（仅 focus/resized/scale 等 7 个
  // 事件），原调用运行时 TypeError，「重显重载」从未生效——改用 onFocusChanged 近似（payload=是否
  // 聚焦；mini 显示即是为了查看码值，聚焦≈刚显示，与 App.vue 失焦隐藏同款事件）
  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) void load()
  })
})

onScopeDispose(() => {
  unlistenForceLock?.()
  unlistenMiniSession?.()
})

/** 列表排序：pinned 优先 → order 升序（sortMiniEntries 纯函数，与 CodesPage.vue 同口径，跨宿主顺序一致） */
const sorted = computed(() => (store.value ? sortMiniEntries(store.value.vault.entries) : []))
const { codes } = useOtpCodes(sorted)
/** 标签筛选选中集合（P4 Task 2）：快速窗**会话语义，不持久化**——mini 常驻后台随开随选，与
 *  CodesPage/popup 的 settings 持久化（rememberTagFilter→lastTagFilterIds）刻意不同；mini store
 *  每次聚焦重载即重建实例，持久化恢复反而引入悬空恢复负担。tagMode 则与 CodesPage 同款走全局
 *  settings（跨窗共享 any/all） */
const selectedTagIds = ref<string[]>([])
const tagMode = computed<TagFilterMode>({
  get: () => store.value?.settings.tagFilterMode ?? 'any',
  set: (m) => {
    const s = store.value
    if (!s) return
    s.settings.tagFilterMode = m
    void s.commitSettings()
  },
})
/** 可见列表（P4 Task 2，与 CodesPage 同款组合口径）：搜索过滤（谓词与 popup 同源 searchEntries）
 *  → 标签筛选（filterByTags，any/all）；仅在有选中标签时走 filterByTags（空集合直通） */
const visible = computed(() => {
  const list = searchEntries(sorted.value, query.value.trim())
  if (selectedTagIds.value.length === 0) return list
  return filterByTags(list, new Set(selectedTagIds.value), tagMode.value)
})
/** 兜底：tag 被删除（主窗管理/远端同步）后从选中集合剔除悬空 id（CodesPage 同款）。mini store 是
 *  shallowRef 包装且每次聚焦重载重建实例，watch 源对 store.value 动态解引用——实例替换时 getter
 *  重估（新数组）同样触发清理 */
watch(
  () => store.value?.vault.tags.map((t) => t.id),
  (ids) => {
    if (!ids) return
    const next = selectedTagIds.value.filter((id) => ids.includes(id))
    if (next.length !== selectedTagIds.value.length) selectedTagIds.value = next
  },
  { immediate: true },
)

/** 复制编排统一走 createDesktopCopy（R13，与主窗同一事实源）：stage 成功武装 30s 清空。
 *  R3-I1：失败反馈改全局 error toast（原 copyFailed 横幅会顶替列表区且与主窗形态漂移，
 *  设计 §3.2 三宿主一致）；成功反馈仍是复制后 500ms 自动隐藏，不重复提示 */
const toast = useToast()
const { copyToClipboard } = createDesktopCopy({
  isEnabled: () => store.value?.settings.clipboardClearEnabled === true,
  stage: (value) => invoke('stage_clipboard_write', { value }).then(() => {}),
  clearIfStaged: () => invoke('clipboard_clear_if_staged').then(() => {}),
})

/** mini pin（spec §1.5）：状态真源在 Rust（settings.json+缓存），本地 ref 镜像供按钮与自动隐藏判定。
 *  R1-M3：invoke 成功才提交本地翻转——失败（写盘拒绝）不乐观更新，UI 与 Rust 真源保持一致 */
const pinned = ref(false)
async function togglePin() {
  const next = !pinned.value
  try {
    await invoke('mini_pin_set', { pinned: next })
    pinned.value = next
  } catch (e) {
    console.error('[mini] pin set failed:', e)
  }
}
/** 收起（R1-M2）：走 close() 复用 Rust CloseRequested 拦截链（prevent_close→记忆位置→hide），
 *  直调 hide() 不记录位置会使 LAST_MINI_POS 陈旧（销毁重建后快捷键恢复到旧位） */
function hideMini() { void getCurrentWindow().close() }

/** 复制后 500ms 自动隐藏控制器（审查 I-1 武装竞态守卫）：纯逻辑抽至 miniAutoHide.ts 便于单测覆盖取消时序；
 *  pinned 时让位（hide 回调内动态检查，取消 pin 即恢复自动隐藏，无需重建控制器） */
const autoHide = createCopyAutoHide(500, () => { if (!pinned.value) void getCurrentWindow().hide() })

async function copy(entry: { uuid: string; type?: string; counter?: number }) {
  // I-1：copy 开始即快照揭示代次——若双击（递增代次）落在下方 await 期间，
  // completeCopy 检出失配跳过武装，覆盖「cancel 先于 timer 武装到达」的竞态时序
  const generation = autoHide.beginCopy()
  const code = codes.value.get(entry.uuid)?.code
  if (!code) return
  // onStaged 扩展点（mini 通道特定收尾，stage 成功才调用）：
  // C14：HOTP 复制的是旧 counter 的码（RFC 语义），复制完成后再递增；TOTP 不动 counter。
  // mini 锁定时模板不渲染条目（见 template v-if="store && locked" 分支），故此处 store 必已解锁；
  // updateEntryOp 在 locked 态会抛错，捕获避免在某些边界场景把窗口隐藏打断
  const ok = await copyToClipboard(code, {
    onStaged: async () => {
      if (entry.type === 'hotp') {
        try { await store.value?.updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 }) } catch { /* mini 降级不打扰 */ }
      }
      autoHide.completeCopy(generation)
    },
  })
  // R3-I1：stage 失败（剪贴板被独占等）→ error toast；不武装隐藏，窗口保持可见供用户重试
  if (!ok) toast.show(tr('mini.copyFailed'), 'error')
}
</script>

<template>
  <main class="mini">
    <!-- 无边框标题区（spec §1.4）：data-tauri-drag-region 拖拽 + pin/收起自绘 chrome -->
    <header class="titlebar">
      <span class="title-drag" data-tauri-drag-region>TOTP</span>
      <button class="tb-btn" data-test="pin-btn" :class="{ active: pinned }" :aria-pressed="pinned" :title="tr('mini.pinTitle')" :aria-label="tr('mini.pinTitle')" @click="togglePin">📌</button>
      <button class="tb-btn" data-test="hide-btn" :title="tr('mini.hideTitle')" :aria-label="tr('mini.hideTitle')" @click="hideMini">✕</button>
    </header>
    <!-- R16⑤（评审 A2 方案 a）：落盘失败常驻告警，与主体并列不互斥 -->
    <PersistErrorBanner :show="persistFailed" :text="tr('app.persistError')" />
    <div v-if="store && locked" class="empty">{{ tr('mini.lockedNote') }}</div>
    <div v-else-if="loadFailed && !store" class="copy-error" role="alert">{{ tr('mini.loadFailed') }}</div>
    <!-- P4 Task 2：搜索行 + 列表区整体换装 QuickCodesPanel（冻结筛选行 + 纯取码列表 + 两态空文案，
         行内 QR 入口面板内恒关）。过滤编排（搜索→标签）与复制/自动隐藏通道留宿主。面板内
         SearchBar/TagFilterRow 依赖 i18n 插件，i18nReady 门控保留；锁定/load 失败分支仍沿
         v-else-if 链优先于面板（复制失败 R3-I1 起走 toast 不再占位） -->
    <QuickCodesPanel
      v-else-if="i18nReady"
      :entries="visible" :codes="codes" :icons="icons"
      :empty-text="tr('mini.empty')" :no-match-text="tr('mini.searchEmpty')"
      v-model:query="query"
      compact
      tag-row :tags="store?.vault.tags ?? []"
      v-model:selected-tag-ids="selectedTagIds" v-model:tag-mode="tagMode"
      @copy="(e) => copy(e)" @dblclick="autoHide.onDblclick"
    />
    <!-- 兜底（沿旧空态语义）：boot 未完成（store 未置位）先显示全空文案，mini-ready 前窗口不可见 -->
    <div v-else class="empty">{{ tr('mini.empty') }}</div>
    <!-- 双击揭示：面板把 OtpListItem 根元素 dblclick 显式上抛（declared emit，携带 MouseEvent），
         宿主接 autoHide.onDblclick 取消 500ms 自动隐藏（控制器内部递增揭示代次，使 await 期间
         在途的 copy 不再武装自动隐藏，审查 I-1） -->
    <!-- 全局 toast 渲染端（R3-I1：复制失败 error toast 与三宿主同口径） -->
    <ToastHost />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
/* R5-M6：.mini padding 6px = sticky 冻结条两侧缝隙宽，面板 .frozen 负 margin 补偿取同值 */
.mini { display: flex; flex-direction: column; gap: 2px; padding: 6px; --frozen-bleed: 6px; }
.titlebar { display: flex; align-items: center; gap: 2px; height: 30px; padding: 0 4px 0 10px; user-select: none; }
.title-drag { flex: 1; font-size: var(--md-sys-typescale-body-small); opacity: .6; }
/* 32px 视觉（spec §2.5 titlebar 30px 紧凑档）；Task 2 曾为 40px 视觉，与 30px titlebar 溢出收敛 */
.tb-btn { border: none; background: transparent; cursor: pointer; width: 32px; height: 32px; border-radius: var(--md-sys-shape-corner-small); color: inherit; font-size: 12px; line-height: 1; position: relative; }
/* 命中层:inset -4px 使 32px 钮达 40px 触达（compact 裁定，spec §2.9 内部冲突以小窗紧凑优先） */
.tb-btn::after { content: ''; position: absolute; inset: -4px; border-radius: inherit; }
.tb-btn:hover { background: var(--md-sys-color-surface-container-highest, rgba(0, 0, 0, .08)); }
.tb-btn.active { color: var(--md-sys-color-primary); }
.empty { text-align: center; opacity: .6; padding: 32px 0; font-size: var(--md-sys-typescale-body-medium); }
.copy-error { text-align: center; color: var(--md-sys-color-error); background: var(--md-sys-color-error-container); border-radius: var(--md-sys-shape-corner-small); padding: 8px 0; font-size: var(--md-sys-typescale-body-small); }
/* CSS 装载后接管精确主题色：mini.html 内联底色只保首帧（防加载期白屏），html data-mode 随 useTheme 切换 */
html { background: var(--md-sys-color-background, #fff); }
</style>
