<script setup lang="ts">
import { base32Decode, type Group, type OtpEntry } from '@totp/core'
import { reactive, ref } from 'vue'
import type { EntryFormData } from './entryForm'

export type { EntryFormData }

const props = defineProps<{ initial?: OtpEntry | null; groups?: Group[] }>()
const emit = defineEmits<{ save: [data: EntryFormData]; cancel: [] }>()

const form = reactive({
  type: (props.initial?.type ?? 'totp') as 'totp' | 'hotp' | 'steam',
  issuer: props.initial?.issuer ?? '',
  label: props.initial?.label ?? '',
  secret: props.initial?.secret ?? '',
  note: props.initial?.note ?? '',
  groupIds: [...(props.initial?.groupIds ?? [])],
  matchRules: [...(props.initial?.matchRules ?? [])],
})
const error = ref('')
const isNew = !props.initial

function cleanSecret(): string {
  return form.secret.replace(/\s+/g, '').toUpperCase()
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
  emit('save', { ...form, secret: cleanSecret() })
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
    <input v-model="form.label" placeholder="账户名" />
    <input v-model="form.secret" placeholder="密钥 base32" required />
    <textarea v-model="form.note" placeholder="备注（可选）" rows="2" />
    <fieldset v-if="(groups ?? []).length > 0">
      <legend>分组</legend>
      <label v-for="g in groups" :key="g.id" class="group-check">
        <input type="checkbox" :value="g.id" v-model="form.groupIds" /> {{ g.name }}
      </label>
    </fieldset>
    <!-- matchRules 编辑区：Task 6 填充实现 -->
    <div class="match-rules-placeholder"></div>
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
fieldset { border: 1px solid rgba(128,128,128,.3); border-radius: 6px; display: flex; gap: 10px; flex-wrap: wrap; }
.group-check { font-size: 13px; display: flex; align-items: center; gap: 4px; }
.error { color: #d9534f; font-size: 12px; }
.row { display: flex; gap: 8px; }
</style>
