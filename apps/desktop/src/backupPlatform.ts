/**
 * desktop 备份平台工厂（P4 自 App.vue 抽出，纯搬移行为不变；plan16 T9 源化形状）：
 * - createBackupPlatform：BackupCard 全部成员——createBackup=全部启用本地源按各自 retention 落盘
 *   并返回中文摘要；本地源经 listLocalSources/saveLocalSource/removeLocalSource 增删改（AppData
 *   backupSources 键）；备份/恢复按 (sourceId, name) 定位来源目录；旧 backupMode/getBackupDir/
 *   setBackupDir 随源模型删除（retention 进每源，目录=每源 dir，迁移见 runLegacyMigrations）；
 * - createImportSchemesApi：直读写 adapter 的 SCHEMES_KEY（本地 AppData JSON）；
 *   load 容错：坏 JSON → 空表；adapter 未就绪 load 返回 [] / save 中文报错。
 * deps 以 getStore/getAdapter/tr 注入：store/adapter 在壳层 onMounted 就绪后赋值（闭包实时读取，
 * 旧单页仅在 store 就绪后渲染，不会读到 null 的生产路径不因抽工厂改变）；tr 供对话框过滤器
 * 调用时取词（i18n 随 store 就绪装入，而平台方法均在其后调用）。
 */
import {
  backupFileName, base64ToBytes, createBackupEnvelope, loadSources, normalizeSchemes, openBackupEnvelope,
  saveSources, SCHEMES_KEY, sha256Hex,
  type BackupSource, type ImportScheme, type StorageAdapter, type Vault,
} from '@totp/core'
import type { BackupPlatform, ImportSchemesApi, LocalSourceView, VueStore } from '@totp/ui'
import {
  createBackupToSources, listBackupsFromSources, pickBackupDirOs, pickBackupOpenOs, pickBackupSaveOs,
  readBackupByName, readBackupFileOs, writeBackupFileOs, writeBytesFileOs, writeTextFileOs,
  type DialogFilterSpec, type PickedOsFile,
} from './backupService'
import { decryptDpapiOs, pickImportFileOs, readImportFileBytesOs, readImportFileOs } from './importService'
import {
  loadBackupPrefs, persistBackupPrefs, readAutoStatusText, writeLastBackupHash, BACKUP_AUTO_STATUS_KEY,
} from './desktopPrefs'
import { kdfProfileOf, requireAdapter, requireStore } from './storeAccess'

/** A3 导入扩展名单点(与 src-tauri/src/dialog_grants.rs 白名单镜像互验;不带点形态供 DialogFilterSpec) */
export const IMPORT_TEXT_EXTS = ['json', 'jsonl', 'wauth', 'xml', 'txt', 'aegis'] as const
export const IMPORT_BINARY_EXTS = ['db', 'sqlitedb', 'sqlite', 'zip'] as const

export interface BackupPlatformDeps {
  /** store 浅包装实时读取（未就绪 null → 平台方法「数据尚未就绪」中文报错） */
  getStore(): VueStore | null
  /** adapter 实时读取（onMounted createTauriFs 后赋值） */
  getAdapter(): StorageAdapter | null
  /** 壳层取词（对话框过滤器名调用时取词，随 locale 联动） */
  tr(key: string, params?: Record<string, unknown>): string
}

/** core 本地源 → ui LocalSourceView（BackupCard 源列表区渲染/编辑用） */
export function toLocalViews(list: BackupSource[]): LocalSourceView[] {
  return list
    .filter((s) => s.kind === 'local')
    .map(({ id, name, dir, retention, enabled }) => ({ id, name, dir: dir ?? null, retention, enabled }))
}

