/**
 * Tauri 统一 mock 工厂（P0 基建）：desktop 测试的 Tauri 边界统一在此收敛，
 * 取代逐文件手写 vi.hoisted + vi.mock（既有先例 backupService.test.ts 保留不动）。
 *
 * 覆盖面（与 src 实际 invoke/listen/fs/window 使用面一一对应，见盘点底稿 D 节）：
 * - invoke：全部 36 个 Rust 命令（INVOKE_COMMANDS），按命令名注册 handler/返回值；
 *   未注册的已知命令返回 null（与 Rust Option 返回一致）；清单外命令视为命令名笔误，抛错提示
 *   （on/onReturn/listen 注册侧同口径 fail-loud，emit 侧保持宽松）
 * - 事件：@tauri-apps/api/event listen 的 6 类事件（EVENTS）+ emitTo 定向派发记录
 *   + getCurrentWindow onFocusChanged
 * - plugin-fs：tauriFs/backupService 用到的 8 个成员（含 BaseDirectory.AppData）
 * - 窗口：getCurrentWindow 的 label/hide/onFocusChanged
 *
 * 用法（四个 vi.mock 各自指向本工厂；路径按测试文件位置相对书写）：
 *   vi.mock('@tauri-apps/api/core', async () => (await import('./mocks/tauri')).invokeModule())
 *   vi.mock('@tauri-apps/api/event', async () => (await import('./mocks/tauri')).eventModule())
 *   vi.mock('@tauri-apps/api/window', async () => (await import('./mocks/tauri')).windowModule())
 *   vi.mock('@tauri-apps/plugin-fs', async () => (await import('./mocks/tauri')).fsModule())
 * 然后 import { tauriMock } from './mocks/tauri' 注册行为、emit 事件、断言调用。
 * vi.mock 提升于 import 之上，工厂模块在同一测试文件的模块图中单例共享，无需 vi.hoisted。
 *
 * store 构造守则（后续批次挂载测试）：createVueStore(createMemoryStorage(), { windowId })。
 * why：storeWrap 9 例实证 store 内部 shallowRef 约束，禁止把普通 store 传入 reactive 包装。
 */
import { vi } from 'vitest'

type Args = Record<string, unknown>
type CommandHandler = (args: Args | undefined) => unknown
type EventHandler = (e: { event: string; id: number; payload: unknown }) => void

/** src 实际调用的全部 Rust 命令（盘点底稿 D 节 25 个 + App.vue 的 mcp_revoke_approvals 等 31 个 + mini pin 2 个 = 33 个起步，后续批次续增 MCP 配置/审批响应与 devtools/释放策略，现 36 个） */
export const INVOKE_COMMANDS = [
  // 剪贴板暂存
  'stage_clipboard_write',
  'clipboard_clear_if_staged',
  // DEK 暂存
  'take_stashed_dek',
  'stash_dek',
  'clear_stashed_dek',
  // mini DEK 进程内槽（主窗→mini 解锁态同步）
  'set_mini_dek',
  'peek_mini_dek',
  'clear_mini_dek',
  // mini pin 态（spec §1.5 无边框标题区）
  'mini_pin_get',
  'mini_pin_set',
  // DPAPI / OS 解锁
  'os_auto_protect',
  'os_auto_unprotect',
  'os_auto_forget',
  'decrypt_dpapi',
  // 对话框授权
  'pick_dir_os',
  'pick_save_file_os',
  'pick_open_file_os',
  'dir_token_os',
  // 文件 IO
  'read_text_file_os',
  'write_text_file_os',
  'write_bytes_file_os',
  'list_backup_files_os',
  'remove_backup_file',
  'remove_backup_file_os',
  'read_import_file_os',
  'read_import_file_bytes_os',
  // MCP
  'mcp_get_config',
  'mcp_set_config',
  'mcp_regenerate_token',
  'mcp_revoke_approvals',
  'mcp_approval_response',
  'mcp_respond',
  // devtools / 释放策略
  'devtools_get_config',
  'devtools_set_config',
  'release_policy_get',
  'release_policy_set',
] as const

/** src 实际 listen 的事件（onFocusChanged 属 window API，见 window mock；mini-session 见 MiniApp 跟随主窗解锁联动） */
export const EVENTS = [
  'system-lock',
  'force-lock',
  'stash-dek-request',
  'mini-session',
  'mcp://approval',
  'mcp://tool-approval',
  'mcp://req',
] as const

