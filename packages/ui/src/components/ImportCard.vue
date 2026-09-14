<script setup lang="ts">
import {
  SQLITE_TABLE_PROBES, applyImport, extractGenericRows, findConflicts, importAegisEncrypted,
  importAegisPlaintext, importAndOtp, importAuthy, importBattleNet, importBitwarden, importDuo,
  importFreeOtp, importFreeOtpLegacy, importGeneric, importProton, importStratum,
  importTotpAuthenticator, importTwoFas, importUriBatch, importWinauth, matchSchemes,
  normalizeSchemes, removeScheme, sniffAegis, sniffFormat, upsertScheme,
  type ConflictPolicy, type ImportFormat, type ImportResult, type ImportScheme, type RowMapping,
} from '@totp/core'
import { computed, ref } from 'vue'
import { openSqlite } from '../sqliteLoader'
import type { VueStore } from '../store'
import type { ImportPlatform, ImportSchemesApi } from './importPlatform'

const props = defineProps<{
  /** 平台导入能力（readImportFile + 可选 readImportFileBytes/decryptDpapi + store）；null 时整卡不渲染（popup 不受影响） */
  platform: ImportPlatform | null
  /** 映射方案存取能力（宿主直读写 storage 的 SCHEMES_KEY）；null 时映射页方案区不渲染 */
  schemesApi?: ImportSchemesApi | null
}>()

// 流程状态机：idle → picked →（generic→mapping / aegis 加密与 winauth/authy→password、totpAuthenticator 分享文件→password）→ confirm → report
type Step = 'idle' | 'picked' | 'mapping' | 'password' | 'confirm' | 'report'

// 可分派格式 = sniff 全集 + 非 sniff 判定的补充入口（authy/battleNet/duo 文本、msAuth/sqlite 字节）
type ManualFormat = ImportFormat | 'authy' | 'battleNet' | 'duo' | 'msAuth' | 'sqlite'
// 直接解析族（其余格式分别走：generic→映射页、aegis/winauth/authy→口令页、totpAuthenticator 分享文件→条件口令页、msAuth/sqlite→字节入口）
type DirectFormat = Exclude<ManualFormat, 'generic' | 'aegis' | 'winauth' | 'authy' | 'msAuth' | 'sqlite'>

const step = ref<Step>('idle')
const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')
const fileName = ref('')
const fileText = ref('')
const format = ref<ManualFormat | null>(null)
const manual = ref<'auto' | ManualFormat>('auto')
const password = ref('')
const passwordHint = ref('')
const policy = ref<ConflictPolicy>('skip')
const result = ref<ImportResult | null>(null)
const conflicts = ref<Set<number>>(new Set())

const FORMAT_LABEL: Record<ManualFormat, string> = {
  aegis: 'Aegis 备份（加密或明文）',
  winauth: 'WinAuth 配置（XML）',
  uriBatch: 'otpauth URI 批量文本',
  generic: '通用 JSON / JSONL',
  twoFas: '2FAS 导出（JSON）',
  bitwarden: 'Bitwarden 导出（JSON）',
  proton: 'Proton Authenticator 导出（JSON）',
  stratum: 'Stratum 导出（JSON）',
  freeOtp: 'FreeOTP+ 导出（JSON）',
  freeOtpLegacy: '旧版 FreeOTP（tokens.xml）',
  totpAuthenticator: 'TOTP Authenticator 导出',
  andOtp: 'andOTP 明文导出（JSON）',
  authy: 'Authy shared_prefs（XML）',
  battleNet: 'Battle.net shared_prefs（XML）',
  duo: 'Duo duokit accounts（JSON）',
  msAuth: 'Microsoft Authenticator（SQLite）',
  sqlite: 'SQLite 数据库（表名探测）',
}

