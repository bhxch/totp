<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BackupCard from '../components/BackupCard.vue'
import BackupSecretCard from '../components/BackupSecretCard.vue'
import CloudCard from '../components/CloudCard.vue'
import SyncCard from '../components/SyncCard.vue'
import SyncHealthBar from '../components/SyncHealthBar.vue'
import type { BackupPlatform } from '../components/backupPlatform'
import type { CloudPlatform } from '../components/cloudPlatform'
import MdCard from '../components/md/MdCard.vue'
import type { SyncPlatform, SyncStatus } from '../components/syncPlatform'
import type { VueStore } from '../store'

const props = withDefaults(defineProps<{
  /** 全局响应式 store（vaultJson 快照源；NavigationShell pageProps 按 /sync 分发） */
  store: VueStore
  /** 备份平台实现；缺省不渲染本地备份区块（popup 零影响） */
  platform?: BackupPlatform | null
  /** 云同步平台实现；缺省不渲染云同步区块（popup 零影响） */
  cloudPlatform?: CloudPlatform | null
  /** 浏览器同步平台实现；缺省不渲染浏览器同步区块（desktop/popup 零影响） */
  syncPlatform?: SyncPlatform | null
  /** 云凭据失效标志（跨端同步 T4）：转发 CloudCard 渲染重授权警示（T11 自 SyncCard 归位）；缺省 false */
  cloudAuthFailed?: boolean
}>(), { platform: null, cloudPlatform: null, syncPlatform: null, cloudAuthFailed: false })

const { t } = useI18n()

/** 备份内容快照（saveVault 同款 JSON）：序列化 reactive 代理以保持 computed 依赖追踪（与 旧单页 一致） */
const vaultJson = computed(() => JSON.stringify(props.store.vault))
/** 会话备份口令（D1）：store.backupSecret 是 ComputedRef，在 setup computed 内 .value 解包保持依赖追踪 */
const sessionSecret = computed(() => props.store.backupSecret.value)

/** BackupCard 导出口令「记住到保管区」上抛（批① §2.3）：store.setBackupSecret 落盘；
 *  守护失败（未启用加密/锁定）仅告警——导出已完成，不再打断用户 */
function onRememberSecret(pw: string): void {
  props.store.setBackupSecret(pw, true).catch((e: unknown) => console.warn('[backup] 记住导出口令失败', e))
}

// ---------- 同步健康摘要条（spec §5 ⑤，T11）：两通道状态 + 冲突计数（30s 轻轮询自愈） ----------
/** 未裁决条目冲突数（store.conflictCount；锁定态 store 清空 → 0，与 CloudCard 区块同源） */
const conflicts = computed(() => props.store.conflictCount.value)
/** 云通道摘要（宿主 loadAutoStatus 已格式化文本；null=无云平台/无能力/读取失败，不渲染该通道） */
const cloudText = ref<string | null>(null)
/** 浏览器通道摘要（状态快照短文案；null=无 syncPlatform（desktop），不渲染该通道） */
const browserText = ref<string | null>(null)

/** 浏览器同步状态 → 短文案（健康条摘要用；完整建议文案仍在 SyncCard 状态行） */
function browserStateText(state: SyncStatus['state']): string {
  switch (state) {
    case 'ok': return t('syncHealth.browserOk')
    case 'quota': return t('syncHealth.browserQuota')
    case 'error': return t('syncHealth.browserError')
    case 'conflict': return t('syncHealth.browserConflict')
    case 'invalid': return t('syncHealth.browserInvalid')
    default: return t('syncHealth.browserOff')
  }
}

async function refreshHealth(): Promise<void> {
  if (props.cloudPlatform?.loadAutoStatus) {
    try {
      cloudText.value = await props.cloudPlatform.loadAutoStatus()
    } catch {
      cloudText.value = null
    }
  } else {
    cloudText.value = null
  }
  if (props.syncPlatform) {
    try {
      const st = await props.syncPlatform.readStatus()
      browserText.value = browserStateText(st?.state ?? 'off')
    } catch {
      browserText.value = t('syncHealth.browserError')
    }
  } else {
    browserText.value = null
  }
}

let healthPoll: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refreshHealth()
  healthPoll = setInterval(() => void refreshHealth(), 30_000) // 与 SyncCard 状态轮询同节奏
})
onUnmounted(() => {
  if (healthPoll !== null) clearInterval(healthPoll)
})
</script>

<template>
  <section class="page">
    <!-- 同步健康摘要条（spec §5 ⑤）：两通道状态汇总 + 冲突强提示徽标（desktop 应用内横幅即此） -->
    <MdCard class="block">
      <SyncHealthBar :conflicts="conflicts" :cloud-text="cloudText" :browser-text="browserText" />
    </MdCard>
    <!-- 功能卡自带 h2 标题(MdCard #header 会与之重复,审查 F2 去重);卡片边界由 MdCard outlined 统一 -->
    <MdCard class="block">
      <BackupSecretCard :store="store" />
    </MdCard>
    <MdCard v-if="platform" class="block">
      <BackupCard :platform="platform" :vault-json="vaultJson" :session-secret="sessionSecret" @remember-secret="onRememberSecret" />
    </MdCard>
    <MdCard v-if="cloudPlatform" class="block">
      <CloudCard :platform="cloudPlatform" :session-secret="sessionSecret" :store="store" :auth-failed="cloudAuthFailed" />
    </MdCard>
    <MdCard v-if="syncPlatform" class="block">
      <SyncCard :platform="syncPlatform" />
    </MdCard>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
</style>
