/**
 * backupService 直测缺口补全（P3b）：saveConflictBackupToDir（冲突副本命名/恒默认目录/不参与滚动删除）、
 * writeBackupFileOs / writeTextFileOs / writeBytesFileOs（OS 白名单命令调用形状）、
 * pickBackupSaveOs / pickBackupOpenOs（取消语义与实参透传）。
 * why：多源 retention/聚合列表/按名读取/云源合并写已在 src/backupService.test.ts
 * （vi.hoisted+vi.mock 先例，保留不动）；本文件补齐剩余直测面并走 P0 工厂接法。
 * 不 mock @totp/core：本文件触达的路径不含 Argon2id（冲突副本/OS 写盘均为纯文本字节操作）。
 */
import { READABLE_BACKUP_RE, type BackupEnvelope } from '@totp/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tauriMock } from './mocks/tauri'
import {
  pickBackupOpenOs, pickBackupSaveOs, saveConflictBackupToDir,
  writeBackupFileOs, writeBytesFileOs, writeTextFileOs,
} from '../src/backupService'

vi.mock('@tauri-apps/api/core', async () => (await import('./mocks/tauri')).invokeModule())
vi.mock('@tauri-apps/plugin-fs', async () => (await import('./mocks/tauri')).fsModule())

const bytes = new TextEncoder().encode('{"v":1}')

/** 信封形状样本（仅验 JSON 序列化透传，不解密语义在 core 侧已测） */
const envelope: BackupEnvelope = {
  v: 2,
  kdf: { alg: 'argon2id', profile: 'balanced', m: 1, t: 1, p: 1, salt: 's' },
  wrapNonce: 'wn', wrappedDek: 'wd', aead: 'aes-256-gcm', dataNonce: 'dn', ciphertext: 'ct',
}

beforeEach(() => {
  tauriMock.reset()
})

describe('saveConflictBackupToDir（云同步冲突副本）', () => {
  it('缺省：恒写默认 backups 目录（tmp+rename 原子写），命名 conflict-{ts}，不参与滚动删除', async () => {
    const name = await saveConflictBackupToDir(bytes)
    expect(name).toMatch(/^conflict-\d{8}-\d{6}\.totpbackup$/)
    expect(tauriMock.fs.mkdir).toHaveBeenCalledWith('backups', { baseDir: 'AppData', recursive: true })
    expect(tauriMock.fs.writeTextFile).toHaveBeenCalledWith(`backups/${name}.tmp`, '{"v":1}', { baseDir: 'AppData' })
    expect(tauriMock.fs.rename).toHaveBeenCalledWith(
      `backups/${name}.tmp`, `backups/${name}`,
      { oldPathBaseDir: 'AppData', newPathBaseDir: 'AppData' },
    )
    // 不参与滚动删除：无 os 列表/删除命令、无 plugin-fs readDir
    expect(tauriMock.calls('list_backup_files_os')).toEqual([])
    expect(tauriMock.calls('remove_backup_file')).toEqual([])
    expect(tauriMock.fs.readDir).not.toHaveBeenCalled()
  })

  it('带 sourceId：命名 conflict-{sourceId}-{ts}（desktop 侧拼接），落在 READABLE_BACKUP_RE 白名单内（恢复侧可见）', async () => {
    const name = await saveConflictBackupToDir(bytes, null, 'webdav')
    expect(name).toMatch(/^conflict-webdav-\d{8}-\d{6}\.totpbackup$/)
    expect(READABLE_BACKUP_RE.test(name)).toBe(true)

    // 旧迁移源 id=backend 单段、新源 uuid 五段连字符均在白名单口径内
    const uuidName = await saveConflictBackupToDir(bytes, null, '2dc4bf8a-5ca7-4087-8b3e-2f1a4d5c6b7e')
    expect(READABLE_BACKUP_RE.test(uuidName)).toBe(true)
  })

  it('显式 dirOverride（历史签名兼容）：走 os 通道 dir_token_os→write_text_file_os，同样不滚动删除', async () => {
    tauriMock.onReturn('dir_token_os', 'tok')
    const name = await saveConflictBackupToDir(bytes, 'C:\\bk', 'gist')
    expect(name).toMatch(/^conflict-gist-\d{8}-\d{6}\.totpbackup$/)
    expect(tauriMock.calls('dir_token_os')).toEqual([{ command: 'dir_token_os', args: { dir: 'C:\\bk' } }])
    expect(tauriMock.calls('write_text_file_os')).toEqual([
      { command: 'write_text_file_os', args: { path: `C:\\bk\\${name}`, contents: '{"v":1}', dirToken: 'tok' } },
    ])
    expect(tauriMock.calls('list_backup_files_os')).toEqual([])
    expect(tauriMock.fs.writeTextFile).not.toHaveBeenCalled()
  })
})

