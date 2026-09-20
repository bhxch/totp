import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'

// C9：从用户对话框返回的完整路径取其父目录作为 allowed_dir，传给 Rust 端做白名单校验
async function parentDirOf(path: string): Promise<string> {
  const sep = path.includes('\\') ? '\\' : '/'
  const idx = path.lastIndexOf(sep)
  if (idx <= 0) return await appDataDir()
  return path.slice(0, idx)
}

// 导入文件读取：Rust 端白名单 .json/.wauth/.xml/.txt/.aegis（见 lib.rs read_import_file_os）
export async function readImportFileOs(path: string): Promise<string> {
  const allowedDir = await parentDirOf(path)
  return invoke<string>('read_import_file_os', { path, allowedDir })
}

// 导入文件字节读取（SQLite 等二进制格式，ImportCard 字节入口）：不经文本管道，二进制无损。
// Rust 端白名单在文本命令基础上加 .db/.sqlitedb/.sqlite（见 lib.rs read_import_file_bytes_os）
export async function readImportFileBytesOs(path: string): Promise<Uint8Array> {
  const allowedDir = await parentDirOf(path)
  return Uint8Array.from(await invoke<number[]>('read_import_file_bytes_os', { path, allowedDir }))
}

// WinAuth DPAPI 层解密：输入 base64(密文) → 输出 UTF-8 明文（WinAuth 明文恒为 hex ASCII）。
// 仅桌面端可用（CryptUnprotectData）；插件端不提供此能力，core importWinauth 自动逐条 failure。
// Task 5 接线：platform.decryptDpapi = (b64) => decryptDpapiOs(b64)
// F3：Rust 端要求显式用途声明（仅接受 winauth-import）并校验明文 hex-ASCII 形状（见 lib.rs decrypt_dpapi）
export async function decryptDpapiOs(b64: string): Promise<string> {
  return invoke<string>('decrypt_dpapi', { b64, purpose: 'winauth-import' })
}
