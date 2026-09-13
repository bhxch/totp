<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { VaultManager, createVueStore, type VueStore } from '@totp/ui'
import { onMounted, ref } from 'vue'
import { createTauriFs } from './tauriFs'

const store = ref<VueStore | null>(null)
const loadError = ref('')

onMounted(async () => {
  try {
    const s = createVueStore(await createTauriFs())
    await s.initStore()
    store.value = s
  } catch (e) {
    loadError.value = '本地数据初始化失败：' + (e instanceof Error ? e.message : String(e))
  }
})

async function copyToClipboard(code: string) {
  await writeText(code)
}
</script>

<template>
  <main class="page">
    <header>
      <h1>TOTP 验证码工具</h1>
      <button @click="getCurrentWindow().hide()">隐藏到托盘</button>
    </header>
    <div v-if="loadError" class="error">{{ loadError }}</div>
    <VaultManager v-else-if="store" :store="store" enable-copy @copy="copyToClipboard" />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.page { max-width: 720px; margin: 0 auto; padding: 16px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
h1 { font-size: 20px; margin: 0; }
.error { color: #d9534f; }
</style>
