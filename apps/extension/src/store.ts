import { SECRET_BAG_KEY } from '@totp/core'
import { createVueStore, type VueStore } from '@totp/ui'
import { createDekSession } from './dekSession'
import { createChromeStorage } from './chromeStorage'
import { setConflictBadge } from './conflictBadge'

/** 共享 chrome.storage.local 适配器：vault 与 icons 同源（popup/options 各自建 IconStore 用） */
export const storageAdapter = createChromeStorage()

/** 浏览器同步推送调度：syncEnabled=false 短路不发消息，否则立即 sendMessage。
 *  不在页面端 debounce——popup 发完即可能失焦销毁，1s 合并窗口由 background 承接（SW 收到消息后合并） */
function scheduleSyncPush(s: VueStore): void {
  if (s.settings.syncEnabled !== true) return
  try {
    void chrome.runtime.sendMessage({ type: 'sync-push' }).catch(() => {}) // background 未就绪等场景不打扰
  } catch {
    // 扩展上下文失效（重载中）：忽略
  }
}

/** 扩展创建独立 store 的工厂：spec §7 末尾要求窗口独立解锁，popup/options 各持各的 locked/dek；
 *  windowId 决定闭包内的 Map 索引——同进程多 store 实例互不泄漏。
 *  onCommittedExtra（纯增量，Task 12）：经队列的全部写路径（commit/commitSettings/加解密 op 等）
 *  成功后在既有 sync-push 调度之后调用——options 页存活期自动云同步的变更通知由此接入；
 *  具名 commit/commitSettings 包装（下方）是 popup 单例路径，popup 无自动云同步 runner，不接 extra
 *  dekPersist（plan16 T12）：宿主会话级 DEK 存取（chrome.storage.session）——解锁必写、lock 必清；
 *  session 区跨扩展上下文共享，popup/options 各自传 createDekSession() 即达成共享解锁态
 *  （任一端解锁后另一端 initStore 自动恢复解锁；plan16 设计 §1 附带收益，取代原「窗口完全独立」语义） */
export function createExtensionStore(
  windowId: string,
  opts: {
    onCommittedExtra?: () => void
    dekPersist?: { get(): Promise<string | null>; set(dek: Uint8Array): Promise<void>; clear(): Promise<void> }
    /** 自写抑制窗口透传（ui createVueStore 同名参数，默认 500）；测试注入 0 验证远端通知即时生效 */
    selfWriteSuppressMs?: number
  } = {},
): VueStore {
  const s = createVueStore(storageAdapter, {
    windowId,
    dekPersist: opts.dekPersist,
    selfWriteSuppressMs: opts.selfWriteSuppressMs,
    registerSync: (cb) =>
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return
        // secretBag（审查 I7）：另一上下文（popup/options）写保管区 → 本上下文重读前进内存视图，
        // 否则两个 options 页并发写保管区可丢失先写者数据（键名取 core SECRET_BAG_KEY 常量防漂移）
        cb({ vault: !!changes['vault'], settings: !!changes['settings'], secretBag: !!changes[SECRET_BAG_KEY] })
      }),
    onCommitted: () => {
      scheduleSyncPush(s)
      opts.onCommittedExtra?.()
    },
    // 冲突裁决即时对账（badge 滞后修复）：裁决成功 → 持久计数键 + action badge 立即按新计数更新
    // （清零清 badge、非零保持/更新，setConflictBadge 数值驱动），与 cloudRunnerFactory onConflicts
    // 每轮同步的对账同口径——自动同步关闭时裁决完最后一条冲突也无需等下轮同步/重开 options 才清 badge
    onConflictCountChanged: (count) => {
      void storageAdapter.set('cloudConflictCount', JSON.stringify(count)).catch(() => {})
      setConflictBadge(count)
    },
  })
  return s
}

/** 失败不调度：commit reject（如锁定）时盘上未变更，推送无意义 */
export async function commit(fn: Parameters<NonNullable<ReturnType<typeof createVueStore>['commit']>>[0]): Promise<void> {
  if (!store) throw new Error('store not initialized')
  await store.commit(fn)
  scheduleSyncPush(store)
}

export async function commitSettings(): Promise<void> {
  if (!store) throw new Error('store not initialized')
  await store.commitSettings()
  scheduleSyncPush(store)
}

// ---------- popup 单例 ----------
/** popup 入口独立 store（windowId='popup'）：与 options 隔离，spec §7 末尾窗口独立解锁。
 *  dekPersist（plan16 T12）：popup 与 options 是不同上下文但共享同一 session 区——
 *  必须传才能读到 options 侧解锁写入的 DEK（「options 解锁 popup 即解锁」） */
export const store = createExtensionStore('popup', { dekPersist: createDekSession() })

export const {
  vault, initStore, registerStorageSync,
  locked, hasEncryption, unlock, lock, enableEncryption, disableEncryption, changePassphrase,
  prfSources, addPrfSourceOp, removePrfSourceOp, settings,
} = store
export const { commit: storeCommit, commitSettings: storeCommitSettings } = store

export const addEntryOp = store.addEntryOp
export const updateEntryOp = store.updateEntryOp
export const removeEntryOp = store.removeEntryOp
export const addTagOp = store.addTagOp
export const renameTagOp = store.renameTagOp
export const removeTagOp = store.removeTagOp
export const reorderOp = store.reorderOp
export const replaceAllOp = store.replaceAllOp