<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { KdfProfile } from '@totp/core'
import type { LockPrefs, SecurityPlatform } from './securityPlatform'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'
import MdSelect from './md/MdSelect.vue'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

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
  { value: 'fast', label: '更快（低端机友好）' },
  { value: 'balanced', label: '平衡（默认）' },
  { value: 'paranoid', label: '更慢更耐暴力破解' },
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
  if (!a) return '请输入口令'
  if (a !== b) return '两次输入的口令不一致'
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
  if (await run(() => p.enableEncryption(password.value), '已启用加密')) {
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
    ? (dpapiOps.value ? `；已绑定的 Passkey/${dpapiOps.value.label}已因密钥轮换失效，请重新绑定` : '；已绑定的 Passkey已因密钥轮换失效，请重新绑定')
    : ''
  if (await run(() => p.changePassphrase(newPw.value, { rotateDek: true }), `口令已更换${rebindHint}`)) {
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
  if (!profilePw.value) return fail(new Error('请输入当前口令'))
  if (await run(() => p.changePassphrase(profilePw.value, { rotateDek: false, profile: sel }), '加密强度已更新（立即生效，数据无需重新加密）')) {
    profileSel.value = null
    profilePw.value = ''
  }
}

/** 锁定策略任一控件变更：内存即时前进 + 完整对象覆写（避免宿主端部分更新歧义） */
async function onLockPrefChange(patch: Partial<LockPrefs>): Promise<void> {
  const lp = props.platform?.lockPrefs
  const cur = lockPrefsState.value
  if (!lp || !cur) return
  const next: LockPrefs = { ...cur, ...patch }
  lockPrefsState.value = next
  await lp.set(next)
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
    await run(() => p.disableEncryption(), '已关闭加密')
  } finally {
    confirmDisable.value = false
  }
}

async function onAddPasskey(): Promise<void> {
  const pk = passkeyOps.value
  if (!pk) return
  const prf = prfLabel.value
  await run(async () => {
    if (!(await pk.add())) throw new Error(`${prf} 创建未完成（已取消或认证器不支持 PRF）`)
  }, `${prf} 已绑定，下次锁定后可使用 ${prf} 解锁`)
}

async function onRemovePasskey(credentialId: string): Promise<void> {
  const pk = passkeyOps.value
  if (!pk) return
  await run(() => pk.remove(credentialId), `${prfLabel.value} 已移除`)
}

/** 启用 OS 自动解锁：取当前 DEK → OS 包裹（Windows=DPAPI / mac=Keychain / linux=Secret Service）→ 绑定来源落盘 */
async function onEnableDpapi(): Promise<void> {
  const ops = dpapiOps.value
  if (!ops) return
  await run(async () => {
    const dek = ops.getCurrentDek()
    if (!dek) throw new Error('当前无可用 DEK（需先解锁）')
    await ops.add(await ops.protect(dek))
  }, `${ops.label}已启用`)
}

