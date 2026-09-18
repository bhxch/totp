/** 审查 I10：desktop 锁定策略能力声明（SecurityCard lockPrefs.unsupported 隐藏机制）。 */

/** desktop 不支持的锁定策略键：
 * - lockOnRestart 全平台不支持：desktop 无会话级 DEK 存储（重启后无凭据可静默解锁，进程启动必锁），
 *   「重启后保持解锁」开关无实现支撑，隐藏防无效设置（与 ext 侧同口径，见 ext options App.vue）；
 * - lockOnSystemLock 仅 Windows 支持：系统锁屏事件源为 Rust lock_events（WTS 会话通知），
 *   macOS/Linux 为 no-op 空实现（挂账）恒不触发，非 Windows 平台隐藏该开关。
 *
 * UA 平台判定依据（与 App.vue unlockNaming 同源自审）：desktop 桌面壳 UA 形态——
 * Windows WebView2 恒含 "Windows NT"；macOS WKWebView 恒含 "Mac"（"Macintosh" 平台段）；
 * Linux 桌面 UA 恒含 "Linux"。桌面端不存在移动形态，非 Windows 即视为 mac/Linux 降级端。 */
export function lockPrefsUnsupportedKeys(ua: string): ReadonlyArray<'lockOnRestart' | 'lockOnSystemLock'> {
  if (/Windows/i.test(ua)) return ['lockOnRestart']
  return ['lockOnRestart', 'lockOnSystemLock']
}