/** 直读写 adapter 的 SCHEMES_KEY（本地 AppData JSON）；load 容错：坏 JSON → 空表 */
export function createImportSchemesApi(deps: Pick<BackupPlatformDeps, 'getAdapter'>): ImportSchemesApi {
  return {
    async load(): Promise<ImportScheme[]> {
      const adapter = deps.getAdapter()
      if (!adapter) return []
      try {
        const raw = await adapter.get(SCHEMES_KEY)
        return raw ? normalizeSchemes(JSON.parse(raw)) : []
      } catch {
        return []
      }
    },
    async save(list: ImportScheme[]): Promise<void> {
      const adapter = requireAdapter(deps.getAdapter)
      await adapter.set(SCHEMES_KEY, JSON.stringify(list))
    },
  }
}

export function createBackupPlatform(deps: BackupPlatformDeps): BackupPlatform {
  const { tr } = deps

  /** 全部源列表（云源+本地源；各消费方按 kind 过滤） */
  async function loadAllSources(): Promise<BackupSource[]> {
    return loadSources(requireAdapter(deps.getAdapter))
  }

  /** store 整体替换（恢复确认覆盖后由 BackupCard 调用，绑定 store.replaceAllOp） */
  async function replaceAllOps(v: Vault): Promise<void> {
    await requireStore(deps.getStore).replaceAllOp(v)
  }

  /** envelope 文本 → 解密出明文 vault JSON（口令错误/文件损坏由 openBackupEnvelope 抛错，卡片统一展示） */
  async function openBackupText(text: string, password: string): Promise<string> {
    return openBackupEnvelope(JSON.parse(text), password)
  }

  // 文件对话框过滤器名（D2 抽串）：i18n 随 store 就绪装入，而平台方法均在其后调用——改为工厂函数调用时取词
  const backupFileFilters = (): DialogFilterSpec[] => [{ name: tr('desktop.filterBackup'), extensions: ['totpbackup'] }]
  // 文本导出（批① §2.3）对话框过滤器：otpauth 文本落 .txt、Aegis 导出落 .json
  const textFileFilters = (): DialogFilterSpec[] => [{ name: tr('desktop.filterExport'), extensions: ['json', 'txt'] }]
  // 图片导出（批① §2.5 二维码拼版）对话框过滤器：拼版 PNG 落 .png
  const imageFileFilters = (): DialogFilterSpec[] => [{ name: tr('desktop.filterImage'), extensions: ['png'] }]
  // 导入对话框过滤器:A3 单点化——文本组+二进制组与 Rust dialog_grants.rs 的
  // IMPORT_TEXT_EXTENSIONS/IMPORT_BINARY_EXTENSIONS 集合互验(见 backupPlatform.test.ts 镜像用例),
  // 防三端漂移(R11 历史漂移:Rust/extension 已含 .jsonl 而 desktop 过滤器缺)。
  // .db 经文本读取报 UTF-8 错时由 ImportCard 转字节入口复查(见 read_import_file_bytes_os);AP .zip 走字节通道
  const importFileFilters = (): DialogFilterSpec[] => [
    { name: tr('desktop.filterImport'), extensions: [...IMPORT_TEXT_EXTS, ...IMPORT_BINARY_EXTS] },
  ]

  // 最后一次导入选择的 Rust 对话框结果（F4：path+token 成对缓存）：SQLite 字节入口复用，避免同一文件二次弹窗
  let lastImportPick: PickedOsFile | null = null

  return {
    createBackup: async (vaultJson, password) => {
      // 审查 I8：按结构化结果如实提示；仅全部启用源成功才记录 lastBackupHash——
      // 部分失败推进基线会让自动通道按 unchanged 跳过后续重试（静默停摆），与自动通道同口径
      const r = await createBackupToSources(await loadAllSources(), vaultJson, password, kdfProfileOf(deps.getStore))
      if (r.outcome === 'ok') {
        try {
          writeLastBackupHash(await sha256Hex(new TextEncoder().encode(vaultJson)))
        } catch { /* hash 记录失败不影响备份本身 */ }
      }
      return r.summary
    },
    listLocalSources: async () => toLocalViews(await loadAllSources()),
    async saveLocalSource(v) {
      const adapter = requireAdapter(deps.getAdapter)
      const source: BackupSource = { ...v, kind: 'local', role: 'replica' }
      const list = await loadSources(adapter)
      const idx = list.findIndex((s) => s.id === v.id)
      if (idx >= 0) list[idx] = source
      else list.push(source)
      await saveSources(adapter, list)
    },
    async removeLocalSource(id) {
      const adapter = requireAdapter(deps.getAdapter)
      await saveSources(adapter, (await loadSources(adapter)).filter((s) => s.id !== id))
    },
    async exportToFile(vaultJson, password) {
      // F4：save 对话框改由 Rust 打开并登记保存位置父目录（取消则直接 false），
      // 再做 Argon2id 加密写文件，省一次白跑的 KDF（档位随备份设置）
      const picked = await pickBackupSaveOs(backupFileName(new Date()), backupFileFilters())
      if (!picked) return false
      const envelope = await createBackupEnvelope(vaultJson, password, kdfProfileOf(deps.getStore))
      await writeBackupFileOs(picked, envelope)
      return true
    },
    // 文本导出（批① §2.3）：save 对话框（Rust 登记授权）+ OS 白名单写；取消=不写盘返回 false
    async saveTextFile(name, content) {
      const picked = await pickBackupSaveOs(name, textFileFilters())
      if (!picked) return false
      await writeTextFileOs(picked, content)
      return true
    },
    // 图片导出（批① §2.5 多选二维码拼版 PNG）：save 对话框（Rust 登记授权）+ OS 白名单字节写
    // （dataUrl 解 base64 为原始字节，不经文本管道）；取消=不写盘返回 false
    async saveImageFile(name, dataUrl) {
      const picked = await pickBackupSaveOs(name, imageFileFilters())
      if (!picked) return false
      await writeBytesFileOs(picked, base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1)))
      return true
    },
    async restoreFromPicker(password) {
      // F4：open 对话框由 Rust 打开（path+dirToken 成对返回），遏制基准=后端登记父目录
      const picked = await pickBackupOpenOs(backupFileFilters())
      if (!picked) return null
      return { json: await openBackupText(await readBackupFileOs(picked), password) }
    },
    listBackups: async () => listBackupsFromSources(await loadAllSources()),
    async restoreByName(sourceId, name, password) {
      return { json: await openBackupText(await readBackupByName(sourceId, name, await loadAllSources()), password) }
    },
    getAutoPrefs: () => loadBackupPrefs(),
    setAutoPrefs: (p) => persistBackupPrefs(p),
    getAutoStatus: async () => readAutoStatusText(BACKUP_AUTO_STATUS_KEY),
    pickBackupDir: async () => {
      // F4：目录选择经 Rust pick_dir_os（canonical 登记 + 跨会话持久化），前端仍只持久化 path
      return pickBackupDirOs()
    },
    replaceAllOp: async (v) => replaceAllOps(v),
    // 备份加密强度档位（plan16 T11.5）：settings 持久化（backupKdfProfile 字段 + commitSettings）
    backupKdfProfile: {
      get: () => kdfProfileOf(deps.getStore),
      set: (p) => {
        const s = requireStore(deps.getStore)
        s.settings.backupKdfProfile = p
        void s.commitSettings()
      },
    },
    async readImportFile() {
      // F4：open 对话框由 Rust 打开（登记父目录返回 token），文本/字节入口共用同一登记结果
      const picked = await pickImportFileOs(importFileFilters())
      if (!picked) return null
      lastImportPick = picked
      return { text: await readImportFileOs(picked), name: picked.path.split(/[\\/]/).pop() ?? picked.path }
    },
    // SQLite 字节入口：复用最近一次选择的登记结果（避免二次弹窗）；无最近选择时补弹对话框
    async readImportFileBytes() {
      const picked = lastImportPick ?? (await pickImportFileOs(importFileFilters()))
      if (!picked) return null
      return { bytes: await readImportFileBytesOs(picked), name: picked.path.split(/[\\/]/).pop() ?? picked.path }
    },
    decryptDpapi: (b64) => decryptDpapiOs(b64),
  }
}
