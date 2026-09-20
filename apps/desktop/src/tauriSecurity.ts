import { invoke } from '@tauri-apps/api/core'
import { base64ToBytes, bytesToBase64 } from '@totp/core'

// 桌面 OS 自动解锁（计划 11 T3 → 计划 15 T14 统一为 os_auto_* 三平台通道）：
// OS 保护直接包裹 DEK 本体（T1 裁定 wrappedDekD 语义），base64 进出。
// Windows 下 os_auto_* 即 DPAPI（Rust 委托 dek_* 通道）；macOS Keychain / Linux Secret
// Service 经 keyring（运行时行为 Windows 构建不可验证，登记 backlog 真机验证）。
// SecurityCard（启用/移除）与 LockScreen（静默解锁）经 ui DpapiUnlockOps 通道使用。
// F3：Windows DEK 通道升级 v2 格式 = base64( TOTPDEK1 ‖ DPAPI(DEK, 应用专属附加熵) )，
// 并仅主窗口可调用——os_auto_unprotect/dpapi_unprotect 不再能解任意用户态 DPAPI 密文
// （异熵/无熵非 32B 一律拒绝）；历史无熵 wrappedDekD 由 Rust 端 32B 兜底解出（不 brick 存量），
// 成功解锁后经 migrateDekWrapToEntropyBound（App.vue）重包为 v2。

// C8：DEK 长度强校验（XChaCha20-Poly1305 key = 32 字节）。Rust 侧不隐式接受任意
// 长度字节，前端先拒可避免无效调用打到 OS 加密边界上才报错；解包路径 Rust 返回后
// 仍由前端 osAutoUnprotectOs 后置兜底校验 32B，双层防御。
const DEK_LENGTH = 32

// F3 v2 包裹格式版本前缀（与 Rust lib.rs DEK_WRAP_MARKER 逐字对齐）：
// 迁移判定用——无此前缀的历史 wrappedDekD 走 Rust 旧格式兜底解包，成功解锁后重包升级
const DEK_WRAP_MARKER = new TextEncoder().encode('TOTPDEK1')

/** wrappedDekD 是否已是 v2 应用熵绑定格式（前缀 + DPAPI(DEK, 熵)）；解析失败按旧格式对待 */
export function isEntropyBoundDekWrap(wrappedB64: string): boolean {
  let raw: Uint8Array
  try {
    raw = base64ToBytes(wrappedB64)
  } catch {
    return false
  }
  return (
    raw.length > DEK_WRAP_MARKER.length &&
    raw.subarray(0, DEK_WRAP_MARKER.length).every((b, i) => b === DEK_WRAP_MARKER[i])
  )
}

/** DEK 字节 → wrappedDekD（dpapi_protect；F3 起与 os_auto_protect 同为 v2 应用熵绑定通道，仅语义兼容保留） */
export async function dpapiProtectOs(dek: Uint8Array): Promise<string> {
  if (dek.length !== DEK_LENGTH) throw new Error('DEK must be 32 bytes')
  return invoke<string>('dpapi_protect', { dataB64: bytesToBase64(dek) })
}

/** wrappedDekD → DEK 字节（dpapi_unprotect；F3 起与 os_auto_unprotect 同通道，仅接受本应用 DEK 包裹）；
 *  失败（跨机器/跨用户/损坏/非本应用包裹）由调用方静默处理 */
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

/** 删除 keyring 中的 DEK 条目（macOS Keychain / Linux Secret Service；审查 M1：移除原生自动
 *  解锁来源时清理残留，条目不存在幂等成功）。Windows/其余平台为报错桩（DPAPI 无独立条目）——
 *  调用方按 best-effort 处理，失败不影响移除主流程 */
export async function osAutoForgetOs(): Promise<void> {
  await invoke('os_auto_forget')
}
