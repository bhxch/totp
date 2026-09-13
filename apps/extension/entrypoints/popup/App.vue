<script setup lang="ts">
import { addEntry, base32Decode, loadVault, saveVault, type OtpEntry, type Vault } from '@totp/core'
import { OtpListItem, useOtpCodes } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
import { createChromeStorage } from '../../src/chromeStorage'

const entries = ref<OtpEntry[]>([])
const loaded = ref(false)
const showForm = ref(false)
const form = ref({ issuer: '', label: '', secret: '', type: 'totp' as 'totp' | 'steam' })
const error = ref('')

onMounted(async () => {
  try {
    const vault = await loadVault(createChromeStorage())
    entries.value = [...vault.entries].sort((a, b) => a.order - b.order)
  } catch (e) {
    error.value = '本地数据读取失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    loaded.value = true
  }
})

const { codes } = useOtpCodes(entries)
const sorted = computed(() => [...entries.value].sort((a, b) => a.order - b.order))

async function persist(fn: (v: Vault) => Vault) {
  const adapter = createChromeStorage()
  const vault = await loadVault(adapter)
  await saveVault(adapter, fn(vault))
}

async function add() {
  error.value = ''
  const secret = form.value.secret.replace(/\s+/g, '').toUpperCase()
  try {
    try {
      base32Decode(secret)
    } catch {
      error.value = '密钥不是有效的 base32 编码（base32 仅允许字母 A–Z 和数字 2–7）'
      return
    }
    // 直接构造条目，避免 buildOtpUri → parseOtpUri 往返把 issuer=Steam 的 TOTP 强制改判为 Steam 类型
    const entry: OtpEntry = {
      uuid: crypto.randomUUID(),
      type: form.value.type,
      issuer: form.value.issuer.trim(),
      label: form.value.label.trim(),
      secret,
      algorithm: 'SHA1',
      digits: form.value.type === 'steam' ? 5 : 6,
      period: 30,
      groupIds: [],
      order: 0, // addEntry 会覆写为 maxOrder + 1
      createdAt: Date.now(),
    }
    await persist((v) => addEntry(v, entry))
    entries.value = [...entries.value, entry]
    showForm.value = false
    form.value = { issuer: '', label: '', secret: '', type: 'totp' }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function copy(entry: OtpEntry) {
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  await navigator.clipboard.writeText(c)
  window.close()
}
</script>

<template>
  <main>
    <header>
      <h1>TOTP 验证码</h1>
      <button @click="showForm = !showForm">{{ showForm ? '取消' : '＋ 添加' }}</button>
    </header>

    <div v-if="error" class="error">{{ error }}</div>

    <form v-if="showForm" class="add-form" @submit.prevent="add">
      <input v-model="form.issuer" placeholder="服务名（如 GitHub）" />
      <input v-model="form.label" placeholder="账户名" />
      <input v-model="form.secret" placeholder="base32 密钥" required />
      <select v-model="form.type">
        <option value="totp">TOTP</option>
        <option value="steam">Steam</option>
      </select>
      <button type="submit">保存</button>
    </form>

    <div v-if="loaded && sorted.length === 0" class="empty">暂无条目，点击右上角「＋ 添加」录入。</div>
    <OtpListItem v-for="e in sorted" :key="e.uuid" :entry="e" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 8px; }
main { display: flex; flex-direction: column; gap: 4px; }
header { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px; }
h1 { font-size: 16px; margin: 0; }
.add-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; margin-bottom: 8px; }
.add-form input, .add-form select, .add-form button { padding: 6px 8px; }
.error { color: #d9534f; font-size: 12px; }
.empty { text-align: center; opacity: .6; padding: 32px 0; }
</style>
