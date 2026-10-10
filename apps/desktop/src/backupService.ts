import { invoke } from '@tauri-apps/api/core'
import { mkdir, readDir, readTextFile, rename, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import {
  backupFileName, conflictBackupFileName, createBackupEnvelope, DEFAULT_KDF_PROFILE, loadSources, OVERWRITE_NAME,
  READABLE_BACKUP_RE, saveSources, selectBackupsToKeep,
  type BackupEnvelope, type BackupSource, type KdfProfile, type Retention, type StorageAdapter,
} from '@totp/core'

const dir = 'backups'

/** F4：Rust 对话框（pick_*_os）返回的不透明授权句柄——token=后端登记目录，
 *  path=选中路径原样。文件命令不再接受前端自证的 allowed_dir */
export interface PickedOsFile {
  path: string
  dirToken: string
}

/** 与 Rust DialogFilter 对齐的系统对话框过滤器 */
export interface DialogFilterSpec {
  name: string
  extensions: string[]
}

/** 备份源仅持久化目录路径字符串；每会话经 dir_token_os 重取授权句柄
 *  （后端仅对对话框授权过/启动装载的目录发放，未登记目录拒绝） */
async function tokenForDir(dirPath: string): Promise<string> {
  return invoke<string>('dir_token_os', { dir: dirPath })
}

/** 目录选择（备份源，F4）：对话框改由 Rust 打开并登记授权，前端只拿 path 展示/持久化 */
export async function pickBackupDirOs(): Promise<string | null> {
  const picked = await invoke<PickedOsFile | null>('pick_dir_os')
  return picked?.path ?? null
}

/** 文件保存（备份导出，F4）：Rust save 对话框 → 登记保存位置父目录 → {token, path} */
export async function pickBackupSaveOs(defaultName: string, filters: DialogFilterSpec[]): Promise<PickedOsFile | null> {
  return invoke<PickedOsFile | null>('pick_save_file_os', { defaultName, filters })
}

/** 文件打开（备份恢复，F4）：Rust open 对话框 → 登记所选文件父目录 → {token, path} */
export async function pickBackupOpenOs(filters: DialogFilterSpec[]): Promise<PickedOsFile | null> {
  return invoke<PickedOsFile | null>('pick_open_file_os', { filters })
}

/** 每源备份输入（plan16 T14）：ui LocalSourceView / core BackupSource 的公共结构子集，
 *  宿主直接传 core loadSources 结果（结构兼容，本模块不感知 kind/objectPath；dir 可选与 BackupSource 对齐） */
export interface BackupSourceInput {
  id: string
  /** 摘要中展示的用户可见别名 */
  name: string
  /** 备份目录绝对路径；null/缺省=默认（AppData/backups） */
  dir?: string | null
  retention: Retention
  enabled: boolean
}

/** 用户自选备份目录（D4）的路径拼接：分隔符按 dir 自身风格判定——含 \ 用 \ 连接
 *  （Windows 目录选择器返回 C:\... 天然含反斜杠）；否则（POSIX 含 / 或无分隔符的相对名）用 / 连接 */
export function joinBackupPath(dirPath: string, name: string): string {
  const sep = dirPath.includes('\\') ? '\\' : '/'
  return dirPath.endsWith(sep) ? `${dirPath}${name}` : `${dirPath}${sep}${name}`
}

/** 两通道统一列表过滤口径（R10 对齐）：读侧 READABLE_BACKUP_RE 单一口径——聚合列表与滚动
 *  删除候选同源。原先 os 分支依赖 Rust 白名单（vault-/conflict- 前缀+.totpbackup 后缀、中段
 *  不限），默认分支按 READABLE_BACKUP_RE 过滤，两分支口径已漂移（原 81-85 注释自认）；收敛后
 *  os 名单在此再过滤，宽中段名（如 vault-notes/conflict-Weird_Name）不再混入聚合列表 */
function filterReadableNames(names: string[]): string[] {
  return names.filter((n) => READABLE_BACKUP_RE.test(n))
}

/** 备份目录访问策略（R10）：「os 授权目录 vs AppData 默认目录」双通道收敛为四操作单接口
 *  （写/列/读/删）。目录访问方式是稳定变化点：新增操作只写一次，两分支行为在接口内单点对齐 */
interface BackupDirSink {
  /** 写入备份文本：默认通道 mkdir+tmp+rename 原子写；os 通道 write_text_file_os 直写
   *  （无 rename 原语；目录为用户显式选择已存在，无需 mkdir） */
  write(name: string, contents: string): Promise<void>
  /** 备份文件名列表：两通道统一 READABLE_BACKUP_RE 口径（filterReadableNames 单点） */
  listNames(): Promise<string[]>
  /** 读取备份文本 */
  readText(name: string): Promise<string>
  /** 删除单个备份文件（滚动删除用） */
  remove(name: string): Promise<void>
}

/** os 授权目录 sink：每操作经 tokenForDir 现取会话句柄（F4：token 不持久化，后端仅对
 *  对话框授权过/启动装载的目录发放，未登记目录拒绝） */
function osDirSink(dirPath: string): BackupDirSink {
  return {
    async write(name, contents) {
      const dirToken = await tokenForDir(dirPath)
      await invoke('write_text_file_os', { path: joinBackupPath(dirPath, name), contents, dirToken })
    },
    async listNames() {
      const dirToken = await tokenForDir(dirPath)
      // Rust 端已白名单过滤+升序；TS 侧再过 READABLE_BACKUP_RE 与默认分支单点对齐（R10）
      return filterReadableNames(await invoke<string[]>('list_backup_files_os', { dirToken }))
    },
    async readText(name) {
      const dirToken = await tokenForDir(dirPath)
      return invoke<string>('read_text_file_os', { path: joinBackupPath(dirPath, name), dirToken })
    },
    async remove(name) {
      const dirToken = await tokenForDir(dirPath)
      await invoke('remove_backup_file_os', { path: joinBackupPath(dirPath, name), dirToken })
    },
  }
}

/** AppData/backups 默认目录 sink（plugin-fs） */
function appDataSink(): BackupDirSink {
  return {
    async write(name, contents) {
      // backups/ 子目录可能尚不存在（首次备份），ensure 后再原子写
      await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true })
      const tmp = `${name}.tmp`
      await writeTextFile(`${dir}/${tmp}`, contents, { baseDir: BaseDirectory.AppData })
      // plugin-fs v2 RenameOptions 仅支持 oldPathBaseDir/newPathBaseDir（无 baseDir 字段）
      await rename(`${dir}/${tmp}`, `${dir}/${name}`, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
    },
    async listNames() {
      const names = (await readDir(dir, { baseDir: BaseDirectory.AppData })).map((e) => e.name)
      return filterReadableNames(names)
    },
    async readText(name) {
      return readTextFile(`${dir}/${name}`, { baseDir: BaseDirectory.AppData })
    },
    async remove(name) {
      await invoke('remove_backup_file', { name })
    },
  }
}

