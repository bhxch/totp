<script setup lang="ts">
import type { OtpEntry, Tag, TagFilterMode } from '@totp/core'
import { computed } from 'vue'
import { iconView, type IconStore } from '../iconStore'
import OtpListItem from './OtpListItem.vue'
import SearchBar from './SearchBar.vue'
import TagFilterRow from './TagFilterRow.vue'

/** P4 快速取码面板（popup/mini 共享）：只共享视觉结构与冻结（SearchBar + TagFilterRow + sticky
 *  容器 + OtpListItem 纯取码列表 + 两态空文案），业务差异留宿主（popup 四级回退/URL 过滤/
 *  pending 确认态、mini desktopCopy 通道/复制后自动隐藏均由宿主编排，见计划 2026-10-07-p4）。
 *  签名即三端装配契约（Task 2/3 按 props/emits 装配），不可临时改动。 */
const props = withDefaults(defineProps<{
  /** 宿主过滤后的可见列表（过滤逻辑——搜索/标签/URL 站点——归宿主，面板只做纯展示） */
  entries: OtpEntry[]
  codes: Map<string, { code: string; remaining: number; progress: number }>
  /** 条目图标 store（stored/url 图标解析用；builtin 不依赖）；popup 尚未 init 时可传 null */
  icons?: IconStore | null
  /** popup loaded 门控：true 前不渲染列表与空态（冻结筛选行仍在） */
  loading?: boolean
  /** 全空列表文案（宿主 i18n 后传入）；entries 空 + 无 query + 无标签选中时显示 */
  emptyText?: string
  /** 有 entries 语义下的过滤后空文案（有 query 或有标签选中时显示） */
  noMatchText?: string
  /** v-model:query（SearchBar 透传，过滤执行在宿主） */
  query: string
  /** v-model:search-secret（SearchBar 透传） */
  searchSecret?: boolean
  /** 标签筛选行开关（默认 false；mini/popup 开启并传 tags） */
  tagRow?: boolean
  /** tagRow 时必传；空数组隐藏筛选行（快速窗无管理入口，无标签时不露空行） */
  tags?: Tag[]
  /** v-model:selected-tag-ids */
  selectedTagIds?: string[]
  /** v-model:tag-mode */
  tagMode?: TagFilterMode
  /** 条目右键菜单（默认 false：快速窗无管理操作不接菜单；透传 OtpListItem） */
  contextMenu?: boolean
  /** 行首 1-based 序号（默认 true；透传 OtpListItem index=i+1） */
  showIndex?: boolean
}>(), { showIndex: true })
const emit = defineEmits<{
  'update:query': [string]
  'update:searchSecret': [boolean]
  'update:selectedTagIds': [ids: string[]]
  'update:tagMode': [mode: TagFilterMode]
  copy: [entry: OtpEntry]
  dblclick: [event: MouseEvent]
}>()

/** TagFilterRow 仅在显式开启且有标签时渲染：mini/popup 快速窗语义（无管理入口），
 *  与 CodesPage 恒渲染（零标签行留管理钮作创建首个标签的途径）刻意不同 */
const showTagRow = computed(() => props.tagRow === true && (props.tags?.length ?? 0) > 0)

/* 行内 QR 入口已组件级移除（OtpListItem 不再有 showQr/QR 钮，QR 归宿主右键菜单承担）：
 * 同 manageable 固定 false 的处理方式，不留 prop */

/** 两态空文案（对齐 popup empty/noMatch 语义）：全空（无 query 且无标签选中）→ emptyText；
 *  有过滤条件（query 或标签选中）而空 → noMatchText。loading 中一律不渲染空态 */
const emptyDisplay = computed(() => {
  if (props.loading || props.entries.length > 0) return ''
  const filtered = !!props.query || (props.selectedTagIds?.length ?? 0) > 0
  return filtered ? (props.noMatchText ?? '') : (props.emptyText ?? '')
})
</script>

<template>
  <div class="quick-codes-panel">
    <!-- 冻结容器（对照 CodesPage .frozen 先例）：搜索行+标签筛选行 sticky 挂滚动祖先，列表滚动时保持可见 -->
    <div class="frozen">
      <SearchBar
        :model-value="query" :search-secret="searchSecret"
        @update:model-value="emit('update:query', $event)"
        @update:search-secret="emit('update:searchSecret', $event)"
      />
      <TagFilterRow
        v-if="showTagRow" :manageable="false"
        :tags="tags ?? []" :selected-ids="selectedTagIds ?? []" :mode="tagMode ?? 'any'"
        @update:selected-ids="emit('update:selectedTagIds', $event)"
        @update:mode="emit('update:tagMode', $event)"
      />
    </div>
    <template v-if="!loading">
      <OtpListItem
        v-for="(e, i) in entries" :key="e.uuid"
        :entry="e" :icon="iconView(e.icon, icons ?? undefined)"
        :index="showIndex ? i + 1 : undefined" :context-menu="contextMenu"
        v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 1 }"
        @copy="emit('copy', e)" @dblclick="emit('dblclick', $event)"
      />
      <div v-if="emptyDisplay" class="empty">{{ emptyDisplay }}</div>
    </template>
  </div>
</template>

<style scoped>
/* 冻结容器：sticky 规则与背景同 CodesPage .frozen（z-index 5 < TagFilterRow 说明气泡 10）；
   column+gap 隔开搜索行与筛选行。R5-M6 缝隙补偿：sticky 贴滚动视口顶时背景只盖自身盒，
   列表内容可从宿主 padding（popup body 8px / mini 6px / CodesPage 卡片 16px）两侧缝隙穿过——
   负 margin 拉通 + 等量 padding 内缩（宿主经 --frozen-bleed 按各自 padding 设值，默认 0 不动），
   内容布局不变、背景延伸覆盖缝隙 */
.frozen { position: sticky; top: 0; z-index: 5; background: var(--md-sys-color-surface); display: flex; flex-direction: column; gap: 8px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  margin-inline: calc(-1 * var(--frozen-bleed, 0px)); padding-inline: var(--frozen-bleed, 0px); }
/* 两态空态文案（同 popup .empty） */
.empty { text-align: center; opacity: .6; padding: 32px 0; }
</style>
