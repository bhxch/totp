<script setup lang="ts">
import { suggestIcons, type BuiltinIcon, type IconSuggestion } from '@totp/core'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ensureFullIcons, fullIconsError, fullIconsReady } from '../fullIcons'
import MdDialog from './md/MdDialog.vue'
import MdTextField from './md/MdTextField.vue'

/** 选中载荷：stored 含上传与包导入图标 */
export interface PickerSelect {
  kind: 'builtin' | 'stored'
  id: string
  title: string
}

const props = defineProps<{
  open: boolean
  builtin: Record<string, BuiltinIcon>
  /** 当前服务商名称：打开时按模糊匹配生成推荐区，空/无候选则不显示 */
  issuer?: string
  /** stored dataUrl 映射（urlcache: 前缀键排除在选择源之外） */
  stored?: Readonly<Record<string, string>>
  /** 包注册表（normKey → { name, iconIds }）：来源筛选与按包删除 */
  packs?: Readonly<Record<string, { name: string; iconIds: string[] }>>
}>()
const emit = defineEmits<{ select: [item: PickerSelect]; removePack: [normKey: string]; close: [] }>()

const { t } = useI18n()
const query = ref('')
watch(
  () => props.open,
  (open) => {
    if (open) {
      query.value = ''
      active.value = 'all'
      confirmingRemove.value = null
      void ensureFullIcons()
      void nextTick(measure)
    }
  },
)

// ---- 来源分桶（派生判定，零迁移）----
interface Item {
  id: string
  title: string
  kind: 'builtin' | 'stored'
  src?: string
}
const storedItems = computed<Item[]>(() =>
  Object.entries(props.stored ?? {})
    .filter(([id]) => !id.startsWith('urlcache:'))
    .map(([id, src]) => ({ id, title: id, kind: 'stored' as const, src })),
)
function packKeyOf(id: string): string | undefined {
  for (const [key, p] of Object.entries(props.packs ?? {})) if (p.iconIds.includes(id)) return key
  return undefined
}
const storedExtras = computed(() => storedItems.value.map((i) => ({ id: i.id })))

// ---- 来源筛选 chips ----
type ChipKey = 'all' | 'builtin' | 'uploaded' | (string & {})
const active = ref<ChipKey>('all')
const uploadedCount = computed(() => storedItems.value.filter((i) => !packKeyOf(i.id)).length)
const chips = computed(() => {
  const list: Array<{ key: ChipKey; label: string }> = [
    { key: 'all', label: t('entryForm.iconFilterAll') },
    { key: 'builtin', label: t('entryForm.iconFilterBuiltin') },
  ]
  if (uploadedCount.value > 0) list.push({ key: 'uploaded', label: t('entryForm.iconFilterUploaded') })
  for (const [key, p] of Object.entries(props.packs ?? {})) list.push({ key, label: p.name })
  return list
})
function matchesChip(item: Item): boolean {
  if (active.value === 'all') return true
  if (active.value === 'builtin') return item.kind === 'builtin'
  if (active.value === 'uploaded') return item.kind === 'stored' && !packKeyOf(item.id)
  return item.kind === 'stored' && packKeyOf(item.id) === active.value
}
/** 非 package chip（全部/内置/上传）整体单 button；包 chip 拆 label/× 两个真 button（交互元素不可嵌套） */
const isPackChip = (key: ChipKey) => key !== 'all' && key !== 'builtin' && key !== 'uploaded'
const plainChips = computed(() => chips.value.filter((c) => !isPackChip(c.key)))
const packChips = computed(() => chips.value.filter((c) => isPackChip(c.key)))

/** 包删除两步确认：× → 确认按钮 → emit；切换/关闭重置 */
const confirmingRemove = ref<string | null>(null)
function onConfirmRemove() {
  const key = confirmingRemove.value
  confirmingRemove.value = null
  if (key) {
    emit('removePack', key)
    if (active.value === key) active.value = 'all'
  }
}

// ---- 列表组装：搜索走 suggestIcons（含 stored extra），否则全集按 chip 过滤 ----
const searching = computed(() => query.value.trim() !== '')
const results = computed<Item[]>(() => {
  if (searching.value) {
    return suggestIcons(query.value.trim(), Number.MAX_SAFE_INTEGER, storedExtras.value)
      .map((s: IconSuggestion) =>
        s.source === 'builtin'
          ? { id: s.id, title: s.title, kind: 'builtin' as const }
          : { id: s.id, title: s.title, kind: 'stored' as const, src: props.stored?.[s.id] },
      )
      .filter(matchesChip)
  }
  const builtinItems: Item[] = Object.values(props.builtin).map((b) => ({ id: b.id, title: b.title, kind: 'builtin' }))
  const pool = active.value === 'builtin' ? builtinItems : [...builtinItems, ...storedItems.value]
  return pool.filter(matchesChip)
})
const recommended = computed<IconSuggestion[]>(() =>
  props.open ? suggestIcons(props.issuer ?? '', 3, storedExtras.value) : [],
)

