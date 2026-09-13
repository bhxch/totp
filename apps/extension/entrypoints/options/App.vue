<script setup lang="ts">
import { VaultManager } from '@totp/ui'
import { onMounted } from 'vue'
import { initStore, registerStorageSync, store } from '../../src/store'

onMounted(async () => { await initStore(); registerStorageSync() })
</script>

<template>
  <main class="page">
    <h1>TOTP 验证码工具</h1>
    <VaultManager :store="store" />
  </main>
</template>

<style scoped>
body { font-family: system-ui, sans-serif; }
.page { max-width: 640px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
h1 { font-size: 20px; }
</style>
