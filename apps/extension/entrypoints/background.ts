import { parsePastedText } from '@totp/core'
import { PENDING_OTPAUTH_KEY, encodePending } from '../src/pendingOtpauth'
import { decodeImageBytesToUri } from '../src/qrDecode'
import { pullSyncIfNewer, pushSync } from '../src/syncEngine'
import { handleCloudFetchMessage } from '../src/cloudFetchHandler'
import { canOpenPopup, ext } from '../src/extApi'

/** 清剪贴板 alarm 名（同名 create 即覆盖 = 重复复制重置计时） */
const CLIPBOARD_CLEAR_ALARM = 'clipboard-clear'
/** offscreen document URL（WXT entrypoints/offscreen → 输出根目录 offscreen.html） */
const OFFSCREEN_URL = 'offscreen.html'
/** 调度消息未带 delayMs 时的兜底延迟 */
const DEFAULT_CLEAR_DELAY_MS = 30_000
/** sync-push 合并窗口：连写（如导入批量 commit）只触发一次推送 */
const SYNC_PUSH_MERGE_MS = 1_000
/** 右键菜单 id：把选中的 otpauth 链接导入为条目 */
const OTPAUTH_MENU_ID = 'otpauth-add'
/** 右键菜单 id：识别图片中的 otpauth 二维码（C4，activeTab 随右键授予，零新增权限） */
const QR_IMAGE_MENU_ID = 'qr-decode-image'
/** 右键菜单 id：打开主界面态（popup 精简后管理面全在 options#/codes，快捷入口直达） */
const OPEN_MAIN_MENU_ID = 'otp-open-main'
/** Firefox 回退通知 id：notifications.onClicked 只认它（点击 → popup.html 标签页完成添加） */
const PENDING_NOTIFY_ID = 'totp-pending-add'
/** 批量导入通知 id（R5-I2）：多条分流可点击，onClicked 点击 → options#/codes 导入页 */
const BATCH_IMPORT_NOTIFY_ID = 'totp-batch-import'

/** 桌面通知单点（R16⑪ 三连收敛）：basic 通知样式恒同（图标/标题），仅 message 差异 */
function notify(message: string): void {
  // MV3 create 无 callback 重载返回 Promise：创建失败（图标缺失/上下文失效）会 reject——
  // fire-and-forget 吞掉，与 background 其余通道「吞 rejection」口径对齐，防 unhandled rejection
  void ext!.notifications
    .create({
      type: 'basic',
      iconUrl: '/icon/128.png',
      title: 'TOTP 验证码工具',
      message,
    })
    .catch(() => {})
}

/** 带 id 可点击通知（R5-I2 收敛四处样板）：点击经 notifications.onClicked 按 id 直达对应页面；
 * create 失败 fire-and-forget 吞掉（同 notify 口径） */
function notifyClickable(id: string, message: string): void {
  void ext!.notifications
    .create(id, {
      type: 'basic',
      iconUrl: '/icon/128.png',
      title: 'TOTP 验证码工具',
      message,
    })
    .catch(() => {})
}

/** 确保 offscreen document 存在：每扩展仅允许一个，重复 createDocument 会抛错，捕获即「已存在」 */
async function ensureOffscreenDocument(): Promise<void> {
  try {
    await ext!.offscreen.createDocument({
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
    // C4:ensureOffscreenDocument 内层已吞一切(createDocument 抛错即视为已存在),
    // 此处 catch 不可达——删死防御;「无 offscreen 权限」场景由内层静默保留复用语义
    await ensureOffscreenDocument()
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (v: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(t)
        ext!.runtime.onMessage.removeListener(listener)
        resolve(v)
      }
      const t = setTimeout(() => finish(false), 1000)
      const listener = (m: { type?: string }): void => {
        if (m?.type === 'clear-clipboard-ack') finish(true)
      }
      ext!.runtime.onMessage.addListener(listener)
      ext!.runtime.sendMessage({ type: 'clear-clipboard' }).catch(() => finish(false))
    })
    if (ok) return
  }
}