/** picked 页手动指定格式下拉（嗅探失败/误判时自选；freeOtpPlus 与 freeOtp 同 parser 不单列） */
const MANUAL_OPTIONS: Array<{ value: ManualFormat; label: string }> = [
  { value: 'uriBatch', label: 'otpauth URI 批量文本' },
  { value: 'aegis', label: 'Aegis 备份（JSON）' },
  { value: 'winauth', label: 'WinAuth（XML）' },
  { value: 'generic', label: '通用 JSON / JSONL（字段映射）' },
  { value: 'twoFas', label: '2FAS（JSON）' },
  { value: 'bitwarden', label: 'Bitwarden（JSON）' },
  { value: 'proton', label: 'Proton Authenticator（JSON）' },
  { value: 'stratum', label: 'Stratum（JSON）' },
  { value: 'freeOtp', label: 'FreeOTP+（JSON）' },
  { value: 'freeOtpLegacy', label: '旧版 FreeOTP（tokens.xml）' },
  { value: 'totpAuthenticator', label: 'TOTP Authenticator（明文/外部分享）' },
  { value: 'andOtp', label: 'andOTP 明文导出（JSON）' },
  { value: 'authy', label: 'Authy shared_prefs（XML）' },
  { value: 'battleNet', label: 'Battle.net shared_prefs（XML）' },
  { value: 'duo', label: 'Duo duokit accounts（JSON）' },
  { value: 'msAuth', label: 'Microsoft Authenticator（SQLite）' },
  { value: 'sqlite', label: 'SQLite 数据库（表名探测）' },
]

/** 实际生效格式：手动选择覆盖嗅探结果（auto 时用嗅探值，可能为 null=未识别） */
const effectiveFormat = computed<ManualFormat | null>(() => (manual.value === 'auto' ? format.value : manual.value))

// generic 映射页：每目标字段一个点路径输入，secret 必填；rows 取自 extractGenericRows
type MapFieldKey = 'secret' | 'issuer' | 'label' | 'type' | 'algorithm' | 'digits' | 'period' | 'counter' | 'note'
const FIELDS: Array<{ key: MapFieldKey; label: string; required?: boolean }> = [
  { key: 'secret', label: 'secret', required: true },
  { key: 'issuer', label: 'issuer' },
  { key: 'label', label: 'label' },
  { key: 'type', label: 'type' },
  { key: 'algorithm', label: 'algorithm' },
  { key: 'digits', label: 'digits' },
  { key: 'period', label: 'period' },
  { key: 'counter', label: 'counter' },
  { key: 'note', label: 'note' },
]
const emptyPaths = (): Record<MapFieldKey, string> => ({
  secret: '', issuer: '', label: '', type: '', algorithm: '', digits: '', period: '', counter: '', note: '',
})
const rows = ref<unknown[]>([])
const rowsKind = ref('')
const paths = ref<Record<MapFieldKey, string>>(emptyPaths())
/** 显式行数组点路径（留空走 findFirstArray 探测） */
const rowsPath = ref('')

// 常见键名猜测：按候选顺序扫描首行 keys（大小写不敏感）
const GUESS: Array<{ key: MapFieldKey; candidates: string[] }> = [
  { key: 'secret', candidates: ['secret', 'key'] },
  { key: 'issuer', candidates: ['issuer', 'name', 'service'] },
  { key: 'label', candidates: ['label', 'account', 'username'] },
]
/** 首个对象行的键（sampleKeys：方案推荐匹配 + 猜测预填共用） */
function firstRowKeys(): string[] {
  const row = rows.value.find((r) => r !== null && typeof r === 'object' && !Array.isArray(r))
  return row ? Object.keys(row as Record<string, unknown>) : []
}
function guessPaths(): void {
  const keys = firstRowKeys()
  if (keys.length === 0) return
  const lower = keys.map((k) => k.toLowerCase())
  for (const g of GUESS) {
    const hit = g.candidates.map((c) => keys[lower.indexOf(c)]).find(Boolean)
    if (hit) paths.value[g.key] = hit
  }
}

// ---------- 映射方案（命名保存/推荐复用/删除）：schemesApi 缺省时整区不渲染 ----------
const schemes = ref<ImportScheme[]>([])
const schemeName = ref('')
const schemeSel = ref('')
const sampleKeys = ref<string[]>([])
const recommended = computed(() => matchSchemes(schemes.value, sampleKeys.value))
const otherSchemes = computed(() => {
  const rec = new Set(recommended.value.map((s) => s.id))
  return schemes.value.filter((s) => !rec.has(s.id))
})

