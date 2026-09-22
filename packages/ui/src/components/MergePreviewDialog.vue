<!--
  manual 合并预览对话框（spec §4 ⑤⑥ 前置确认，T11）：runner manual 通道 preview 轮检出条目级
  合并时经 cloudSyncBridge 挂起征询，本组件以三段形态呈现差异——
  - 仅本地方有（云端无此条目或云端已删除）：conflicts 中 ours 非 null 且 theirs 为 null；
  - 仅云地方有（本地无此条目或本地已删除）：ours 为 null 且 theirs 非 null；
  - 双方均有修改：两侧均非 null（合并取 updatedAt 新者，另一版本入冲突列表待裁决）。
  三段由 runner 实际回调签名 ManualMergePreview{conflicts,mergeDegraded,sourceName} 派生（runner
  不另传整库 diff——干净合并不产生冲突记录，预览语义=「本次合并涉及的条目与形态」）。
  确认 emit confirm（runner 重跑 apply）；取消/MdDialog 关闭通道（Esc/遮罩/组件卸载）emit cancel
  （runner 记跳过态，预览只读本地云端零痕迹）。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ManualMergePreview } from './cloudRunner'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'

const props = defineProps<{
  /** true=有挂起征询，渲染对话框（槽位驱动，与 cloudSyncBridge pendingMergeConfirm 绑定） */
  open: boolean
  /** 预览摘要；null 时 open 恒 false（防御：无内容不渲染） */
  preview: ManualMergePreview | null
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const { t } = useI18n()

/** 仅本地方有：ours 在场、theirs 缺席（云端新增对立面=本地新增/云端已删） */
const onlyLocal = computed(() => props.preview?.conflicts.filter((c) => c.ours !== null && c.theirs === null) ?? [])
/** 仅云地方有：theirs 在场、ours 缺席 */
const onlyCloud = computed(() => props.preview?.conflicts.filter((c) => c.ours === null && c.theirs !== null) ?? [])
/** 双方均有修改（两侧都在场；两侧皆 null 的退化形态不属于任何差异段） */
const both = computed(() => props.preview?.conflicts.filter((c) => c.ours !== null && c.theirs !== null) ?? [])
const empty = computed(() => props.preview !== null && props.preview.conflicts.length === 0)
</script>

<template>
  <MdDialog :open="open && preview !== null" :headline="t('cloudCard.previewTitle')" @close="emit('cancel')">
    <p v-if="preview" class="preview-source">{{ t('cloudCard.previewSource', { name: preview.sourceName }) }}</p>
    <p v-if="preview?.mergeDegraded" class="preview-degraded" role="alert">{{ t('cloudCard.previewDegraded') }}</p>
    <p v-if="empty" class="preview-empty">{{ t('cloudCard.previewEmpty') }}</p>
    <template v-else>
      <section v-if="onlyLocal.length > 0" class="preview-section preview-only-local">
        <h3>{{ t('cloudCard.previewOnlyLocal', { count: onlyLocal.length }) }}</h3>
        <ul>
          <li v-for="c in onlyLocal" :key="c.entryId"><strong>{{ c.issuer }}</strong> {{ c.label }}</li>
        </ul>
      </section>
      <section v-if="onlyCloud.length > 0" class="preview-section preview-only-cloud">
        <h3>{{ t('cloudCard.previewOnlyCloud', { count: onlyCloud.length }) }}</h3>
        <ul>
          <li v-for="c in onlyCloud" :key="c.entryId"><strong>{{ c.issuer }}</strong> {{ c.label }}</li>
        </ul>
      </section>
      <section v-if="both.length > 0" class="preview-section preview-both">
        <h3>{{ t('cloudCard.previewBoth', { count: both.length }) }}</h3>
        <ul>
          <li v-for="c in both" :key="c.entryId"><strong>{{ c.issuer }}</strong> {{ c.label }}</li>
        </ul>
      </section>
    </template>
    <template #actions>
      <MdButton variant="text" class="preview-cancel" @click="emit('cancel')">{{ t('cloudCard.cancel') }}</MdButton>
      <MdButton class="preview-confirm" @click="emit('confirm')">{{ t('cloudCard.previewConfirm') }}</MdButton>
    </template>
  </MdDialog>
</template>

<style scoped>
.preview-source { font-size: var(--md-sys-typescale-body-small); opacity: .75; margin: 0 0 8px; }
.preview-degraded { color: var(--md-sys-color-tertiary); font-size: var(--md-sys-typescale-body-medium); margin: 0 0 8px; }
.preview-empty { font-size: var(--md-sys-typescale-body-medium); opacity: .65; margin: 0; }
.preview-section { margin: 0 0 12px; }
.preview-section h3 { font-size: var(--md-sys-typescale-title-small); margin: 0 0 4px; font-weight: 500; }
.preview-section ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.preview-section li { font-size: var(--md-sys-typescale-body-medium); }
</style>
