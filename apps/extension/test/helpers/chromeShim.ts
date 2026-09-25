/**
 * chrome 内存 shim 公共 fixture（P0 基建）：收敛 store.test（installChrome）、
 * dekSession.test（makeSessionArea）、syncEngine.test（makeArea）、lockEnforcer.test
 * （installChromeIdle）四处重复手写，并补齐 background 测试所需的 alarms 与
 * runtime 双向消息通道。`ext` 的模块导入期快照问题仍经 ../helpers/extApiMock 惰性桥
 * 解决（本 fixture 只负责向 globalThis.chrome 注入内存实现，两配套合用）。
 *
 * 覆盖面：
 * - storage：local/sync/session 三区（get(null)/get(keys)/set/remove/getBytesInUse/QUOTA_BYTES）；
 *   onChanged 经 emit 手动派发（不用例不自动派发——自写回声窗口语义由被测层处理，
 *   store.test 依赖「先写盘后手动 emit」的确定性时序）
 * - alarms：create 记录 + onAlarm 派发（emitAlarm 模拟触发）
 * - runtime：onMessage 注册 + sendMessage 双向通道（ack=listener 返回 true 后经 sendResponse
 *   应答；无监听 reject「Receiving end does not exist」与 Chrome 一致；receive 模拟入站消息）
 * - idle / action.setBadgeText：lockEnforcer 与 store 迁移所需；按需安装 idle
 *   （lockEnforcer 有「宿主无 idle 权限」降级用例，故 idle 仅在 opts.idle 给出时存在）
 *
 * 后续批次可按需在 opts/对象上扩展（如 contextMenus/notifications），不改既有形状。
 *
 * store 构造守则（桌面端 mock 工厂同款）：挂载测试一律
 * createVueStore(createMemoryStorage(), { windowId })，禁止把普通 store 传入 reactive 包装。
 */
import { vi } from 'vitest'

export type Store = Record<string, unknown>
export type ChangeDict = Record<string, { newValue?: unknown }>
export type OnChangedListener = (changes: ChangeDict, areaName: string) => void
export type IdleState = 'active' | 'idle' | 'locked'
export type MessageListener = (
  msg: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void

/** chrome.storage.Area 内存实现：data 直读直写（断言落盘内容用），API 方法走 chrome 语义 */
export interface StorageAreaShim {
  data: Store
  calls: { get: number; set: number; remove: number; getBytesInUse: number }
  QUOTA_BYTES: number
  get(keys: string | string[] | null): Promise<Store>
  set(obj: Store): Promise<void>
  remove(keys: string | string[]): Promise<void>
  getBytesInUse(): Promise<number>
}

export function makeStorageArea(initial: Store = {}): StorageAreaShim {
  const data: Store = { ...initial }
  const calls = { get: 0, set: 0, remove: 0, getBytesInUse: 0 }
  return {
    data,
    calls,
    QUOTA_BYTES: 102_400,
    async get(keys) {
      calls.get++
      if (keys === null) return { ...data }
      const list = typeof keys === 'string' ? [keys] : keys
      const out: Store = {}
      for (const k of list) if (k in data) out[k] = data[k]
      return out
    },
    async set(obj) {
      calls.set++
      Object.assign(data, obj)
    },
    async remove(keys) {
      calls.remove++
      for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k]
    },
    async getBytesInUse() {
      calls.getBytesInUse++
      return JSON.stringify(data).length
    },
  }
}

/** chrome.idle 内存实现：调用记录恒保留，行为经 on* 钩子/state 注入（lockEnforcer 迁移语义） */
export interface IdleShim {
  calls: { setDetectionInterval: number[]; queryState: number[] }
  state: IdleState
  onSetDetectionInterval: ((seconds: number) => void) | null
  onQueryState: ((cb: (s: IdleState) => void) => void) | null
  setDetectionInterval(seconds: number): void
  queryState(seconds: number, cb: (s: IdleState) => void): void
}

export interface ChromeShimOptions {
  /** 三区初始内容（注入即落盘，不派发 onChanged） */
  local?: Store
  sync?: Store
  session?: Store
  /** 给出才安装 chrome.idle（缺省不装，供「宿主无 idle 权限」降级用例） */
  idle?: {
    state?: IdleState
    onSetDetectionInterval?: ((seconds: number) => void) | null
    onQueryState?: ((cb: (s: IdleState) => void) => void) | null
  }
}

export interface ChromeShim {
  /** 注入 globalThis.chrome 的对象（生产代码经 extApi 惰性桥读取） */
  chrome: Record<string, unknown>
  local: StorageAreaShim
  sync: StorageAreaShim
  session: StorageAreaShim
  /** 手动派发 storage.onChanged（areaName 缺省 'local'） */
  emit(changes: ChangeDict, areaName?: string): void
  onChanged: {
    addListener(cb: OnChangedListener): void
    removeListener(cb: OnChangedListener): void
  }
  setBadgeText: ReturnType<typeof vi.fn>
  idle?: IdleShim
  alarms: {
    created: Array<{ name: string; info?: unknown }>
    create(name: string, info?: unknown): void
    clear(name?: string): Promise<boolean>
    onAlarm: { addListener(cb: (alarm: { name: string; scheduledTime?: number }) => void): void; removeListener(cb: (alarm: { name: string; scheduledTime?: number }) => void): void }
  }
  /** 模拟 alarm 到点触发 */
  emitAlarm(alarm: { name: string; scheduledTime?: number }): void
  /** 出站消息记录（sendMessage 语义经 chrome.runtime.sendMessage） */
  runtime: {
    sendMessage(msg: unknown): Promise<unknown>
    /** 模拟入站消息（他上下文发来），返回首个 sendResponse 应答 */
    receive(msg: unknown, sender?: unknown): Promise<unknown>
    messageListenerCount(): number
  }
  onMessage: {
    addListener(cb: MessageListener): void
    removeListener(cb: MessageListener): void
  }
  /** 移除注入（原始值非 undefined 则还原） */
  restore(): void
}