// ---------------------------------------------------------------------------
// invoke：按命令名分发
// ---------------------------------------------------------------------------
const commandHandlers = new Map<string, CommandHandler>()

// mini pin 态变量（spec §1.5）：mini_pin_get 返回、mini_pin_set 更新（对应 Rust settings.json+缓存）
let miniPinned = false

/** 默认 handler（模块初始化与 reset 后重装）：未显式注册时 pin get/set 即可用，行为与 Rust 命令一致 */
function installDefaultCommandHandlers(): void {
  commandHandlers.set('mini_pin_get', () => miniPinned)
  commandHandlers.set('mini_pin_set', (args) => { miniPinned = args?.pinned === true })
}
installDefaultCommandHandlers()

export const invoke = vi.fn(async (cmd: string, args?: Args): Promise<unknown> => {
  if (!(INVOKE_COMMANDS as readonly string[]).includes(cmd)) {
    throw new Error(`[tauriMock] 未知 invoke 命令「${cmd}」——清单外命令视为笔误（已知 ${INVOKE_COMMANDS.length} 个，见 INVOKE_COMMANDS）`)
  }
  const handler = commandHandlers.get(cmd)
  return handler ? await handler(args) : null
})

/** 命令名笔误防护（与 invoke 侧 fail-loud 对齐）：注册时即抛，不留「永远打不到的 handler」 */
function assertKnownCommand(command: string): void {
  if (!(INVOKE_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`[tauriMock] 未知命令「${command}」——on/onReturn 仅接受 INVOKE_COMMANDS 清单内命令名（清单外视为笔误）`)
  }
}

/** 注册命令 handler（可抛错/返回 Promise；每次调用现求值；清单外命令名抛错） */
export function on(command: string, handler: CommandHandler): void {
  assertKnownCommand(command)
  commandHandlers.set(command, handler)
}

/** 注册命令静态返回值（Option 命令注册 null 即显式「取消/无」语义；清单外命令名抛错） */
export function onReturn(command: string, value: unknown): void {
  assertKnownCommand(command)
  commandHandlers.set(command, () => value)
}

/** 调用记录：按命令名过滤（缺省返回全部），供 toHaveBeenCalled 类断言外的内容断言 */
export function calls(command?: string): Array<{ command: string; args?: Args }> {
  const all = invoke.mock.calls.map(([c, a]) => ({ command: c as string, args: a as Args | undefined }))
  return command ? all.filter((x) => x.command === command) : all
}

// ---------------------------------------------------------------------------
// event：listen 注册表 + emit 派发（模拟 Rust 后端发事件）
// ---------------------------------------------------------------------------
const eventListeners = new Map<string, Set<EventHandler>>()
let eventIdSeq = 0

