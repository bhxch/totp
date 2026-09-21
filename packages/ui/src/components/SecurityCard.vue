<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { KdfProfile } from '@totp/core'
import type { LockPrefs, SecurityPlatform } from './securityPlatform'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'
import MdSelect from './md/MdSelect.vue'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const { t } = useI18n()

const props = defineProps<{
  /** 安全平台能力；null 时整卡不渲染（popup 不受影响） */
  platform: SecurityPlatform | null
}>()

const password = ref('')
const confirmPw = ref('')
const newPw = ref('')
const newPwConfirm = ref('')
const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')
/** 关闭加密的两步确认（警示明文存储） */
const confirmDisable = ref(false)

const hasEnc = computed(() => props.platform?.security?.hasEncryption.value ?? false)
const isLocked = computed(() => props.platform?.security?.locked.value ?? false)
const clipboardOn = computed(() => props.platform?.clipboardClearEnabled.value ?? true)

/** 解锁方式按端命名（宿主经 unlockNaming 注入 prfLabel；OS 自动解锁显示名经 DpapiUnlockOps.label
 *  由宿主注入，UI 内不硬编码平台名，仅 prfLabel 未注入时回退 'Passkey'） */
const naming = computed(() => props.platform?.unlockNaming ?? null)
/** Passkey 显示名（msg 拼接与模板共用；未注入回退 'Passkey'） */
const prfLabel = computed(() => naming.value?.prfLabel ?? 'Passkey')
/** 启用提示的「可绑定方式」串：Passkey（+ OS 自动解锁显示名，宿主注入时） */
const bindMethods = computed(() => {
  const os = naming.value?.osAutoLabel
  return os ? `${prfLabel.value} ${t('securityCard.or')} ${os}` : prfLabel.value
})

/** Passkey(PRF) 能力探测结果：unknown=探测中/宿主未提供；false 时显示不支持提示 */
const prfCap = ref<'unknown' | boolean>('unknown')
const passkeyOps = computed(() => props.platform?.security?.passkey ?? null)
const passkeySources = computed(() => passkeyOps.value?.sources.value ?? [])

/** DPAPI(Windows) 自动解锁能力（仅 desktop 宿主提供；source 非 null=已绑定） */
const dpapiOps = computed(() => props.platform?.dpapi ?? null)
const dpapiSource = computed(() => dpapiOps.value?.source.value ?? null)

/** I54：检测本端 KEK 来源仅 password（无 Passkey/DPAPI 备用）→ 跨设备必须用同一口令 */
const kekOnlyPassword = computed(() => {
  if (!hasEnc.value) return false
  // passkey/DPAPI 任意存在即不算「仅口令」
  return passkeySources.value.length === 0 && dpapiSource.value === null
})

// ---- plan16 T11：KDF 加密强度档位 ----

/** 三档选项（设计 §2 KDF 档位表：fast≈OWASP 低档 / balanced=历史默认 / paranoid=保守） */
const KDF_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'fast', label: t('securityCard.kdfFast') },
  { value: 'balanced', label: t('securityCard.kdfBalanced') },
  { value: 'paranoid', label: t('securityCard.kdfParanoid') },
]
const curProfile = computed<KdfProfile>(() => props.platform?.security?.kdfProfile.value ?? 'balanced')
/** 待确认的新档位（null=未在调整；确认成功或取消/重选当前档位即复位） */
const profileSel = ref<KdfProfile | null>(null)
const profilePw = ref('')

/** 主口令最近更换时间（null=宿主未记录）与天数换算 */
const pwChangedAt = computed(() => props.platform?.security?.passwordChangedAt.value ?? null)
const pwAgeDays = computed<number | null>(() => {
  const at = pwChangedAt.value
  if (at === null) return null
  return Math.floor((Date.now() - at) / 86_400_000)
})

// ---- plan16 T11：锁定策略偏好（异步载入，载入完成前不渲染避免闪烁默认值） ----

const lockPrefsState = ref<LockPrefs | null>(null)

/** 该端不支持的锁定偏好键（宿主声明）：对应控件隐藏防无效设置（缺省空集=三控件全渲染） */
const unsupportedLockPrefs = computed(() => new Set(props.platform?.lockPrefs?.unsupported ?? []))

