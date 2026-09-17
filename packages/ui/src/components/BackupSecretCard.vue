<script setup lang="ts">
import { computed, ref } from 'vue'
import type { VueStore } from '../store'
import MdButton from './md/MdButton.vue'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  /** 全局响应式 store：读 hasEncryption/backupSecret/bagStored，写走 setBackupSecret/forgetBackupSecret */
  store: VueStore
}>()

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
  if (!sessionSecret.value) return '未设置'
  return storedInBag.value ? '已存入保管区，解锁即用' : '会话内已启用'
})

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

/** 启用前校验：非空且两次一致（错误不清空输入，便于修改重试） */
function validatePw(): string | null {
  if (!password.value.trim()) return '请输入口令'
  if (password.value !== confirmPw.value) return '两次输入的口令不一致'
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
    msg.value = '备份口令已启用'
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
    msg.value = '已清除'
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
    <h2>备份口令</h2>
    <div class="hint desc">用于加密本地备份文件与云端同步对象，两者共用；开启记住后存入库旁的加密保管区（受本地主口令保护），解锁库即可用；未记住则锁定或关闭页面后需重新输入。</div>
    <div class="pw-row">
      <MdTextField v-model="password" type="password" label="备份口令" placeholder="备份口令" autocomplete="new-password" />
      <MdTextField v-model="confirmPw" type="password" label="确认口令" placeholder="确认口令" autocomplete="new-password" />
    </div>
    <div class="remember-row">
      <MdSwitch v-model="remember" aria-label="记住（存入保管区）" :disabled="!hasEnc" />
      <span>记住（存入保管区）</span>
    </div>
    <div class="hint remember-hint">开启后以密文存入保管区（需已启用加密），解锁库即可用，系统原生解锁方式同样生效。</div>
    <div class="actions">
      <MdButton class="secret-save" :disabled="busy" @click="onEnable">启用会话</MdButton>
      <MdButton v-if="sessionSecret" class="secret-clear" variant="tonal" :disabled="busy" @click="onClear">清除</MdButton>
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
