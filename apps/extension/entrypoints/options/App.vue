<script setup lang="ts">
import { VaultManager } from '@totp/ui'
import { onMounted, ref } from 'vue'
import { initStore, registerStorageSync, store } from '../../src/store'

const loadError = ref('')

onMounted(async () => {
  try {
    await initStore()
    registerStorageSync()
  } catch (e) {
    loadError.value = '本地数据读取失败：' + (e instanceof Error ? e.message : String(e))
  }
})

async function copyToClipboard(code: string) {
  await navigator.clipboard.writeText(code)
}
</script>

<template>
  <main class="page">
    <h1>TOTP 验证码工具</h1>
    <div v-if="loadError" class="error">{{ loadError }}</div>
    <VaultManager v-else :store="store" enable-copy @copy="copyToClipboard" />
  </main>
</template>

<style scoped>
body { font-family: system-ui, sans-serif; }
.page { max-width: 640px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
h1 { font-size: 20px; }
.error { color: #d9534f; font-size: 12px; }
</style>
