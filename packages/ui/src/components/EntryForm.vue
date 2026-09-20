<script setup lang="ts">
import { base32Decode, getBuiltinIcons, recommendBuiltinIcon, type BuiltinIcon, type HashAlgorithm, type MatchRule, type MatchStrategy, type OtpEntry, type Tag } from '@totp/core'
import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MAX_ICON_PACK_ZIP_BYTES, fileToScaledDataUrl, importIconPackZip } from '../iconImport'
import { blobToPixels } from '../qr/imageSource'
import { decodeQrToUri } from '../qr/decodeQr'
import { parseUriToEntryData } from '../otpauthFlow'
import type { IconStore } from '../iconStore'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'
import MdIconButton from './md/MdIconButton.vue'
import MdSelect from './md/MdSelect.vue'
import MdTextField from './md/MdTextField.vue'
import { type EntryFormData, validateRegex, type RegexIssue } from './entryForm'

const { t } = useI18n()

/** RegexIssue → 成品文案：raw（浏览器本地化消息）优先，否则 t(key, params) */
function regexIssueMessage(issue: RegexIssue): string {
  return issue.raw ?? t(issue.key, issue.params ?? {})
}

export type { EntryFormData }

/** 与 vue 原生 v-model.number 同语义的宽松转数字（parseFloat 失败回退原串，如清空输入时的 ''）；
 *  MdTextField 无 modelModifiers 机制，digits/period/counter 的数字绑定经此转换 */
function looseToNumber(v: string): number {
  const n = Number.parseFloat(v)
  return Number.isNaN(n) ? (v as unknown as number) : n
}

const props = defineProps<{
  initial?: OtpEntry | null
  tags?: Tag[]
  /** 内联快速建 tag：宿主侧创建并回传新 tag id；缺省不渲染内联建行 */
  createTag?: (name: string) => Promise<string>
  /** 图标数据源：builtin 内置集 + stored（含 'url:' 前缀缓存键）dataUrl 映射；缺省不渲染推荐气泡与图标选择区 */
  icons?: { builtin: Record<string, BuiltinIcon>; stored: Readonly<Record<string, string>> }
  /** 图标存储：上传/URL 拉取需要写能力；缺省时隐藏上传与 URL 拉取 */
  iconStore?: IconStore
}>()
const emit = defineEmits<{ save: [data: EntryFormData]; cancel: [] }>()

const form = reactive({
  type: (props.initial?.type ?? 'totp') as 'totp' | 'hotp' | 'steam' | 'yandex',
  issuer: props.initial?.issuer ?? '',
  label: props.initial?.label ?? '',
  secret: props.initial?.secret ?? '',
  algorithm: (props.initial?.algorithm ?? 'SHA1') as HashAlgorithm,
  digits: (props.initial?.digits ?? 6) as number,
  period: (props.initial?.period ?? 30) as number,
  counter: (props.initial?.counter ?? 0) as number,
  pin: props.initial?.pin ?? '',
  note: props.initial?.note ?? '',
  tagIds: [...(props.initial?.tagIds ?? [])],
  matchRules: (props.initial?.matchRules ?? []).map((r) => ({ ...r })),
  icon: props.initial?.icon as EntryFormData['icon'],
})
const error = ref('')
// F2：type 切换时实时同步 digits（steam 固定 5、yandex 固定 8；离开这两类回落 6），
// 输入框所见即所存，不再依赖 submit 时的静默纠正（此前 UI 显示 6 但保存为 5，视觉与数据不一致）
watch(
  () => form.type,
  (type, old) => {
    if (type === old) return
    if (type === 'steam') form.digits = 5
    else if (type === 'yandex') form.digits = 8
    else if (old === 'steam' || old === 'yandex') form.digits = 6
  },
)
// isNew：预填对象（URI 导入）uuid 为哑值空串，须按新建处理（按钮「添加」而非「保存」）
const isNew = !props.initial || !props.initial.uuid
/** secret 遮蔽：默认 password，点右侧按钮明文查看 */
const showSecret = ref(false)

