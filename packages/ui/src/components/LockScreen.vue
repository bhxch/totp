<script setup lang="ts">
import { base64ToBytes, unlockWithPrf } from '@totp/core'
import { computed, onMounted, ref } from 'vue'
import type { DpapiUnlockOps } from './securityPlatform'
import { getPrfOutput, prfSupported } from '../prf'
import type { VueStore } from '../store'
import MdButton from './md/MdButton.vue'
import MdIconButton from './md/MdIconButton.vue'
import MdTextField from './md/MdTextField.vue'

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
/** 口令明/密文显示切换（MdTextField 经 type prop 切 password/text） */
const showPassword = ref(false)
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

/** 解锁：成功清空口令与错误并 emit unlocked（父级可凭 locked 变化自行切换视图）；失败展示错误消息。
 *  busy 守卫：MdTextField 无 disabled 态，防重复提交（原由输入框 disabled 承担）由函数承担 */
async function onUnlock(): Promise<void> {
  if (busy.value) return
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
    <form class="unlock-form" @submit.prevent="onUnlock">
      <div class="pw-row">
        <MdTextField
          v-model="password" class="grow" label="口令" placeholder="口令"
          :type="showPassword ? 'text' : 'password'" aria-label="解锁口令"
        />
        <MdIconButton
          :title="showPassword ? '隐藏口令' : '显示口令'" :aria-label="showPassword ? '隐藏口令' : '显示口令'"
          @click="showPassword = !showPassword"
        >{{ showPassword ? '🙈' : '👁' }}</MdIconButton>
      </div>
      <MdButton class="unlock" type="submit" :disabled="busy">解锁</MdButton>
    </form>
    <MdButton
      v-if="showPasskey"
      variant="tonal"
      class="passkey"
      :disabled="busy || !passkeySupported"
      :title="passkeySupported ? undefined : '当前浏览器不支持 Passkey 解锁'"
      @click="onPasskeyUnlock"
    >
      使用 Passkey 解锁
    </MdButton>
    <!-- I44：DPAPI 已绑定但静默解锁失败 1s 后仍锁定 → 显示重试入口 -->
    <MdButton
      v-if="dpapi?.source.value && dpapiFailed"
      variant="tonal"
      class="dpapi-retry"
      :disabled="dpapiRetrying || busy"
      @click="onRetryDpapi"
    >
      重试 Windows 自动解锁
    </MdButton>
    <div v-if="msg" class="err" role="alert">{{ msg }}</div>
  </section>
</template>

<style scoped>
.lockscreen { display: flex; flex-direction: column; gap: 8px; padding: 32px 16px; max-width: 360px; margin: 0 auto; }
h2 { font-size: 16px; margin: 0; text-align: center; }
.hint { font-size: 13px; opacity: .65; margin: 0; text-align: center; }
.unlock-form { display: flex; flex-direction: column; gap: 8px; }
.pw-row { display: flex; gap: 4px; align-items: center; }
.pw-row .grow { flex: 1; }
.unlock { width: 100%; }
.err { color: var(--md-sys-color-error); font-size: 13px; }
</style>
