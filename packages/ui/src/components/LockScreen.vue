<script setup lang="ts">
import { base64ToBytes, unlockWithPrf } from '@totp/core'
import { computed, onMounted, ref } from 'vue'
import type { DpapiUnlockOps } from './securityPlatform'
import { getPrfOutput, prfSupported } from '../prf'
import type { VueStore } from '../store'

const props = withDefaults(
  defineProps<{
    /** 已启用加密的 store；锁定态由父级 v-if 控制（store.locked 为 true 时渲染本组件） */
    store: VueStore
    /** [可选] DPAPI(Windows) 解锁通道（desktop 提供）；已绑定来源时挂载后静默尝试自动解锁 */
    dpapi?: DpapiUnlockOps | null
    /** [可选] 是否提供 Passkey 解锁按钮（默认 true）。popup 认证器弹窗夺焦即销毁窗口、WebAuthn get() 中断，该入口恒失败，popup 传 false 隐藏 */
    allowPasskey?: boolean
  }>(),
  // 显式默认 true：Boolean prop 缺省会被 vue 运行时 boolean-cast 成 false，必须声明 default
  { allowPasskey: true },
)

const emit = defineEmits<{ (e: 'unlocked'): void }>()

const password = ref('')
const busy = ref(false)
const msg = ref('')
/** PRF 能力探测（基于 UA + getClientCapabilities）；unknown=探测中；false=浏览器不支持，passkey 入口即便已绑定也应禁用 */
const prfCap = ref<'unknown' | boolean>('unknown')
/** Passkey 按钮显隐：已绑定 prf 来源（kekSources 含条目）且入口未被禁用 */
const showPasskey = computed(() => props.allowPasskey !== false && props.store.prfSources.value.length > 0)
/** Passkey 入口是否启用：探测完成且能力可用（C17 按浏览器能力显隐） */
const passkeySupported = computed(() => prfCap.value === true)

onMounted(() => {
  // 1) PRF 能力探测：仅在入口可见时执行；探测完前按钮 disabled 防用户点击
  if (showPasskey.value) {
    prfSupported()
      .then((ok) => { prfCap.value = ok })
      .catch(() => { prfCap.value = false })
  }
  // 2) DPAPI 静默自动解锁
  const ops = props.dpapi
  const src = ops?.source.value
  if (!ops || !src) return
  ops.unprotect(src.wrappedDekD)
    .then((dek) => props.store.unlockWithDek(dek).then(() => emit('unlocked')))
    .catch(() => {
      // I44：DPAPI 静默失败属预期（换机/换用户），不打断手动解锁路径；
      // 但若用户停留在锁定页超 1s 未操作，暴露「重试」入口（部分环境首次解包有竞争/偶发失败）
      setTimeout(() => {
        if (props.store.locked.value) dpapiFailed.value = true
      }, 1000)
    })
})

/** I44：DPAPI 静默失败且本端仍处于锁定态 → 显示「重试」按钮，避免误以为可解锁但无入口 */
const dpapiFailed = ref(false)
const dpapiRetrying = ref(false)
async function onRetryDpapi(): Promise<void> {
  const ops = props.dpapi
  const src = ops?.source.value
  if (!ops || !src) return
  dpapiRetrying.value = true
  try {
    const dek = await ops.unprotect(src.wrappedDekD)
    await props.store.unlockWithDek(dek)
    emit('unlocked')
  } catch {
    // 仍失败：保留按钮可见以便再试；不报错打断手动解锁
  } finally {
    dpapiRetrying.value = false
  }
}

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
    <button
      v-if="showPasskey"
      type="button"
      class="passkey"
      :disabled="busy || !passkeySupported"
      :title="passkeySupported ? undefined : '当前浏览器不支持 Passkey 解锁'"
      @click="onPasskeyUnlock"
    >
      使用 Passkey 解锁
    </button>
    <!-- I44：DPAPI 已绑定但静默解锁失败 1s 后仍锁定 → 显示重试入口 -->
    <button
      v-if="dpapi?.source.value && dpapiFailed"
      type="button"
      class="dpapi-retry"
      :disabled="dpapiRetrying || busy"
      @click="onRetryDpapi"
    >
      重试 Windows 自动解锁
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
