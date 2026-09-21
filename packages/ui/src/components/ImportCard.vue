<script setup lang="ts">
import {
  SQLITE_TABLE_PROBES, applyImportPlan, dedupeWithinFile, extractGenericRows, importAegisEncrypted,
  importAegisPlaintext, importAndOtp, importAuthenticatorPlus, importAuthy, importBattleNet,
  importBitwarden, importDuo, importFoxauth, importFreeOtp, importFreeOtpLegacy, importGeneric, importProton,
  importStratum, importTotpAuthenticator, importTwoFas, importUriBatch, importWinauth, matchSchemes,
  planImport, normalizeSchemes, removeScheme, sniffAegis, sniffFormat, upsertScheme,
  type ConflictPolicy, type ImportFormat, type ImportPlan, type ImportResult, type ImportScheme,
  type ImportStats, type ParsedEntry, type RowMapping, type SuspectChoice,
} from '@totp/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { openSqlite } from '../sqliteLoader'
import type { VueStore } from '../store'
import MdButton from './md/MdButton.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'
import MdSelect from './md/MdSelect.vue'
import MdTextField from './md/MdTextField.vue'
import type { ImportPlatform, ImportSchemesApi } from './importPlatform'

const { t } = useI18n()

const props = defineProps<{
  /** 平台导入能力（readImportFile + 可选 readImportFileBytes/decryptDpapi + store）；null 时整卡不渲染（popup 不受影响） */
  platform: ImportPlatform | null
  /** 映射方案存取能力（宿主直读写 storage 的 SCHEMES_KEY）；null 时映射页方案区不渲染 */
  schemesApi?: ImportSchemesApi | null
}>()

// 流程状态机：idle → picked →（generic→mapping / aegis 加密与 winauth/authy→password、totpAuthenticator 分享文件→password）→ confirm → report
type Step = 'idle' | 'picked' | 'mapping' | 'password' | 'confirm' | 'report'

// 可分派格式 = sniff 全集 + 非 sniff 判定的补充入口（authy/battleNet/duo 文本、authenticatorPlus zip 字节、msAuth/sqlite 字节）
type ManualFormat = ImportFormat | 'authy' | 'battleNet' | 'duo' | 'authenticatorPlus' | 'msAuth' | 'sqlite'
// 直接解析族（其余格式分别走：generic→映射页、aegis/winauth/authy→口令页、totpAuthenticator 分享文件→条件口令页、
// authenticatorPlus→口令页+字节通道、msAuth/sqlite→字节入口）
type DirectFormat = Exclude<ManualFormat, 'generic' | 'aegis' | 'winauth' | 'authy' | 'authenticatorPlus' | 'msAuth' | 'sqlite'>

const step = ref<Step>('idle')
const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')
const fileName = ref('')
const fileText = ref('')
/** 字节通道缓存：start() 文本管道读失败的二进制文件（AP 加密 zip）经 readImportFileBytes 兜底缓存 */
const fileBytes = ref<Uint8Array | null>(null)
const format = ref<ManualFormat | null>(null)
const manual = ref<'auto' | ManualFormat>('auto')
const password = ref('')
const passwordHint = ref('')
const policy = ref<ConflictPolicy>('skip')
const result = ref<ImportResult | null>(null)
// plan16 四档去重判定树（设计 §4）：confirm 进页时按当前 vault 算一次逐条标注；
// commit 时重算（vault 可能在预览期间被远端/其他窗口改动）
const importPlan = ref<ImportPlan | null>(null)
const inFileMerged = ref(0)
const suspectChoices = ref<Map<number, SuspectChoice>>(new Map())

