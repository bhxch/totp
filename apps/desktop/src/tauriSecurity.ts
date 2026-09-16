import { invoke } from '@tauri-apps/api/core'
import { base64ToBytes, bytesToBase64 } from '@totp/core'

// 桌面 OS 自动解锁（计划 11 T3 → 计划 15 T14 统一为 os_auto_* 三平台通道）：
// OS 保护直接包裹 DEK 本体（T1 裁定 wrappedDekD 语义），base64 进出。
// Windows 下 os_auto_* 即 DPAPI（Rust 委托 dpapi_*_inner）；macOS Keychain / Linux Secret
// Service 经 keyring（运行时行为 Windows 构建不可验证，登记 backlog 真机验证）。
// SecurityCard（启用/移除）与 LockScreen（静默解锁）经 ui DpapiUnlockOps 通道使用。

// C8：DEK 长度强校验（XChaCha20-Poly1305 key = 32 字节）。Rust 侧不隐式接受任意
// 长度字节，前端先拒可避免无效调用打到 OS 加密边界上才报错；解包路径 Rust 返回后
// 仍由前端 osAutoUnprotectOs 后置兜底校验 32B，双层防御。
const DEK_LENGTH = 32

/** DEK 字节 → base64(DPAPI(DEK))（wrappedDekD；Windows DPAPI 直连，语义保留兼容） */
export async function dpapiProtectOs(dek: Uint8Array): Promise<string> {
  if (dek.length !== DEK_LENGTH) throw new Error('DEK must be 32 bytes')
  return invoke<string>('dpapi_protect', { dataB64: bytesToBase64(dek) })
}

/** base64(wrappedDekD) → DEK 字节；失败（跨机器/跨用户/损坏）由调用方静默处理 */
export async function dpapiUnprotectOs(wrappedB64: string): Promise<Uint8Array> {
  const bytes = base64ToBytes(await invoke<string>('dpapi_unprotect', { wrappedB64 }))
  if (bytes.length !== DEK_LENGTH) throw new Error('DEK must be 32 bytes')
  return bytes
}

/** DEK 字节 → base64(OS保护(DEK))（osAutoUnlock 统一通道：Windows=DPAPI / macOS=Keychain / Linux=Secret Service） */
export async function osAutoProtectOs(dek: Uint8Array): Promise<string> {
  if (dek.length !== DEK_LENGTH) throw new Error('DEK must be 32 bytes')
  return invoke<string>('os_auto_protect', { dataB64: bytesToBase64(dek) })
}

/** base64(OS保护(DEK)) → DEK 字节；失败（跨机器/跨用户/条目缺失）由调用方静默处理 */
export async function osAutoUnprotectOs(wrappedB64: string): Promise<Uint8Array> {
  const bytes = base64ToBytes(await invoke<string>('os_auto_unprotect', { wrappedB64 }))
  if (bytes.length !== DEK_LENGTH) throw new Error('DEK must be 32 bytes')
  return bytes
}