onMounted(() => {
  const pk = passkeyOps.value
  if (pk) {
    pk.prfSupported()
      .then((ok) => { prfCap.value = ok })
      .catch(() => { prfCap.value = false })
  }
  const lp = props.platform?.lockPrefs
  if (!lp) return
  Promise.resolve(lp.get())
    .then((p) => { lockPrefsState.value = { ...p } })
    .catch(() => { /* 载入失败按未提供处理（锁定策略区不渲染） */ })
})

/** credentialId 缩略显示：base64url 串较长，取首尾各 6 字符 */
function shortId(id: string): string {
  return id.length > 16 ? id.slice(0, 6) + '…' + id.slice(-6) : id
}

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

/** 口令校验：非空且两次一致（启用/换口令共用） */
function validatePw(a: string, b: string): string | null {
  if (!a) return t('securityCard.passphraseRequired')
  if (a !== b) return t('securityCard.passphraseMismatch')
  return null
}

/** busy/消息统一包装（同 BackupCard 模式） */
async function run(fn: () => Promise<void>, okMsg: string): Promise<boolean> {
  busy.value = true
  msg.value = ''
  try {
    await fn()
    msg.value = okMsg
    msgKind.value = 'ok'
    return true
  } catch (e) {
    fail(e)
    return false
  } finally {
    busy.value = false
  }
}

async function onEnable(): Promise<void> {
  const p = props.platform?.security
  if (!p) return
  const err = validatePw(password.value, confirmPw.value)
  if (err) return fail(new Error(err))
  if (await run(() => p.enableEncryption(password.value), t('securityCard.enabled'))) {
    password.value = ''
    confirmPw.value = ''
  }
}

async function onChangePw(): Promise<void> {
  const p = props.platform?.security
  if (!p) return
  const err = validatePw(newPw.value, newPwConfirm.value)
  if (err) return fail(new Error(err))
  // 换口令即被动轮换（plan16 设计 §2 裁定，rotateDek:true）：DEK 重生成 → prf/dpapi 旧包裹来源全部失效需重绑。
  // 换前存在非口令来源时追加重绑提示（文案按 dpapiOps 有无动态化，与旧 keepHint 反向）
  const hadAlternate = passkeySources.value.length > 0 || dpapiSource.value !== null
  const rebindHint = hadAlternate
    ? t(dpapiOps.value ? 'securityCard.rebindWithOs' : 'securityCard.rebindNoOs', { os: dpapiOps.value?.label ?? '' })
    : ''
  if (await run(() => p.changePassphrase(newPw.value, { rotateDek: true }), t('securityCard.pwChanged', { hint: rebindHint }))) {
    newPw.value = ''
    newPwConfirm.value = ''
  }
}

/** 选择档位：与当前档位相同视作取消（收起确认行）；不同则展开当前口令确认行 */
function onProfileSelect(v: string | number): void {
  const next = v as KdfProfile
  profileSel.value = next === curProfile.value ? null : next
}

/** 档位调整确认：重 wrap 立即生效（rotateDek:false + profile），口令不变、数据无需重加密 */
async function onConfirmProfile(): Promise<void> {
  const p = props.platform?.security
  const sel = profileSel.value
  if (!p || !sel) return
  if (!profilePw.value) return fail(new Error(t('securityCard.currentPwRequired')))
  if (await run(() => p.changePassphrase(profilePw.value, { rotateDek: false, profile: sel }), t('securityCard.profileUpdated'))) {
    profileSel.value = null
    profilePw.value = ''
  }
}

/** 锁定策略任一控件变更：内存即时前进 + 完整对象覆写（避免宿主端部分更新歧义）；写失败走 msg 通道而非静默 */
async function onLockPrefChange(patch: Partial<LockPrefs>): Promise<void> {
  const lp = props.platform?.lockPrefs
  const cur = lockPrefsState.value
  if (!lp || !cur) return
  const next: LockPrefs = { ...cur, ...patch }
  lockPrefsState.value = next
  try {
    await lp.set(next)
  } catch (e) {
    fail(e)
  }
}

/** 空闲分钟输入钳制：≥0 整数，0=禁用 */
async function onIdleMinutesChange(value: string): Promise<void> {
  const mins = Math.max(0, Math.floor(Number(value) || 0))
  await onLockPrefChange({ lockIdleMinutes: mins })
}

async function onDisable(): Promise<void> {
  const p = props.platform?.security
  if (!p) return
  // I71：无论 run 成功失败都显式复位 confirmDisable（run 内部已 finally 复位 busy，
  // 但 confirmDisable 不能依赖 run 副作用；当前实现 run=false 时不进入 if 分支导致状态残留）
  try {
    await run(() => p.disableEncryption(), t('securityCard.disabled'))
  } finally {
    confirmDisable.value = false
  }
}

