<script setup lang="ts">
import { applyImport, dedupeWithinFile, parsePastedText, planImport, type ImportKind, type OtpEntry, type ParsedEntry, type Vault } from '@totp/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseUriToEntryData } from '../otpauthFlow'
import { decodeQrToUri } from '../qr/decodeQr'
import { blobToPixels, imagesFromClipboard } from '../qr/imageSource'
import type { VueStore } from '../store'
import MdButton from './md/MdButton.vue'
import MdSelect from './md/MdSelect.vue'

const { t } = useI18n()

type RowKind = ImportKind
type RowChoice = 'skip' | 'add' | 'replace' | 'merge'
/** 行内决策模型：kind new 恒 add、identical 恒 skip 不可选；suspect 可 skip/add；conflict 可 skip/add/replace/merge */
interface RowDecision {
  entry: ParsedEntry
  kind: RowKind
  choice: RowChoice
}

const props = defineProps<{ store: VueStore }>()
const emit = defineEmits<{ added: [count: number] }>()

const text = ref('')
const error = ref('')
const rows = ref<RowDecision[]>([])
const failureLines = ref<string[]>([])
const imageErrors = ref<string[]>([])
const pendingImages = ref(0)

function parse(): void {
  error.value = ''
  failureLines.value = []
  rows.value = []
  imageErrors.value = []
  // parser 对结构畸形输入可能直接抛错（如嗅探为 aegis 后解析中断）：兜底展示，不让点击崩掉
  let r: ReturnType<typeof parsePastedText>
  try {
    r = parsePastedText(text.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return
  }
  if ('unsupported' in r) {
    error.value = r.unsupported
    return
  }
  if (r.entries.length === 0 && r.failures.length > 0) {
    error.value = t('batchPastePanel.noEntries', { count: r.failures.length })
    return
  }
  // 批内先去重再判定（dedupeWithinFile 返回 { kept, removed }，core import/dedup.ts:24）：
  // 同一 URI 粘两遍时两行全字段相同，若直接进 planImport 恒判 new → vault 落两条完全相同条目。
  // 前置与文件导入路径（ImportCard）一致；被移除行不单独展示，静默合并进后续流程
  const { kept } = dedupeWithinFile(r.entries)
  // planImport 返回 { kinds, targetUuids, counts }（import/dedup.ts:48）——按下标对齐逐条标注
  const plan = planImport(props.store.vault, kept)
  rows.value = kept.map((entry, i) => {
    const kind = plan.kinds[i] ?? 'new'
    return { entry, kind, choice: kind === 'new' ? ('add' as const) : ('skip' as const) }
  })
  failureLines.value = r.failures.map((f) => t('batchPastePanel.failureLine', { index: f.index + 1, message: f.message }))
}

/** OtpEntry 哑值 → ParsedEntry 字段投影：仅导入判定/落库相关字段，uuid/order/createdAt 等管理字段不投影 */
function toParsed(d: OtpEntry): ParsedEntry {
  return {
    type: d.type,
    issuer: d.issuer,
    label: d.label,
    secret: d.secret,
    algorithm: d.algorithm,
    digits: d.digits,
    period: d.period,
    ...(d.counter !== undefined ? { counter: d.counter } : {}),
    // yandex（yaotp URI）的 PIN 随投影保留（I1a）：缺省即无 PIN
    ...(d.pin !== undefined ? { pin: d.pin } : {}),
  }
}

async function onPasteImages(e: ClipboardEvent): Promise<void> {
  const files = imagesFromClipboard(e)
  if (files.length > 0) { e.preventDefault(); await decodeImages(files) }
}

async function onDropImages(e: DragEvent): Promise<void> {
  // @dragover.prevent 已无条件把面板标记为投放目标，drop 必须兜底取消默认导航：
  // 非图片（或 MIME 为空）文件落入时若不 preventDefault，浏览器会导航打开该文件（popup 关闭丢状态）
  if ((e.dataTransfer?.files.length ?? 0) > 0) e.preventDefault()
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
  if (files.length > 0) await decodeImages(files)
}

/** 逐图解码合并进结果列表：单图失败不阻塞后续（记入 imageErrors）；
 * 入列表前走文本路径同一去重键（dedupeWithinFile 保首条）——同一二维码贴两次不双写 */
async function decodeImages(files: File[]): Promise<void> {
  pendingImages.value += files.length
  try {
    for (const f of files) {
      try {
        const r = decodeQrToUri(await blobToPixels(f))
        if ('error' in r) { imageErrors.value.push(t('batchPastePanel.imageError', { name: f.name, message: r.error })); continue }
        const d = parseUriToEntryData(r.uri)
        if ('error' in d) { imageErrors.value.push(t('batchPastePanel.imageError', { name: f.name, message: d.error })); continue }
        const parsed = toParsed(d.data)
        const prior = rows.value.map((row) => row.entry)
        if (dedupeWithinFile([...prior, parsed]).kept.length !== prior.length + 1) continue
        const plan = planImport(props.store.vault, [parsed])
        rows.value.push({ entry: parsed, kind: plan.kinds[0] ?? 'new', choice: plan.kinds[0] === 'new' ? 'add' : 'skip' })
      } catch {
        imageErrors.value.push(t('batchPastePanel.imageError', { name: f.name, message: t('batchPastePanel.imageReadFailed') }))
      }
    }
  } finally {
    pendingImages.value -= files.length
  }
}

async function commit(): Promise<void> {
  const active = rows.value.filter((r) => r.choice !== 'skip' && r.kind !== 'identical')
  if (active.length === 0) {
    emit('added', 0)
    return
  }
  await props.store.commit((v) => applyByChoices(v, active))
  emit('added', active.length)
}

/** 逐条决策 → 三批次串联 applyImport（immutable，store.commit 采纳末值）：
 * add=强制新增（空冲突集绕过 skip 策略）；replace/merge=整批标记冲突集 + 对应策略，
 * 复用 conflict.ts 按 issuer+label 定位既有条目（replace 覆盖 / merge 并存追加） */
function applyByChoices(v: Vault, active: RowDecision[]): Vault {
  const asNew = active.filter((r) => r.choice === 'add').map((r) => r.entry)
  const asReplace = active.filter((r) => r.choice === 'replace').map((r) => r.entry)
  const asMerge = active.filter((r) => r.choice === 'merge').map((r) => r.entry)
  let next = v
  next = applyImport(next, asNew, 'skip', new Set<number>())
  next = applyImport(next, asReplace, 'replace', new Set(asReplace.map((_, i) => i)))
  next = applyImport(next, asMerge, 'merge', new Set(asMerge.map((_, i) => i)))
  return next
}

const activeCount = computed(() => rows.value.filter((r) => r.choice !== 'skip' && r.kind !== 'identical').length)

function kindLabel(k: RowKind): string {
  return k === 'identical' ? t('batchPastePanel.kindIdentical') : k === 'suspect' ? t('batchPastePanel.kindSuspect') : k === 'conflict' ? t('batchPastePanel.kindConflict') : t('batchPastePanel.kindNew')
}

/** MdSelect 选项随 kind 收敛：suspect 无覆盖/并集语义（无 issuer+label 定位目标） */
function choiceOptions(kind: RowKind): Array<{ value: string | number; label: string }> {
  if (kind === 'conflict') {
    return [
      { value: 'skip', label: t('batchPastePanel.choiceSkip') },
      { value: 'add', label: t('batchPastePanel.choiceAdd') },
      { value: 'replace', label: t('batchPastePanel.choiceReplace') },
      { value: 'merge', label: t('batchPastePanel.choiceMerge') },
    ]
  }
  return [
    { value: 'skip', label: t('batchPastePanel.choiceSkip') },
    { value: 'add', label: t('batchPastePanel.choiceAdd') },
  ]
}

/** MdSelect emit 值为泛化 string|number，赋值前收敛回精确联合类型（EntryForm onTypeSelect 同款收口） */
function onChoiceSelect(r: RowDecision, v: string | number): void {
  r.choice = v as RowChoice
}
</script>
<template>
  <div class="batch-paste" data-test="paste-zone" @paste="onPasteImages" @dragover.prevent @drop="onDropImages">
    <textarea v-model="text" rows="6" :aria-label="t('batchPastePanel.pasteAria')"
      :placeholder="t('batchPastePanel.pastePlaceholder')"></textarea>
    <p v-if="pendingImages > 0" class="pending" data-test="paste-decoding">{{ t('batchPastePanel.decoding') }}</p>
    <div class="actions">
      <MdButton data-test="paste-parse" :disabled="text.trim() === ''" @click="parse">{{ t('batchPastePanel.parse') }}</MdButton>
      <MdButton data-test="paste-commit" variant="filled" :disabled="rows.length === 0" @click="commit">
        {{ t('batchPastePanel.addBtn', { count: activeCount }) }}
      </MdButton>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-for="f in failureLines" :key="f" class="err">{{ f }}</p>
    <p v-for="(ie, i) in imageErrors" :key="`img-${i}`" class="err" data-test="paste-image-error">{{ ie }}</p>
    <ul v-if="rows.length > 0" class="rows">
      <li v-for="(r, i) in rows" :key="i" data-test="paste-row">
        <span class="meta">{{ r.entry.issuer }} · {{ r.entry.label }}</span>
        <span class="kind" :class="`kind--${r.kind}`">{{ kindLabel(r.kind) }}</span>
        <MdSelect v-if="r.kind !== 'new' && r.kind !== 'identical'" class="choice" :label="t('batchPastePanel.choiceLabel')"
          :model-value="r.choice" :options="choiceOptions(r.kind)"
          :aria-label="t('batchPastePanel.choiceAria', { target: r.entry.issuer || r.entry.label })"
          @update:model-value="onChoiceSelect(r, $event)" />
      </li>
    </ul>
  </div>
</template>
<style scoped>
.batch-paste { display: flex; flex-direction: column; gap: 12px; }
.batch-paste textarea { box-sizing: border-box; width: 100%; resize: vertical; font: inherit;
  padding: 12px 16px; border-radius: 8px; border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-highest); color: var(--md-sys-color-on-surface); }
.batch-paste textarea:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.actions { display: flex; gap: 8px; align-items: center; }
.err { margin: 0; color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); }
.pending { margin: 0; color: var(--md-sys-color-on-surface-variant); font-size: var(--md-sys-typescale-body-small); }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.rows li { display: flex; align-items: center; gap: 12px; padding: 8px 12px;
  border-radius: 8px; background: var(--md-sys-color-surface-container); }
.meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--md-sys-typescale-body-medium); color: var(--md-sys-color-on-surface); }
.kind { flex: none; font-size: var(--md-sys-typescale-body-small); padding: 2px 8px; border-radius: 100px; }
.kind--new { color: var(--md-sys-color-on-primary-container); background: var(--md-sys-color-primary-container); }
.kind--identical { color: var(--md-sys-color-on-surface-variant); background: var(--md-sys-color-surface-container-highest); }
.kind--suspect { color: var(--md-sys-color-on-tertiary-container); background: var(--md-sys-color-tertiary-container); }
.kind--conflict { color: var(--md-sys-color-on-error-container); background: var(--md-sys-color-error-container); }
.choice { flex: none; width: 168px; }
</style>
