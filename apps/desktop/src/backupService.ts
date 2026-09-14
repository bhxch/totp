import { invoke } from '@tauri-apps/api/core'
import { mkdir, readDir, readTextFile, rename, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { backupFileName, conflictBackupFileName, selectBackupsToKeep, READABLE_BACKUP_RE, OVERWRITE_NAME, createBackupEnvelope, type BackupEnvelopeV1 } from '@totp/core'

const dir = 'backups'

async function writeDirFile(name: string, contents: string): Promise<void> {
  // backups/ 子目录可能尚不存在（首次备份），ensure 后再原子写
  await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true })
  const tmp = `${name}.tmp`
  await writeTextFile(`${dir}/${tmp}`, contents, { baseDir: BaseDirectory.AppData })
  // plugin-fs v2 RenameOptions 仅支持 oldPathBaseDir/newPathBaseDir（无 baseDir 字段）
  await rename(`${dir}/${tmp}`, `${dir}/${name}`, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
}

export async function createBackupToDir(vaultJson: string, password: string, mode: { type: 'keep'; n: number } | { type: 'overwrite' }): Promise<'created' | 'overwritten'> {
  const env = await createBackupEnvelope(vaultJson, password)
  const contents = JSON.stringify(env, null, 2)
  if (mode.type === 'overwrite') {
    await writeDirFile(OVERWRITE_NAME, contents)
    return 'overwritten'
  }
  await writeDirFile(backupFileName(new Date()), contents)
  const entries = await readDir(dir, { baseDir: BaseDirectory.AppData })
  const stale = selectBackupsToKeep(entries.map((e) => e.name), mode.n)
  for (const name of stale) await invoke('remove_backup_file', { name })
  return 'created'
}

/** 云同步冲突副本：本地 vault JSON 字节写 backups/conflict-{ts}.totpbackup（不参与滚动删除），返回文件名 */
export async function saveConflictBackupToDir(bytes: Uint8Array): Promise<string> {
  const name = conflictBackupFileName(new Date())
  await writeDirFile(name, new TextDecoder().decode(bytes))
  return name
}

export async function listBackups(): Promise<Array<{ name: string }>> {
  const entries = await readDir(dir, { baseDir: BaseDirectory.AppData })
  // 显式排序保证确定性（不依赖文件系统返回顺序），倒序=新在前
  return entries.filter((e) => e.name.endsWith('.totpbackup')).map((e) => ({ name: e.name })).sort((a, b) => a.name.localeCompare(b.name)).reverse()
}

export async function readBackupByName(name: string): Promise<string> {
  if (!READABLE_BACKUP_RE.test(name)) throw new Error('invalid backup name')
  return readTextFile(`${dir}/${name}`, { baseDir: BaseDirectory.AppData })
}

export async function readBackupFileOs(path: string): Promise<string> {
  return invoke<string>('read_text_file_os', { path })
}

export async function writeBackupFileOs(path: string, envelope: BackupEnvelopeV1): Promise<void> {
  await invoke('write_text_file_os', { path, contents: JSON.stringify(envelope, null, 2) })
}
