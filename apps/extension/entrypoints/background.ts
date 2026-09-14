import { parseOtpUri } from '@totp/core'
import { PENDING_OTPAUTH_KEY } from '../src/pendingOtpauth'
import { pullSyncIfNewer, pushSync } from '../src/syncEngine'

/** 清剪贴板 alarm 名（chrome.alarms 同名 create 即覆盖 = 重复复制重置计时） */
const CLIPBOARD_CLEAR_ALARM = 'clipboard-clear'
/** offscreen document URL（WXT entrypoints/offscreen → 输出根目录 offscreen.html） */
const OFFSCREEN_URL = 'offscreen.html'
/** 调度消息未带 delayMs 时的兜底延迟 */
const DEFAULT_CLEAR_DELAY_MS = 30_000
/** sync-push 合并窗口：连写（如导入批量 commit）只触发一次推送 */
const SYNC_PUSH_MERGE_MS = 1_000
/** 右键菜单 id：把选中的 otpauth 链接导入为条目 */
const OTPAUTH_MENU_ID = 'otpauth-add'

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

/**
 * 发送 clear-clipboard 并等待 offscreen 回执：原实现裸发 sendMessage 后即返回，
 * SW 冷启动 / offscreen 未就绪时消息丢失，30s 清空承诺静默失效。
 * 3 次重试 + 每次 1s 超时，每次先 ensureOffscreen 再发，避免「文档存在但 listener 未挂上」竞态。
 */
async function clearClipboardWithRetry(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await ensureOffscreenDocument()
    } catch {
      // createDocument 失败（无 offscreen 权限等）：放弃本次
      return
    }
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (v: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(t)
        chrome.runtime.onMessage.removeListener(listener)
        resolve(v)
      }
      const t = setTimeout(() => finish(false), 1000)
      const listener = (m: { type?: string }): void => {
        if (m?.type === 'clear-clipboard-ack') finish(true)
      }
      chrome.runtime.onMessage.addListener(listener)
      chrome.runtime.sendMessage({ type: 'clear-clipboard' }).catch(() => finish(false))
    })
    if (ok) return
  }
}

export default defineBackground(() => {
  // C11：右键菜单在 SW 每次启动时注册，幂等：create 同 id 会抛错（lastError），吞掉即视为成功。
  // 原 onInstalled 注册在浏览器 SW 已被本扩展事件唤醒的场景下不触发，导致菜单偶发缺失。
  chrome.contextMenus.create(
    { id: OTPAUTH_MENU_ID, title: '将选中的 otpauth 链接添加为条目', contexts: ['selection'] },
    () => void chrome.runtime.lastError,
  )
  // 点击：selectionText 双重校验（前缀 + parseOtpUri）后写入 pendingOtpauth 并尝试打开 popup
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== OTPAUTH_MENU_ID) return
    const text = (info.selectionText ?? '').trim()
    let valid = false
    if (text.startsWith('otpauth://')) {
      try {
        parseOtpUri(text)
        valid = true
      } catch { /* 落入下方提示 */ }
    }
    if (!valid) {
      void chrome.notifications.create({
        type: 'basic',
        iconUrl: '/icon/128.png',
        title: 'TOTP 验证码工具',
        message: '选中文本不是有效的 otpauth 链接',
      })
      return
    }
    void chrome.storage.local
      .set({ [PENDING_OTPAUTH_KEY]: text })
      .then(() => {
        // openPopup 仅部分 Chromium 版本开放（需用户手势）；不可用时静默——用户点扩展图标即见预填。
        // M22：直接访问 chrome.action.openPopup（现代 chrome-types 已收录），删除原 `as unknown as {...}.openPopup?.()` 类型断言。
        try {
          const fn = (chrome.action as { openPopup?: () => unknown }).openPopup
          if (fn) {
            const result = fn.call(chrome.action)
            if (result instanceof Promise) void result.catch(() => {})
          }
        } catch { /* API 不存在/调用失败：静默降级 */ }
      })
      .catch(() => {}) // 写入失败极罕见，不打扰
  })

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
    // options 开启同步后主动调度一次拉取（开启开关只写 local settings，不触发 onChanged('sync')）
    if (msg?.type === 'sync-pull') void pullSyncIfNewer()
  })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CLIPBOARD_CLEAR_ALARM) return
    void clearClipboardWithRetry()
  })
  // 浏览器同步：sync 区任一键变化（本端 push 或他端经 Chrome 账号同步落库）→ 尝试拉取更新
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') void pullSyncIfNewer()
  })
  // SW 冷启动兜底：浏览器关闭期间他端推送已随账号云落库，重放时不会再触发 onChanged，
  // 启动即尝试拉取一次（engine 内复核 syncEnabled，关闭同步时无操作）
  void pullSyncIfNewer()
})