async function onAddPasskey(): Promise<void> {
  const pk = passkeyOps.value
  if (!pk) return
  const prf = prfLabel.value
  await run(async () => {
    if (!(await pk.add())) throw new Error(t('securityCard.prfCreateFailed', { prf }))
  }, t('securityCard.prfAdded', { prf }))
}

async function onRemovePasskey(credentialId: string): Promise<void> {
  const pk = passkeyOps.value
  if (!pk) return
  await run(() => pk.remove(credentialId), t('securityCard.prfRemoved', { prf: prfLabel.value }))
}

/** 启用 OS 自动解锁：取当前 DEK → OS 包裹（Windows=DPAPI / mac=Keychain / linux=Secret Service）→ 绑定来源落盘 */
async function onEnableDpapi(): Promise<void> {
  const ops = dpapiOps.value
  if (!ops) return
  await run(async () => {
    const dek = ops.getCurrentDek()
    if (!dek) throw new Error(t('securityCard.noDek'))
    await ops.add(await ops.protect(dek))
  }, t('securityCard.osEnabled', { label: ops.label }))
}

async function onRemoveDpapi(): Promise<void> {
  const ops = dpapiOps.value
  if (!ops) return
  await run(() => ops.remove(), t('securityCard.osRemoved', { label: ops.label }))
}

async function onClipboardChange(checked: boolean): Promise<void> {
  await props.platform?.setClipboardClear(checked)
}

async function onDelayChange(value: string): Promise<void> {
  const ms = Math.max(0, Math.floor(Number(value) || 0))
  await props.platform?.setPopupCloseDelay?.(ms)
}
</script>

