import { base64ToBytes, bytesToBase64 } from '@totp/core'

/** DEK 会话级持久化（plan16 设计 §1 锁定策略·重启即锁的 extension 宿主实现）：
 *  chrome.storage.session 键 'dek'（base64）——浏览器退出即清、默认不落盘，
 *  仅扩展页/SW 等受信上下文可读（TRUSTED_CONTEXTS 默认）。
 *  session 区跨扩展上下文共享：popup 与 options 任一解锁写 DEK，另一端 initStore
 *  经 ui store 的 dekPersist.get() 自动恢复解锁（共享解锁态）。
 *  set/clear 环境性 IO 错误吞掉（解锁/锁定主流程不因会话存储瞬断失败）；
 *  get 全路径失败按无 DEK（null）；set 对非 32B 输入抛错（编程错误立即暴露）。 */
export function createDekSession(): { get(): Promise<string | null>; set(dek: Uint8Array): Promise<void>; clear(): Promise<void> } {
  const DEK_KEY = 'dek'
  return {
    async get() {
      try {
        const o = await chrome.storage.session.get(DEK_KEY)
        const raw = o[DEK_KEY]
        if (typeof raw !== 'string') return null
        base64ToBytes(raw) // 合法性校验：损坏/篡改的 base64 经 atob 抛错 → catch 按 null
        return raw
      } catch {
        return null
      }
    },
    async set(dek) {
      if (dek.length !== 32) throw new Error(`invalid DEK length: ${dek.length} (expected 32)`) // AES-256
      try {
        await chrome.storage.session.set({ [DEK_KEY]: bytesToBase64(dek) })
      } catch {
        // 会话存储不可用（扩展重载中上下文失效等）：吞掉，不影响解锁主流程
      }
    },
    async clear() {
      try {
        await chrome.storage.session.remove(DEK_KEY)
      } catch {
        // 同 set：环境性失败吞掉（锁定本身已在内存丢弃 DEK）
      }
    },
  }
}
