<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { VueStore } from '../store'
import MdButton from './md/MdButton.vue'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  /** 全局响应式 store：读 hasEncryption/backupSecret/bagStored，写走 setBackupSecret/forgetBackupSecret */
  store: VueStore
}>()

const { t } = useI18n()

const password = ref('')
const confirmPw = ref('')
const remember = ref(false)
const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')

/** store 返回对象内的 computed 不随 props 解包，须显式 .value */
const hasEnc = computed(() => props.store.hasEncryption.value)
const sessionSecret = computed(() => props.store.backupSecret.value)
/** 保管区已存口令（bag.backupPassword 非空；解锁自动装载、lock 清空） */
const storedInBag = computed(() => props.store.bagStored.value)

/** 状态行三态：未设置 / 会话内已启用 / 已存入保管区 */
const statusText = computed(() => {
  if (!sessionSecret.value) return t('backupSecretCard.statusUnset')
  return storedInBag.value ? t('backupSecretCard.statusStoredInBag') : t('backupSecretCard.statusSessionOnly')
})

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

/** 启用前校验：非空且两次一致（错误不清空输入，便于修改重试） */
function validatePw(): string | null {
  if (!password.value.trim()) return t('backupSecretCard.passphraseRequired')
  if (password.value !== confirmPw.value) return t('backupSecretCard.passphraseMismatch')
  return null
}

async function onEnable(): Promise<void> {
  const err = validatePw()
  if (err) return fail(new Error(err))
  busy.value = true
  msg.value = ''
  try {
    await props.store.setBackupSecret(password.value.trim(), remember.value)
    password.value = ''
    confirmPw.value = ''
    msg.value = t('backupSecretCard.enabled')
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function onClear(): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    await props.store.forgetBackupSecret()
    msg.value = t('backupSecretCard.cleared')
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="card backup-secret">
    <h2>{{ t('backupSecretCard.title') }}</h2>
    <div class="hint desc">{{ t('backupSecretCard.desc') }}</div>
    <div class="pw-row">
      <MdTextField v-model="password" type="password" :label="t('backupSecretCard.pwLabel')" :placeholder="t('backupSecretCard.pwPlaceholder')" autocomplete="new-password" />
      <MdTextField v-model="confirmPw" type="password" :label="t('backupSecretCard.confirmLabel')" :placeholder="t('backupSecretCard.confirmPlaceholder')" autocomplete="new-password" />
    </div>
    <div class="remember-row">
      <MdSwitch v-model="remember" :aria-label="t('backupSecretCard.remember')" :disabled="!hasEnc" />
      <span>{{ t('backupSecretCard.remember') }}</span>
    </div>
    <div class="hint remember-hint">{{ t('backupSecretCard.rememberHint') }}</div>
    <div class="actions">
      <MdButton class="secret-save" :disabled="busy" @click="onEnable">{{ t('backupSecretCard.enableSession') }}</MdButton>
      <MdButton v-if="sessionSecret" class="secret-clear" variant="tonal" :disabled="busy" @click="onClear">{{ t('backupSecretCard.clear') }}</MdButton>
    </div>
    <div class="status">{{ statusText }}</div>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供(M3 双描边裁定,2026-09-16 审查 X1);本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.pw-row { display: flex; gap: 8px; }
.pw-row .md-text-field { flex: 1; }
.remember-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.status { font-size: var(--md-sys-typescale-body-medium); }
.ok { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
.hint { opacity: .65; font-size: var(--md-sys-typescale-body-medium); }
</style>