const FORMAT_LABEL: Record<ManualFormat, string> = {
  aegis: t('importCard.fmtAegis'),
  winauth: t('importCard.fmtWinauth'),
  uriBatch: t('importCard.fmtUriBatch'),
  generic: t('importCard.fmtGeneric'),
  twoFas: t('importCard.fmtTwoFas'),
  bitwarden: t('importCard.fmtBitwarden'),
  proton: t('importCard.fmtProton'),
  stratum: t('importCard.fmtStratum'),
  freeOtp: t('importCard.fmtFreeOtp'),
  freeOtpLegacy: t('importCard.fmtFreeOtpLegacy'),
  totpAuthenticator: t('importCard.fmtTotpAuthenticator'),
  andOtp: t('importCard.fmtAndOtp'),
  foxauth: t('importCard.fmtFoxauth'),
  authenticatorPlus: t('importCard.fmtAuthenticatorPlus'),
  authy: t('importCard.fmtAuthy'),
  battleNet: t('importCard.fmtBattleNet'),
  duo: t('importCard.fmtDuo'),
  msAuth: t('importCard.fmtMsAuth'),
  sqlite: t('importCard.fmtSqlite'),
}

/** picked 页手动指定格式下拉（嗅探失败/误判时自选；freeOtpPlus 与 freeOtp 同 parser 不单列） */
const MANUAL_OPTIONS: Array<{ value: ManualFormat; label: string }> = [
  { value: 'uriBatch', label: t('importCard.manualUriBatch') },
  { value: 'aegis', label: t('importCard.manualAegis') },
  { value: 'winauth', label: t('importCard.manualWinauth') },
  { value: 'generic', label: t('importCard.manualGeneric') },
  { value: 'twoFas', label: t('importCard.manualTwoFas') },
  { value: 'bitwarden', label: t('importCard.manualBitwarden') },
  { value: 'proton', label: t('importCard.manualProton') },
  { value: 'stratum', label: t('importCard.manualStratum') },
  { value: 'freeOtp', label: t('importCard.manualFreeOtp') },
  { value: 'freeOtpLegacy', label: t('importCard.manualFreeOtpLegacy') },
  { value: 'totpAuthenticator', label: t('importCard.manualTotpAuthenticator') },
  { value: 'andOtp', label: t('importCard.manualAndOtp') },
  { value: 'authenticatorPlus', label: t('importCard.manualAuthenticatorPlus') },
  { value: 'authy', label: t('importCard.manualAuthy') },
  { value: 'battleNet', label: t('importCard.manualBattleNet') },
  { value: 'duo', label: t('importCard.manualDuo') },
  { value: 'msAuth', label: t('importCard.manualMsAuth') },
  { value: 'sqlite', label: t('importCard.manualSqlite') },
]

/** 实际生效格式：手动选择覆盖嗅探结果（auto 时用嗅探值，可能为 null=未识别） */
const effectiveFormat = computed<ManualFormat | null>(() => (manual.value === 'auto' ? format.value : manual.value))

/** 手动指定格式 MdSelect 选项：首项「自动」label 随嗅探结果动态（picked 页可能晚于嗅探渲染） */
const manualOptions = computed<Array<{ value: string; label: string }>>(() => [
  { value: 'auto', label: t('importCard.manualAuto', { format: format.value ?? t('importCard.unrecognized') }) },
  ...MANUAL_OPTIONS,
])
/** 格式下拉回调：MdSelect emit 泛化 string|number，收敛回 manual 的联合类型 */
function onManualSelect(v: string | number): void {
  manual.value = v as 'auto' | ManualFormat
}

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
  if (!mapping) return fail(new Error(t('importCard.mappingSecretRequired')))
  const name = schemeName.value.trim()
  if (!name) return fail(new Error(t('importCard.schemeNameRequired')))
  try {
    const s: ImportScheme = { id: crypto.randomUUID(), name, mapping, createdAt: Date.now() }
    const rp = rowsPath.value.trim()
    if (rp) s.rowsPath = rp
    const list = upsertScheme(schemes.value, s)
    await props.schemesApi.save(list)
    schemes.value = list
    schemeSel.value = s.id
    msg.value = t('importCard.schemeSaved', { name })
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  }
}