/** dir=null=默认 AppData/backups，否则=用户自选授权目录（每源 dir 字符串仅持久化路径） */
function sinkFor(dirOverride: string | null): BackupDirSink {
  return dirOverride ? osDirSink(dirOverride) : appDataSink()
}

/** 单源落盘（plan16 前为 createBackupToDir 本体）：overwrite=固定名覆盖；keep=时间戳名+滚动删除。
 *  信封文本由调用方生成传入（多源共享同一份密文，Argon2id 只跑一次）。
 *  写/列/删三操作全部面向 BackupDirSink（R10）：两通道仅剩 sink 选择差异，滚动删除逻辑只写一次 */
async function writeSourceBackup(dirOverride: string | null, contents: string, retention: Retention): Promise<'created' | 'overwritten'> {
  const sink = sinkFor(dirOverride)
  if (retention.type === 'overwrite') {
    await sink.write(OVERWRITE_NAME, contents)
    return 'overwritten'
  }
  const name = backupFileName(new Date())
  await sink.write(name, contents)
  // 滚动删除：列表与删除走同一 sink（授权同源、名单口径同 filterReadableNames；Rust 端另有白名单守护）
  const stale = selectBackupsToKeep(await sink.listNames(), retention.n, retention.days ?? 0)
  for (const staleName of stale) await sink.remove(staleName)
  return 'created'
}