async function onRemoveDpapi(): Promise<void> {
  const ops = dpapiOps.value
  if (!ops) return
  await run(() => ops.remove(), `${ops.label}已移除`)
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
    <h2>安全</h2>
    <template v-if="platform.security">
      <!-- 未启用：口令+确认 → 启用加密 -->
      <template v-if="!hasEnc">
        <p class="hint">此口令用于加密本机存储的验证库数据，与备份口令相互独立。</p>
        <div class="pw-row">
          <MdTextField v-model="password" type="password" label="加密口令" placeholder="加密口令" autocomplete="new-password" :disabled="busy" />
          <MdTextField v-model="confirmPw" type="password" label="确认口令" placeholder="确认口令" autocomplete="new-password" :disabled="busy" />
        </div>
        <div class="actions">
          <MdButton class="enable-enc" :disabled="busy" @click="onEnable">启用加密</MdButton>
        </div>
        <p class="hint">启用后本地数据以口令加密存储。启用后可绑定{{ prfLabel }}{{ naming?.osAutoLabel ? ` 或 ${naming.osAutoLabel}` : '' }}，免输口令解锁。</p>
        <p class="hint">启用后浏览器同步的数据也将是密文。</p>
      </template>
      <!-- 已启用且解锁：解锁方式 + 换口令 + 关闭加密 -->
      <template v-else-if="!isLocked">
        <!-- 解锁方式（prf：宿主提供 passkey ops 才渲染，不支持时仅提示；dpapi：仅 desktop 宿主提供时渲染） -->
        <div v-if="passkeyOps || dpapiOps" class="unlock-methods">
          <h3>解锁方式</h3>
          <template v-if="passkeyOps">
            <p v-if="prfCap === false" class="hint">当前浏览器不支持 {{ prfLabel }} 解锁（PRF）</p>
            <template v-else>
              <div class="method-row">
                <span class="method">口令</span>
                <span class="method-hint">默认解锁方式，不可移除</span>
              </div>
              <ul v-if="passkeySources.length" class="passkey-list">
                <li v-for="c in passkeySources" :key="c.credentialId">
                  <code>Passkey {{ shortId(c.credentialId) }}</code>
                  <MdButton variant="text" danger class="remove-passkey" :disabled="busy" @click="onRemovePasskey(c.credentialId)">移除</MdButton>
                </li>
              </ul>
              <div class="actions">
                <MdButton variant="tonal" class="add-passkey" :disabled="busy || prfCap !== true" @click="onAddPasskey">添加 {{ prfLabel }} 解锁</MdButton>
              </div>
            </template>
          </template>
          <template v-if="dpapiOps">
            <div v-if="dpapiSource" class="dpapi-row">
              <span class="method">{{ dpapiOps.label }}{{ dpapiOps.techSuffix ?? '（DPAPI）' }}</span>
              <MdButton variant="text" danger class="remove-dpapi" :disabled="busy" @click="onRemoveDpapi">移除</MdButton>
            </div>
            <div v-else class="actions">
              <MdButton variant="tonal" class="enable-dpapi" :disabled="busy" @click="onEnableDpapi">启用 {{ dpapiOps.label }}</MdButton>
            </div>
          </template>
        </div>
        <!-- 主口令天数提示（设计 §2：超 180 天强调色；passwordChangedAt 缺失显示未记录） -->
        <p v-if="pwAgeDays === null" class="pw-age-hint">本地主口令未记录更换时间</p>
        <p v-else :class="pwAgeDays > 180 ? 'pw-age-warn' : 'pw-age-hint'">本地主口令已 {{ pwAgeDays }} 天未更换</p>
        <!-- 加密强度档位（plan16 设计 §2 立即生效裁定：重 wrap 换 salt，数据无需重加密） -->
        <div class="kdf-row">
          <MdSelect
            class="kdf-select" label="加密强度" aria-label="加密强度"
            :model-value="profileSel ?? curProfile" :options="KDF_OPTIONS" :disabled="busy"
            @update:model-value="onProfileSelect"
          />
          <span class="opt-hint">调整立即生效，数据无需重新加密</span>
        </div>
        <div v-if="profileSel" class="confirm-row kdf-confirm">
          <MdTextField v-model="profilePw" type="password" label="当前口令" placeholder="当前口令" autocomplete="current-password" :disabled="busy" />
          <MdButton class="confirm-kdf" :disabled="busy" @click="onConfirmProfile">确认调整</MdButton>
          <MdButton variant="text" :disabled="busy" @click="profileSel = null">取消</MdButton>
        </div>
        <div class="pw-row">
          <MdTextField v-model="newPw" type="password" label="新口令" placeholder="新口令" autocomplete="new-password" :disabled="busy" />
          <MdTextField v-model="newPwConfirm" type="password" label="确认新口令" placeholder="确认新口令" autocomplete="new-password" :disabled="busy" />
        </div>
        <div class="actions">
          <MdButton class="change-pw" :disabled="busy" @click="onChangePw">更换口令</MdButton>
          <MdButton v-if="!confirmDisable" danger class="disable-enc" :disabled="busy" @click="confirmDisable = true">关闭加密</MdButton>
        </div>
        <div v-if="confirmDisable" class="confirm-row">
          <span>关闭加密将把全部条目以明文存储，确定？</span>
          <MdButton danger :disabled="busy" @click="onDisable">确认关闭</MdButton>
          <MdButton variant="text" :disabled="busy" @click="confirmDisable = false">取消</MdButton>
        </div>
      </template>
      <!-- 锁定：仅提示（解锁入口由主 LockScreen 处理） -->
      <p v-else class="locked-hint">已锁定——解锁后可管理加密设置</p>
      <!-- 锁定策略区（plan16 设计 §1；仅已启用加密且宿主提供 lockPrefs 时渲染，锁定态也可改——settings 写入不依赖 DEK） -->
      <div v-if="hasEnc && platform.lockPrefs && lockPrefsState" class="lock-prefs">
        <h3>锁定策略</h3>
        <div class="opt">
          <MdSwitch
            class="lock-restart" :model-value="lockPrefsState.lockOnRestart" aria-label="重启后保持锁定"
            @update:model-value="(v: boolean) => onLockPrefChange({ lockOnRestart: v })"
          />
          <span>重启后保持锁定</span>
          <span class="opt-hint">（关闭后浏览器会话内保持解锁，仅对支持会话保持的端有意义）</span>
        </div>
        <div class="opt">
          <span>空闲 N 分钟后锁定（0=禁用）</span>
          <MdTextField
            class="idle-min" type="number" label="空闲（分钟）" aria-label="空闲 N 分钟后锁定（0 为禁用）"
            min="0" :model-value="String(lockPrefsState.lockIdleMinutes)" :disabled="busy"
            @update:model-value="onIdleMinutesChange"
          />
        </div>
        <div class="opt">
          <MdSwitch
            class="lock-syslock" :model-value="lockPrefsState.lockOnSystemLock" aria-label="系统锁屏时锁定"
            @update:model-value="(v: boolean) => onLockPrefChange({ lockOnSystemLock: v })"
          />
          <span>系统锁屏时锁定</span>
        </div>
      </div>
    </template>
    <!-- 通用设置区 -->
    <div class="opt">
      <MdCheckbox
        class="clipboard-clear" :model-value="clipboardOn" :disabled="isLocked"
        label="复制后 30 秒自动清空剪贴板" ariaLabel="复制后 30 秒自动清空剪贴板"
        @update:model-value="onClipboardChange"
      />
      <span class="opt-hint">（剪贴板自动清空当前仅在 Chrome/Edge 生效）</span>    </div>
    <div v-if="platform.popupCloseDelayMs && platform.setPopupCloseDelay" class="opt">
      <span>复制后弹窗自动关闭延迟（毫秒）</span>
      <MdTextField
        class="delay-ms" type="number" label="延迟（毫秒）" aria-label="复制后弹窗自动关闭延迟（毫秒）"
        min="0" :model-value="String(platform.popupCloseDelayMs.value)"
        :disabled="busy || isLocked" @update:model-value="onDelayChange"
      />
    </div>
    <!-- I65：锁定态下两个通用设置均被禁用，提示用户先解锁 -->
    <p v-if="isLocked" class="locked-hint">解锁后可调整</p>
    <!-- I54：双端独立加密提示——仅 password 解锁时提醒跨设备需用同一口令 -->
    <p v-if="kekOnlyPassword" class="kek-hint">当前为口令解锁，跨设备需用同一口令</p>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供(M3 双描边裁定,2026-09-16 审查 X1);本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
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