function cleanSecret(): string {
  return form.secret.replace(/\s+/g, '').toUpperCase()
}

// ---------- 从图片识别（批② C2）：单图二维码解码 → otpauth 解析 → 覆盖 OTP 字段预填 ----------
const qrFile = ref<HTMLInputElement | null>(null)

async function onQrFile(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0]
  ;(ev.target as HTMLInputElement).value = '' // 允许重复选同一文件
  if (!file) return
  try {
    const pixels = await blobToPixels(file)
    const r = decodeQrToUri(pixels)
    if ('error' in r) { error.value = r.error; return }
    const d = parseUriToEntryData(r.uri)
    if ('error' in d) { error.value = d.error; return }
    // 预填（保留用户已填的 note/tagIds/icon，覆盖 OTP 字段）
    form.type = d.data.type; form.issuer = d.data.issuer; form.label = d.data.label
    form.secret = d.data.secret; form.algorithm = d.data.algorithm; form.digits = d.data.digits
    form.period = d.data.period; if (d.data.counter !== undefined) form.counter = d.data.counter
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('entryForm.imageReadFailed')
  }
}

// ---------- MdSelect 选项与回调（原生 select 收口；emit 值为泛化 string|number，赋值前收敛回精确联合类型） ----------
const TYPE_OPTIONS = [
  { value: 'totp', label: 'TOTP' },
  { value: 'hotp', label: t('entryForm.typeHotp') },
  { value: 'steam', label: 'Steam' },
  { value: 'yandex', label: t('entryForm.typeYandex') },
]
const ALGO_OPTIONS: Array<{ value: HashAlgorithm; label: string }> = [
  { value: 'SHA1', label: 'SHA1' },
  { value: 'SHA256', label: 'SHA256' },
  { value: 'SHA512', label: 'SHA512' },
]
const STRATEGY_OPTIONS: Array<{ value: MatchStrategy; label: string }> = [
  { value: 'baseDomain', label: t('entryForm.strategyBaseDomain') },
  { value: 'host', label: t('entryForm.strategyHost') },
  { value: 'exact', label: t('entryForm.strategyExact') },
  { value: 'startsWith', label: t('entryForm.strategyStartsWith') },
  { value: 'regex', label: t('entryForm.strategyRegex') },
]
/** type 下拉回调：赋值触发 digits 联动 watch（steam=5，离开 steam 回 6） */
function onTypeSelect(v: string | number): void {
  form.type = v as typeof form.type
}
function onAlgoSelect(v: string | number): void {
  form.algorithm = v as HashAlgorithm
}
function setRuleStrategy(r: MatchRule, v: string | number): void {
  r.strategy = v as MatchStrategy
}

/** 标签勾选（MdCheckbox 替代数组 v-model checkbox）：勾上加 id，取消勾移除 */
function toggleTag(id: string, checked: boolean): void {
  if (checked) {
    if (!form.tagIds.includes(id)) form.tagIds.push(id)
  } else {
    form.tagIds = form.tagIds.filter((g) => g !== id)
  }
}

// ---------- 内联快速建 tag（spec §3 EntryForm）：回车/按钮 → createTag → 自动勾选 ----------
const newTagName = ref('')
const creatingTag = ref(false)
/** 内联新建的 tag：宿主 tags prop 异步回流前先本地渲染，保证创建后立即出现于复选列表（按 id 去重） */
const createdTags = ref<Tag[]>([])
/** 复选列表 = 宿主 tags + 内联新建（按 id 去重，宿主回流后自然收敛） */
const shownTags = computed(() => {
  const list = props.tags ? [...props.tags] : []
  for (const created of createdTags.value) {
    if (!list.some((x) => x.id === created.id)) list.push(created)
  }
  return list
})
async function createTagAndCheck() {
  const name = newTagName.value.trim()
  if (!name || !props.createTag || creatingTag.value) return
  creatingTag.value = true
  try {
    const id = await props.createTag(name)
    if (id && !form.tagIds.includes(id)) form.tagIds.push(id)
    if (id) createdTags.value.push({ id, name })
    newTagName.value = ''
  } finally {
    creatingTag.value = false
  }
}

