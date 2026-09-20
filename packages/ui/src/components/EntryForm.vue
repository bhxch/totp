<script setup lang="ts">
import { base32Decode, getBuiltinIcons, recommendBuiltinIcon, type BuiltinIcon, type HashAlgorithm, type MatchRule, type MatchStrategy, type OtpEntry, type Tag } from '@totp/core'
import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
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
import { type EntryFormData, validateRegex } from './entryForm'

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
  type: (props.initial?.type ?? 'totp') as 'totp' | 'hotp' | 'steam',
  issuer: props.initial?.issuer ?? '',
  label: props.initial?.label ?? '',
  secret: props.initial?.secret ?? '',
  algorithm: (props.initial?.algorithm ?? 'SHA1') as HashAlgorithm,
  digits: (props.initial?.digits ?? 6) as number,
  period: (props.initial?.period ?? 30) as number,
  counter: (props.initial?.counter ?? 0) as number,
  note: props.initial?.note ?? '',
  tagIds: [...(props.initial?.tagIds ?? [])],
  matchRules: (props.initial?.matchRules ?? []).map((r) => ({ ...r })),
  icon: props.initial?.icon as EntryFormData['icon'],
})
const error = ref('')
// F2：type 切换时实时同步 digits（steam 固定 5；从 steam 切回其他类型回落 6），输入框所见即所存，
// 不再依赖 submit 时的静默纠正（此前 UI 显示 6 但保存为 5，视觉与数据不一致）
watch(
  () => form.type,
  (t, old) => {
    if (t === old) return
    if (t === 'steam') form.digits = 5
    else if (old === 'steam') form.digits = 6
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
    error.value = e instanceof Error ? e.message : '图片读取失败'
  }
}

// ---------- MdSelect 选项与回调（原生 select 收口；emit 值为泛化 string|number，赋值前收敛回精确联合类型） ----------
const TYPE_OPTIONS = [
  { value: 'totp', label: 'TOTP' },
  { value: 'hotp', label: 'HOTP（计数器）' },
  { value: 'steam', label: 'Steam' },
]
const ALGO_OPTIONS: Array<{ value: HashAlgorithm; label: string }> = [
  { value: 'SHA1', label: 'SHA1' },
  { value: 'SHA256', label: 'SHA256' },
  { value: 'SHA512', label: 'SHA512' },
]
const STRATEGY_OPTIONS: Array<{ value: MatchStrategy; label: string }> = [
  { value: 'baseDomain', label: '基础域名' },
  { value: 'host', label: '主机' },
  { value: 'exact', label: '精确' },
  { value: 'startsWith', label: '前缀' },
  { value: 'regex', label: '正则' },
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
  for (const t of createdTags.value) {
    if (!list.some((x) => x.id === t.id)) list.push(t)
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
  return '密钥字符仅允许 A–Z 与 2–7（base32）'
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
      cors: '图标拉取失败（站点不允许跨域 CORS 或网络不通）',
      notfound: '图标拉取失败（资源不存在，HTTP 错误）',
      toolarge: '图标拉取失败（文件超过 200KB 上限）',
      other: '图标拉取失败',
    }
    iconError.value = `${tip[result.kind] ?? tip.other}（${result.message}）`
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
      throw new Error(`图标包超过 ${Math.floor(MAX_ICON_PACK_ZIP_BYTES / 1024 / 1024)}MB 大小上限`)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await importIconPackZip(bytes, props.iconStore)
    packMessage.value = `已导入 ${result.imported} 个图标（跳过 ${result.skipped} 个）`
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
      error.value = '密钥不是有效的 base32 编码（base32 仅允许字母 A–Z 和数字 2–7）'
      return
    }
  }
  const digits = form.digits
  if (form.type === 'steam' && digits !== 5) {
    error.value = 'Steam 类型的位数必须为 5'
    return
  }
  if (form.type !== 'steam' && ![6, 7, 8].includes(digits)) {
    error.value = '位数必须为 6/7/8'
    return
  }
  if (!Number.isFinite(form.period) || form.period < 1) {
    error.value = '周期必须为 ≥1 的数字'
    return
  }
  if (form.type === 'hotp' && (!Number.isInteger(form.counter) || form.counter < 0)) {
    error.value = '计数器必须为非负整数'
    return
  }
  // I51：regex 策略客户端预校验；非 regex 策略由浏览器插件侧自行判定
  for (const r of form.matchRules) {
    if (r.strategy !== 'regex') continue
    const msg = validateRegex(r.pattern)
    if (msg) {
      error.value = `匹配规则正则非法：${msg}`
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
    // type 变更时同步默认 digits：steam=5，其他=6（避免显示错位数）
    ...(form.type !== props.initial?.type ? { digits: form.type === 'steam' ? 5 : 6 } : {}),
    // HOTP 才提交 counter；其他类型不带（避免污染 TOTP/steam 模型）
    ...(form.type === 'hotp' ? { counter: form.counter } : {}),
  })
}
</script>