<template>
  <section v-if="platform" class="card security">
    <h2>{{ t('securityCard.title') }}</h2>
    <template v-if="platform.security">
      <!-- 未启用：口令+确认 → 启用加密 -->
      <template v-if="!hasEnc">
        <p class="hint">{{ t('securityCard.enableIntro') }}</p>
        <div class="pw-row">
          <MdTextField v-model="password" type="password" :label="t('securityCard.pwLabel')" :placeholder="t('securityCard.pwLabel')" autocomplete="new-password" :disabled="busy" />
          <MdTextField v-model="confirmPw" type="password" :label="t('securityCard.confirmLabel')" :placeholder="t('securityCard.confirmLabel')" autocomplete="new-password" :disabled="busy" />
        </div>
        <div class="actions">
          <MdButton class="enable-enc" :disabled="busy" @click="onEnable">{{ t('securityCard.enableBtn') }}</MdButton>
        </div>
        <p class="hint">{{ t('securityCard.enableBindHint', { methods: bindMethods }) }}</p>
        <p class="hint">{{ t('securityCard.enableSyncHint') }}</p>
      </template>
      <!-- 已启用且解锁：解锁方式 + 换口令 + 关闭加密 -->
      <template v-else-if="!isLocked">
        <!-- 解锁方式（prf：宿主提供 passkey ops 才渲染，不支持时仅提示；dpapi：仅 desktop 宿主提供时渲染） -->
        <div v-if="passkeyOps || dpapiOps" class="unlock-methods">
          <h3>{{ t('securityCard.unlockMethodsTitle') }}</h3>
          <template v-if="passkeyOps">
            <p v-if="prfCap === false" class="hint">{{ t('securityCard.prfUnsupported', { prf: prfLabel }) }}</p>
            <template v-else>
              <div class="method-row">
                <span class="method">{{ t('securityCard.methodPassphrase') }}</span>
                <span class="method-hint">{{ t('securityCard.methodHint') }}</span>
              </div>
              <ul v-if="passkeySources.length" class="passkey-list">
                <li v-for="c in passkeySources" :key="c.credentialId">
                  <code>Passkey {{ shortId(c.credentialId) }}</code>
                  <MdButton variant="text" danger class="remove-passkey" :disabled="busy" @click="onRemovePasskey(c.credentialId)">{{ t('securityCard.remove') }}</MdButton>
                </li>
              </ul>
              <div class="actions">
                <MdButton variant="tonal" class="add-passkey" :disabled="busy || prfCap !== true" @click="onAddPasskey">{{ t('securityCard.addPrf', { prf: prfLabel }) }}</MdButton>
              </div>
            </template>
          </template>
          <template v-if="dpapiOps">
            <div v-if="dpapiSource" class="dpapi-row">
              <span class="method">{{ dpapiOps.label }}{{ dpapiOps.techSuffix ?? t('securityCard.dpapiTechSuffix') }}</span>
              <MdButton variant="text" danger class="remove-dpapi" :disabled="busy" @click="onRemoveDpapi">{{ t('securityCard.remove') }}</MdButton>
            </div>
            <div v-else class="actions">
              <MdButton variant="tonal" class="enable-dpapi" :disabled="busy" @click="onEnableDpapi">{{ t('securityCard.enableOs', { label: dpapiOps.label }) }}</MdButton>
            </div>
          </template>
        </div>
        <!-- 主口令天数提示（设计 §2：超 180 天强调色；passwordChangedAt 缺失显示未记录） -->
        <p v-if="pwAgeDays === null" class="pw-age-hint">{{ t('securityCard.pwAgeUnknown') }}</p>
        <p v-else :class="pwAgeDays > 180 ? 'pw-age-warn' : 'pw-age-hint'">{{ t('securityCard.pwAge', { days: pwAgeDays }) }}</p>
        <!-- 加密强度档位（plan16 设计 §2 立即生效裁定：重 wrap 换 salt，数据无需重加密） -->
        <div class="kdf-row">
          <MdSelect
            class="kdf-select" :label="t('securityCard.kdfLabel')" :aria-label="t('securityCard.kdfLabel')"
            :model-value="profileSel ?? curProfile" :options="KDF_OPTIONS" :disabled="busy"
            @update:model-value="onProfileSelect"
          />
          <span class="opt-hint">{{ t('securityCard.kdfHint') }}</span>
        </div>
        <div v-if="profileSel" class="confirm-row kdf-confirm">
          <MdTextField v-model="profilePw" type="password" :label="t('securityCard.currentPwLabel')" :placeholder="t('securityCard.currentPwLabel')" autocomplete="current-password" :disabled="busy" />
          <MdButton class="confirm-kdf" :disabled="busy" @click="onConfirmProfile">{{ t('securityCard.confirmProfileBtn') }}</MdButton>
          <MdButton variant="text" :disabled="busy" @click="profileSel = null">{{ t('securityCard.cancel') }}</MdButton>
        </div>
        <div class="pw-row">
          <MdTextField v-model="newPw" type="password" :label="t('securityCard.newPwLabel')" :placeholder="t('securityCard.newPwLabel')" autocomplete="new-password" :disabled="busy" />
          <MdTextField v-model="newPwConfirm" type="password" :label="t('securityCard.newPwConfirmLabel')" :placeholder="t('securityCard.newPwConfirmLabel')" autocomplete="new-password" :disabled="busy" />
        </div>
        <div class="actions">
          <MdButton class="change-pw" :disabled="busy" @click="onChangePw">{{ t('securityCard.changePwBtn') }}</MdButton>
          <MdButton v-if="!confirmDisable" danger class="disable-enc" :disabled="busy" @click="confirmDisable = true">{{ t('securityCard.disableBtn') }}</MdButton>
        </div>
        <div v-if="confirmDisable" class="confirm-row">
          <span>{{ t('securityCard.disableConfirm') }}</span>
          <MdButton danger :disabled="busy" @click="onDisable">{{ t('securityCard.confirmDisableBtn') }}</MdButton>
          <MdButton variant="text" :disabled="busy" @click="confirmDisable = false">{{ t('securityCard.cancel') }}</MdButton>
        </div>
      </template>
      <!-- 锁定：仅提示（解锁入口由主 LockScreen 处理） -->
      <p v-else class="locked-hint">{{ t('securityCard.lockedHint') }}</p>
      <!-- 锁定策略区（plan16 设计 §1；仅已启用加密且宿主提供 lockPrefs 时渲染，锁定态也可改——settings 写入不依赖 DEK） -->
      <div v-if="hasEnc && platform.lockPrefs && lockPrefsState" class="lock-prefs">
        <h3>{{ t('securityCard.lockPrefsTitle') }}</h3>
        <!-- 重启后保持锁定：仅对有会话保持能力的端有意义，宿主声明不支持（unsupported）时隐藏 -->
        <div v-if="!unsupportedLockPrefs.has('lockOnRestart')" class="opt">
          <MdSwitch
            class="lock-restart" :model-value="lockPrefsState.lockOnRestart" :aria-label="t('securityCard.lockOnRestart')"
            @update:model-value="(v: boolean) => onLockPrefChange({ lockOnRestart: v })"
          />
          <span>{{ t('securityCard.lockOnRestart') }}</span>
          <span class="opt-hint">{{ t('securityCard.lockOnRestartHint') }}</span>
        </div>
        <div class="opt">
          <span>{{ t('securityCard.lockIdle') }}</span>
          <MdTextField
            class="idle-min" type="number" :label="t('securityCard.idleLabel')" :aria-label="t('securityCard.idleAria')"
            min="0" :model-value="String(lockPrefsState.lockIdleMinutes)" :disabled="busy"
            @update:model-value="onIdleMinutesChange"
          />
        </div>
        <!-- 系统锁屏时锁定：宿主声明不支持（unsupported，如无系统锁屏事件源的端）时隐藏 -->
        <div v-if="!unsupportedLockPrefs.has('lockOnSystemLock')" class="opt">
          <MdSwitch
            class="lock-syslock" :model-value="lockPrefsState.lockOnSystemLock" :aria-label="t('securityCard.lockOnSystemLock')"
            @update:model-value="(v: boolean) => onLockPrefChange({ lockOnSystemLock: v })"
          />
          <span>{{ t('securityCard.lockOnSystemLock') }}</span>
        </div>
      </div>
    </template>
    <!-- 通用设置区 -->
    <div class="opt">
      <MdCheckbox
        class="clipboard-clear" :model-value="clipboardOn" :disabled="isLocked"
        :label="t('securityCard.clipboardClear')" :aria-label="t('securityCard.clipboardClear')"
        @update:model-value="onClipboardChange"
      />
      <span class="opt-hint">{{ t('securityCard.clipboardHint') }}</span>    </div>
    <div v-if="platform.popupCloseDelayMs && platform.setPopupCloseDelay" class="opt">
      <span>{{ t('securityCard.closeDelay') }}</span>
      <MdTextField
        class="delay-ms" type="number" :label="t('securityCard.delayLabel')" :aria-label="t('securityCard.closeDelay')"
        min="0" :model-value="String(platform.popupCloseDelayMs.value)"
        :disabled="busy || isLocked" @update:model-value="onDelayChange"
      />
    </div>
    <!-- I65：锁定态下两个通用设置均被禁用，提示用户先解锁 -->
    <p v-if="isLocked" class="locked-hint">{{ t('securityCard.lockedAdjustHint') }}</p>
    <!-- I54：双端独立加密提示——仅 password 解锁时提醒跨设备需用同一口令 -->
    <p v-if="kekOnlyPassword" class="kek-hint">{{ t('securityCard.kekOnlyHint') }}</p>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供(M3 双描边裁定,2026-09-16 审查 X1);本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.unlock-methods { display: flex; flex-direction: column; gap: 12px; }