/** I68：base32 实时校验——非 hotp 类型（不需 secret）+ secret 非空时按 [A-Z2-7]+=* 判定；用于输入框实时反馈。
 *  实际合法性（含 RFC 4648 padding/长度）仍以 submit 时 base32Decode 为准；此处仅做轻量字符集合校验 */
const isValidBase32 = computed(() => {
  if (form.type === 'hotp') return true // hotp 不展示 secret 输入框
  const s = cleanSecret()
  if (!s) return true // 空串允许（HOTP 类型或预填待补）
  return /^[A-Z2-7]+=*$/.test(s)
})
/** I68：inline 错误文案——非空 + 不合法时给提示，但不阻塞输入；submit 时 base32Decode 仍把关 */
const base32Hint = computed(() => {
  if (isValidBase32.value) return ''
  return t('entryForm.base32Hint')
})

// ---------- 图标推荐（issuer 防抖 300ms） ----------
/** 用户是否已手动设置过图标（推荐气泡只在未手动设置时出现）
 *  M25（intentional）：iconTouched 仅在表单实例生命周期内有效 —— 用户手动清除图标后不会再显示推荐，
 *  这是有意行为：避免「清空即重置推荐 → 推荐又立刻填充」的视觉跳跃；推荐应只在首次进入表单时介入一次。 */
const iconTouched = ref(props.initial?.icon !== undefined)
const recommended = ref<BuiltinIcon | null>(null)
let recommendTimer: ReturnType<typeof setTimeout> | null = null
// I67：组件卸载时清理防抖定时器，避免异步回调在 unmount 后写 ref 触发警告
onScopeDispose(() => {
  if (recommendTimer !== null) {
    clearTimeout(recommendTimer)
    recommendTimer = null
  }
})

watch(
  () => form.issuer,
  (v) => {
    if (recommendTimer) clearTimeout(recommendTimer)
    recommendTimer = setTimeout(() => {
      recommended.value = props.icons && !iconTouched.value && !form.icon ? recommendBuiltinIcon(v.trim()) : null
    }, 300)
  },
)
const recommendVisible = computed(() => props.icons !== undefined && !iconTouched.value && !form.icon && recommended.value !== null)

function useRecommended() {
  if (!recommended.value) return
  form.icon = { kind: 'builtin', id: recommended.value.id }
  iconTouched.value = true
  recommended.value = null
}

// ---------- 图标选择区（details 默认收起） ----------
const iconError = ref('')
const iconUrlInput = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
/** stored id：编辑沿用条目 uuid（重复上传即覆盖）；新建/预填（哑值空串 uuid）各取随机 uuid 作存储键，避免连续预填互相覆盖 */
const iconId = props.initial?.uuid || crypto.randomUUID()

function builtinHtml(path: string): string {
  return `<path d="${path}"></path>`
}
const currentIcon = computed<{ html?: string; src?: string } | undefined>(() => {
  const ref = form.icon
  if (!ref) return undefined
  if (ref.kind === 'builtin') {
    const path = (props.icons?.builtin ?? getBuiltinIcons())[ref.id]?.path
    return path ? { html: builtinHtml(path) } : undefined
  }
  const key = ref.kind === 'url' ? `urlcache:${ref.id}` : ref.id
  const src = props.icons?.stored[key]
  return src ? { src } : undefined
})

async function onIconFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !props.iconStore) return
  iconError.value = ''
  try {
    const dataUrl = await fileToScaledDataUrl(file)
    await props.iconStore.put(iconId, dataUrl)
    form.icon = { kind: 'stored', id: iconId }
    iconTouched.value = true
  } catch (err) {
    iconError.value = err instanceof Error ? err.message : String(err)
  } finally {
    input.value = '' // 允许重复选择同一文件
  }
}

