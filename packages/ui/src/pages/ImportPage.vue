<script setup lang="ts">
import { computed } from 'vue'
import ImportCard from '../components/ImportCard.vue'
import type { BackupPlatform } from '../components/backupPlatform'
import type { ImportPlatform, ImportSchemesApi } from '../components/importPlatform'
import MdCard from '../components/md/MdCard.vue'
import type { VueStore } from '../store'

const props = withDefaults(defineProps<{
  /** 全局响应式 store（NavigationShell pageProps 按 /import 分发） */
  store: VueStore
  /** 备份平台实现；其 readImportFile 存在才渲染导入卡（popup platform=null 零影响） */
  platform?: BackupPlatform | null
  /** 导入映射方案存取；缺省时 ImportCard 方案区不渲染 */
  schemesApi?: ImportSchemesApi | null
}>(), { platform: null, schemesApi: null })

/** 导入平台：宿主 platform 提供了 readImportFile 才渲染导入卡
 *  （自 VaultManager 的 importPlatform computed 迁移；popup 端 platform 无该能力时零渲染） */
const importPlatform = computed<ImportPlatform | null>(() => {
  const p = props.platform
  if (!p?.readImportFile) return null
  return {
    readImportFile: p.readImportFile,
    readImportFileBytes: p.readImportFileBytes,
    decryptDpapi: p.decryptDpapi,
    store: props.store,
  }
})
</script>

<template>
  <section class="page">
    <MdCard class="block">
      <template #header>导入</template>
      <ImportCard :platform="importPlatform" :schemes-api="schemesApi" />
    </MdCard>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.block :deep(.card) { border: none; padding: 0; }
</style>
