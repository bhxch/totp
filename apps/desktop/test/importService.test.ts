/**
 * importService 全测（P3b）：导入文件 OS 通道四函数薄封装直测（盘点 B3 16 的 invoke 面）。
 * why：F4 后导入文件经 Rust 对话框登记父目录返回 dirToken，读取命令以 token 反查遏制——
 * 前端不再自证 allowed_dir；本模块只做透传，测试锚定「实参形状 + 取消语义 + 错误透传」契约。
 * 注：lastImportPick 缓存成对与文件名取 path 尾段是 App.vue 的 readImportFile/Bytes 装配层
 * 方法（P4 范围），不在本模块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tauriMock } from './mocks/tauri'
import { decryptDpapiOs, pickImportFileOs, readImportFileBytesOs, readImportFileOs } from '../src/importService'

vi.mock('@tauri-apps/api/core', async () => (await import('./mocks/tauri')).invokeModule())

// 与 App.vue importFileFilters() 同款过滤器（Rust 对话框白名单的前端声明面）
const importFilters = [
  { name: '导入文件', extensions: ['json', 'wauth', 'txt', 'aegis', 'xml', 'db', 'sqlitedb', 'sqlite', 'zip'] },
]

beforeEach(() => {
  tauriMock.reset()
})

describe('pickImportFileOs（Rust open 对话框）', () => {
  it('filters 原样透传，Rust 结果 {path, dirToken} 透出', async () => {
    tauriMock.onReturn('pick_open_file_os', { path: 'C:\\imp\\a.json', dirToken: 'tok-1' })
    expect(await pickImportFileOs(importFilters)).toEqual({ path: 'C:\\imp\\a.json', dirToken: 'tok-1' })
    expect(tauriMock.calls('pick_open_file_os')).toEqual([
      { command: 'pick_open_file_os', args: { filters: importFilters } },
    ])
  })

  it('用户取消（Rust null）→ null', async () => {
    tauriMock.onReturn('pick_open_file_os', null)
    expect(await pickImportFileOs(importFilters)).toBeNull()
  })
})

describe('readImportFileOs（文本读取）', () => {
  it('path+dirToken 成对透传（dirToken 遏制基准=对话框登记父目录），文本透出', async () => {
    tauriMock.onReturn('read_import_file_os', '{"entries":[]}')
    const picked = { path: 'C:\\imp\\a.wauth', dirToken: 'tok-1' }
    expect(await readImportFileOs(picked)).toBe('{"entries":[]}')
    expect(tauriMock.calls('read_import_file_os')).toEqual([
      { command: 'read_import_file_os', args: { path: picked.path, dirToken: picked.dirToken } },
    ])
  })
})

describe('readImportFileBytesOs（字节读取）', () => {
  it('path+dirToken 成对透传；number[] → Uint8Array（二进制不经文本管道）', async () => {
    tauriMock.onReturn('read_import_file_bytes_os', [104, 101, 33, 0, 255])
    const picked = { path: 'C:\\imp\\a.db', dirToken: 'tok-2' }
    const out = await readImportFileBytesOs(picked)
    expect(out).toBeInstanceOf(Uint8Array)
    expect(Array.from(out)).toEqual([104, 101, 33, 0, 255])
    expect(tauriMock.calls('read_import_file_bytes_os')).toEqual([
      { command: 'read_import_file_bytes_os', args: { path: picked.path, dirToken: picked.dirToken } },
    ])
  })
})

describe('decryptDpapiOs（WinAuth DPAPI 层解密）', () => {
  it('purpose 显式声明 winauth-import（F3：Rust 端仅接受该用途）', async () => {
    tauriMock.onReturn('decrypt_dpapi', 'a1b2c3d4')
    expect(await decryptDpapiOs('Q0lQSEVS')).toBe('a1b2c3d4')
    expect(tauriMock.calls('decrypt_dpapi')).toEqual([
      { command: 'decrypt_dpapi', args: { b64: 'Q0lQSEVS', purpose: 'winauth-import' } },
    ])
  })

  it('invoke 抛错（非 DPAPI 密文等）→ 透传（导入卡统一逐条 failure）', async () => {
    tauriMock.on('decrypt_dpapi', () => Promise.reject('DPAPI 解密失败'))
    await expect(decryptDpapiOs('bad-b64')).rejects.toBe('DPAPI 解密失败')
  })
})
