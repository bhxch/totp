import { pullSyncIfNewer, pushSync } from '../src/syncEngine'

/** 清剪贴板 alarm 名（chrome.alarms 同名 create 即覆盖 = 重复复制重置计时） */
const CLIPBOARD_CLEAR_ALARM = 'clipboard-clear'
/** offscreen document URL（WXT entrypoints/offscreen → 输出根目录 offscreen.html） */
const OFFSCREEN_URL = 'offscreen.html'
/** 调度消息未带 delayMs 时的兜底延迟 */
const DEFAULT_CLEAR_DELAY_MS = 30_000
/** sync-push 合并窗口：连写（如导入批量 commit）只触发一次推送 */
const SYNC_PUSH_MERGE_MS = 1_000

/** 确保 offscreen document 存在：每扩展仅允许一个，重复 createDocument 会抛错，捕获即「已存在」 */
async function ensureOffscreenDocument(): Promise<void> {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['CLIPBOARD'],
      justification: '清空剪贴板（验证码复制 30s 后自动清空，popup 已关闭需后台承载）',
    })
  } catch {
    // offscreen document 已存在：保留复用（取简单者，不做用后关闭）
  }
}

export default defineBackground(() => {
  // 页面端写路径成功后立即发 {type:'sync-push'}（popup 发完即可能销毁，页面端不做 debounce）：
  // SW 内 1s 合并窗口把连写合并为一次推送；SW 被杀时消息本身会唤醒 SW 重新计时，推送不丢
  let syncPushTimer: ReturnType<typeof setTimeout> | undefined
  chrome.runtime.onMessage.addListener((msg) => {
    // popup/options 复制后发 {type:'schedule-clipboard-clear', delayMs}——popup 即将关闭，30s 清空须由后台承载
    if (msg?.type === 'schedule-clipboard-clear') {
      // when 绝对时间触发；delayMs 为 30s 满足 Chrome 120+ 的 alarms 最小间隔 30s
      void chrome.alarms.create(CLIPBOARD_CLEAR_ALARM, { when: Date.now() + (typeof msg.delayMs === 'number' ? msg.delayMs : DEFAULT_CLEAR_DELAY_MS) })
    }
    if (msg?.type === 'sync-push') {
      if (syncPushTimer !== undefined) clearTimeout(syncPushTimer)
      syncPushTimer = setTimeout(() => {
        syncPushTimer = undefined
        void pushSync() // syncEngine 内复核 syncEnabled（双保险）并串行化
      }, SYNC_PUSH_MERGE_MS)
    }
  })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CLIPBOARD_CLEAR_ALARM) return
    void ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: 'clear-clipboard' }))
      .catch(() => {}) // offscreen 消息无人应答等场景不打扰
  })
  // 浏览器同步：sync 区任一键变化（本端 push 或他端经 Chrome 账号同步落库）→ 尝试拉取更新
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') void pullSyncIfNewer()
  })
})
