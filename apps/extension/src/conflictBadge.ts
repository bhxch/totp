/**
 * 扩展 action badge（spec §4 冲突强提示，T11）：未裁决冲突数 >0 → 徽标「!」，=0 → 清空。
 * 调用点：cloudRunnerFactory onConflicts（每轮同步对账）+ options 挂载时按持久计数恢复。
 * 存在性守卫：测试环境（jsdom 无 chrome）、旧内核缺 action API、setBadgeText 拒绝（扩展上下文
 * 失效）一律静默跳过——badge 非关键路径，绝不影响同步主流程。
 */
export function setConflictBadge(count: number): void {
  try {
    if (typeof chrome === 'undefined' || !chrome.action?.setBadgeText) return
    void Promise.resolve(chrome.action.setBadgeText({ text: count > 0 ? '!' : '' })).catch(() => {})
  } catch { /* 上下文失效等：守卫兜底 */ }
}