async function onFetchIcon() {
  if (!props.iconStore) return
  const url = iconUrlInput.value.trim()
  if (!url) return
  iconError.value = ''
  const ref = { kind: 'url' as const, id: iconId, url }
  const result = await props.iconStore.fetchAndCache(ref)
  if (result.ok) {
    form.icon = ref
    iconTouched.value = true
  } else {
    // I59：根据失败原因展示对应文案
    const tip: Record<string, string> = {
      cors: t('entryForm.iconFetchCors'),
      notfound: t('entryForm.iconFetchNotfound'),
      toolarge: t('entryForm.iconFetchToolarge'),
      other: t('entryForm.iconFetchOther'),
    }
    iconError.value = t('entryForm.iconFetchFailed', { reason: tip[result.kind] ?? tip.other, message: result.message })
  }
}

function clearIcon() {
  form.icon = undefined
  iconTouched.value = true
}

// ---------- 图标包（zip）导入 ----------
const packInput = ref<HTMLInputElement | null>(null)
const packBusy = ref(false)
const packMessage = ref('')

async function onPackFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !props.iconStore) return
  packBusy.value = true
  iconError.value = ''
  packMessage.value = ''
  try {
    // F15：读入前按文件大小前置拦截（解压预算之外的第一道闸）
    if (file.size > MAX_ICON_PACK_ZIP_BYTES) {
      throw new Error(t('entryForm.iconPackTooLarge', { limit: Math.floor(MAX_ICON_PACK_ZIP_BYTES / 1024 / 1024) }))
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await importIconPackZip(bytes, props.iconStore)
    packMessage.value = t('entryForm.iconPackImported', { imported: result.imported, skipped: result.skipped })
  } catch (err) {
    iconError.value = err instanceof Error ? err.message : String(err)
  } finally {
    packBusy.value = false
    input.value = '' // 允许重复选择同一文件
  }
}

function submit() {
  error.value = ''
  // secret 可空（HOTP 不需 secret；新建条目允许先填其他字段）
  if (form.type !== 'hotp' && cleanSecret()) {
    try {
      base32Decode(cleanSecret())
    } catch {
      error.value = t('entryForm.invalidBase32')
      return
    }
  }
  const digits = form.digits
  if (form.type === 'steam' && digits !== 5) {
    error.value = t('entryForm.steamDigitsError')
    return
  }
  if (form.type === 'yandex' && digits !== 8) {
    error.value = t('entryForm.yandexDigitsError')
    return
  }
  if (form.type !== 'steam' && form.type !== 'yandex' && ![6, 7, 8].includes(digits)) {
    error.value = t('entryForm.digitsError')
    return
  }
  if (!Number.isFinite(form.period) || form.period < 1) {
    error.value = t('entryForm.periodError')
    return
  }
  if (form.type === 'hotp' && (!Number.isInteger(form.counter) || form.counter < 0)) {
    error.value = t('entryForm.counterError')
    return
  }
  // I51：regex 策略客户端预校验；非 regex 策略由浏览器插件侧自行判定
  for (const r of form.matchRules) {
    if (r.strategy !== 'regex') continue
    const issue = validateRegex(r.pattern)
    if (issue) {
      error.value = t('entryForm.ruleRegexInvalid', { message: regexIssueMessage(issue) })
      return
    }
  }
  emit('save', {
    type: form.type,
    issuer: form.issuer.trim(),
    label: form.label.trim(),
    secret: cleanSecret(),
    algorithm: form.algorithm,
    digits: form.digits,
    period: form.period,
    note: form.note,
    tagIds: form.tagIds,
    matchRules: form.matchRules.filter((r) => r.pattern.trim()),
    icon: form.icon,
    // type 变更时同步默认 digits：steam=5、yandex=8，其他=6（避免显示错位数）
    ...(form.type !== props.initial?.type ? { digits: form.type === 'steam' ? 5 : form.type === 'yandex' ? 8 : 6 } : {}),
    // yandex 提交 PIN（trim；空串也提交以便编辑时清除既有 PIN）；其他类型不带
    ...(form.type === 'yandex' ? { pin: form.pin.trim() } : {}),
    // HOTP 才提交 counter；其他类型不带（避免污染 TOTP/steam 模型）
    ...(form.type === 'hotp' ? { counter: form.counter } : {}),
  })
}
</script>

