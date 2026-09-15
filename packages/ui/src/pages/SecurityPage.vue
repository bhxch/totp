<script setup lang="ts">
import SecurityCard from '../components/SecurityCard.vue'
import type { SecurityPlatform } from '../components/securityPlatform'
import MdCard from '../components/md/MdCard.vue'

withDefaults(defineProps<{
  /** 安全平台实现；null/缺省时不渲染安全卡（popup 零影响） */
  securityPlatform?: SecurityPlatform | null
}>(), { securityPlatform: null })
</script>

<template>
  <section class="page">
    <MdCard class="block">
      <template #header>安全</template>
      <SecurityCard :platform="securityPlatform" />
    </MdCard>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.block :deep(.card) { border: none; padding: 0; }
</style>
