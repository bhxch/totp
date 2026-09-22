<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SyncPlatform, SyncStatus } from './syncPlatform'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'

const props = defineProps<{
  /** 同步平台实现；null 时整卡不渲染（desktop/popup 不受影响） */
  platform: SyncPlatform | null
}>()

const { t } = useI18n()

const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')
// 用 SyncStatus 而非手写 { state; at }：漏掉 pct 会使 usageText 读 s.pct 时被类型层截掉
const status = ref<SyncStatus | null>(null)
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
async function onToggle(enabled: boolean): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    await props.platform!.setSyncEnabled(enabled)
    await refreshStatus()
  } catch (err) {
    fail(err)
  } finally {
    busy.value = false
  }
}

function fmtTime(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const statusText = computed(() => {
  const s = status.value
  if (!s) return ''
  switch (s.state) {
    case 'ok': return t('syncCard.statusOk', { time: fmtTime(s.at) })
    case 'quota': return t('syncCard.statusQuota')
    case 'error': return t('syncCard.statusError')
    case 'conflict': return t('syncCard.statusConflict')
    case 'invalid': return t('syncCard.statusInvalid')
    case 'off': return t('syncCard.statusOff')
    default: return ''
  }
})
const stateClass = computed(() => (status.value ? `sync-${status.value.state}` : ''))

/** 明文同步警示：开关开启且宿主声明未启用加密时提示（hasEncryption 为 ComputedRef<boolean>，未提供按未知，不警示） */
const plainSyncWarn = computed(() => props.platform?.syncEnabled === true && props.platform.hasEncryption?.value === false)

/** I57：占用百分比 = inUse / QUOTA_BYTES * 100；状态快照 pct 不存在 → null（不渲染） */
const usageText = computed(() => {
  const s = status.value
  if (!s || typeof s.pct !== 'number') return ''
  return t('syncCard.usage', { pct: Math.round(s.pct) })
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
    <h2>{{ t('syncCard.title') }}</h2>
    <MdCheckbox
      class="sync-toggle" :model-value="platform.syncEnabled" :disabled="busy || !platform.canSync"
      :label="t('syncCard.toggleLabel')" :aria-label="t('syncCard.toggleLabel')"
      @update:model-value="onToggle"
    />
    <p v-if="!platform.canSync" class="hint">{{ t('syncCard.unsupported') }}</p>
    <!-- I55：per-device 同步开关明示，避免用户误解为他机关闭会影响本端 -->
    <p class="per-device-hint">{{ t('syncCard.perDeviceHint') }}</p>
    <!-- 加密警示承载于状态条区域：label 不绑定「加密分片」承诺（未加密时以明文同步） -->
    <p v-if="plainSyncWarn" class="warn" role="alert">
      {{ t('syncCard.plainWarn') }}
    </p>
    <!-- T4 云凭据失效警示已归位 CloudCard（spec §5 ⑤ 配置状态归位，T11）：
         语义属云通道，宿主 cloudAuthFailed 镜像现经 SyncPage → CloudCard 渲染 -->
    <div class="status-row">
      <span v-if="statusText" :class="['status', stateClass]" role="status">{{ statusText }}</span>
      <span v-if="usageText" class="usage" role="status">{{ usageText }}</span>
      <MdButton variant="text" class="refresh" :disabled="busy" @click="refreshStatus">{{ t('syncCard.refresh') }}</MdButton>
    </div>
    <div v-if="msg" :class="msgKind" role="alert">{{ msg }}</div>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供(M3 双描边裁定,2026-09-16 审查 X1);本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.status-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.status.sync-ok { color: var(--md-sys-color-primary); }
.status.sync-quota { color: var(--md-sys-color-tertiary); }
.status.sync-error { color: var(--md-sys-color-error); }
/* F14：拒绝降级同步属安全事件，同 error 色呈现 */
.status.sync-conflict { color: var(--md-sys-color-error); }
/* F6：拒绝非法远端数据属安全事件，同 error 色呈现 */
.status.sync-invalid { color: var(--md-sys-color-error); }
.status.sync-off { opacity: .65; }
.warn { color: var(--md-sys-color-tertiary); font-size: var(--md-sys-typescale-body-medium); margin: 0; }
.refresh { font-size: var(--md-sys-typescale-body-small); }
.hint { font-size: var(--md-sys-typescale-body-medium); opacity: .65; margin: 0; }
.ok { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
</style>