// ---- 窗口化：行高定值 + 列数按容器宽推算；jsdom 高度 0 → 回退 30 项 ----
const scroller = ref<HTMLElement | null>(null)
const CELL_H = 96
const COL_MIN = 76
const colCount = ref(5)
const first = ref(0)
const visibleCount = ref(30)
function measure() {
  const el = scroller.value
  if (!el) return
  colCount.value = Math.max(3, Math.floor((el.clientWidth + 4) / (COL_MIN + 4)))
  el.style.setProperty('--picker-cols', String(colCount.value))
  if (el.clientHeight > 0) visibleCount.value = (Math.ceil(el.clientHeight / CELL_H) + 4) * colCount.value
}
function onScroll() {
  const el = scroller.value
  if (!el) return
  const startRow = Math.max(0, Math.floor(el.scrollTop / CELL_H) - 4)
  first.value = startRow * colCount.value
}
watch([results, () => props.open], () => {
  first.value = 0
  // 归零滚动位置（等价 scrollTo(0,0)，scrollTop 赋值为 jsdom 支持的写法）
  if (scroller.value) scroller.value.scrollTop = 0
  void nextTick(measure)
})
const windowed = computed(() => results.value.slice(first.value, first.value + visibleCount.value))
/** spacer 总高占位：行数 × CELL_H，撑起真实滚动空间使 scrollTop 可达翻页阈值 */
const totalHeight = computed(() => Math.ceil(results.value.length / colCount.value) * CELL_H)
/** 网格锚点：窗口首行距 spacer 顶部的偏移 */
const firstRow = computed(() => Math.floor(first.value / colCount.value))

function select(item: Item) {
  emit('select', { kind: item.kind, id: item.id, title: item.title })
}
</script>

<template>
  <MdDialog :open="open" :headline="t('entryForm.iconPickerTitle')" @close="emit('close')">
    <MdTextField
      v-model="query" class="picker-search" :label="t('entryForm.searchIconsLabel')"
      :placeholder="t('entryForm.searchIcons')" :aria-label="t('entryForm.searchIconsLabel')"
    />
    <div class="picker-chips">
      <!-- 非 package chip：单 button 整体可点；包 chip：label 与 × 拆为真 button（键盘可达删包入口） -->
      <button
        v-for="chip in plainChips" :key="chip.key" type="button" class="picker-chip"
        :class="{ active: active === chip.key }" @click="active = chip.key; confirmingRemove = null"
      >{{ chip.label }}</button>
      <span v-for="chip in packChips" :key="chip.key" class="picker-chip" :class="{ active: active === chip.key }">
        <button type="button" class="chip-label" @click="active = chip.key; confirmingRemove = null">{{ chip.label }}</button>
        <button
          type="button" class="chip-remove" :aria-label="t('entryForm.iconPackRemoveConfirm')"
          @click.stop="confirmingRemove = String(chip.key)"
        >×</button>
        <template v-if="confirmingRemove === chip.key">
          <button type="button" class="chip-remove-confirm" @click.stop="onConfirmRemove">{{ t('entryForm.iconPackRemoveConfirm') }}</button>
          <button type="button" class="chip-remove-cancel" @click.stop="confirmingRemove = null">{{ t('entryForm.iconPackRemoveCancel') }}</button>
        </template>
      </span>
    </div>
    <p v-if="open && !fullIconsReady && !fullIconsError" class="picker-loading">{{ t('entryForm.iconsLoading') }}</p>
    <button v-if="open && fullIconsError" type="button" class="picker-retry" @click="void ensureFullIcons()">
      {{ t('entryForm.iconsLoadRetry') }}
    </button>
    <div v-if="!searching && recommended.length > 0" class="picker-recommended">
      <p class="picker-section-label">{{ t('entryForm.recommendedSection') }}</p>
      <div class="picker-grid">
        <button
          v-for="icon in recommended" :key="`rec-${icon.source}-${icon.id}`" type="button" class="picker-cell"
          :title="icon.title" :aria-label="icon.title" @click="select(icon.source === 'builtin'
            ? { id: icon.id, title: icon.title, kind: 'builtin' }
            : { id: icon.id, title: icon.title, kind: 'stored' })"
        >
          <svg v-if="icon.path" viewBox="0 0 24 24" aria-hidden="true"><path :d="icon.path" /></svg>
          <img v-else :src="stored?.[icon.id]" alt="" />
        </button>
      </div>
    </div>
    <p class="picker-section-label">{{ searching ? t('entryForm.searchResultsSection') : t('entryForm.allIconsSection') }}</p>
    <div ref="scroller" class="picker-scroll" @scroll.passive="onScroll">
      <div class="picker-spacer" :style="{ height: totalHeight + 'px', position: 'relative' }">
        <div
          class="picker-grid picker-grid--all" :data-total="results.length" :data-first="first"
          :style="{ top: firstRow * CELL_H + 'px' }"
        >
          <button
            v-for="item in windowed" :key="`${item.kind}-${item.id}`" type="button" class="picker-cell picker-cell--labeled"
            :title="item.title" :aria-label="item.title" @click="select(item)"
          >
            <svg v-if="item.kind === 'builtin'" viewBox="0 0 24 24" aria-hidden="true"><path :d="builtin[item.id]!.path" /></svg>
            <img v-else :src="item.src" alt="" />
            <span class="picker-cell-label">{{ item.title }}</span>
          </button>
        </div>
      </div>
    </div>
    <p v-if="searching && results.length === 0" class="picker-empty">{{ t('entryForm.iconPickerNoResults') }}</p>
  </MdDialog>
