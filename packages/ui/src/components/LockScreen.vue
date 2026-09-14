<script setup lang="ts">
import { base64ToBytes, unlockWithPrf } from '@totp/core'
import { computed, onMounted, ref } from 'vue'
import type { DpapiUnlockOps } from './securityPlatform'
import { getPrfOutput } from '../prf'
import type { VueStore } from '../store'

const props = defineProps<{
  /** 已启用加密的 store；锁定态由父级 v-if 控制（store.locked 为 true 时渲染本组件） */
  store: VueStore
  /** [可选] DPAPI(Windows) 解锁通道（desktop 提供）；已绑定来源时挂载后静默尝试自动解锁 */
  dpapi?: DpapiUnlockOps | null
}>()

const emit = defineEmits<{ (e: 'unlocked'): void }>()

const password = ref('')
const busy = ref(false)
const msg = ref('')
/** 已绑定 passkey 解锁来源（kekSources 含 prf 条目时显示按钮） */
const hasPrf = computed(() => props.store.prfSources.value.length > 0)

/** DPAPI 静默自动解锁：unprotect(wrappedDekD)→unlockWithDek。
 *  失败（跨机器/跨用户/数据损坏）静默吞掉——保留口令/passkey 手动解锁路径 */
onMounted(async () => {
  const ops = props.dpapi
  const src = ops?.source.value
  if (!ops || !src) return
  try {
    await props.store.unlockWithDek(await ops.unprotect(src.wrappedDekD))
    emit('unlocked')
  } catch {
    // 静默：DPAPI 解不开属预期场景（换机/换用户），不提示、不打断手动解锁
  }
})

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

/** Passkey 解锁：逐来源 PRF 求值（UV 弹窗）→ core unlockWithPrf 解出 DEK → store 注入解锁。
 *  用户取消/无 PRF 输出 → getPrfOutput 返回 null，尝试下一来源；全部失败提示统一文案 */
async function onPasskeyUnlock(): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    const security = props.store.securitySettings.value
    if (!security) throw new Error('encryption not enabled')
    for (const src of props.store.prfSources.value) {
      const out = await getPrfOutput(src.credentialId, base64ToBytes(src.salt))
      if (!out) continue
      const dek = await unlockWithPrf(security, out, { credentialId: src.credentialId })
      await props.store.unlockWithDek(dek)
      emit('unlocked')
      return
    }
    msg.value = 'passkey 解锁失败'
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
    <button v-if="hasPrf" type="button" class="passkey" :disabled="busy" @click="onPasskeyUnlock">
      使用 Passkey 解锁
    </button>
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