export const listen = vi.fn(async (event: string, cb: EventHandler): Promise<() => void> => {
  if (!(EVENTS as readonly string[]).includes(event)) {
    // 注册侧 fail-loud（emit 侧保持宽松：派发不存在监听的事件为无操作）
    throw new Error(`[tauriMock] 未知事件「${event}」——listen 仅接受 EVENTS 清单内事件名（清单外视为笔误）`)
  }
  let set = eventListeners.get(event)
  if (!set) {
    set = new Set()
    eventListeners.set(event, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
  }
})

/** 派发事件给已注册的 listen 回调（Tauri 事件载荷形状 { event, id, payload }） */
export function emit(event: string, payload: unknown): void {
  eventIdSeq++
  for (const cb of eventListeners.get(event) ?? []) cb({ event, id: eventIdSeq, payload })
}

/** 事件监听数（断言 listen 注册/卸载用） */
export function listenerCount(event: string): number {
  return eventListeners.get(event)?.size ?? 0
}

/** emitTo（主窗→指定窗口定向派发，miniSession 'mini-session' 用）：宽松记录不校验清单 */
export const emitTo = vi.fn(async (_target: string, _event: string, _payload?: unknown): Promise<void> => undefined)

/** 前端侧 emit（@tauri-apps/api/event 的 emit，mini-ready 首屏就绪上报用）：宽松记录不派发 */
export const frontendEmit = vi.fn(async (_event: string, _payload?: unknown): Promise<void> => undefined)

/** 前端 emit 调用记录：[event, payload] 元组列表（内容断言用） */
export function frontendEmitCalls(): Array<[string, unknown]> {
  return frontendEmit.mock.calls.map(([e, p]) => [e as string, p as unknown])
}

/** emitTo 调用记录：[target, event, payload] 元组列表（对齐 calls() 风格，内容断言用） */
export function emitToCalls(): Array<[string, string, unknown]> {
  return emitTo.mock.calls.map(([t, e, p]) => [t as string, e as string, p as unknown])
}

// ---------------------------------------------------------------------------
// window：getCurrentWindow 的使用面（App.vue/MiniApp.vue：label/hide/onFocusChanged）
// ---------------------------------------------------------------------------
type FocusHandler = (e: { payload: boolean }) => void
const focusListeners = new Set<FocusHandler>()
let currentWindowLabel = 'main'

export const window = {
  get label(): string {
    return currentWindowLabel
  },
  set label(v: string) {
    currentWindowLabel = v
  },
  hide: vi.fn(async (): Promise<void> => undefined),
  onFocusChanged: vi.fn(async (cb: FocusHandler): Promise<() => void> => {
    focusListeners.add(cb)
    return () => {
      focusListeners.delete(cb)
    }
  }),
}

/** 派发窗口失焦/聚焦（App.vue 失焦隐藏、MiniApp 聚焦重建链路的测试入口） */
export function emitFocusChanged(focused: boolean): void {
  for (const cb of focusListeners) cb({ payload: focused })
}

// ---------------------------------------------------------------------------
// plugin-fs：tauriFs.ts / backupService.ts 的使用面
// ---------------------------------------------------------------------------
export const fs = {
  exists: vi.fn(async (): Promise<boolean> => false),
  mkdir: vi.fn(async (): Promise<void> => undefined),
  readTextFile: vi.fn(async (): Promise<string> => ''),
  writeTextFile: vi.fn(async (): Promise<void> => undefined),
  rename: vi.fn(async (): Promise<void> => undefined),
  readDir: vi.fn(async (): Promise<Array<{ name: string }>> => []),
  remove: vi.fn(async (): Promise<void> => undefined),
}

/** 真实枚举值即字符串 'AppData'（backupService.test.ts 同款）；src 仅使用 AppData */
export const BaseDirectory = { AppData: 'AppData' } as const

// ---------------------------------------------------------------------------
// vi.mock 工厂入口 + reset
// ---------------------------------------------------------------------------
export function invokeModule() {
  return { invoke }
}
export function eventModule() {
  return { listen, emitTo, emit: frontendEmit }
}
export function windowModule() {
  return { getCurrentWindow: () => window }
}
export function fsModule() {
  return { ...fs, BaseDirectory }
}

function resetFsDefaults(): void {
  fs.exists.mockReset().mockImplementation(async () => false)
  fs.mkdir.mockReset().mockImplementation(async () => undefined)
  fs.readTextFile.mockReset().mockImplementation(async () => '')
  fs.writeTextFile.mockReset().mockImplementation(async () => undefined)
  fs.rename.mockReset().mockImplementation(async () => undefined)
  fs.readDir.mockReset().mockImplementation(async () => [])
  fs.remove.mockReset().mockImplementation(async () => undefined)
}

/** 回到干净态：清 handler/调用记录/事件与焦点监听/fs 行为。测试 beforeEach 调用 */
export function reset(): void {
  commandHandlers.clear()
  installDefaultCommandHandlers()
  miniPinned = false
  invoke.mockClear()
  listen.mockClear()
  emitTo.mockClear()
  frontendEmit.mockClear()
  eventListeners.clear()
  eventIdSeq = 0
  focusListeners.clear()
  currentWindowLabel = 'main'
  window.hide.mockClear()
  window.onFocusChanged.mockClear()
  resetFsDefaults()
}

/** 单一入口（测试文件只需 import 这个） */
export const tauriMock = {
  invoke,
  on,
  onReturn,
  calls,
  listen,
  emit,
  emitTo,
  emitToCalls,
  /** 前端侧 emit（@tauri-apps/api/event），与后端派发用的 emit（本对象顶层）区分 */
  event: { emit: frontendEmit },
  frontendEmitCalls,
  listenerCount,
  window,
  emitFocusChanged,
  fs,
  BaseDirectory,
  reset,
}
