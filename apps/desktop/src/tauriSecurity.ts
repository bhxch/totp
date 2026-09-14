import { invoke } from '@tauri-apps/api/core'
import { base64ToBytes, bytesToBase64 } from '@totp/core'

// 桌面 DPAPI 自动解锁（计划 11 T3，见 lib.rs dpapi_protect/dpapi_unprotect）：
// CryptProtectData 直接包裹 DEK 本体（T1 裁定 wrappedDekD 语义），base64 进出。
// SecurityCard（启用/移除）与 LockScreen（静默解锁）经 ui DpapiUnlockOps 通道使用。

/** DEK 字节 → base64(DPAPI(DEK))（wrappedDekD） */
export async function dpapiProtectOs(dek: Uint8Array): Promise<string> {
  return invoke<string>('dpapi_protect', { dataB64: bytesToBase64(dek) })
}

/** base64(wrappedDekD) → DEK 字节；失败（跨机器/跨用户/损坏）由调用方静默处理 */
export async function dpapiUnprotectOs(wrappedB64: string): Promise<Uint8Array> {
  return base64ToBytes(await invoke<string>('dpapi_unprotect', { wrappedB64 }))
}