export function installChromeShim(opts: ChromeShimOptions = {}): ChromeShim {
  const local = makeStorageArea(opts.local)
  const sync = makeStorageArea(opts.sync)
  const session = makeStorageArea(opts.session)

  const onChangedListeners: OnChangedListener[] = []
  const alarmListeners: Array<(alarm: { name: string; scheduledTime?: number }) => void> = []
  const messageListeners: MessageListener[] = []

  const setBadgeText = vi.fn()

  const dispatchMessage = (msg: unknown, sender: unknown): Promise<unknown> => {
    const listeners = [...messageListeners]
    if (listeners.length === 0) {
      return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
    }
    return new Promise((resolve) => {
      let settled = false
      const sendResponse = (response?: unknown): void => {
        if (!settled) {
          settled = true
          resolve(response)
        }
      }
      let held = false
      for (const l of listeners) {
        try {
          if (l(msg, sender, sendResponse) === true) held = true
        } catch {
          // listener 抛错视为未响应（真实浏览器按 lastError 处理，不中断其他 listener）
        }
      }
      if (!held && !settled) resolve(undefined) // 已送达但无 ack：按「无应答」收束
    })
  }

  let idle: IdleShim | undefined
  if (opts.idle) {
    idle = {
      calls: { setDetectionInterval: [], queryState: [] },
      state: opts.idle.state ?? 'active',
      onSetDetectionInterval: opts.idle.onSetDetectionInterval ?? null,
      onQueryState: opts.idle.onQueryState ?? null,
      setDetectionInterval(seconds) {
        this.calls.setDetectionInterval.push(seconds)
        this.onSetDetectionInterval?.(seconds)
      },
      queryState(seconds, cb) {
        this.calls.queryState.push(seconds)
        if (this.onQueryState) this.onQueryState(cb)
        else cb(this.state)
      },
    }
  }

  const chrome: Record<string, unknown> = {
    storage: {
      local,
      sync,
      session,
      onChanged: {
        addListener(cb: OnChangedListener): void {
          onChangedListeners.push(cb)
        },
        removeListener(cb: OnChangedListener): void {
          const i = onChangedListeners.indexOf(cb)
          if (i >= 0) onChangedListeners.splice(i, 1)
        },
      },
    },
    alarms: {
      created: [] as Array<{ name: string; info?: unknown }>,
      create(this: { created: Array<{ name: string; info?: unknown }> }, name: string, info?: unknown): void {
        this.created.push({ name, info }) // 同名 create 在真实 API 为覆盖；记录序供断言
      },
      clear(): Promise<boolean> {
        return Promise.resolve(true)
      },
      onAlarm: {
        addListener(cb: (alarm: { name: string; scheduledTime?: number }) => void): void {
          alarmListeners.push(cb)
        },
        removeListener(cb: (alarm: { name: string; scheduledTime?: number }) => void): void {
          const i = alarmListeners.indexOf(cb)
          if (i >= 0) alarmListeners.splice(i, 1)
        },
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage: (msg: unknown): Promise<unknown> => dispatchMessage(msg, {}),
      onMessage: {
        addListener(cb: MessageListener): void {
          messageListeners.push(cb)
        },
        removeListener(cb: MessageListener): void {
          const i = messageListeners.indexOf(cb)
          if (i >= 0) messageListeners.splice(i, 1)
        },
      },
    },
    action: { setBadgeText },
  }
  if (idle) chrome.idle = idle

  const g = globalThis as unknown as { chrome?: unknown; browser?: unknown }
  const original = g.chrome
  g.chrome = chrome

  return {
    chrome,
    local,
    sync,
    session,
    emit(changes, areaName = 'local') {
      for (const l of [...onChangedListeners]) l(changes, areaName)
    },
    onChanged: {
      addListener(cb: OnChangedListener): void {
        onChangedListeners.push(cb)
      },
      removeListener(cb: OnChangedListener): void {
        const i = onChangedListeners.indexOf(cb)
        if (i >= 0) onChangedListeners.splice(i, 1)
      },
    },
    setBadgeText,
    idle,
    alarms: chrome.alarms as ChromeShim['alarms'],
    emitAlarm(alarm) {
      for (const l of [...alarmListeners]) l(alarm)
    },
    runtime: {
      sendMessage: (chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }).sendMessage,
      receive: (msg: unknown, sender: unknown = { id: 'test' }) => dispatchMessage(msg, sender),
      messageListenerCount: () => messageListeners.length,
    },
    onMessage: {
      addListener(cb: MessageListener): void {
        messageListeners.push(cb)
      },
      removeListener(cb: MessageListener): void {
        const i = messageListeners.indexOf(cb)
        if (i >= 0) messageListeners.splice(i, 1)
      },
    },
    restore() {
      const gg = globalThis as unknown as { chrome?: unknown }
      if (original === undefined) delete gg.chrome
      else gg.chrome = original
    },
  }
}