.unlock-methods h3 { font-size: var(--md-sys-typescale-body-medium); margin: 0; opacity: .8; }
.method-row { display: flex; align-items: baseline; gap: 8px; }
.method-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
.method { font-size: var(--md-sys-typescale-body-medium); }
.passkey-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.passkey-list li { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.passkey-list code { font-size: var(--md-sys-typescale-body-small); opacity: .75; }
.dpapi-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.pw-row { display: flex; gap: 8px; }
.pw-row .md-text-field { flex: 1; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.confirm-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); flex-wrap: wrap; }
.opt { font-size: var(--md-sys-typescale-body-medium); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.opt-hint { opacity: .65; font-size: var(--md-sys-typescale-body-small); }
.delay-ms { width: 150px; }
.hint, .locked-hint { font-size: var(--md-sys-typescale-body-medium); opacity: .65; margin: 0; }
.ok { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
.hint { opacity: .65; font-size: var(--md-sys-typescale-body-medium); }
.kek-hint { font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-tertiary); margin: 0; }
/* plan16 T11：主口令天数提示（默认弱化，超 180 天 error 强调）与加密强度/锁定策略排版 */
.pw-age-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.pw-age-warn { font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-error); margin: 0; }
.kdf-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kdf-select { width: 260px; }
.lock-prefs { display: flex; flex-direction: column; gap: 8px; }
.lock-prefs h3 { font-size: var(--md-sys-typescale-body-medium); margin: 0; opacity: .8; }
.idle-min { width: 150px; }
</style>