export default defineBackground(() => {
  // C11：右键菜单在 SW 每次启动时注册，幂等：create 同 id 会抛错（lastError），吞掉即视为成功。
  // 原 onInstalled 注册在浏览器 SW 已被本扩展事件唤醒的场景下不触发，导致菜单偶发缺失。
  ext!.contextMenus.create(
    { id: OTPAUTH_MENU_ID, title: '将选中的验证码内容添加为条目', contexts: ['selection'] },
    () => void ext!.runtime.lastError,
  )
  ext!.contextMenus.create(
    { id: QR_IMAGE_MENU_ID, title: '识别图中的验证码二维码', contexts: ['image'] },
    () => void ext!.runtime.lastError,
  )
  // P4：action 图标右键 / 页面右键均可直达主界面态（URL 与 popup「打开主界面」按钮同源）
  ext!.contextMenus.create(
    { id: OPEN_MAIN_MENU_ID, title: '打开主界面', contexts: ['action', 'page'] },
    () => void ext!.runtime.lastError,
  )
  // 点击：listener 改 async（MV3 只要求 addListener 本身同步注册；事件回调返回的 promise 被
  // Chrome 忽略，无副作用），async 化使 QR 分支可直接 await fetch/storage，分支复用三件套
  ext!.contextMenus.onClicked.addListener(async (info) => {
    // C4 图片识别：activeTab 权限随本次右键点击授予该 tab 的源访问权，fetch 图片字节后本地解码。
    // fetch 被权限/CORS 拒绝（Failed to fetch）、解码失败、内容非 otpauth → 统一失败通知
    if (info.menuItemId === QR_IMAGE_MENU_ID) {
      const src = info.srcUrl ?? ''
      let uri: string | null = null
      try {
        const res = await fetch(src)
        uri = await decodeImageBytesToUri(new Uint8Array(await res.arrayBuffer()))
      } catch { uri = null }
      if (uri === null) {
        notify('图中未识别到有效的 otpauth 二维码')
        return
      }
      // P5：写盘升级为 pending 信封（kind=uri），popup 消费端按 kind 分派
      await ext!.storage.local.set({ [PENDING_OTPAUTH_KEY]: encodePending({ v: 1, kind: 'uri', text: uri }) })
      // M4：成功也发带 id 通知（复用 totp-pending-add 通道）——Firefox 等无 openPopup 宿主
      // 点击通知经 notifications.onClicked 打开 popup.html 消费 pending（kind=uri 信封链路同）；
      // Chromium 通知常驻可点，作 openPopup 缺席时的兜底入口。失败路径仍普通 notify（无 pending 可消费）
      notifyClickable(PENDING_NOTIFY_ID, '已识别验证码二维码，点击完成添加')
      return
    }
    // P4 打开主界面：tabs.create 建新标签页直达 options#/codes；create 失败（浏览器侧极少）吞掉
    if (info.menuItemId === OPEN_MAIN_MENU_ID) {
      void ext!.tabs.create({ url: ext!.runtime.getURL('options.html#/codes') }).catch(() => {})
      return
    }
    if (info.menuItemId !== OTPAUTH_MENU_ID) return
    // P5：选中文本交 parsePastedText 全格式嗅探（P2 粘贴白名单：otpauth URI 行/SteamGuard JSON/
    // base32 等），不再本地只认 otpauth URI。单条 → 写 pending 信封（原始文本整体，popup 消费端
    // 复解得到同一结果）+ openPopup 尝试；多条 → 批量在导入页做，仅通知条数引导；0 条（含
    // 格式不识别）→ 透传嗅探引导文案或通用提示，不写 pending、不 openPopup。
    const text = (info.selectionText ?? '').trim()
    const parsed = parsePastedText(text)
    if ('unsupported' in parsed) {
      notify(parsed.unsupported)
      return
    }
    if (parsed.entries.length === 0) {
      notify('未识别出可导入的条目')
      return
    }
    if (parsed.entries.length > 1) {
      // R5-I2：多条分流通知带 id 可点击——点击直达 options#/codes 导入页（对齐「打开主界面」
      // 菜单行为）；旧 notify() 无 id 点击无动作、文案指路含糊（浏览器通知点击后自动消失，
      // 无需手动 clear）
      notifyClickable(BATCH_IMPORT_NOTIFY_ID, `识别到 ${parsed.entries.length} 条，点击通知打开主界面完成批量添加`)
      return
    }
    void ext!.storage.local
      .set({ [PENDING_OTPAUTH_KEY]: encodePending({ v: 1, kind: 'pasted', text }) })
      .then(() => {
        // openPopup 仅部分 Chromium 版本开放（需用户手势）；Firefox 等无此能力 → 发带 id 通知，
        // 点击经 notifications.onClicked 监听打开 popup.html 标签页完成添加。
        // M22：canOpenPopup 探测后直调 action.openPopup（现代 chrome-types 已收录）。
        try {
          if (canOpenPopup()) {
            const result = (ext!.action as { openPopup: () => unknown }).openPopup()
            if (result instanceof Promise) {
              // R5-M3：openPopup reject（无用户手势等）时 pending 已写但既无弹窗也无通知——
              // 兜底发 PENDING_NOTIFY_ID 保住「点击完成添加」入口，信封不滞留成零反馈孤儿
              void result.catch(() => notifyClickable(PENDING_NOTIFY_ID, '已识别待添加内容，点击完成添加'))
            }
          } else {
            notifyClickable(PENDING_NOTIFY_ID, '已识别待添加内容，点击完成添加')
          }
        } catch { /* API 不存在/调用失败：静默降级 */ }
      })
      .catch(() => {}) // 写入失败极罕见，不打扰
  })

  // P5 Firefox 回退：无 openPopup 能力时选择分支写入 pending 后发 PENDING_NOTIFY_ID 通知；
  // 点击通知 → popup.html 作标签页打开，自动走 consumePendingOtpauth（ext+otpauth 协议回调
  // 先例同路径）。notify() 的默认通知无此 id，点击不动作。listener 挂在事件 target 上，
  // SW 生命周期内天然单例（defineBackground 冷启动重复执行不重复派发），顶层注册满足 MV3
  // SW 唤醒要求。R5-I2：批量导入通知点击 → options#/codes 导入页（通知点击后浏览器自动消失）
  ext!.notifications.onClicked.addListener((notificationId) => {
    if (notificationId === PENDING_NOTIFY_ID) {
      void ext!.tabs.create({ url: ext!.runtime.getURL('popup.html') }).catch(() => {})
      return
    }
    if (notificationId === BATCH_IMPORT_NOTIFY_ID) {
      void ext!.tabs.create({ url: ext!.runtime.getURL('options.html#/codes') }).catch(() => {})
    }
  })

  // 页面端写路径成功后立即发 {type:'sync-push'}（popup 发完即可能销毁，页面端不做 debounce）：
  // SW 内 1s 合并窗口把连写合并为一次推送；SW 被杀时消息本身会唤醒 SW 重新计时，推送不丢
  let syncPushTimer: ReturnType<typeof setTimeout> | undefined
  ext!.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 页面端云请求代理（③）：host_permissions 内 SW fetch 不受 CORS 限制，应答经 sendResponse 回传。
    // 云-I3：仅本扩展内部页面可驱动（sender.id === 自身 runtime id）；外部来源同步回结构化拒绝。
    // 无 externally_connectable 时外部页面 sender.id 为 undefined 天然被拒——将来加 content script
    // 也不会静默变成任意网页可驱动的出网中继。
    if (msg?.type === 'cloud-fetch') {
      return handleCloudFetchMessage(msg, sender, sendResponse, ext!.runtime.id)
    }
    // popup/options 复制后发 {type:'schedule-clipboard-clear', delayMs}——popup 即将关闭，30s 清空须由后台承载
    if (msg?.type === 'schedule-clipboard-clear') {
      // when 绝对时间触发；delayMs 为 30s 满足 Chrome 120+ 的 alarms 最小间隔 30s
      void ext!.alarms.create(CLIPBOARD_CLEAR_ALARM, { when: Date.now() + (typeof msg.delayMs === 'number' ? msg.delayMs : DEFAULT_CLEAR_DELAY_MS) })
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
  ext!.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CLIPBOARD_CLEAR_ALARM) return
    void clearClipboardWithRetry()
  })
  // 浏览器同步：sync 区任一键变化（本端 push 或他端经 Chrome 账号同步落库）→ 尝试拉取更新
  ext!.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') void pullSyncIfNewer()
  })
  // SW 冷启动兜底：浏览器关闭期间他端推送已随账号云落库，重放时不会再触发 onChanged，
  // 启动即尝试拉取一次（engine 内复核 syncEnabled，关闭同步时无操作）
  void pullSyncIfNewer()
})
