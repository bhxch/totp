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
    <!-- SecurityCard 自带 h2 标题(审查 F2 去重);卡片边界由 MdCard outlined 统一 -->
    <MdCard class="block">
      <SecurityCard :platform="securityPlatform" />
    </MdCard>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
</style>
