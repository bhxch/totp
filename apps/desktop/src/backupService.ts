import { invoke } from '@tauri-apps/api/core'
import { mkdir, readDir, readTextFile, rename, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { backupFileName, conflictBackupFileName, selectBackupsToKeep, READABLE_BACKUP_RE, OVERWRITE_NAME, createBackupEnvelope, type BackupEnvelopeV1 } from '@totp/core'

const dir = 'backups'

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

export async function createBackupToDir(vaultJson: string, password: string, mode: { type: 'keep'; n: number } | { type: 'overwrite' }, dirOverride: string | null = null): Promise<'created' | 'overwritten'> {
  const env = await createBackupEnvelope(vaultJson, password)
  const contents = JSON.stringify(env, null, 2)
  if (mode.type === 'overwrite') {
    if (dirOverride) await writeOsFile(dirOverride, OVERWRITE_NAME, contents)
    else await writeDirFile(OVERWRITE_NAME, contents)
    return 'overwritten'
  }
  const name = backupFileName(new Date())
  if (dirOverride) {
    await writeOsFile(dirOverride, name, contents)
    // 滚动删除走 os 列表+删除命令（目录即授权目标；Rust 端已做白名单过滤）
    const names = await invoke<string[]>('list_backup_files_os', { dir: dirOverride })
    const stale = selectBackupsToKeep(names, mode.n)
    for (const staleName of stale) await invoke('remove_backup_file_os', { path: joinBackupPath(dirOverride, staleName), allowedDir: dirOverride })
  } else {
    await writeDirFile(name, contents)
    const entries = await readDir(dir, { baseDir: BaseDirectory.AppData })
    const stale = selectBackupsToKeep(entries.map((e) => e.name), mode.n)
    for (const staleName of stale) await invoke('remove_backup_file', { name: staleName })
  }
  return 'created'
}

/** 云同步冲突副本：本地 vault JSON 字节写 backups/conflict-{ts}.totpbackup（不参与滚动删除），返回文件名。
 *  多目标场景带 backendKey 区分来源（conflict-{backendKey}-{ts}.totpbackup，desktop 侧拼接——
 *  core conflictBackupFileName(now) 无第二参）；缺省保持历史名。 */
export async function saveConflictBackupToDir(bytes: Uint8Array, dirOverride: string | null = null, backendKey?: string): Promise<string> {
  const base = conflictBackupFileName(new Date())
  const name = backendKey ? `conflict-${backendKey}-${base.slice('conflict-'.length)}` : base
  const contents = new TextDecoder().decode(bytes)
  if (dirOverride) await writeOsFile(dirOverride, name, contents)
  else await writeDirFile(name, contents)
  return name
}

export async function listBackups(dirOverride: string | null = null): Promise<Array<{ name: string }>> {
  // 显式排序保证确定性（不依赖文件系统返回顺序），倒序=新在前；Rust 端已按白名单过滤并升序返回
  const names = dirOverride
    ? await invoke<string[]>('list_backup_files_os', { dir: dirOverride })
    : (await readDir(dir, { baseDir: BaseDirectory.AppData })).map((e) => e.name)
  return names.filter((n) => n.endsWith('.totpbackup')).map((n) => ({ name: n })).sort((a, b) => a.name.localeCompare(b.name)).reverse()
}

export async function readBackupByName(name: string, dirOverride: string | null = null): Promise<string> {
  if (!READABLE_BACKUP_RE.test(name)) throw new Error('invalid backup name')
  if (dirOverride) return invoke<string>('read_text_file_os', { path: joinBackupPath(dirOverride, name), allowedDir: dirOverride })
  return readTextFile(`${dir}/${name}`, { baseDir: BaseDirectory.AppData })
}

export async function readBackupFileOs(path: string): Promise<string> {
  const allowedDir = await parentDirOf(path)
  return invoke<string>('read_text_file_os', { path, allowedDir })
}

export async function writeBackupFileOs(path: string, envelope: BackupEnvelopeV1): Promise<void> {
  const allowedDir = await parentDirOf(path)
  await invoke('write_text_file_os', { path, contents: JSON.stringify(envelope, null, 2), allowedDir })
}
