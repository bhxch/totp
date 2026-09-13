import { invoke } from '@tauri-apps/api/core'

// 导入文件读取：Rust 端白名单 .json/.wauth/.xml/.txt/.aegis（见 lib.rs read_import_file_os）
export async function readImportFileOs(path: string): Promise<string> {
  return invoke<string>('read_import_file_os', { path })
}

// WinAuth DPAPI 层解密：输入 base64(密文) → 输出 UTF-8 明文（WinAuth 明文恒为 hex ASCII）。
// 仅桌面端可用（CryptUnprotectData）；插件端不提供此能力，core importWinauth 自动逐条 failure。
// Task 5 接线：platform.decryptDpapi = (b64) => decryptDpapiOs(b64)
export async function decryptDpapiOs(b64: string): Promise<string> {
  return invoke<string>('decrypt_dpapi', { b64 })
}
