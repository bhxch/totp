<script setup lang="ts">
import { computed } from 'vue'
import BackupCard from '../components/BackupCard.vue'
import BackupSecretCard from '../components/BackupSecretCard.vue'
import CloudCard from '../components/CloudCard.vue'
import SyncCard from '../components/SyncCard.vue'
import type { BackupPlatform } from '../components/backupPlatform'
import type { CloudPlatform } from '../components/cloudPlatform'
import MdCard from '../components/md/MdCard.vue'
import type { SyncPlatform } from '../components/syncPlatform'
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
}>(), { platform: null, cloudPlatform: null, syncPlatform: null })

/** 备份内容快照（saveVault 同款 JSON）：序列化 reactive 代理以保持 computed 依赖追踪（与 旧单页 一致） */
const vaultJson = computed(() => JSON.stringify(props.store.vault))
/** 会话备份口令（D1）：store.backupSecret 是 ComputedRef，在 setup computed 内 .value 解包保持依赖追踪 */
const sessionSecret = computed(() => props.store.backupSecret.value)

/** BackupCard 导出口令「记住到保管区」上抛（批① §2.3）：store.setBackupSecret 落盘；
 *  守护失败（未启用加密/锁定）仅告警——导出已完成，不再打断用户 */
function onRememberSecret(pw: string): void {
  props.store.setBackupSecret(pw, true).catch((e: unknown) => console.warn('[backup] 记住导出口令失败', e))
}
</script>

<template>
  <section class="page">
    <!-- 功能卡自带 h2 标题(MdCard #header 会与之重复,审查 F2 去重);卡片边界由 MdCard outlined 统一 -->
    <MdCard class="block">
      <BackupSecretCard :store="store" />
    </MdCard>
    <MdCard v-if="platform" class="block">
      <BackupCard :platform="platform" :vault-json="vaultJson" :session-secret="sessionSecret" @remember-secret="onRememberSecret" />
    </MdCard>
    <MdCard v-if="cloudPlatform" class="block">
      <CloudCard :platform="cloudPlatform" :session-secret="sessionSecret" />
    </MdCard>
    <MdCard v-if="syncPlatform" class="block">
      <SyncCard :platform="syncPlatform" />
    </MdCard>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
</style>
