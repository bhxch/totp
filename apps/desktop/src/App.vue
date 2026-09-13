<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { VaultManager, createVueStore, type VueStore } from '@totp/ui'
import { onMounted, onScopeDispose, ref } from 'vue'
import { createTauriFs } from './tauriFs'

const store = ref<VueStore | null>(null)
const loadError = ref('')
let unlistenFocus: (() => void) | null = null

onMounted(async () => {
  // 主窗口失焦自动隐藏：仅注册一次，回调内实时读取开关值（勿在 watch 里叠加监听）
  const win = getCurrentWindow()
  const un = await win.onFocusChanged(({ payload: focused }) => {
    if (!focused && store.value?.settings.blurHideEnabled && win.label === 'main') void win.hide()
  })
  unlistenFocus = un
  try {
    const s = createVueStore(await createTauriFs())
    await s.initStore()
    store.value = s
  } catch (e) {
    loadError.value = '本地数据初始化失败：' + (e instanceof Error ? e.message : String(e))
  }
})

onScopeDispose(() => unlistenFocus?.())

async function copyToClipboard(code: string) {
  await writeText(code)
}

async function onBlurHideChange(e: Event) {
  const s = store.value
  if (!s) return
  s.settings.blurHideEnabled = (e.target as HTMLInputElement).checked
  await s.commitSettings()
}
</script>

<template>
  <main class="page">
    <header>
      <h1>TOTP 验证码工具</h1>
      <div class="header-ops">
        <label class="blur-hide"><input type="checkbox" :checked="store?.settings.blurHideEnabled" @change="onBlurHideChange" /> 失焦自动隐藏</label>
        <button @click="getCurrentWindow().hide()">隐藏到托盘</button>
      </div>
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
.header-ops { display: flex; align-items: center; gap: 12px; }
.blur-hide { font-size: 13px; display: flex; align-items: center; gap: 4px; cursor: pointer; }
.error { color: #d9534f; }
</style>
