<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { OtpListItem, createClipboardClearer, createIconStore, createVueStore, iconView, useOtpCodes, useTheme, type IconStore, type VueStore } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
import { createTauriFs } from './tauriFs'

const store = ref<VueStore | null>(null)
const icons = ref<IconStore | null>(null)

async function load() {
  try {
    const adapter = await createTauriFs()
    // spec §7 末尾：mini 窗口独立保持锁定（即使主窗口已解锁）——windowId='mini' 与 'main' 隔离 DEK，
    // locked=true 初值使其无法解锁；store.commit 拒绝 locked 态写，spec 要求 mini 与 App 交互一致但读不到密文
    const s = createVueStore(adapter, { windowId: 'mini' })
    await s.initStore()
    store.value = s
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
  // mini 常驻隐藏，重新显示时从盘重载（initStore 幂等不刷新内存，故重建 store）
  await getCurrentWindow().onVisibleChanged(({ payload: visible }) => {
    if (visible) void load()
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

/** 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup 作用域销毁自动 dispose；store 未就绪时读不到开关视为关闭） */
const clearer = createClipboardClearer(
  () => store.value?.settings.clipboardClearEnabled === true,
  () => writeText(''),
)

async function copy(entry: { uuid: string; type?: string; counter?: number }) {
  const code = codes.value.get(entry.uuid)?.code
  if (!code) return
  await writeText(code)
  // C14：HOTP 复制的是旧 counter 的码（RFC 语义），复制完成后再递增；TOTP 不动 counter。
  // mini 锁定时模板不渲染条目（见 template #v-if="store && store.locked" 分支），故此处 store 必已解锁；
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
    <div v-if="store && store.locked" class="empty">加密启用后迷你窗不可用，请在主窗口解锁使用</div>
    <div v-else-if="!store || sorted.length === 0" class="empty">暂无条目</div>
    <OtpListItem v-for="e in sorted" :key="e.uuid" :entry="e" :icon="iconView(e.icon, icons ?? undefined)" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" @reveal="revealing = e" />

    <!-- F1：reveal 模态（只读展示密钥前后各 4 位） -->
    <div v-if="revealing" class="reveal-mask" @click="revealing = null">
      <div class="reveal-card" @click.stop>
        <h3>{{ revealing.issuer }} — 密钥</h3>
        <code class="reveal-secret">{{ maskSecret(revealing.secret) }}</code>
        <p class="reveal-hint">仅显示密钥前后各 4 位；完整密钥请在主窗口编辑查看。</p>
        <button class="reveal-close" @click="revealing = null">关闭</button>
      </div>
    </div>
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.mini { display: flex; flex-direction: column; gap: 2px; padding: 6px; }
.empty { text-align: center; opacity: .6; padding: 32px 0; font-size: 13px; }
.reveal-mask { position: fixed; inset: 0; background: color-mix(in srgb, var(--md-sys-color-scrim) 55%, transparent); display: grid; place-items: center; z-index: 1000; }
.reveal-card { background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); padding: 16px 18px; border-radius: 10px; max-width: 280px; width: 86%; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 4px 24px color-mix(in srgb, var(--md-sys-color-shadow) 25%, transparent); }
.reveal-card h3 { font-size: 13px; margin: 0; }
.reveal-secret { font-family: ui-monospace, monospace; font-size: 16px; letter-spacing: 1px; background: var(--md-sys-color-surface-container-highest); padding: 8px; border-radius: 6px; text-align: center; word-break: break-all; }
.reveal-hint { font-size: 11px; opacity: .65; margin: 0; }
.reveal-close { align-self: flex-end; }
</style>