/** 进映射页时后台加载方案表；load 失败视为无方案，不阻断映射流程 */
async function refreshSchemes(): Promise<void> {
  if (!props.schemesApi) return
  try {
    schemes.value = normalizeSchemes(await props.schemesApi.load())
  } catch {
    schemes.value = []
  }
}

/** 保存方案：当前映射按输入名存为新方案（id=randomUUID），upsert 同名同 id 覆盖后整体落盘 */
async function saveScheme(): Promise<void> {
  if (!props.schemesApi || busy.value) return
  const mapping = buildMapping()
  if (!mapping) return fail(new Error('secret 字段的映射路径必填'))
  const name = schemeName.value.trim()
  if (!name) return fail(new Error('请先输入方案名称'))
  try {
    const s: ImportScheme = { id: crypto.randomUUID(), name, mapping, createdAt: Date.now() }
    const rp = rowsPath.value.trim()
    if (rp) s.rowsPath = rp
    const list = upsertScheme(schemes.value, s)
    await props.schemesApi.save(list)
    schemes.value = list
    schemeSel.value = s.id
    msg.value = `方案「${name}」已保存`
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  }
}

/** 应用方案：回填映射路径输入（覆盖预填/当前值）与 rowsPath，未映射字段清空 */
function applyScheme(): void {
  const s = schemes.value.find((x) => x.id === schemeSel.value)
  if (!s) return fail(new Error('请先选择方案'))
  for (const f of FIELDS) paths.value[f.key] = s.mapping[f.key]?.path ?? ''
  rowsPath.value = s.rowsPath ?? ''
}

/** 删除方案：removeScheme 后整体落盘，清选中 */
async function deleteScheme(): Promise<void> {
  const api = props.schemesApi
  if (!api || busy.value || !schemeSel.value) return
  try {
    const list = removeScheme(schemes.value, schemeSel.value)
    await api.save(list)
    schemes.value = list
    schemeSel.value = ''
  } catch (e) {
    fail(e)
  }
}

const report = ref<{ imported: number; replaced: number; skipped: number; failures: ImportResult['failures'] } | null>(null)
const conflictCount = computed(() => conflicts.value.size)

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

function reset(): void {
  step.value = 'idle'
  fileName.value = ''
  fileText.value = ''
  format.value = null
  manual.value = 'auto'
  password.value = ''
  passwordHint.value = ''
  policy.value = 'skip'
  result.value = null
  report.value = null
  rows.value = []
  rowsKind.value = ''
  paths.value = emptyPaths()
  rowsPath.value = ''
}

/** SQLite 文件头（SQLiteDatabase.HEADER_STRING，16 字节） */
const SQLITE_MAGIC = 'SQLite format 3\u0000'

function isSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false
  }
  return true
}

/**
 * 第 1 步：选文件 + 格式嗅探；取消→提示；文本读取失败（二进制经 UTF-8 管道报错）或嗅探失败
 * → 字节入口自动复查 SQLite（见 importFromSqlite auto）；仍未识别 → picked 页手动指定
 */
