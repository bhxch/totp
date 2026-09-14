<script setup lang="ts">
import { base32Decode, getBuiltinIcons, recommendBuiltinIcon, type BuiltinIcon, type Group, type OtpEntry } from '@totp/core'
import { computed, reactive, ref, watch } from 'vue'
import { fileToScaledDataUrl, importIconPackZip } from '../iconImport'
import type { IconStore } from '../iconStore'
import type { EntryFormData } from './entryForm'

export type { EntryFormData }

const props = defineProps<{
  initial?: OtpEntry | null
  groups?: Group[]
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
  note: props.initial?.note ?? '',
  groupIds: [...(props.initial?.groupIds ?? [])],
  matchRules: (props.initial?.matchRules ?? []).map((r) => ({ ...r })),
  icon: props.initial?.icon as EntryFormData['icon'],
})
const error = ref('')
const isNew = !props.initial
/** secret 遮蔽：默认 password，点右侧按钮明文查看 */
const showSecret = ref(false)

function cleanSecret(): string {
  return form.secret.replace(/\s+/g, '').toUpperCase()
}

// ---------- 图标推荐（issuer 防抖 300ms） ----------
/** 用户是否已手动设置过图标（推荐气泡只在未手动设置时出现） */
const iconTouched = ref(props.initial?.icon !== undefined)
const recommended = ref<BuiltinIcon | null>(null)
let recommendTimer: ReturnType<typeof setTimeout> | null = null

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
/** stored id：编辑沿用条目 uuid（重复上传即覆盖），新建先取随机 uuid（与最终 uuid 无关，仅作存储键） */
const iconId = props.initial?.uuid ?? crypto.randomUUID()

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
  const key = ref.kind === 'url' ? `url:${ref.id}` : ref.id
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
  const cached = await props.iconStore.fetchAndCache(ref)
  if (cached) {
    form.icon = ref
    iconTouched.value = true
  } else {
    iconError.value = '图标拉取失败（检查 URL/网络，或站点不允许跨域）'
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
  if (form.type !== 'hotp') {
    try {
      base32Decode(cleanSecret())
    } catch {
      error.value = '密钥不是有效的 base32 编码（base32 仅允许字母 A–Z 和数字 2–7）'
      return
    }
  }
  emit('save', { ...form, issuer: form.issuer.trim(), label: form.label.trim(), secret: cleanSecret(), matchRules: form.matchRules.filter((r) => r.pattern.trim()) })
}
</script>

<template>
  <form class="entry-form" @submit.prevent="submit">
    <select v-model="form.type" :disabled="form.type === 'hotp'">
      <option value="totp">TOTP</option>
      <option value="steam">Steam</option>
      <option v-if="form.type === 'hotp'" value="hotp">HOTP（计数器）</option>
    </select>
    <input v-model="form.issuer" placeholder="服务名（如 GitHub）" />
    <div v-if="recommendVisible && recommended" class="icon-recommend">
      检测到图标：
      <svg viewBox="0 0 24 24" class="icon-preview" aria-hidden="true" v-html="builtinHtml(recommended.path)" />
      <button type="button" class="use-recommend-icon" @click="useRecommended">使用</button>
    </div>
    <input v-model="form.label" placeholder="账户名" />
    <div class="secret-row">
      <input v-model="form.secret" :type="showSecret ? 'text' : 'password'" placeholder="密钥 base32" required autocomplete="off" />
      <button type="button" class="secret-toggle" @click="showSecret = !showSecret">{{ showSecret ? '隐藏' : '显示' }}</button>
    </div>
    <textarea v-model="form.note" placeholder="备注（可选）" rows="2" />
    <fieldset v-if="(groups ?? []).length > 0">
      <legend>分组</legend>
      <label v-for="g in groups" :key="g.id" class="group-check">
        <input type="checkbox" :value="g.id" v-model="form.groupIds" /> {{ g.name }}
      </label>
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
        <button v-if="iconStore" type="button" class="upload-icon" @click="fileInput?.click()">上传</button>
        <input ref="fileInput" type="file" accept="image/*" class="icon-file" @change="onIconFile" />
        <button v-if="iconStore" type="button" class="import-pack" :disabled="packBusy" @click="packInput?.click()">导入图标包（zip）</button>
        <input ref="packInput" type="file" accept=".zip" class="pack-file" @change="onPackFile" />
        <template v-if="iconStore">
          <input v-model="iconUrlInput" type="url" class="icon-url" placeholder="图标图片 URL" />
          <button type="button" class="fetch-icon" @click="onFetchIcon">拉取</button>
        </template>
        <button v-if="form.icon" type="button" class="clear-icon" @click="clearIcon">清除</button>
      </div>
      <div v-if="packMessage" class="pack-message">{{ packMessage }}</div>
      <div v-if="iconError" class="error">{{ iconError }}</div>
    </details>
    <!-- matchRules 编辑区 -->
    <fieldset>
      <legend>URL 匹配规则（浏览器插件按当前页过滤用）</legend>
      <div v-for="(r, i) in form.matchRules" :key="i" class="rule-row">
        <select class="rule-strategy" v-model="r.strategy">
          <option value="baseDomain">基础域名</option>
          <option value="host">主机</option>
          <option value="exact">精确</option>
          <option value="startsWith">前缀</option>
          <option value="regex">正则</option>
        </select>
        <input class="rule-pattern" v-model="r.pattern" placeholder="如 github.com 或 ^https://" />
        <button type="button" class="rm-rule" @click="form.matchRules.splice(i, 1)">✕</button>
      </div>
      <button type="button" class="add-rule" @click="form.matchRules.push({ strategy: 'baseDomain', pattern: '' })">＋ 添加匹配规则</button>
    </fieldset>
    <div v-if="error" class="error">{{ error }}</div>
    <div class="row">
      <button type="submit">{{ isNew ? '添加' : '保存' }}</button>
      <button type="button" @click="emit('cancel')">取消</button>
    </div>
  </form>
</template>

<style scoped>
.entry-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; }
.entry-form input, .entry-form select, .entry-form textarea, .entry-form button { padding: 6px 8px; box-sizing: border-box; }
.entry-form textarea { resize: vertical; font-family: inherit; }
.secret-row { display: flex; gap: 6px; }
.secret-row input { flex: 1; }
.secret-toggle { white-space: nowrap; }
fieldset { border: 1px solid rgba(128,128,128,.3); border-radius: 6px; display: flex; gap: 10px; flex-wrap: wrap; }
.group-check { font-size: 13px; display: flex; align-items: center; gap: 4px; }
.rule-row { display: flex; gap: 6px; }
.rule-strategy { width: 110px; }
.rule-pattern { flex: 1; }
.icon-recommend { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 4px 8px; background: rgba(74, 144, 217, 0.12); border-radius: 6px; }
.icon-preview { width: 20px; height: 20px; fill: currentColor; flex: none; }
.icon-current-img { width: 20px; height: 20px; object-fit: contain; flex: none; }
.icon-picker summary { cursor: pointer; font-weight: 600; }
.icon-picker .icon-current { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 6px 0; }
.icon-picker .icon-none { opacity: 0.6; font-size: 12px; }
.icon-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.icon-actions .icon-url { flex: 1; min-width: 120px; }
.icon-file, .pack-file { display: none; }
.pack-message { color: #5cb85c; font-size: 12px; }
.error { color: #d9534f; font-size: 12px; }
.row { display: flex; gap: 8px; }
</style>