</template>

<style scoped>
.picker-search { margin-bottom: 4px; }
.picker-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
.picker-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--md-sys-color-outline-variant); border-radius: 999px; background: transparent; color: var(--md-sys-color-on-surface-variant); padding: 2px 10px; font-size: var(--md-sys-typescale-body-small); cursor: pointer; position: relative; }
/* 命中层:inset -6px 扩薄 chip 触达(视觉尺寸不变;相邻 chip 命中带重叠,MD3 允许) */
.picker-chip::after { content: ''; position: absolute; inset: -6px; border-radius: inherit; }
/* C1:packChips 宿主为 span(非交互),命中层是绝对定位盒、绘制于流内内容之上——真实浏览器命中测试
 * 取顶层盒,内嵌 4 类 button(选包/删包/确认/取消)点击全被截走(jsdom 无 hit-testing 故测试未拦)。
 * 内嵌交互元素统一抬高到伪元素之上恢复点击;plainChips 宿主自身为 button(无子 button),不受影响 */
.picker-chip > button { position: relative; z-index: 1; }
.picker-chip.active { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); border-color: transparent; }
.chip-label { border: none; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 0; }
.chip-remove { border: none; background: transparent; color: inherit; font: inherit; cursor: pointer; opacity: 0.6; padding: 0 2px; min-width: 40px; min-height: 40px; }
.chip-remove:hover { opacity: 1; }
.chip-remove-confirm, .chip-remove-cancel { border: none; background: transparent; color: inherit; font-size: var(--md-sys-typescale-label-small); cursor: pointer; padding: 0 2px; min-width: 40px; min-height: 40px; }
.chip-remove-confirm { color: var(--md-sys-color-error); }
.picker-loading, .picker-empty { font-size: var(--md-sys-typescale-body-small); opacity: 0.6; }
.picker-retry { border: none; background: transparent; color: var(--md-sys-color-primary); cursor: pointer; font-size: var(--md-sys-typescale-body-small); }
.picker-section-label { font-size: var(--md-sys-typescale-label-medium); opacity: 0.65; margin: 8px 0 4px; }
.picker-scroll { max-height: 300px; overflow-y: auto; }
.picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 4px; }
/* 全量网格：列数由 measure 写入 CSS 变量（回退 5 与初始 colCount 一致），行高写实对齐 JS CELL_H 常量（92+4 gap=96） */
.picker-grid--all { position: absolute; left: 0; right: 0; grid-template-columns: repeat(var(--picker-cols, 5), minmax(0, 1fr)); }
.picker-cell { display: grid; place-items: center; gap: 2px; width: 100%; padding: 6px 2px; border: none; border-radius: 8px; background: transparent; color: var(--md-sys-color-on-surface-variant); cursor: pointer; }
.picker-cell:hover { background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent); color: var(--md-sys-color-on-surface); }
.picker-cell svg { width: 24px; height: 24px; fill: currentColor; }
.picker-cell img { width: 24px; height: 24px; object-fit: contain; }
.picker-cell--labeled { grid-template-rows: 24px 1fr; height: 92px; }
.picker-cell-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 1.2; }
</style>
