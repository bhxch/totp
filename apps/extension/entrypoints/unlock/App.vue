<script setup lang="ts">
import { createAppI18n, LockScreen, useTheme } from '@totp/ui'
import { getCurrentInstance, onMounted } from 'vue'
import { createDekSession } from '../../src/dekSession'
import { createExtensionStore, persistFailed } from '../../src/store'

// spec §B（方案 A）：独立解锁窗——popup 失焦即销毁，WebAuthn 认证须在真窗口完成；成功写
// session DEK（createDekSession 共享区）后自关，重开 popup 即免密。windowId='unlock' 独立
// 会话与 popup/options 隔离；PersistErrorBanner 不渲染（本页无写路径，persistFailed 仅为
// createExtensionStore 宿主接线占位消费）
const store = createExtensionStore('unlock', {
  dekPersist: createDekSession(),
  onPersistError: (e) => {
    console.error('[store] persist failed:', e)
    persistFailed.value = true
  },
})
const { initStore, locked } = store
// D1 i18n：本组件 setup 创建 store，同 options 口径装入 app 供 LockScreen 的 useI18n
const i18n = createAppI18n(store)
getCurrentInstance()?.appContext.app.use(i18n)
/** ?unlock=passkey → LockScreen 挂载后自动发起一次 PRF 求值（popup 点击入口的续场） */
const autoPasskey = new URLSearchParams(window.location.search).get('unlock') === 'passkey'

onMounted(async () => {
  try {
    await initStore()
    useTheme(store)
    document.title = i18n.global.t('lock.title')
  } catch (e) {
    // boot 异常（storage 不可用等）：自关回退 popup 口令路径，不留死窗
    console.error('[unlock] boot failed:', e)
    window.close()
    return
  }
  // 已解锁（session DEK 恢复 / 未加密库）：无事可做，立即自关
  if (!locked.value) window.close()
})

function onUnlocked(): void {
  window.close()
}
</script>

<template>
  <LockScreen v-if="locked" :store="store" :auto-passkey="autoPasskey" @unlocked="onUnlocked" />
</template>