/** 应用方案：回填映射路径输入（覆盖预填/当前值）与 rowsPath，未映射字段清空 */
function applyScheme(): void {
  const s = schemes.value.find((x) => x.id === schemeSel.value)
  if (!s) return fail(new Error(t('importCard.schemeNotSelected')))
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

/** 方案下拉 MdSelect 选项：占位空值 + 推荐/其他平铺（原生 optgroup 的归类展示在 listbox 语义中不保留，顺序不变） */
const schemeOptions = computed<Array<{ value: string; label: string }>>(() => [
  { value: '', label: t('importCard.schemePlaceholder') },
  ...recommended.value.map((s) => ({ value: s.id, label: s.name })),
  ...otherSchemes.value.map((s) => ({ value: s.id, label: s.name })),
])
/** 方案下拉回调：id 收敛回 string */
function onSchemeSelect(v: string | number): void {
  schemeSel.value = v as string
}

// ---------- 终步冲突策略：三选一以 MdSegmentedButton 呈现（替代原生 radio，参照 BackupCard F5） ----------
const POLICY_OPTIONS = [
  { value: 'skip', label: t('importCard.policySkip') },
  { value: 'replace', label: t('importCard.policyReplace') },
  { value: 'merge', label: t('importCard.policyMerge') },
]
/** 分段按钮回调：emit 的 string 收敛回 ConflictPolicy */
function onPolicySelect(v: string): void {
  policy.value = v as ConflictPolicy
}

// ---------- suspect（疑似同账户）逐条处理：默认跳过，每条可单独改为新增/覆盖 ----------
const SUSPECT_OPTIONS = [
  { value: 'skip', label: t('importCard.suspectSkip') },
  { value: 'add', label: t('importCard.suspectAdd') },
  { value: 'replace', label: t('importCard.suspectReplace') },
]
/** suspect 行渲染项：incoming 索引 + 导入条目 + 按 targetUuid 定位的现有条目（预览期间 vault 变化可致缺失） */
const suspectItems = computed(() => {
  const plan = importPlan.value
  const r = result.value
  if (!plan || !r) return []
  const items: Array<{ idx: number; entry: ParsedEntry; target: { issuer: string; label: string } | null }> = []
  plan.kinds.forEach((k, i) => {
    if (k !== 'suspect') return
    const uuid = plan.targetUuids[i]
    const t = uuid ? props.platform!.store.vault.entries.find((e) => e.uuid === uuid) : undefined
    items.push({ idx: i, entry: r.entries[i]!, target: t ? { issuer: t.issuer, label: t.label } : null })
  })
  return items
})
/** suspect 分段按钮回调：choices 键=incoming 索引 */
function onSuspectSelect(idx: number, v: string): void {
  suspectChoices.value.set(idx, v as SuspectChoice)
}

// report 命名沿用 core ImportStats 口径（plan16 T10）：identical/suspect*/conflict*/inFileMerged 逐项展示，
// imported = 新增落库（new + suspect add）+ 冲突并存（merge 条目也实际入库）
const report = ref<{
  imported: number; identical: number; suspectSkipped: number; suspectAdded: number; suspectReplaced: number
  conflictSkipped: number; conflictReplaced: number; conflictMerged: number; inFileMerged: number
  failures: ImportResult['failures']
} | null>(null)

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

function reset(): void {
  step.value = 'idle'
  fileName.value = ''
  fileText.value = ''
  fileBytes.value = null
  format.value = null
  manual.value = 'auto'
  password.value = ''
  passwordHint.value = ''
  policy.value = 'skip'
  result.value = null
  importPlan.value = null
  inFileMerged.value = 0
  suspectChoices.value = new Map()
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
        msg.value = t('importCard.canceled')
        msgKind.value = 'hint'
        return
      }
      if (await importFromSqlite(true)) return // 字节入口已接手（picked/confirm+错误已展示）
      // 文本管道读失败的二进制文件（如 Authenticator Plus 加密 zip）：字节通道兜底落到 picked 页，
      // 由用户手动指定格式（zip 无文本嗅探特征，属预期入口）
      const rb = props.platform.readImportFileBytes
      if (rb) {
        try {
          const fb = await rb()
          if (fb) {
            fileBytes.value = fb.bytes
            fileText.value = ''
            fileName.value = fb.name
            format.value = null
            manual.value = 'auto'
            step.value = 'picked'
            return
          }
        } catch {
          // 字节通道也失败：回落到下方原 readErr 展示
        }
      }
      throw readErr
    }
    fileBytes.value = null
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
      passwordHint.value = t('importCard.pwRetryHint')
      step.value = 'password'
      return
    }
    if (opts.emptyGoesBack && r.entries.length === 0 && r.failures.length > 0) {
      fail(new Error(t('importCard.emptyResult', { count: r.failures.length, message: r.failures[0]!.message })))
      return
    }
    // 文件内全字段完全重复行先合并（设计 §4），避免预览计数虚高；合并数在 confirm/report 页展示
    const dedup = dedupeWithinFile(r.entries)
    r.entries = dedup.kept
    inFileMerged.value = dedup.removed
    result.value = r
    // 四档逐条标注按当前 vault 一次算好（identical > suspect > conflict > new，优先级在 core 判定树内）；
    // commit 时会按最新 vault 重算，对齐既有「冲突数按 commit 时最新 vault 重算」语义
    importPlan.value = planImport(props.platform!.store.vault.entries, r.entries)
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
  foxauth: () => importFoxauth(fileText.value),
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
    if (!auto) fail(new Error(t('importCard.sqliteUnsupported')))
    return false
  }
  busy.value = true
  msg.value = ''
  try {
    const picked = await readBytes()
    if (!picked) {
      if (!auto) {
        msg.value = t('importCard.canceled')
        msgKind.value = 'hint'
      }
      return false
    }
    if (!isSqliteHeader(picked.bytes)) {
      if (!auto) fail(new Error(t('importCard.sqliteBadHeader')))
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
        if (!probe) throw new Error(t('importCard.sqliteUnknown'))
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
  if (f === null) return fail(new Error(t('importCard.unrecognizedFile')))
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
    // M11：使用 sniffAegis 暴露的 encrypted 标志（顶层 db 为密文 Base64 字符串 → 加密；明文 vault 同样带空 slots 的 header）
    const aegis = sniffAegis(fileText.value)
    if (aegis?.encrypted) {
      passwordHint.value = t('importCard.aegisPwHint')
      step.value = 'password'
      return
    }
    await parseAndConfirm(() => importAegisPlaintext(fileText.value))
    return
  }
  if (f === 'winauth') {
    passwordHint.value = t('importCard.winauthPwHint')
    step.value = 'password'
    return
  }
  if (f === 'authy') {
    passwordHint.value = t('importCard.authyPwHint')
    step.value = 'password'
    return
  }
  if (f === 'authenticatorPlus') {
    passwordHint.value = t('importCard.apPwHint')
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
    passwordHint.value = t('importCard.totpAuthPwHint')
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
  if (!mapping) return fail(new Error(t('importCard.mappingSecretRequired')))
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
    if (!password.value) return fail(new Error(t('importCard.passphraseRequired')))
    await parseAndConfirm(() => importAegisEncrypted(fileText.value, password.value))
    return
  }
  if (f === 'authy') {
    await parseAndConfirm(() => importAuthy(fileText.value, password.value || undefined))
    return
  }
  if (f === 'authenticatorPlus') {
    // zip 二进制：优先用 start() 字节通道兜底缓存的 bytes，否则走 readImportFileBytes（平台侧复用最近选择，免二次弹窗）
    const readBytes = props.platform?.readImportFileBytes
    if (!fileBytes.value && !readBytes) return fail(new Error(t('importCard.apUnsupported')))
    await parseAndConfirm(async () => {
      let bytes = fileBytes.value
      if (!bytes) {
        const fb = await readBytes!()
        if (!fb) throw new Error(t('importCard.noFilePicked'))
        bytes = fb.bytes
      }
      return importAuthenticatorPlus(bytes, password.value)
    })
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
  fail(new Error(t('importCard.pwPageUnused')))
}

/** 终步：按 commit 时最新 vault 重算判定树（预览期间 vault 可能被远端/其他窗口改动），
 * applyImportPlan 按 plan+suspect 逐条选择+冲突策略落库后进报告页 */
async function commitImport(): Promise<void> {
  const r = result.value
  if (!r || busy.value) return
  busy.value = true
  msg.value = ''
  try {
    const pol = policy.value
    let plan = importPlan.value
    let stats: ImportStats = { added: 0, replaced: 0, suspectSkipped: 0, identical: 0, conflictSkipped: 0, conflictReplaced: 0, conflictMerged: 0 }
    await props.platform!.store.commit((v) => {
      plan = planImport(v, r.entries)
      const res = applyImportPlan(v, r.entries, plan, suspectChoices.value, pol)
      stats = res.stats
      return res.vault
    })
    // suspect 新增/覆盖计数 core 未单列（stats.added 混合 new+suspect add），按重算后的 plan+选择在 UI 侧推导
    let suspectAdded = 0
    let suspectReplaced = 0
    plan!.kinds.forEach((k, i) => {
      if (k !== 'suspect') return
      const c = suspectChoices.value.get(i) ?? 'skip'
      if (c === 'add') suspectAdded++
      else if (c === 'replace') suspectReplaced++
    })
    report.value = {
      imported: stats.added + stats.conflictMerged,
      identical: stats.identical,
      suspectSkipped: stats.suspectSkipped,
      suspectAdded,
      suspectReplaced,
      conflictSkipped: stats.conflictSkipped,
      conflictReplaced: stats.conflictReplaced,
      conflictMerged: stats.conflictMerged,
      inFileMerged: inFileMerged.value,
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
    return t('importCard.failureLine', { index: f.index + 1, line, message: f.message })
  }
  return t('importCard.failureItem', { index: f.index + 1, message: f.message })
}
</script>

<template>
  <section v-if="platform" class="card import">
    <h2>{{ t('importCard.title') }}</h2>
    <!-- idle 态首屏说明：仅 idle 渲染（其余步骤的「冲突」等断言/文案不受污染） -->
    <template v-if="step === 'idle'">
      <p class="meta">{{ t('importCard.idleIntro') }}</p>
      <details class="formats">
        <summary>{{ t('importCard.formatsSummary') }}</summary>
        <ul>
          <li>{{ t('importCard.formatsEncrypted') }}</li>
          <li>{{ t('importCard.formatsApps') }}</li>
          <li>{{ t('importCard.formatsText') }}</li>
        </ul>
      </details>
    </template>

    <template v-if="step === 'idle'">
      <div class="actions">
        <MdButton class="import-start" :disabled="busy" @click="start">{{ t('importCard.startBtn') }}</MdButton>
      </div>
    </template>

    <template v-else-if="step === 'picked'">
      <p class="meta">{{ t('importCard.pickedMeta', { name: fileName, format: format ?? t('importCard.unknown') }) }}</p>
      <p class="hint">{{ effectiveFormat ? FORMAT_LABEL[effectiveFormat] : t('importCard.manualNeeded') }}</p>
      <div class="actions">
        <MdSelect
          :model-value="manual" class="format-select" :label="t('importCard.formatLabel')" :aria-label="t('importCard.formatAria')"
          :disabled="busy" :options="manualOptions" @update:model-value="onManualSelect"
        />
        <MdButton class="import-next" :disabled="busy" @click="nextFromPicked">{{ t('importCard.next') }}</MdButton>
        <MdButton variant="text" :disabled="busy" @click="reset">{{ t('importCard.cancel') }}</MdButton>
      </div>
    </template>

    <template v-else-if="step === 'mapping'">
      <p class="meta">{{ t('importCard.mappingMeta', { count: rows.length, kind: rowsKind }) }}</p>
      <div v-if="rowsKind === 'jsonObjectArray'" class="map-row">
        <MdTextField v-model="rowsPath" class="map-field" data-field="rowsPath" :label="t('importCard.rowsPathLabel')" :placeholder="t('importCard.rowsPathPlaceholder')" />
      </div>
      <div v-for="f in FIELDS" :key="f.key" class="map-row">
        <MdTextField
          v-model="paths[f.key]" class="map-field" :data-field="f.key" :label="f.label"
          :placeholder="f.required ? t('importCard.requiredHint') : t('importCard.defaultHint')"
        />
      </div>
      <div v-if="schemesApi" class="schemes">
        <div class="scheme-row">
          <MdTextField v-model="schemeName" class="scheme-name" :label="t('importCard.schemeNameLabel')" :placeholder="t('importCard.schemeNamePlaceholder')" @keydown.enter.prevent="saveScheme" />
          <MdButton variant="tonal" class="scheme-save" :disabled="busy" @click="saveScheme">{{ t('importCard.saveSchemeBtn') }}</MdButton>
        </div>
        <div v-if="schemes.length" class="scheme-row">
          <MdSelect
            :model-value="schemeSel" class="scheme-select" :label="t('importCard.schemeLabel')" :aria-label="t('importCard.schemeLabel')"
            :options="schemeOptions" @update:model-value="onSchemeSelect"
          />
          <MdButton variant="tonal" class="scheme-apply" :disabled="!schemeSel" @click="applyScheme">{{ t('importCard.applyBtn') }}</MdButton>
          <MdButton danger class="scheme-delete" :disabled="!schemeSel || busy" @click="deleteScheme">{{ t('importCard.deleteBtn') }}</MdButton>
        </div>
      </div>
      <div class="actions">
        <MdButton variant="text" class="prefill" :disabled="busy" @click="guessPaths">{{ t('importCard.prefillBtn') }}</MdButton>
        <MdButton class="import-next" :disabled="busy" @click="nextFromMapping">{{ t('importCard.next') }}</MdButton>
        <MdButton variant="text" :disabled="busy" @click="reset">{{ t('importCard.cancel') }}</MdButton>
      </div>
    </template>

    <template v-else-if="step === 'password'">
      <p class="meta">{{ passwordHint }}</p>
      <MdTextField
        v-model="password" type="password" class="import-password" :label="t('importCard.pwLabel')" :placeholder="t('importCard.pwPlaceholder')"
        autocomplete="off" @keydown.enter="nextFromPassword"
      />
      <div class="actions">
        <MdButton class="import-next" :disabled="busy" @click="nextFromPassword">{{ t('importCard.next') }}</MdButton>
        <MdButton variant="text" :disabled="busy" @click="reset">{{ t('importCard.cancel') }}</MdButton>
      </div>
    </template>

    <template v-else-if="step === 'confirm'">
      <p class="meta">{{ t('importCard.confirmMeta', { parsed: result?.entries.length ?? 0, failed: result?.failures.length ?? 0 }) }}</p>
      <p v-if="inFileMerged" class="meta">{{ t('importCard.inFileMerged', { count: inFileMerged }) }}</p>
      <p class="meta">
        {{ t('importCard.confirmCounts', {
          added: importPlan?.counts.new ?? 0,
          identical: importPlan?.counts.identical ?? 0,
          suspect: importPlan?.counts.suspect ?? 0,
          conflict: importPlan?.counts.conflict ?? 0,
        }) }}
      </p>
      <div v-if="suspectItems.length" class="suspects">
        <p class="meta">{{ t('importCard.suspectIntro') }}</p>
        <div v-for="s in suspectItems" :key="s.idx" class="suspect-row">
          <span class="suspect-line">
            {{ t('importCard.suspectLine', {
              incoming: (s.entry.issuer || t('importCard.noIssuer')) + '/' + (s.entry.label || t('importCard.noLabel')),
              existing: s.target ? `${s.target.issuer}/${s.target.label}` : t('importCard.targetGone'),
            }) }}
          </span>
          <MdSegmentedButton
            :model-value="suspectChoices.get(s.idx) ?? 'skip'" :options="SUSPECT_OPTIONS"
            :aria-label="t('importCard.suspectAria', { target: `${s.entry.issuer}/${s.entry.label}` })" @update:model-value="onSuspectSelect(s.idx, $event)"
          />
        </div>
      </div>
      <div class="policies">
        <MdSegmentedButton
          :aria-label="t('importCard.policyAria')" :model-value="policy" :options="POLICY_OPTIONS"
          @update:model-value="onPolicySelect"
        />
      </div>
      <div class="actions">
        <MdButton class="import-commit" :disabled="busy" @click="commitImport">{{ t('importCard.commitBtn') }}</MdButton>
        <MdButton variant="text" :disabled="busy" @click="reset">{{ t('importCard.cancel') }}</MdButton>
      </div>
    </template>

    <template v-else-if="step === 'report' && report">
      <p class="ok">{{ t('importCard.reportImported', { count: report.imported }) }}</p>
      <p v-if="report.inFileMerged" class="meta">{{ t('importCard.inFileMerged', { count: report.inFileMerged }) }}</p>
      <p v-if="report.identical" class="meta">{{ t('importCard.reportIdentical', { count: report.identical }) }}</p>
      <p v-if="report.suspectSkipped" class="meta">{{ t('importCard.reportSuspectSkipped', { count: report.suspectSkipped }) }}</p>
      <p v-if="report.suspectAdded" class="meta">{{ t('importCard.reportSuspectAdded', { count: report.suspectAdded }) }}</p>
      <p v-if="report.suspectReplaced" class="meta">{{ t('importCard.reportSuspectReplaced', { count: report.suspectReplaced }) }}</p>
      <p v-if="report.conflictSkipped" class="meta">{{ t('importCard.reportConflictSkipped', { count: report.conflictSkipped }) }}</p>
      <p v-if="report.conflictReplaced" class="meta">{{ t('importCard.reportConflictReplaced', { count: report.conflictReplaced }) }}</p>
      <p v-if="report.conflictMerged" class="meta">{{ t('importCard.reportConflictMerged', { count: report.conflictMerged }) }}</p>
      <div v-if="report.failures.length">
        <p class="meta">{{ t('importCard.reportFailures', { count: report.failures.length }) }}</p>
        <ul class="failures">
          <li v-for="(f, i) in report.failures" :key="i">{{ failureLabel(f) }}</li>
        </ul>
      </div>
      <div class="actions">
        <MdButton class="import-done" :disabled="busy" @click="reset">{{ t('importCard.doneBtn') }}</MdButton>
      </div>
    </template>

    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供(M3 双描边裁定,2026-09-16 审查 X1);本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.meta { font-size: var(--md-sys-typescale-body-medium); margin: 0; }
.hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.formats { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
.formats summary { cursor: pointer; }
.formats ul { margin: 4px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.actions .format-select { min-width: 0; flex: 1; max-width: 320px; }
.map-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.map-row .map-field { flex: 1; }
.schemes { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--md-sys-color-outline-variant); padding-top: 8px; }
.scheme-row { display: flex; gap: 8px; align-items: center; }
.scheme-row .md-text-field, .scheme-row .md-select { flex: 1; min-width: 0; }
.policies { display: flex; font-size: var(--md-sys-typescale-body-medium); }
/* 三段标签较长，confirm 步内紧凑渲染：缩段内 padding 防溢出（本卡 scoped，不改 MdSegmentedButton） */
.policies :deep(.md-seg__item), .suspect-row :deep(.md-seg__item) { padding: 0 12px; }
/* suspect 逐条确认区：一行「导入 X → 现有 Y」+ 三选分段按钮，行内换行防窄卡溢出 */
.suspects { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--md-sys-color-outline-variant); padding-top: 8px; }
.suspect-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--md-sys-typescale-body-small); }
.suspect-line { flex: 1; min-width: 200px; }
.failures { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-error); }
.ok { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); margin: 0; }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
</style>
