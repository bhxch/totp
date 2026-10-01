<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { OtpListItem, PersistErrorBanner, createIconStore, iconView, useOtpCodes, useTheme, type IconStore, type VueStore } from '@totp/ui'
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
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
    store.value = s
    if (restoredFromSlot && !s.locked.value) {
      const dekStillThere = await invoke<string | null>('peek_mini_dek').catch(() => 'gone')
      if (dekStillThere === null) s.lock()
    }
    // D1 i18n 挂载：设置已从盘载入（含 locale）；仅首次生效，重载不再装入
    mountI18n(s)
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(s)
    const iconStore = createIconStore(adapter)
    await iconStore.init()
    icons.value = iconStore
  } catch {
    // 重载失败保留旧数据（mini 窗口只读，无写盘风险）
  }
}

// 释放策略联动（spec 批⑧ §7.4）：force-lock=暂停/销毁锁库。只注册一次，回调动态解引用
// store（mini 聚焦即重建 store 实例）；不监听 stash-dek-request（mini 只读无回注路径，backlog），
// 但锁库本身经 onLocked 清 Rust 暂存槽（见 load 内注入）
let unlistenForceLock: (() => void) | null = null
// ① mini 跟随主窗解锁：主窗解锁/锁库广播（desktopShell.publishMiniUnlock/publishMiniLock → miniSession）
let unlistenMiniSession: (() => void) | null = null

onMounted(async () => {
  await load()
  // store 就绪后再挂监听（App.vue 同款，见 App.vue 的对应初始化段：store 建立后才注册锁定联动）；容错注册，失败仅该联动降级
  unlistenForceLock = await listen('force-lock', () => {
    store.value?.lock()
  }).catch(() => null)
  // ① 跟随主窗解锁态：locked:true 跟随锁库（onLocked 清 Rust 暂存槽）；locked:false 且当前锁定 →
  // 整链重建（槽可能已有主窗解锁写入的 DEK，load 内 dekPersist.get=peek 自动恢复）。与 force-lock 同款
  // 容错注册，失败仅该联动降级
  unlistenMiniSession = await listen<{ locked: boolean }>('mini-session', (e) => {
    if (e.payload.locked) store.value?.lock()
    else if (store.value && locked.value) void load()
  }).catch(() => null)
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

/** 复制编排统一走 createDesktopCopy（R13，与主窗同一事实源）：stage 成功武装 30s 清空、失败横幅
 *  3s 自动复位（修复：mini 原横幅不复位，行为已与 desktopCopy 漂移，以 desktopCopy 为准） */
const { copyFailed, copyToClipboard } = createDesktopCopy({
  isEnabled: () => store.value?.settings.clipboardClearEnabled === true,
  stage: (value) => invoke('stage_clipboard_write', { value }).then(() => {}),
  clearIfStaged: () => invoke('clipboard_clear_if_staged').then(() => {}),
})

/** 复制后 500ms 自动隐藏控制器（审查 I-1 武装竞态守卫）：纯逻辑抽至 miniAutoHide.ts 便于单测覆盖取消时序 */
const autoHide = createCopyAutoHide(500, () => { void getCurrentWindow().hide() })

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
  await copyToClipboard(code, {
    onStaged: async () => {
      if (entry.type === 'hotp') {
        try { await store.value?.updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 }) } catch { /* mini 降级不打扰 */ }
      }
      autoHide.completeCopy(generation)
    },
  })
}
</script>

<template>
  <main class="mini">
    <!-- R16⑤（评审 A2 方案 a）：落盘失败常驻告警，与主体并列不互斥 -->
    <PersistErrorBanner :show="persistFailed" :text="tr('app.persistError')" />
    <div v-if="store && locked" class="empty">{{ tr('mini.lockedNote') }}</div>
    <div v-else-if="copyFailed" class="copy-error" role="alert">{{ tr('mini.copyFailed') }}</div>
    <div v-else-if="!store || sorted.length === 0" class="empty">{{ tr('mini.empty') }}</div>
    <!-- 终审 Important-1：@dblclick 未在 OtpListItem emits 声明，经 attrs fallthrough 合并到组件根元素，
         与组件内部揭示 onDblclick 合并共存（Vue 3 mergeProps 依次调用）——双击即揭示并取消 500ms 自动隐藏
         （审查 I-1：控制器内部递增揭示代次，使 await 期间在途的 copy 不再武装自动隐藏） -->
    <OtpListItem v-for="(e, i) in sorted" :key="e.uuid" :entry="e" :icon="iconView(e.icon, icons ?? undefined)" :index="i + 1" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" :context-menu="false" :show-qr="false" @copy="copy(e)" @dblclick="autoHide.onDblclick" />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.mini { display: flex; flex-direction: column; gap: 2px; padding: 6px; }
.empty { text-align: center; opacity: .6; padding: 32px 0; font-size: var(--md-sys-typescale-body-medium); }
.copy-error { text-align: center; color: var(--md-sys-color-error); background: var(--md-sys-color-error-container); border-radius: 6px; padding: 8px 0; font-size: var(--md-sys-typescale-body-small); }
</style>