<template>
  <form class="entry-form" @submit.prevent="submit">
    <MdSelect
      class="type-select" label="类型" aria-label="类型"
      :model-value="form.type" :options="TYPE_OPTIONS" @update:model-value="onTypeSelect"
    />
    <MdTextField v-model="form.issuer" label="服务名" placeholder="服务名（如 GitHub）" aria-label="服务名" />
    <div v-if="recommendVisible && recommended" class="icon-recommend">
      检测到图标：
      <svg viewBox="0 0 24 24" class="icon-preview" aria-hidden="true" v-html="builtinHtml(recommended.path)" />
      <MdButton variant="text" class="use-recommend-icon" @click="useRecommended">使用</MdButton>
    </div>
    <MdTextField v-model="form.label" label="账户名" aria-label="账户名" />
    <div class="secret-row">
      <MdTextField
        v-model="form.secret" class="secret-field" :type="showSecret ? 'text' : 'password'"
        label="密钥" placeholder="密钥 base32" aria-label="密钥 base32"
        :class="{ invalid: !isValidBase32 }"
      />
      <MdButton variant="text" class="secret-toggle" @click="showSecret = !showSecret">{{ showSecret ? '隐藏' : '显示' }}</MdButton>
      <MdButton variant="text" data-test="qr-pick" @click="qrFile?.click()">从图片识别</MdButton>
      <input ref="qrFile" type="file" accept="image/*" data-test="qr-file" class="visually-hidden" @change="onQrFile" />
    </div>
    <!-- I68：base32 实时校验的视觉反馈（不阻塞输入，submit 仍把关） -->
    <p v-if="base32Hint" class="base32-hint" role="status">{{ base32Hint }}</p>
    <div class="advanced-row">
      <MdSelect
        class="algorithm" label="算法" aria-label="算法"
        :model-value="form.algorithm" :options="ALGO_OPTIONS" @update:model-value="onAlgoSelect"
      />
      <MdTextField
        class="digits" type="number" label="位数" aria-label="位数" min="5" max="8"
        :model-value="String(form.digits)" @update:model-value="form.digits = looseToNumber($event)"
      />
      <MdTextField
        v-if="form.type !== 'hotp'" class="period" type="number" label="周期（秒）" aria-label="周期（秒）" min="1"
        :model-value="String(form.period)" @update:model-value="form.period = looseToNumber($event)"
      />
      <!-- steam 强制 5 位提示 -->
      <p v-if="form.type === 'steam'" class="steam-hint">Steam 类型位数固定为 5</p>
      <MdTextField
        v-if="form.type === 'hotp'" class="counter" type="number" label="计数器" aria-label="计数器" min="0"
        :model-value="String(form.counter)" @update:model-value="form.counter = looseToNumber($event)"
      />
    </div>
    <textarea v-model="form.note" placeholder="备注（可选）" rows="2" aria-label="备注" />
    <fieldset v-if="shownTags.length > 0 || createTag">
      <legend>标签</legend>
      <MdCheckbox
        v-for="t in shownTags" :key="t.id" class="tag-check"
        :model-value="form.tagIds.includes(t.id)" :label="t.name" :aria-label="t.name"
        @update:model-value="toggleTag(t.id, $event)"
      />
      <div v-if="createTag" class="new-tag-row">
        <MdTextField
          v-model="newTagName" class="new-tag" label="新标签" placeholder="新标签，回车创建" aria-label="新标签名称"
          @keydown.enter.prevent="createTagAndCheck"
        />
        <MdButton variant="text" :disabled="creatingTag" @click="createTagAndCheck">添加</MdButton>
      </div>
    </fieldset>
    <!-- 图标选择区：默认收起 -->
    <details v-if="icons" class="icon-picker">
      <summary>图标</summary>
      <div class="icon-current">
        <svg v-if="currentIcon?.html" viewBox="0 0 24 24" class="icon-preview" aria-hidden="true" v-html="currentIcon.html" />
        <img v-else-if="currentIcon?.src" :src="currentIcon.src" class="icon-current-img" alt="当前图标" />
        <span v-else class="icon-none">未设置（列表显示首字母）</span>
      </div>
      <div class="icon-actions">
        <MdButton v-if="iconStore" variant="text" class="upload-icon" @click="fileInput?.click()">上传</MdButton>
        <input ref="fileInput" type="file" accept="image/*" class="icon-file" @change="onIconFile" />
        <MdButton v-if="iconStore" variant="text" class="import-pack" :disabled="packBusy" @click="packInput?.click()">导入图标包（zip）</MdButton>
        <input ref="packInput" type="file" accept=".zip" class="pack-file" @change="onPackFile" />
        <template v-if="iconStore">
          <MdTextField
            v-model="iconUrlInput" class="icon-url" label="图标 URL" placeholder="图标图片 URL" aria-label="图标图片 URL"
          />
          <MdButton variant="text" class="fetch-icon" @click="onFetchIcon">拉取</MdButton>
        </template>
        <MdButton v-if="form.icon" variant="text" class="clear-icon" @click="clearIcon">清除</MdButton>
      </div>
      <div v-if="packMessage" class="pack-message">{{ packMessage }}</div>
      <div v-if="iconError" class="error">{{ iconError }}</div>
    </details>
    <!-- matchRules 编辑区 -->
    <fieldset>
      <legend>URL 匹配规则（浏览器插件按当前页过滤用）</legend>
      <div v-for="(r, i) in form.matchRules" :key="i" class="rule-row">
        <MdSelect
          class="rule-strategy" label="策略" aria-label="匹配策略"
          :model-value="r.strategy" :options="STRATEGY_OPTIONS" @update:model-value="setRuleStrategy(r, $event)"
        />
        <MdTextField
          v-model="r.pattern" class="rule-pattern" label="模式" placeholder="如 github.com 或 ^https://" aria-label="匹配模式"
          :class="{ invalid: r.strategy === 'regex' && r.pattern.trim() !== '' && validateRegex(r.pattern) !== null }"
        />
        <MdIconButton class="rm-rule" title="删除规则" aria-label="删除规则" @click="form.matchRules.splice(i, 1)">✕</MdIconButton>
        <!-- I51：regex 策略且 pattern 非空但非法 → 行内错误提示 -->
        <span
          v-if="r.strategy === 'regex' && r.pattern.trim() !== '' && validateRegex(r.pattern) !== null"
          class="rule-error"
          role="alert"
        >
          {{ validateRegex(r.pattern) }}
        </span>
      </div>
      <MdButton variant="text" class="add-rule" @click="form.matchRules.push({ strategy: 'baseDomain', pattern: '' })">＋ 添加匹配规则</MdButton>
    </fieldset>
    <div v-if="error" class="error">{{ error }}</div>
    <div class="row">
      <MdButton type="submit">{{ isNew ? '添加' : '保存' }}</MdButton>
      <MdButton variant="text" @click="emit('cancel')">取消</MdButton>
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
.advanced-row .digits, .advanced-row .period, .advanced-row .counter { flex: 1; min-width: 80px; }
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