<template>
  <form class="entry-form" @submit.prevent="submit">
    <MdSelect
      class="type-select" :label="t('entryForm.typeLabel')" :aria-label="t('entryForm.typeLabel')"
      :model-value="form.type" :options="TYPE_OPTIONS" @update:model-value="onTypeSelect"
    />
    <MdTextField v-model="form.issuer" :label="t('entryForm.issuerLabel')" :placeholder="t('entryForm.issuerPlaceholder')" :aria-label="t('entryForm.issuerLabel')" />
    <div v-if="recommendVisible && recommended" class="icon-recommend">
      {{ t('entryForm.iconDetected') }}
      <svg viewBox="0 0 24 24" class="icon-preview" aria-hidden="true" v-html="builtinHtml(recommended.path)" />
      <MdButton variant="text" class="use-recommend-icon" @click="useRecommended">{{ t('entryForm.useIcon') }}</MdButton>
    </div>
    <MdTextField v-model="form.label" :label="t('entryForm.labelLabel')" :aria-label="t('entryForm.labelLabel')" />
    <div class="secret-row">
      <MdTextField
        v-model="form.secret" class="secret-field" :type="showSecret ? 'text' : 'password'"
        :label="t('entryForm.secretLabel')" :placeholder="t('entryForm.secretPlaceholder')" :aria-label="t('entryForm.secretPlaceholder')"
        :class="{ invalid: !isValidBase32 }"
      />
      <MdButton variant="text" class="secret-toggle" @click="showSecret = !showSecret">{{ showSecret ? t('entryForm.hide') : t('entryForm.show') }}</MdButton>
      <MdButton variant="text" data-test="qr-pick" @click="qrFile?.click()">{{ t('entryForm.fromImage') }}</MdButton>
      <input ref="qrFile" type="file" accept="image/*" data-test="qr-file" class="visually-hidden" @change="onQrFile" />
    </div>
    <!-- I68：base32 实时校验的视觉反馈（不阻塞输入，submit 仍把关） -->
    <p v-if="base32Hint" class="base32-hint" role="status">{{ base32Hint }}</p>
    <div class="advanced-row">
      <MdSelect
        class="algorithm" :label="t('entryForm.algorithmLabel')" :aria-label="t('entryForm.algorithmLabel')"
        :model-value="form.algorithm" :options="ALGO_OPTIONS" @update:model-value="onAlgoSelect"
      />
      <MdTextField
        class="digits" type="number" :label="t('entryForm.digitsLabel')" :aria-label="t('entryForm.digitsLabel')" min="5" max="8"
        :model-value="String(form.digits)" @update:model-value="form.digits = looseToNumber($event)"
      />
      <MdTextField
        v-if="form.type !== 'hotp'" class="period" type="number" :label="t('entryForm.periodLabel')" :aria-label="t('entryForm.periodLabel')" min="1"
        :model-value="String(form.period)" @update:model-value="form.period = looseToNumber($event)"
      />
      <!-- steam 强制 5 位提示 -->
      <p v-if="form.type === 'steam'" class="steam-hint">{{ t('entryForm.steamDigitsHint') }}</p>
      <!-- yandex PIN（可选）：空缺省按无 PIN 计算 -->
      <MdTextField
        v-if="form.type === 'yandex'" v-model="form.pin" class="pin" :label="t('entryForm.pinLabel')"
        placeholder="Yandex PIN" :aria-label="t('entryForm.pinAria')"
      />
      <MdTextField
        v-if="form.type === 'hotp'" class="counter" type="number" :label="t('entryForm.counterLabel')" :aria-label="t('entryForm.counterLabel')" min="0"
        :model-value="String(form.counter)" @update:model-value="form.counter = looseToNumber($event)"
      />
    </div>
    <textarea v-model="form.note" :placeholder="t('entryForm.notePlaceholder')" rows="2" :aria-label="t('entryForm.noteAria')" />
    <fieldset v-if="shownTags.length > 0 || createTag">
      <legend>{{ t('entryForm.tagsLegend') }}</legend>
      <MdCheckbox
        v-for="tg in shownTags" :key="tg.id" class="tag-check"
        :model-value="form.tagIds.includes(tg.id)" :label="tg.name" :aria-label="tg.name"
        @update:model-value="toggleTag(tg.id, $event)"
      />
      <div v-if="createTag" class="new-tag-row">
        <MdTextField
          v-model="newTagName" class="new-tag" :label="t('entryForm.newTagLabel')" :placeholder="t('entryForm.newTagPlaceholder')" :aria-label="t('entryForm.newTagAria')"
          @keydown.enter.prevent="createTagAndCheck"
        />
        <MdButton variant="text" :disabled="creatingTag" @click="createTagAndCheck">{{ t('entryForm.add') }}</MdButton>
      </div>
    </fieldset>
    <!-- 图标选择区：默认收起 -->
    <details v-if="icons" class="icon-picker">
      <summary>{{ t('entryForm.iconsSummary') }}</summary>
      <div class="icon-current">
        <svg v-if="currentIcon?.html" viewBox="0 0 24 24" class="icon-preview" aria-hidden="true" v-html="currentIcon.html" />
        <img v-else-if="currentIcon?.src" :src="currentIcon.src" class="icon-current-img" :alt="t('entryForm.currentIconAlt')" />
        <span v-else class="icon-none">{{ t('entryForm.iconNone') }}</span>
      </div>
      <div class="icon-actions">
        <MdButton v-if="iconStore" variant="text" class="upload-icon" @click="fileInput?.click()">{{ t('entryForm.upload') }}</MdButton>
        <input ref="fileInput" type="file" accept="image/*" class="icon-file" @change="onIconFile" />
        <MdButton v-if="iconStore" variant="text" class="import-pack" :disabled="packBusy" @click="packInput?.click()">{{ t('entryForm.importIconPack') }}</MdButton>
        <input ref="packInput" type="file" accept=".zip" class="pack-file" @change="onPackFile" />
        <template v-if="iconStore">
          <MdTextField
            v-model="iconUrlInput" class="icon-url" :label="t('entryForm.iconUrlLabel')" :placeholder="t('entryForm.iconUrlPlaceholder')" :aria-label="t('entryForm.iconUrlPlaceholder')"
          />
          <MdButton variant="text" class="fetch-icon" @click="onFetchIcon">{{ t('entryForm.fetchIcon') }}</MdButton>
        </template>
        <MdButton v-if="form.icon" variant="text" class="clear-icon" @click="clearIcon">{{ t('entryForm.clearIcon') }}</MdButton>
      </div>
      <div v-if="packMessage" class="pack-message">{{ packMessage }}</div>
      <div v-if="iconError" class="error">{{ iconError }}</div>
    </details>
    <!-- matchRules 编辑区 -->
    <fieldset>
      <legend>{{ t('entryForm.matchRulesLegend') }}</legend>
      <div v-for="(r, i) in form.matchRules" :key="i" class="rule-row">
        <MdSelect
          class="rule-strategy" :label="t('entryForm.strategyLabel')" :aria-label="t('entryForm.strategyAria')"
          :model-value="r.strategy" :options="STRATEGY_OPTIONS" @update:model-value="setRuleStrategy(r, $event)"
        />
        <MdTextField
          v-model="r.pattern" class="rule-pattern" :label="t('entryForm.patternLabel')" :placeholder="t('entryForm.patternPlaceholder')" :aria-label="t('entryForm.patternAria')"
          :class="{ invalid: r.strategy === 'regex' && r.pattern.trim() !== '' && validateRegex(r.pattern) !== null }"
        />
        <MdIconButton class="rm-rule" :title="t('entryForm.deleteRule')" :aria-label="t('entryForm.deleteRule')" @click="form.matchRules.splice(i, 1)">✕</MdIconButton>
        <!-- I51：regex 策略且 pattern 非空但非法 → 行内错误提示 -->
        <span
          v-if="r.strategy === 'regex' && r.pattern.trim() !== '' && validateRegex(r.pattern) !== null"
          class="rule-error"
          role="alert"
        >
          {{ regexIssueMessage(validateRegex(r.pattern)!) }}
        </span>
      </div>
      <MdButton variant="text" class="add-rule" @click="form.matchRules.push({ strategy: 'baseDomain', pattern: '' })">{{ t('entryForm.addRule') }}</MdButton>
    </fieldset>
    <div v-if="error" class="error">{{ error }}</div>
    <div class="row">
      <MdButton type="submit">{{ isNew ? t('entryForm.add') : t('entryForm.save') }}</MdButton>
      <MdButton variant="text" @click="emit('cancel')">{{ t('entryForm.cancel') }}</MdButton>
    </div>
  </form>