/** createBackupToSources 结构化结果（审查 I8）：诚实反映每源成败，调用方据此决定
 *  基线推进/状态记录（此前恒 resolve 字符串，失败被吞且详情丢失，自动通道误推进基线静默停摆） */
export interface BackupSourcesResult {
  /** 'ok'=全部启用源成功；'partial'=部分失败；'failed'=全部失败；'empty'=无启用源 */
  outcome: 'ok' | 'partial' | 'failed' | 'empty'
  /** 成功源数 */
  okCount: number
  /** 失败源明细（source=显示名，error=异常消息；此前被 catch 吞掉的错误详情） */
  failed: Array<{ source: string; error: string }>
  /** 本次实际备份的 vault JSON 快照（审查 M3：自动通道以落盘内容计基线 hash，
   *  消除「先算 hash 后备份」窗口内 vault 再变导致基线新于落盘内容的错位） */
  vaultJson: string
  /** 中文摘要（文案与旧版逐字一致，手动备份卡直接展示；自动通道 recordStatus 复用） */
  summary: string
}

/**
 * 每源备份（plan16 T14）：对全部启用源逐一落盘（各按其 retention），返回诚实反映成败的结构化结果。
 * envelope 按 profile 档位一次生成、多目录复用（同 (vaultJson, password, profile) 密文可多目录存放）；
 * 单源失败（写盘/滚动删除异常）不阻断其余源，计入 failed 明细（含错误消息）；无启用源返回 empty。
 */
