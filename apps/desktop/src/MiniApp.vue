<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { OtpListItem, createAppI18n, createClipboardClearer, createIconStore, createVueStore, iconView, useOtpCodes, useTheme, type IconStore, type VueStore } from '@totp/ui'
import { computed, getCurrentInstance, onMounted, ref, shallowRef } from 'vue'
import { createTauriFs } from './tauriFs'

// store 浅包装（T14 审查根修，与 App.vue 同款）：深 ref 会对嵌套 ref/computed 成员自动解包，
// 模板 `store.locked` 的布尔判断在深 ref 下靠「解包后恰为 boolean」侥幸正确，shallowRef 下
// locked 是 ComputedRef（布尔上下文恒真会永远显示不可用）——经下方 locked computed 顶层暴露
const store = shallowRef<VueStore | null>(null)
/** 模板锁定态（mini 未就绪/未加密库显示条目，锁定显示不可用） */
const locked = computed(() => store.value?.locked.value ?? false)
const icons = ref<IconStore | null>(null)
// D1 i18n 挂载（store 就绪后装入，见 load 内）：app 引用必须在 setup 同步段获取；
// mini 的 store 在每次聚焦重载时重建（既有模式，useTheme 同样重新接线）——i18n 插件只能
// 装入一次，首次就绪的 store 驱动 locale（仅首次生效，重载为 no-op）
const appForI18n = getCurrentInstance()?.appContext.app
let i18nInstalled = false
// D2 抽串：mini 壳层 t() 走捕获的 i18n 实例（本组件 script setup 内 useI18n 注入不可用，沿 options 页口径）。
// 模板仅在 store 就绪后渲染，而装入与 store 赋值同步——tr 兜底回原文 key 仅极端时序可见
const i18nRef = shallowRef<ReturnType<typeof createAppI18n> | null>(null)
function tr(key: string, params: Record<string, unknown> = {}): string {
  return i18nRef.value ? i18nRef.value.global.t(key, params) : key
}

async function load() {
  try {
    const adapter = await createTauriFs()
    // spec §7 末尾：mini 窗口独立保持锁定（即使主窗口已解锁）——windowId='mini' 与 'main' 隔离 DEK，
    // locked=true 初值使其无法解锁；store.commit 拒绝 locked 态写，spec 要求 mini 与 App 交互一致但读不到密文
    const s = createVueStore(adapter, { windowId: 'mini' })
    await s.initStore()
    store.value = s
    // D1 i18n 挂载：设置已从盘载入（含 locale）；仅首次生效，重载不再装入
    if (!i18nInstalled) {
      const i18nInst = createAppI18n(s)
      if (appForI18n) {
        appForI18n.use(i18nInst)
        i18nInstalled = true
      }
      i18nRef.value = i18nInst
    }
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(s)
    const iconStore = createIconStore(adapter)
    await iconStore.init()
    icons.value = iconStore
  } catch {
    // 重载失败保留旧数据（mini 窗口只读，无写盘风险）
  }
}

onMounted(async () => {
  await load()
  // mini 常驻隐藏，重新显示时从盘重载（initStore 幂等不刷新内存，故重建 store）。
  // 修复真实 bug：@tauri-apps/api v2 Window 无 onVisibleChanged（仅 focus/resized/scale 等 7 个
  // 事件），原调用运行时 TypeError，「重显重载」从未生效——改用 onFocusChanged 近似（payload=是否
  // 聚焦；mini 显示即是为了查看码值，聚焦≈刚显示，与 App.vue 失焦隐藏同款事件）
  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) void load()
  })
})

const sorted = computed(() => (store.value ? [...store.value.vault.entries].sort((a, b) => a.order - b.order) : []))
const { codes } = useOtpCodes(sorted)

// F1：mini 接线 🔎 揭示（spec §7 mini 只读，右键编辑类菜单裁剪；OtpListItem 已阻止原生右键菜单）
const revealing = ref<{ issuer: string; secret: string } | null>(null)
function maskSecret(secret: string): string {
  const s = secret.replace(/\s+/g, '')
  if (s.length <= 8) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

/** 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup 作用域销毁自动 dispose；store 未就绪时读不到开关视为关闭）。
 *  F16：清除经 Rust clipboard_clear_if_staged 读回比对（仍为本应用复制内容才清空），dispose 欠清除补清、失败重试上报 */
const clearer = createClipboardClearer(
  () => store.value?.settings.clipboardClearEnabled === true,
  () => invoke('clipboard_clear_if_staged').then(() => {}),
)

async function copy(entry: { uuid: string; type?: string; counter?: number }) {
  const code = codes.value.get(entry.uuid)?.code
  if (!code) return
  // F16：复制经 Rust stage 命令登记暂存值（退出兜底比对的事实源）
  await invoke('stage_clipboard_write', { value: code })
  // C14：HOTP 复制的是旧 counter 的码（RFC 语义），复制完成后再递增；TOTP 不动 counter。
  // mini 锁定时模板不渲染条目（见 template v-if="store && locked" 分支），故此处 store 必已解锁；
  // updateEntryOp 在 locked 态会抛错，捕获避免在某些边界场景把窗口隐藏打断
  if (entry.type === 'hotp') {
    try { await store.value?.updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 }) } catch { /* mini 降级不打扰 */ }
  }
  clearer.notifyCopied()
  setTimeout(() => void getCurrentWindow().hide(), 500)
}
</script>

<template>
  <main class="mini">
    <div v-if="store && locked" class="empty">{{ tr('mini.lockedNote') }}</div>
    <div v-else-if="!store || sorted.length === 0" class="empty">{{ tr('mini.empty') }}</div>
    <OtpListItem v-for="e in sorted" :key="e.uuid" :entry="e" :icon="iconView(e.icon, icons ?? undefined)" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" @reveal="revealing = e" />

    <!-- F1：reveal 模态（只读展示密钥前后各 4 位） -->
    <div v-if="revealing" class="reveal-mask" @click="revealing = null">
      <div class="reveal-card" @click.stop>
        <h3>{{ tr('mini.revealTitle', { issuer: revealing.issuer }) }}</h3>
        <code class="reveal-secret">{{ maskSecret(revealing.secret) }}</code>
        <p class="reveal-hint">{{ tr('mini.revealHint') }}</p>
        <button class="reveal-close" @click="revealing = null">{{ tr('mini.close') }}</button>
      </div>
    </div>
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.mini { display: flex; flex-direction: column; gap: 2px; padding: 6px; }
.empty { text-align: center; opacity: .6; padding: 32px 0; font-size: var(--md-sys-typescale-body-medium); }
.reveal-mask { position: fixed; inset: 0; background: color-mix(in srgb, var(--md-sys-color-scrim) 55%, transparent); display: grid; place-items: center; z-index: 1000; }
.reveal-card { background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); padding: 16px 18px; border-radius: 10px; max-width: 280px; width: 86%; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 4px 24px color-mix(in srgb, var(--md-sys-color-shadow) 25%, transparent); }
.reveal-card h3 { font-size: var(--md-sys-typescale-body-medium); margin: 0; }
/* 揭示密文与列表验证码同档 code-large(审查 X11:同屏双端一致,Task 15 挂账裁定,不再用 body-large) */
.reveal-secret { font-family: ui-monospace, monospace; font-size: var(--md-sys-typescale-code-large); letter-spacing: 1px; background: var(--md-sys-color-surface-container-highest); padding: 8px; border-radius: 6px; text-align: center; word-break: break-all; }
.reveal-hint { font-size: var(--md-sys-typescale-label-small); opacity: .65; margin: 0; }
.reveal-close { align-self: flex-end; }
</style>
