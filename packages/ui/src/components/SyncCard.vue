<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { SyncPlatform } from './syncPlatform'

const props = defineProps<{
  /** 同步平台实现；null 时整卡不渲染（desktop/popup 不受影响） */
  platform: SyncPlatform | null
}>()

const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')
const status = ref<{ state: string; at: number } | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

/** 读取状态快照；读取异常按同步出错呈现（下次轮询/手动刷新自愈） */
async function refreshStatus(): Promise<void> {
  const p = props.platform
  if (!p) return
  try {
    status.value = await p.readStatus()
  } catch {
    status.value = { state: 'error', at: Date.now() }
  }
}

/** 开关变更：成功后立即刷新状态（关闭→「未启用」/开启→最近一次推送结果） */
async function onToggle(e: Event): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    await props.platform!.setSyncEnabled((e.target as HTMLInputElement).checked)
    await refreshStatus()
  } catch (err) {
    fail(err)
  } finally {
    busy.value = false
  }
}

const STATUS_TEXT: Record<string, string> = {
  ok: '上次同步 {time}',
  quota: '同步空间已满——建议配置云备份后关闭浏览器同步',
  error: '同步出错',
  off: '未启用',
}

function fmtTime(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const statusText = computed(() => {
  const s = status.value
  if (!s) return ''
  return (STATUS_TEXT[s.state] ?? '').replace('{time}', fmtTime(s.at))
})
const stateClass = computed(() => (status.value ? `sync-${status.value.state}` : ''))

/** 明文同步警示：开关开启且宿主声明未启用加密时提示（hasEncryption 为 ComputedRef<boolean>，未提供按未知，不警示） */
const plainSyncWarn = computed(() => props.platform?.syncEnabled === true && props.platform.hasEncryption?.value === false)

/** I57：占用百分比 = inUse / QUOTA_BYTES * 100；状态快照 pct 不存在 → null（不渲染） */
const usageText = computed(() => {
  const s = status.value
  if (!s || typeof s.pct !== 'number') return ''
  return `已用 ${Math.round(s.pct)}% / 100KB`
})

onMounted(() => {
  if (!props.platform) return // platform null：整卡不渲染，不建轮询
  void refreshStatus()
  pollTimer = setInterval(() => void refreshStatus(), 30_000)
})
onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer)
})
</script>

<template>
  <section v-if="platform" class="card sync">
    <h2>浏览器同步</h2>
    <label class="opt">
      <input
        class="sync-toggle" type="checkbox" :checked="platform.syncEnabled"
        :disabled="busy || !platform.canSync" @change="onToggle"
      />
      启用浏览器同步（Chrome/Edge）
    </label>
    <p v-if="!platform.canSync" class="hint">当前环境不支持浏览器同步</p>
    <!-- I55：per-device 同步开关明示，避免用户误解为他机关闭会影响本端 -->
    <p class="per-device-hint">同步开关按设备独立，他机不会改写本端</p>
    <!-- 加密警示承载于状态条区域：label 不绑定「加密分片」承诺（未加密时以明文同步） -->
    <p v-if="plainSyncWarn" class="warn" role="alert">
      当前未启用本地加密，条目将以明文同步至浏览器账号云端——建议先在安全设置中启用加密
    </p>
    <div class="status-row">
      <span v-if="statusText" :class="['status', stateClass]" role="status">{{ statusText }}</span>
      <span v-if="usageText" class="usage" role="status">{{ usageText }}</span>
      <button class="refresh" :disabled="busy" @click="refreshStatus">刷新状态</button>
    </div>
    <div v-if="msg" :class="msgKind" role="alert">{{ msg }}</div>
  </section>
</template>

<style scoped>
.card { border: 1px solid var(--md-sys-color-outline-variant); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: 15px; margin: 0; }
.opt { font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
.status-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.status.sync-ok { color: var(--md-sys-color-primary); }
.status.sync-quota { color: var(--md-sys-color-tertiary); }
.status.sync-error { color: var(--md-sys-color-error); }
.status.sync-off { opacity: .65; }
.warn { color: var(--md-sys-color-tertiary); font-size: 13px; margin: 0; }
.refresh { font-size: 12px; }
.hint { font-size: 13px; opacity: .65; margin: 0; }
.ok { color: var(--md-sys-color-primary); font-size: 13px; }
.err { color: var(--md-sys-color-error); font-size: 13px; }
</style>
