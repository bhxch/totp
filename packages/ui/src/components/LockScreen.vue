<script setup lang="ts">
import { ref } from 'vue'
import type { VueStore } from '../store'

const props = defineProps<{
  /** 已启用加密的 store；锁定态由父级 v-if 控制（store.locked 为 true 时渲染本组件） */
  store: VueStore
}>()

const emit = defineEmits<{ (e: 'unlocked'): void }>()

const password = ref('')
const busy = ref(false)
const msg = ref('')

/** 解锁：成功清空口令与错误并 emit unlocked（父级可凭 locked 变化自行切换视图）；失败展示错误消息 */
async function onUnlock(): Promise<void> {
  if (!password.value) {
    msg.value = '请输入口令'
    return
  }
  busy.value = true
  msg.value = ''
  try {
    await props.store.unlock(password.value)
    password.value = ''
    emit('unlocked')
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="lockscreen">
    <h2>已锁定</h2>
    <p class="hint">输入口令解锁本地数据</p>
    <form class="row" @submit.prevent="onUnlock">
      <input
        v-model="password" type="password" placeholder="口令" autocomplete="current-password"
        :disabled="busy" aria-label="解锁口令"
      />
      <button type="submit" :disabled="busy">解锁</button>
    </form>
    <div v-if="msg" class="err" role="alert">{{ msg }}</div>
  </section>
</template>

<style scoped>
.lockscreen { display: flex; flex-direction: column; gap: 8px; padding: 32px 16px; max-width: 360px; margin: 0 auto; }
h2 { font-size: 16px; margin: 0; text-align: center; }
.hint { font-size: 13px; opacity: .65; margin: 0; text-align: center; }
.row { display: flex; gap: 8px; }
.row input { flex: 1; }
.err { color: #d9534f; font-size: 13px; }
</style>