export async function createBackupToSources(sources: BackupSourceInput[], vaultJson: string, password: string, profile: KdfProfile = DEFAULT_KDF_PROFILE): Promise<BackupSourcesResult> {
  const enabled = sources.filter((s) => s.enabled)
  if (enabled.length === 0) return { outcome: 'empty', okCount: 0, failed: [], vaultJson, summary: '未配置启用的备份目录' }
  const contents = JSON.stringify(await createBackupEnvelope(vaultJson, password, profile), null, 2)
  const ok: string[] = []
  const failed: Array<{ source: string; error: string }> = []
  for (const s of enabled) {
    try {
      await writeSourceBackup(s.dir ?? null, contents, s.retention)
      ok.push(s.name)
    } catch (e) {
      failed.push({ source: s.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (failed.length === 0) {
    return { outcome: 'ok', okCount: ok.length, failed, vaultJson, summary: `已备份到 ${ok.length} 个目录（${ok.join('、')}）` }
  }
  const failedNames = failed.map((f) => f.source).join('、')
  if (ok.length === 0) {
    return { outcome: 'failed', okCount: 0, failed, vaultJson, summary: `备份失败：${failedNames}` }
  }
  return { outcome: 'partial', okCount: ok.length, failed, vaultJson, summary: `已备份到 ${ok.length} 个目录（${ok.join('、')}）；失败：${failedNames}` }
}

/** 云同步冲突副本：本地 vault JSON 字节写 backups/conflict-{ts}.totpbackup（不参与滚动删除），返回文件名。
 *  多源场景带 sourceId 区分来源（conflict-{sourceId}-{ts}.totpbackup，命名走 core
 *  conflictBackupFileName 单点，R14）；缺省保持历史名。恒写默认 backups 目录（源模型后无单一
 *  「自选目录」，历史 dirOverride 参数已随唯一非空调用方消失而删除） */
export async function saveConflictBackupToDir(bytes: Uint8Array, sourceId?: string): Promise<string> {
  const name = conflictBackupFileName(new Date(), sourceId)
  const contents = new TextDecoder().decode(bytes)
  await appDataSink().write(name, contents)
  return name
}

/** 聚合全部本地源的备份文件列表（plan16 T14）：逐源列目录（单源失败跳过不影响其余），过滤
 *  .totpbackup 后标注 sourceId，按文件名倒序=新在前（时间戳名全局字典序可比；码点比较跨 locale 确定） */
export async function listBackupsFromSources(sources: BackupSourceInput[]): Promise<Array<{ sourceId: string; name: string }>> {
  const out: Array<{ sourceId: string; name: string }> = []
  for (const s of sources) {
    try {
      const names = await sinkFor(s.dir ?? null).listNames()
      for (const n of names) if (n.endsWith('.totpbackup')) out.push({ sourceId: s.id, name: n })
    } catch { /* 单源列表失败（目录被移除等）：跳过该源，其余照常展示 */ }
  }
  return out.sort((x, y) => (x.name < y.name ? 1 : x.name > y.name ? -1 : 0))
}

/** 按源 id + 文件名读取该源目录内备份文本：先过 READABLE_BACKUP_RE 白名单（防路径穿越），
 *  再按 sourceId 定位目录（未知源抛错）；读取经 BackupDirSink（R10：两通道统一入口） */
export async function readBackupByName(sourceId: string, name: string, sources: Array<Pick<BackupSourceInput, 'id' | 'dir'>>): Promise<string> {
  if (!READABLE_BACKUP_RE.test(name)) throw new Error('invalid backup name')
  const src = sources.find((s) => s.id === sourceId)
  if (!src) throw new Error('未找到该备份目录')
  return sinkFor(src.dir ?? null).readText(name)
}

/** 云源保存的合并写入（审查 I11）：CloudCard 快照仅含云源（loadSources 按 kind!=='local' 过滤），
 *  盲写 backupSources 整键会把并发改动中的本地源（BackupCard 读-改-写通道）回退为「仅云源快照」
 *  丢失元数据。语义：读现值，保留「本次提交列表中不存在的 kind==='local' 项」（CloudCard 是云源
 *  权威视图，云源的增/删/改以提交列表为准——被移除的云源 id 不在列表中即删除），再覆盖本次提交项 */
export async function saveCloudSourcesPreservingLocal(adapter: StorageAdapter, list: BackupSource[]): Promise<void> {
  const current = await loadSources(adapter)
  const submitted = new Set(list.map((s) => s.id))
  const preserved = current.filter((s) => s.kind === 'local' && !submitted.has(s.id))
  await saveSources(adapter, [...preserved, ...list])
}

/** 恢复读取（F4）：path 与 dirToken 均来自 Rust pick_backup_open_os 的登记结果，
 *  前端不再以 parentDirOf(同一路径) 自证 allowed_dir */
export async function readBackupFileOs(picked: PickedOsFile): Promise<string> {
  return invoke<string>('read_text_file_os', { path: picked.path, dirToken: picked.dirToken })
}

/** 通用文本写盘（批① §2.3 文本导出）：picked 由 pickBackupSaveOs 产生，遏制基准=其登记父目录 */
export async function writeTextFileOs(picked: PickedOsFile, contents: string): Promise<void> {
  await invoke('write_text_file_os', { path: picked.path, contents, dirToken: picked.dirToken })
}

/** 二进制写盘（批① §2.5 二维码拼版 PNG 保存）：picked 由 pickBackupSaveOs 产生，遏制基准=其登记父目录。
 *  字节显式转 Array 再 invoke（JSON 数组，不经 UTF-8 文本管道，PNG 二进制安全；Rust 侧白名单 .png） */
export async function writeBytesFileOs(picked: PickedOsFile, bytes: Uint8Array): Promise<void> {
  await invoke('write_bytes_file_os', { path: picked.path, contents: Array.from(bytes), dirToken: picked.dirToken })
}

/** 云端备份密文原件另存（plan23 §4）：picked 由 pickBackupSaveOs 产生，遏制基准=其登记父目录。
 *  信封 JSON 是 UTF-8 文本，走 write_text_file_os 通道（EXPORT_EXTENSIONS 含 .totpbackup）——
 *  write_bytes_file_os 白名单 .png 专属（dialog_grants.rs:506），不适用。取消另存=false */
export async function saveBackupFileOs(name: string, bytes: Uint8Array): Promise<boolean> {
  const picked = await pickBackupSaveOs(name, [{ name: 'TOTP 备份', extensions: ['totpbackup'] }])
  if (!picked) return false
  await writeTextFileOs(picked, new TextDecoder().decode(bytes))
  return true
}

/** 导出写盘（F4）：picked 由 pickBackupSaveOs 的 Rust save 对话框产生，遏制基准=其登记父目录 */
export async function writeBackupFileOs(picked: PickedOsFile, envelope: BackupEnvelope): Promise<void> {
  await writeTextFileOs(picked, JSON.stringify(envelope, null, 2))
}