async function start(): Promise<void> {
  if (busy.value || !props.platform) return
  busy.value = true
  msg.value = ''
  try {
    let picked: { text: string; name: string } | null = null
    let readErr: unknown = null
    try {
      picked = await props.platform.readImportFile()
    } catch (e) {
      readErr = e
    }
    if (!picked) {
      if (readErr === null) {
        msg.value = '已取消'
        msgKind.value = 'hint'
        return
      }
      if (await importFromSqlite(true)) return // 字节入口已接手（picked/confirm+错误已展示）
      throw readErr
    }
    const f = sniffFormat(picked.text)
    if (f === null && (await importFromSqlite(true))) return
    fileText.value = picked.text
    fileName.value = picked.name
    format.value = f
    manual.value = 'auto'
    step.value = 'picked'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 解析 → confirm：失败/空结果留在当前页展示错误，不进确认 */
async function parseAndConfirm(
  parse: () => ImportResult | Promise<ImportResult>,
  opts: { retryPasswordOnNeed?: boolean; emptyGoesBack?: boolean } = {},
): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    const r = await parse()
    if (opts.retryPasswordOnNeed && r.entries.length === 0 && r.failures.some((x) => x.message.includes('需要口令'))) {
      passwordHint.value = '该文件包含口令保护条目，请输入口令后重试'
      step.value = 'password'
      return
    }
    if (opts.emptyGoesBack && r.entries.length === 0 && r.failures.length > 0) {
      fail(new Error(`解析结果为空：${r.failures.length} 行全部失败（如「${r.failures[0]!.message}」），请检查字段映射`))
      return
    }
    result.value = r
    conflicts.value = findConflicts(props.platform!.store.vault.entries, r.entries)
    step.value = 'confirm'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 直接解析族分派表：sniff/手动格式 → parser（async parser 交 parseAndConfirm await） */
const TEXT_PARSERS: Record<DirectFormat, () => ImportResult | Promise<ImportResult>> = {
  uriBatch: () => importUriBatch(fileText.value),
  twoFas: () => importTwoFas(fileText.value),
  bitwarden: () => importBitwarden(fileText.value),
  proton: () => importProton(fileText.value),
  stratum: () => importStratum(fileText.value),
  freeOtp: () => importFreeOtp(fileText.value),
  freeOtpLegacy: () => importFreeOtpLegacy(fileText.value),
  totpAuthenticator: () => importTotpAuthenticator(fileText.value),
  andOtp: () => importAndOtp(fileText.value),
  battleNet: () => importBattleNet(fileText.value),
  duo: () => importDuo(fileText.value),
}

/**
 * SQLite 字节入口：读 bytes → 文件头校验 → openSqlite → sqlite_master 已知表名探测
 * → 对应 rowsToEntries（当前仅 msAuth accounts，无口令）。auto=true（文本嗅探失败后的自动复查）：
 * 能力缺失/取消/头不匹配静默返回 false 由调用方回退原流程；auto=false（手动指定 msAuth/sqlite）：
 * 失败以消息展示。返回 true 表示字节入口已接手流程（picked/confirm 页或已展示错误）。
 */
async function importFromSqlite(auto: boolean): Promise<boolean> {
  const readBytes = props.platform?.readImportFileBytes
  if (!readBytes) {
    if (!auto) fail(new Error('当前端不支持 SQLite 导入'))
    return false
  }
  busy.value = true
  msg.value = ''
  try {
    const picked = await readBytes()
    if (!picked) {
      if (!auto) {
        msg.value = '已取消'
        msgKind.value = 'hint'
      }
      return false
    }
    if (!isSqliteHeader(picked.bytes)) {
      if (!auto) fail(new Error('无法识别的 SQLite 数据库（文件头不是 SQLite format 3）'))
      return false
    }
    fileName.value = picked.name
    format.value = 'sqlite'
    manual.value = 'auto'
    step.value = 'picked'
    await parseAndConfirm(async () => {
      const db = await openSqlite(picked.bytes)
      try {
        const names = db.query("SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name))
        const probe = SQLITE_TABLE_PROBES.find((p) => names.includes(p.table))
        if (!probe) throw new Error('无法识别的 SQLite 数据库')
        return probe.toEntries(db.query(`SELECT * FROM "${probe.table}"`))
      } finally {
        db.close()
      }
    })
    return true
  } catch (e) {
    fail(e) // openSqlite/wasm/查询错误：已进 picked(sqlite) 页展示，不让调用方覆写流程
    return true
  } finally {
    busy.value = false
  }
}

/**
 * 第 2 步分派：generic→映射页；aegis 加密→口令页（明文直接解析）；winauth/authy→口令页；
 * totpAuthenticator 分享文件（非 '[' 开头的 Base64 密文）→口令页（明文数组走分派表直接解析）；
 * msAuth/sqlite→字节入口；其余按分派表直接解析；未识别→报错留 picked 页
 */
async function nextFromPicked(): Promise<void> {
  if (busy.value) return
  const f = effectiveFormat.value
  if (f === null) return fail(new Error('无法识别的文件格式，请在下方手动指定格式'))
  if (f === 'generic') {
    const ex = extractGenericRows(fileText.value)
    rows.value = ex.rows
    rowsKind.value = ex.kind
    paths.value = emptyPaths()
    rowsPath.value = ''
    guessPaths()
    sampleKeys.value = firstRowKeys()
    schemeName.value = ''
    schemeSel.value = ''
    void refreshSchemes()
    step.value = 'mapping'
    return
  }
  if (f === 'aegis') {
    // M11：使用 sniffAegis 暴露的 encrypted 标志（'header' 键存在 → 加密）
    const aegis = sniffAegis(fileText.value)
    if (aegis?.encrypted) {
      passwordHint.value = '该 Aegis 备份已加密，请输入导出口令'
      step.value = 'password'
      return
    }
    await parseAndConfirm(() => importAegisPlaintext(fileText.value))
    return
  }
  if (f === 'winauth') {
    passwordHint.value = 'WinAuth 文件可能受口令保护：受保护时必填，未加密可留空'
    step.value = 'password'
    return
  }
  if (f === 'authy') {
    passwordHint.value = 'Authy 令牌可能受口令保护：加密令牌必填，明文可留空'
    step.value = 'password'
    return
  }
  if (f === 'msAuth' || f === 'sqlite') {
    await importFromSqlite(false)
    return
  }
  // totpAuthenticator 条件口令页入口：外部分享文件为 Base64 密文（非明文数组）→ 口令页；
  // 明文 '[' 开头保持下方分派表直接解析
  if (f === 'totpAuthenticator' && !fileText.value.trim().startsWith('[')) {
    passwordHint.value = '输入该分享文件的口令，默认 TotpAuthenticator'
    step.value = 'password'
    return
  }
  await parseAndConfirm(TEXT_PARSERS[f])
}

/** 当前路径输入 → RowMapping（留空字段不带，走 core 默认值）；secret 未填返回 null */
function buildMapping(): RowMapping | null {
  if (!paths.value.secret.trim()) return null
  const mapping: RowMapping = { secret: { path: paths.value.secret } }
  if (paths.value.issuer) mapping.issuer = { path: paths.value.issuer }
  if (paths.value.label) mapping.label = { path: paths.value.label }
  if (paths.value.type) mapping.type = { path: paths.value.type }
  if (paths.value.algorithm) mapping.algorithm = { path: paths.value.algorithm }
  if (paths.value.digits) mapping.digits = { path: paths.value.digits }
  if (paths.value.period) mapping.period = { path: paths.value.period }
  if (paths.value.counter) mapping.counter = { path: paths.value.counter }
  if (paths.value.note) mapping.note = { path: paths.value.note }
  return mapping
}

/** 映射页下一步：组装 RowMapping 并解析；用户填写了 rowsPath 时按显式路径重新探测 */
function nextFromMapping(): void {
  if (busy.value) return
  const mapping = buildMapping()
  if (!mapping) return fail(new Error('secret 字段的映射路径必填'))
  const text = fileText.value
  const rp = rowsPath.value.trim()
  const rowsOverride = rp ? extractGenericRows(text, rp).rows : rows.value
  void parseAndConfirm(() => importGeneric(text, mapping, rowsOverride), { emptyGoesBack: true })
}

/**
 * 口令页下一步（按生效格式分派——手动指定覆盖嗅探，勿用 format.value）：
 * aegis 加密必填口令；authy/winauth 口令可选（缺失且需要时结构级报错回到本页提示）；
 * totpAuthenticator 口令可选（空口令走默认口令 TotpAuthenticator）；其余格式不经口令页，显式报错
 */
async function nextFromPassword(): Promise<void> {
  if (busy.value) return
  const f = effectiveFormat.value
  if (f === 'aegis') {
    if (!password.value) return fail(new Error('请输入口令'))
    await parseAndConfirm(() => importAegisEncrypted(fileText.value, password.value))
    return
  }
  if (f === 'authy') {
    await parseAndConfirm(() => importAuthy(fileText.value, password.value || undefined))
    return
  }
  if (f === 'totpAuthenticator') {
    await parseAndConfirm(() => importTotpAuthenticator(fileText.value, password.value || undefined))
    return
  }
  if (f === 'winauth') {
    await parseAndConfirm(
      () => importWinauth(fileText.value, { password: password.value || undefined, decryptDpapi: props.platform?.decryptDpapi }),
      { retryPasswordOnNeed: !password.value },
    )
    return
  }
  fail(new Error('当前格式不使用口令页，请取消后重新选择'))
}

/** 终步：冲突数按 commit 时的最新 vault 重算，applyImport 按策略落库后进报告页 */
async function commitImport(): Promise<void> {
  const r = result.value
  if (!r || busy.value) return
  busy.value = true
  msg.value = ''
  try {
    const pol = policy.value
    let conflictHit = 0
    await props.platform!.store.commit((v) => {
      const c = findConflicts(v, r.entries)
      conflictHit = c.size
      return applyImport(v, r.entries, pol, c)
    })
    report.value = {
      imported: r.entries.length - (pol === 'merge' ? 0 : conflictHit),
      replaced: pol === 'replace' ? conflictHit : 0,
      skipped: pol === 'skip' ? conflictHit : 0,
      failures: r.failures,
    }
    step.value = 'report'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 报告页失败逐条：uriBatch 的 index 即原始行号，附原始行文本便于定位（手动指定同样生效） */
function failureLabel(f: { index: number; message: string }): string {
  if (effectiveFormat.value === 'uriBatch') {
    const line = fileText.value.split(/\r?\n/)[f.index]?.trim() ?? ''
    return `第 ${f.index + 1} 行：${line}：${f.message}`
  }
  return `第 ${f.index + 1} 项：${f.message}`
}
</script>

<template>
  <section v-if="platform" class="card import">
    <h2>导入</h2>

    <template v-if="step === 'idle'">
      <div class="actions">
        <button class="import-start" :disabled="busy" @click="start">导入</button>
      </div>
    </template>

    <template v-else-if="step === 'picked'">
      <p class="meta">文件：{{ fileName }} · 识别格式：{{ format ?? '未知' }}</p>
      <p class="hint">{{ effectiveFormat ? FORMAT_LABEL[effectiveFormat] : '无法自动识别，请在下方手动指定格式' }}</p>
      <div class="actions">
        <select v-model="manual" class="format-select" :disabled="busy" aria-label="手动指定格式">
          <option value="auto">自动（{{ format ?? '未识别' }}）</option>
          <option v-for="o in MANUAL_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <button class="import-next" :disabled="busy" @click="nextFromPicked">下一步</button>
        <button :disabled="busy" @click="reset">取消</button>
      </div>
    </template>

    <template v-else-if="step === 'mapping'">
      <p class="meta">字段映射（点路径，如 otp.params.secret）· 共 {{ rows.length }} 行（{{ rowsKind }}）</p>
      <div v-if="rowsKind === 'jsonObjectArray'" class="map-row">
        <label>行数组路径</label>
        <input v-model="rowsPath" data-field="rowsPath" placeholder="留空自动" />
      </div>
      <div v-for="f in FIELDS" :key="f.key" class="map-row">
        <label>{{ f.label }}<span v-if="f.required" class="req">必填</span></label>
        <input v-model="paths[f.key]" :data-field="f.key" :placeholder="f.required ? '必填' : '留空使用默认值'" />
      </div>
      <div v-if="schemesApi" class="schemes">
        <div class="scheme-row">
          <input v-model="schemeName" class="scheme-name" placeholder="方案名称（保存当前映射）" @keydown.enter.prevent="saveScheme" />
          <button class="scheme-save" :disabled="busy" @click="saveScheme">保存方案</button>
        </div>
        <div v-if="schemes.length" class="scheme-row">
          <select v-model="schemeSel" class="scheme-select">
            <option value="">选择方案…</option>
            <optgroup v-if="recommended.length" label="推荐">
              <option v-for="s in recommended" :key="s.id" :value="s.id">{{ s.name }}</option>
            </optgroup>
            <optgroup v-if="otherSchemes.length" label="其他">
              <option v-for="s in otherSchemes" :key="s.id" :value="s.id">{{ s.name }}</option>
            </optgroup>
          </select>
          <button class="scheme-apply" :disabled="!schemeSel" @click="applyScheme">应用</button>
          <button class="scheme-delete" :disabled="!schemeSel || busy" @click="deleteScheme">删除</button>
        </div>
      </div>
      <div class="actions">
        <button class="prefill" :disabled="busy" @click="guessPaths">使用预填</button>
        <button class="import-next" :disabled="busy" @click="nextFromMapping">下一步</button>
        <button :disabled="busy" @click="reset">取消</button>
      </div>
    </template>

    <template v-else-if="step === 'password'">
      <p class="meta">{{ passwordHint }}</p>
      <input v-model="password" type="password" class="import-password" placeholder="文件口令" autocomplete="off" @keydown.enter="nextFromPassword" />
      <div class="actions">
        <button class="import-next" :disabled="busy" @click="nextFromPassword">下一步</button>
        <button :disabled="busy" @click="reset">取消</button>
      </div>
    </template>

    <template v-else-if="step === 'confirm'">
      <p class="meta">解析出 {{ result?.entries.length ?? 0 }} 条，解析失败 {{ result?.failures.length ?? 0 }} 条</p>
      <p class="meta">与现有条目冲突：{{ conflictCount }} 条</p>
      <div class="policies">
        <label><input v-model="policy" type="radio" name="import-policy" value="skip" /> 跳过冲突条目</label>
        <label><input v-model="policy" type="radio" name="import-policy" value="replace" /> 覆盖现有条目</label>
        <label><input v-model="policy" type="radio" name="import-policy" value="merge" /> 保留两者（并存）</label>
      </div>
      <div class="actions">
        <button class="import-commit" :disabled="busy" @click="commitImport">确认导入</button>
        <button :disabled="busy" @click="reset">取消</button>
      </div>
    </template>

    <template v-else-if="step === 'report' && report">
      <p class="ok">成功落库 {{ report.imported }} 条</p>
      <p v-if="report.skipped" class="meta">跳过 {{ report.skipped }} 条（与现有条目冲突）</p>
      <p v-if="report.replaced" class="meta">覆盖 {{ report.replaced }} 条（与现有条目冲突）</p>
      <div v-if="report.failures.length">
        <p class="meta">失败 {{ report.failures.length }} 条：</p>
        <ul class="failures">
          <li v-for="(f, i) in report.failures" :key="i">{{ failureLabel(f) }}</li>
        </ul>
      </div>
      <div class="actions">
        <button class="import-done" :disabled="busy" @click="reset">完成</button>
      </div>
    </template>

    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
.card { border: 1px solid rgba(128,128,128,.4); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: 15px; margin: 0; }
.meta { font-size: 13px; margin: 0; }
.hint { font-size: 12px; opacity: .65; margin: 0; }
.req { margin-left: 4px; font-size: 11px; color: #d9534f; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.actions .format-select { min-width: 0; flex: 1; max-width: 320px; }
.map-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.map-row label { width: 90px; flex: none; }
.map-row input { flex: 1; }
.schemes { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed rgba(128,128,128,.3); padding-top: 8px; }
.scheme-row { display: flex; gap: 8px; }
.scheme-row input, .scheme-row select { flex: 1; min-width: 0; }
.policies { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; }
.policies label { display: flex; align-items: center; gap: 4px; }
.failures { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; font-size: 12px; color: #d9534f; }
.ok { color: #2e7d32; font-size: 13px; margin: 0; }
.err { color: #d9534f; font-size: 13px; }
</style>
