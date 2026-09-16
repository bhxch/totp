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
</script>

<template>
  <section class="page">
    <MdCard class="block">
      <template #header>备份口令</template>
      <BackupSecretCard :store="store" />
    </MdCard>
    <MdCard v-if="platform" class="block">
      <template #header>本地备份</template>
      <BackupCard :platform="platform" :vault-json="vaultJson" />
    </MdCard>
    <MdCard v-if="cloudPlatform" class="block">
      <template #header>云同步</template>
      <CloudCard :platform="cloudPlatform" />
    </MdCard>
    <MdCard v-if="syncPlatform" class="block">
      <template #header>浏览器同步</template>
      <SyncCard :platform="syncPlatform" />
    </MdCard>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.block :deep(.card) { border: none; padding: 0; }
</style>
