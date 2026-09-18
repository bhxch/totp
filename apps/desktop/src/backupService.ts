import { invoke } from '@tauri-apps/api/core'
import { mkdir, readDir, readTextFile, rename, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import {
  backupFileName, conflictBackupFileName, createBackupEnvelope, DEFAULT_KDF_PROFILE, loadSources, OVERWRITE_NAME,
  READABLE_BACKUP_RE, saveSources, selectBackupsToKeep,
  type BackupEnvelope, type BackupSource, type KdfProfile, type Retention, type StorageAdapter,
} from '@totp/core'

const dir = 'backups'

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

async function writeDirFile(name: string, contents: string): Promise<void> {
  // backups/ 子目录可能尚不存在（首次备份），ensure 后再原子写
  await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true })
  const tmp = `${name}.tmp`
  await writeTextFile(`${dir}/${tmp}`, contents, { baseDir: BaseDirectory.AppData })
  // plugin-fs v2 RenameOptions 仅支持 oldPathBaseDir/newPathBaseDir（无 baseDir 字段）
  await rename(`${dir}/${tmp}`, `${dir}/${name}`, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
}

/** override 分支写盘（用户自选目录）：经 Rust write_text_file_os（allowed_dir=该目录）。
 *  目录为用户显式选择，已存在，无需 mkdir；无 tmp+rename（os 命令无 rename 原语） */
async function writeOsFile(dirOverride: string, name: string, contents: string): Promise<void> {
  await invoke('write_text_file_os', { path: joinBackupPath(dirOverride, name), contents, allowedDir: dirOverride })
}

/** 单目录备份名列表：os 目录走 Rust 白名单命令（已过滤+升序）；null=AppData/backups 走 plugin-fs
 *  readDir（审查 M4：TS 侧同样按 READABLE_BACKUP_RE 过滤——恢复侧「可恢复的备份文件」口径，
 *  防仅后缀 .totpbackup 的陌生文件混入列表）。两分支过滤并不完全同口径：os 分支在
 *  valid_backup_name（vault- 前缀白名单）之外对 conflict- 前缀副本放行更宽松（仅要求前缀+
 *  后缀），默认分支对齐的是读侧 READABLE_BACKUP_RE 单一口径 */
async function listDirNames(dirOverride: string | null): Promise<string[]> {
  if (dirOverride) return invoke<string[]>('list_backup_files_os', { dir: dirOverride })
  const names = (await readDir(dir, { baseDir: BaseDirectory.AppData })).map((e) => e.name)
  return names.filter((n) => READABLE_BACKUP_RE.test(n))
}

/** 单源落盘（plan16 前为 createBackupToDir 本体）：overwrite=固定名覆盖；keep=时间戳名+滚动删除。
 *  信封文本由调用方生成传入（多源共享同一份密文，Argon2id 只跑一次） */
async function writeSourceBackup(dirOverride: string | null, contents: string, retention: Retention): Promise<'created' | 'overwritten'> {
  if (retention.type === 'overwrite') {
    if (dirOverride) await writeOsFile(dirOverride, OVERWRITE_NAME, contents)
    else await writeDirFile(OVERWRITE_NAME, contents)
    return 'overwritten'
  }
  const name = backupFileName(new Date())
  if (dirOverride) {
    await writeOsFile(dirOverride, name, contents)
    // 滚动删除走 os 列表+删除命令（目录即授权目标；Rust 端已做白名单过滤）
    const names = await invoke<string[]>('list_backup_files_os', { dir: dirOverride })
    const stale = selectBackupsToKeep(names, retention.n)
    for (const staleName of stale) await invoke('remove_backup_file_os', { path: joinBackupPath(dirOverride, staleName), allowedDir: dirOverride })
  } else {
    await writeDirFile(name, contents)
    const entries = await readDir(dir, { baseDir: BaseDirectory.AppData })
    const stale = selectBackupsToKeep(entries.map((e) => e.name), retention.n)
    for (const staleName of stale) await invoke('remove_backup_file', { name: staleName })
  }
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
 *  多源场景带 sourceId 区分来源（conflict-{sourceId}-{ts}.totpbackup，desktop 侧拼接——
 *  core conflictBackupFileName(now) 无第二参）；缺省保持历史名。恒写默认 backups 目录（源模型后无单一「自选目录」） */
export async function saveConflictBackupToDir(bytes: Uint8Array, dirOverride: string | null = null, sourceId?: string): Promise<string> {
  const base = conflictBackupFileName(new Date())
  const name = sourceId ? `conflict-${sourceId}-${base.slice('conflict-'.length)}` : base
  const contents = new TextDecoder().decode(bytes)
  if (dirOverride) await writeOsFile(dirOverride, name, contents)
  else await writeDirFile(name, contents)
  return name
}

/** 聚合全部本地源的备份文件列表（plan16 T14）：逐源列目录（单源失败跳过不影响其余），过滤
 *  .totpbackup 后标注 sourceId，按文件名倒序=新在前（时间戳名全局字典序可比；码点比较跨 locale 确定） */
export async function listBackupsFromSources(sources: BackupSourceInput[]): Promise<Array<{ sourceId: string; name: string }>> {
  const out: Array<{ sourceId: string; name: string }> = []
  for (const s of sources) {
    try {
      const names = await listDirNames(s.dir ?? null)
      for (const n of names) if (n.endsWith('.totpbackup')) out.push({ sourceId: s.id, name: n })
    } catch { /* 单源列表失败（目录被移除等）：跳过该源，其余照常展示 */ }
  }
  return out.sort((x, y) => (x.name < y.name ? 1 : x.name > y.name ? -1 : 0))
}

/** 按源 id + 文件名读取该源目录内备份文本：先过 READABLE_BACKUP_RE 白名单（防路径穿越），
 *  再按 sourceId 定位目录（未知源抛错）；dir=null 走 AppData plugin-fs，否则走 os 命令 */
export async function readBackupByName(sourceId: string, name: string, sources: Array<Pick<BackupSourceInput, 'id' | 'dir'>>): Promise<string> {
  if (!READABLE_BACKUP_RE.test(name)) throw new Error('invalid backup name')
  const src = sources.find((s) => s.id === sourceId)
  if (!src) throw new Error('未找到该备份目录')
  const dirOverride = src.dir ?? null
  if (dirOverride) return invoke<string>('read_text_file_os', { path: joinBackupPath(dirOverride, name), allowedDir: dirOverride })
  return readTextFile(`${dir}/${name}`, { baseDir: BaseDirectory.AppData })
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

export async function readBackupFileOs(path: string): Promise<string> {
  const allowedDir = await parentDirOf(path)
  return invoke<string>('read_text_file_os', { path, allowedDir })
}

export async function writeBackupFileOs(path: string, envelope: BackupEnvelope): Promise<void> {
  const allowedDir = await parentDirOf(path)
  await invoke('write_text_file_os', { path, contents: JSON.stringify(envelope, null, 2), allowedDir })
}

/** C9：从用户对话框返回的完整路径取其父目录，作为 Rust 端 write/read_text_file_os 的 allowed_dir。
 *  若解析不出父目录（如根目录），回退到 appDataDir 基线。 */
async function parentDirOf(path: string): Promise<string> {
  const sep = path.includes('\\') ? '\\' : '/'
  const idx = path.lastIndexOf(sep)
  if (idx <= 0) {
    const { appDataDir } = await import('@tauri-apps/api/path')
    return await appDataDir()
  }
  return path.slice(0, idx)
}