</template>

<style scoped>
.entry-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--md-sys-color-outline-variant); border-radius: 8px; }
/* 仅存的原生控件（textarea/file）保留紧凑样式；输入/按钮/下拉由 md 组件自带样式 */
.entry-form textarea { padding: 6px 8px; box-sizing: border-box; }
.entry-form textarea { resize: vertical; font-family: inherit; }
.secret-row { display: flex; gap: 6px; align-items: center; }
.secret-row .secret-field { flex: 1; }
.secret-toggle { white-space: nowrap; }
.base32-hint { font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-tertiary); margin: 0; }
/* invalid 类在 MdTextField 根 div 上，经 :deep 传到输入框底边 */
.entry-form .secret-field.invalid :deep(.md-text-field__box) { border-bottom-color: var(--md-sys-color-error); }
.advanced-row { display: flex; gap: 8px; flex-wrap: wrap; font-size: var(--md-sys-typescale-body-small); align-items: flex-start; }
.advanced-row .algorithm { flex: 1; min-width: 110px; } /* MdSelect 根随行内 flex 伸展（弹窗窄宽语境触发端 100%） */
.advanced-row .digits, .advanced-row .period, .advanced-row .counter, .advanced-row .pin { flex: 1; min-width: 80px; }
.steam-hint { font-size: var(--md-sys-typescale-label-small); opacity: .65; margin: 0; width: 100%; }
fieldset { border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; display: flex; gap: 10px; flex-wrap: wrap; }
.tag-check { font-size: var(--md-sys-typescale-body-medium); }
.new-tag-row { display: flex; gap: 6px; width: 100%; }
.new-tag { flex: 1; }
.rule-row { display: flex; gap: 6px; align-items: center; }
.rule-strategy { flex: none; width: 128px; } /* MdSelect 根定宽，触发端 100% 填充 */
.rule-row .rule-pattern { flex: 1; }
.rule-row .rule-pattern.invalid :deep(.md-text-field__box) { border-bottom-color: var(--md-sys-color-error); }
.rule-error { font-size: var(--md-sys-typescale-label-small); color: var(--md-sys-color-error); flex-basis: 100%; }
.icon-recommend { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); padding: 4px 8px; background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent); border-radius: 6px; }
.icon-preview { width: 20px; height: 20px; fill: currentColor; flex: none; }
.icon-current-img { width: 20px; height: 20px; object-fit: contain; flex: none; }
.icon-picker summary { cursor: pointer; font-weight: 600; }
.icon-picker .icon-current { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); margin: 6px 0; }
.icon-picker .icon-none { opacity: 0.6; font-size: var(--md-sys-typescale-body-small); }
.icon-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.icon-actions .icon-url { flex: 1; min-width: 120px; }
.icon-file, .pack-file { display: none; }
.visually-hidden { display: none; }
.pack-message { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-small); }
.error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); }
.row { display: flex; gap: 8px; }
</style>
