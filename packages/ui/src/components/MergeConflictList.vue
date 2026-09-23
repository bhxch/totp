<!--
  条目冲突裁决列表（spec §3/§4 冲突强提示，T11）：渲染 store.mergeConflicts 的未裁决条目冲突。
  每行 = issuer/label 标识 + 一侧为 null 的形态标注（「云方已删除」等）+ 「取本地方/取云地方」
  裁决按钮（emit resolve(entryId, pick)，写回走宿主 store.resolveMergeConflictOp）。
  null 侧按钮不禁用：pick 侧为 null 是合法裁决（取该侧=确认该侧删除，两侧语义对称——store op
  将 chosen=null 即删除条目），null 语义由 store op 落地。
-->
<script setup lang="ts">
import type { EntryConflict } from '@totp/core'
import { useI18n } from 'vue-i18n'
import MdButton from './md/MdButton.vue'

withDefaults(defineProps<{
  /** 未裁决冲突列表（store.mergeConflicts 快照） */
  conflicts: EntryConflict[]
  /** 裁决在途禁用（防重入；单条 op 期间全列表按钮禁用） */
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{ resolve: [entryId: string, pick: 'ours' | 'theirs'] }>()
const { t } = useI18n()
</script>

<template>
  <ul class="conflict-list">
    <li v-for="c in conflicts" :key="c.entryId" class="conflict-row">
      <div class="conflict-meta">
        <strong>{{ c.issuer }}</strong>
        <span>{{ c.label }}</span>
        <span v-if="c.theirs === null" class="conflict-note">{{ t('cloudCard.conflictTheirsDeleted') }}</span>
        <span v-else-if="c.ours === null" class="conflict-note">{{ t('cloudCard.conflictOursDeleted') }}</span>
      </div>
      <div class="conflict-actions">
        <MdButton
          variant="text" class="conflict-pick" :disabled="disabled"
          :aria-label="t('cloudCard.pickOursAria', { issuer: c.issuer, label: c.label })"
          @click="emit('resolve', c.entryId, 'ours')"
        >{{ t('cloudCard.pickOurs') }}</MdButton>
        <MdButton
          variant="text" class="conflict-pick" :disabled="disabled"
          :aria-label="t('cloudCard.pickTheirsAria', { issuer: c.issuer, label: c.label })"
          @click="emit('resolve', c.entryId, 'theirs')"
        >{{ t('cloudCard.pickTheirs') }}</MdButton>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.conflict-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.conflict-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: space-between;
  border-bottom: 1px solid var(--md-sys-color-outline-variant); padding-bottom: 6px; }
.conflict-meta { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: var(--md-sys-typescale-body-medium); }
.conflict-note { font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-tertiary); }
.conflict-actions { display: flex; gap: 4px; }
</style>
