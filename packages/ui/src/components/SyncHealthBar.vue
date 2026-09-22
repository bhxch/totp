<!--
  同步健康摘要条（spec §5 ⑤ 配置归位/强提示，T11）：SyncPage 顶部两通道状态汇总。
  展示性组件（VTU 契约=字符串/数字入参）：云通道与浏览器通道摘要文本由 SyncPage 采集
  （cloudPlatform.loadAutoStatus / syncPlatform.readStatus，null=通道未配置不渲染）；
  冲突计数来自 store.conflictCount——>0 渲染高亮徽标（desktop 横幅强提示即此，托盘 tooltip 记 backlog；
  extension 弹层横幅同源语义）。
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  /** 未裁决条目冲突数（store.conflictCount） */
  conflicts: number
  /** 云同步通道摘要文本（宿主 loadAutoStatus 已格式化）；null=通道未配置/无数据，不渲染 */
  cloudText: string | null
  /** 浏览器同步通道摘要文本；null=通道未配置（desktop），不渲染 */
  browserText: string | null
}>()
const { t } = useI18n()
</script>

<template>
  <div class="health-bar">
    <span class="health-title">{{ t('syncHealth.title') }}</span>
    <span v-if="conflicts > 0" class="health-conflict" role="alert">{{ t('syncHealth.conflictAlert', { count: conflicts }) }}</span>
    <span v-if="cloudText !== null" class="health-item health-cloud">
      <span class="health-label">{{ t('syncHealth.cloud') }}</span>{{ cloudText }}
    </span>
    <span v-if="browserText !== null" class="health-item health-browser">
      <span class="health-label">{{ t('syncHealth.browser') }}</span>{{ browserText }}
    </span>
  </div>
</template>

<style scoped>
.health-bar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: var(--md-sys-typescale-body-small); }
.health-title { font-weight: 500; font-size: var(--md-sys-typescale-body-medium); }
.health-conflict { color: var(--md-sys-color-error); background: var(--md-sys-color-error-container);
  border-radius: 100px; padding: 2px 10px; font-size: var(--md-sys-typescale-body-small); }
.health-item { display: inline-flex; align-items: baseline; gap: 6px; opacity: .85; min-width: 0; }
.health-label { font-weight: 500; opacity: .8; flex: none; }
</style>