describe('OS 白名单文件命令（调用形状：path/dirToken/内容）', () => {
  it('writeTextFileOs：{path, contents, dirToken} 原样', async () => {
    await writeTextFileOs({ path: 'C:\\exp\\a.txt', dirToken: 'tok' }, 'text-contents')
    expect(tauriMock.calls('write_text_file_os')).toEqual([
      { command: 'write_text_file_os', args: { path: 'C:\\exp\\a.txt', contents: 'text-contents', dirToken: 'tok' } },
    ])
  })

  it('writeBytesFileOs：字节显式转 Array（JSON 数组，不经 UTF-8 文本管道，PNG 二进制安全）', async () => {
    await writeBytesFileOs({ path: 'C:\\exp\\qr.png', dirToken: 'tok' }, new Uint8Array([137, 80, 78, 71, 0, 255]))
    expect(tauriMock.calls('write_bytes_file_os')).toEqual([
      { command: 'write_bytes_file_os', args: { path: 'C:\\exp\\qr.png', contents: [137, 80, 78, 71, 0, 255], dirToken: 'tok' } },
    ])
  })

  it('writeBackupFileOs：envelope JSON.stringify(…, null, 2) 落文本命令', async () => {
    await writeBackupFileOs({ path: 'C:\\exp\\b.totpbackup', dirToken: 'tok' }, envelope)
    expect(tauriMock.calls('write_text_file_os')).toEqual([
      { command: 'write_text_file_os', args: { path: 'C:\\exp\\b.totpbackup', contents: JSON.stringify(envelope, null, 2), dirToken: 'tok' } },
    ])
  })
})

describe('pickBackupSaveOs / pickBackupOpenOs（F4 对话框授权句柄）', () => {
  it('pickBackupSaveOs：defaultName+filters 透传，成功结果 {path, dirToken} 透出', async () => {
    const filters = [{ name: 'TOTP 备份', extensions: ['totpbackup'] }]
    tauriMock.onReturn('pick_save_file_os', { path: 'C:\\exp\\b.totpbackup', dirToken: 'tok' })
    expect(await pickBackupSaveOs('vault-backup.totpbackup', filters)).toEqual({ path: 'C:\\exp\\b.totpbackup', dirToken: 'tok' })
    expect(tauriMock.calls('pick_save_file_os')).toEqual([
      { command: 'pick_save_file_os', args: { defaultName: 'vault-backup.totpbackup', filters } },
    ])
  })

  it('pickBackupOpenOs：filters 透传；取消（Rust null）→ null（调用方据此中断流程）', async () => {
    const filters = [{ name: 'TOTP 备份', extensions: ['totpbackup'] }]
    tauriMock.onReturn('pick_open_file_os', { path: 'C:\\imp\\b.totpbackup', dirToken: 'tok-9' })
    expect(await pickBackupOpenOs(filters)).toEqual({ path: 'C:\\imp\\b.totpbackup', dirToken: 'tok-9' })
    expect(tauriMock.calls('pick_open_file_os')).toEqual([
      { command: 'pick_open_file_os', args: { filters } },
    ])

    tauriMock.onReturn('pick_open_file_os', null)
    expect(await pickBackupOpenOs(filters)).toBeNull()
  })
})
