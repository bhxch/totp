// 空闲锁定判定（plan16 T6 / 设计 §1 锁定策略）：纯函数，宿主定时器驱动；
// 系统锁屏/重启触发不在本层。idleMinutes 非 int 或 <1 视为禁用（恒 false）。
export function shouldLockNow(input: { idleMinutes: number; lastActivityAt: number; now: number }): boolean {
  if (!Number.isInteger(input.idleMinutes) || input.idleMinutes < 1) return false
  return input.now - input.lastActivityAt >= input.idleMinutes * 60_000
}
