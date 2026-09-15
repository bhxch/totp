<script setup lang="ts">
import type { Vault } from '@totp/core'
import { onMounted, ref, watch } from 'vue'
import type { BackupMode, BackupPlatform } from './backupPlatform'
import { parseVaultJson } from './parseVaultJson'

const props = defineProps<{
  /** 平台备份实现；null 时整卡不渲染（popup 不受影响） */
  platform: BackupPlatform | null
  /** 备份内容=调用方组装的 vault JSON 快照（saveVault 同款） */
  vaultJson: string
}>()

const password = ref('')
const confirmPw = ref('')
const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')
const backups = ref<Array<{ name: string }>>([])

/** 已解密待确认覆盖的 vault（两步确认防误覆盖） */
const pending = ref<Vault | null>(null)

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

/** 备份/导出口令校验：非空且两次一致 */
function validatePw(): string | null {
  if (!password.value) return '请输入口令'
  if (password.value !== confirmPw.value) return '两次输入的口令不一致'
  return null
}

async function onBackup(): Promise<void> {
  const err = validatePw()
  if (err) return fail(new Error(err))
  busy.value = true
  msg.value = ''
  try {
    const r = await props.platform!.createBackup(props.vaultJson, password.value)
    msg.value = r === 'overwritten' ? '备份成功（覆盖）' : '备份成功（新文件）'
    msgKind.value = 'ok'
    if (props.platform?.listBackups) await refreshList()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function onExport(): Promise<void> {
  const err = validatePw()
  if (err) return fail(new Error(err))
  busy.value = true
  msg.value = ''
  try {
    const saved = await props.platform!.exportToFile!(props.vaultJson, password.value)
    if (saved === false) {
      msg.value = '已取消'
      msgKind.value = 'hint'
    } else {
      msg.value = '已导出到文件'
      msgKind.value = 'ok'
    }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function setMode(m: BackupMode): Promise<void> {
  await props.platform?.setMode(m)
}

/** I70：本地 keepN 副本——keep 模式时与平台同步；切到 overwrite 后保留前值，再切回 keep 时恢复。
 *  避免 keep→overwrite→keep 时丢失用户已配的 N */
const keepN = ref<number>(
  props.platform?.mode.type === 'keep' ? props.platform.mode.n : 3,
)
/** 监听平台模式：keep 时把最新 n 同步进本地；overwrite 不动 */
watch(() => props.platform?.mode, (m) => {
  if (m?.type === 'keep') keepN.value = m.n
})

async function onNChange(e: Event): Promise<void> {
  const n = Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1))
  await setMode({ type: 'keep', n })
}

async function refreshList(): Promise<void> {
  try {
    backups.value = await props.platform!.listBackups!()
  } catch {
    backups.value = []
  }
}
onMounted(() => {
  if (props.platform?.listBackups) void refreshList()
})

/** 恢复第 1 步：取备份并解密（口令复用输入框），成功后进入两步确认 */
async function startRestore(kind: 'picker' | 'name', name?: string): Promise<void> {
  const p = props.platform
  if (!p) return
  if (!password.value) return fail(new Error('请先在上方输入口令用于解密备份'))
  busy.value = true
  msg.value = ''
  try {
    const r = kind === 'picker'
      ? await p.restoreFromPicker!(password.value)
      : await p.restoreByName!(name!, password.value)
    if (!r) return // 用户取消了文件选择
    pending.value = parseVaultJson(r.json)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 恢复第 2 步：确认覆盖 → replaceAllOp */
async function confirmRestore(): Promise<void> {
  const p = props.platform
  if (!p || !pending.value) return
  busy.value = true
  try {
    await p.replaceAllOp!(pending.value)
    pending.value = null
    msg.value = '恢复成功'
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="platform" class="card backup">
    <h2>备份</h2>
    <div class="pw-row">
      <input v-model="password" type="password" placeholder="备份口令" autocomplete="new-password" />
      <input v-model="confirmPw" type="password" placeholder="确认口令" autocomplete="new-password" />
    </div>
    <div class="modes">
      <label>
        <input
          type="radio" name="backup-mode" value="keep" :checked="platform.mode.type === 'keep'"
          @change="setMode({ type: 'keep', n: keepN })"
        />
        保留最近
        <input
          v-if="platform.mode.type === 'keep'"
          class="keep-n" type="number" min="1" :value="platform.mode.n" @change="onNChange"
        />
        份
      </label>
      <label>
        <input
          type="radio" name="backup-mode" value="overwrite" :checked="platform.mode.type === 'overwrite'"
          @change="setMode({ type: 'overwrite' })"
        />
        覆盖单一文件
      </label>
    </div>
    <div class="actions">
      <button class="backup-now" :disabled="busy" @click="onBackup">立即备份</button>
      <button v-if="platform.exportToFile" :disabled="busy" @click="onExport">导出到文件</button>
      <button v-if="platform.restoreFromPicker" :disabled="busy" @click="startRestore('picker')">从文件恢复</button>
    </div>
    <ul v-if="backups.length" class="backup-list">
      <li v-for="b in backups" :key="b.name">
        <span class="bname">{{ b.name }}</span>
        <button v-if="platform.restoreByName" :disabled="busy" @click="startRestore('name', b.name)">恢复</button>
      </li>
    </ul>
    <div v-if="pending" class="confirm-row">
      <span>将用备份覆盖当前全部条目？</span>
      <button class="danger" :disabled="busy" @click="confirmRestore">确认覆盖</button>
      <button @click="pending = null">取消</button>
    </div>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
.card { border: 1px solid var(--md-sys-color-outline-variant); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: 15px; margin: 0; }
.pw-row { display: flex; gap: 8px; }
.pw-row input { flex: 1; }
.modes { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; }
.modes label { display: flex; align-items: center; gap: 4px; }
.keep-n { width: 56px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.backup-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; }
.backup-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.bname { flex: 1; opacity: .8; }
.confirm-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.danger { color: var(--md-sys-color-error); }
.ok { color: var(--md-sys-color-primary); font-size: 13px; }
.err { color: var(--md-sys-color-error); font-size: 13px; }
.hint { opacity: .65; font-size: 13px; }
</style>
