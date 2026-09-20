import { invoke } from '@tauri-apps/api/core'
import type { PickedOsFile } from './backupService'

// F4：导入文件对话框改由 Rust 侧打开（pick_open_file_os，Rust 登记所选文件父目录返回 token），
// 读取命令以 dirToken 反查登记目录遏制，不再接受前端 parentDirOf 自证的 allowed_dir
export async function pickImportFileOs(filters: { name: string; extensions: string[] }[]): Promise<PickedOsFile | null> {
  return invoke<PickedOsFile | null>('pick_open_file_os', { filters })
}

// 导入文件读取：Rust 端白名单 .json/.wauth/.xml/.txt/.aegis（见 lib.rs read_import_file_os）
export async function readImportFileOs(picked: PickedOsFile): Promise<string> {
  return invoke<string>('read_import_file_os', { path: picked.path, dirToken: picked.dirToken })
}

// 导入文件字节读取（SQLite 等二进制格式，ImportCard 字节入口）：不经文本管道，二进制无损。
// Rust 端白名单在文本命令基础上加 .db/.sqlitedb/.sqlite（见 lib.rs read_import_file_bytes_os）
export async function readImportFileBytesOs(picked: PickedOsFile): Promise<Uint8Array> {
  return Uint8Array.from(await invoke<number[]>('read_import_file_bytes_os', { path: picked.path, dirToken: picked.dirToken }))
}

// WinAuth DPAPI 层解密：输入 base64(密文) → 输出 UTF-8 明文（WinAuth 明文恒为 hex ASCII）。
// 仅桌面端可用（CryptUnprotectData）；插件端不提供此能力，core importWinauth 自动逐条 failure。
// Task 5 接线：platform.decryptDpapi = (b64) => decryptDpapiOs(b64)
// F3：Rust 端要求显式用途声明（仅接受 winauth-import）并校验明文 hex-ASCII 形状（见 lib.rs decrypt_dpapi）
export async function decryptDpapiOs(b64: string): Promise<string> {
  return invoke<string>('decrypt_dpapi', { b64, purpose: 'winauth-import' })
}
