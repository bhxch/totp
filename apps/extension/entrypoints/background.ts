import { pullSyncIfNewer, pushSync } from '../src/syncEngine'

/** 清剪贴板 alarm 名（chrome.alarms 同名 create 即覆盖 = 重复复制重置计时） */
const CLIPBOARD_CLEAR_ALARM = 'clipboard-clear'
/** offscreen document URL（WXT entrypoints/offscreen → 输出根目录 offscreen.html） */
const OFFSCREEN_URL = 'offscreen.html'
/** 调度消息未带 delayMs 时的兜底延迟 */
const DEFAULT_CLEAR_DELAY_MS = 30_000

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
  // popup/options 复制后发 {type:'schedule-clipboard-clear', delayMs}——popup 即将关闭，30s 清空须由后台承载
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'schedule-clipboard-clear') {
      // when 绝对时间触发；delayMs 为 30s 满足 Chrome 120+ 的 alarms 最小间隔 30s
      void chrome.alarms.create(CLIPBOARD_CLEAR_ALARM, { when: Date.now() + (typeof msg.delayMs === 'number' ? msg.delayMs : DEFAULT_CLEAR_DELAY_MS) })
    }
    // 页面端 store 薄封装在 commit/commitSettings 后调度（页面端已 debounce 1s + syncEnabled 短路，此处双保险复核）
    if (msg?.type === 'sync-push') {
      void pushSync()
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
