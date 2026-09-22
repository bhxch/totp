import { computeEntryCode, entryMatchesUrl, type OtpEntry } from '@totp/core'

/** 响应载荷（mcp_respond 契约，与 Rust BridgeShared 对齐） */
export type McpResult = { ok: true; result: unknown } | { ok: false; error: string }

export interface McpBridgeDeps {
  /** 解锁则返回当前条目；锁定/未就绪抛错（文案即 MCP 错误文案） */
  requireEntries: () => readonly OtpEntry[]
  tagsOf: (e: OtpEntry) => string[]
  /** 触发器（spec §6.1）：只回受理状态，绝不返回 vault 数据；前置不满足回结构化 reason */
  triggerSync: () => Promise<{ triggered: boolean; reason?: string }>
  triggerBackup: () => Promise<{ triggered: boolean; reason?: string }>
}

export interface McpRequestPayload {
  id: number
  tool: string
  args: { filter?: string; url?: string; account_id?: string }
}

/** list_accounts 的筛选：文本 filter（issuer/label 包含，大小写不敏感）∩ url match 引擎 */
export function filterAccounts(
  entries: readonly OtpEntry[],
  filter?: string,
  url?: string,
): OtpEntry[] {
  let list = [...entries]
  if (filter) {
    const f = filter.toLowerCase()
    list = list.filter((e) => e.issuer.toLowerCase().includes(f) || e.label.toLowerCase().includes(f))
  }
  if (url) list = list.filter((e) => entryMatchesUrl(e, url))
  return list
}

/** 列表输出的公开字段白名单——secret/pin/matchRules 等绝不外泄（安全契约，勿增删） */
function toPublic(e: OtpEntry, tagsOf: (e: OtpEntry) => string[]) {
  return { id: e.uuid, issuer: e.issuer, label: e.label, type: e.type, tags: tagsOf(e) }
}

/** 事件桥请求处理（纯逻辑，可测）；错误文案直接到达 AI 模型，保持可执行性 */
export async function handleMcpRequest(deps: McpBridgeDeps, payload: McpRequestPayload): Promise<McpResult> {
  try {
    if (payload.tool === 'list_accounts') {
      const accounts = filterAccounts(deps.requireEntries(), payload.args.filter, payload.args.url)
        .map((e) => toPublic(e, deps.tagsOf))
      return { ok: true, result: { accounts } }
    }
    if (payload.tool === 'get_code') {
      const id = payload.args.account_id
      if (!id) return { ok: false, error: 'account_id is required' }
      const e = deps.requireEntries().find((x) => x.uuid === id)
      if (!e) return { ok: false, error: `unknown account_id: ${id}; call list_accounts first` }
      const r = await computeEntryCode(e, Date.now())
      if (e.type === 'hotp') {
        return { ok: true, result: { code: r.code, counter: r.counter, note: 'HOTP counter was peeked, not advanced' } }
      }
      return { ok: true, result: { code: r.code, expires_in_seconds: r.remaining, period: r.period } }
    }
    // 触发器（spec §6.1）：只透传受理状态 {triggered, reason?}，业务结果经宿主状态行呈现
    if (payload.tool === 'trigger_sync') return { ok: true, result: await deps.triggerSync() }
    if (payload.tool === 'trigger_backup') return { ok: true, result: await deps.triggerBackup() }
    return { ok: false, error: `unknown tool: ${payload.tool}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 触发器装配依赖（createMcpTriggers 消费） */
export interface McpTriggerIo {
  /** 前置守护：null=可受理；非 null=直接回该结构化拒绝（锁定/无口令，同步判定） */
  guard: () => { triggered: false; reason: string } | null
  runSync: () => Promise<unknown>
  runBackup: () => Promise<unknown>
}

/** 触发器装配工厂（spec §6.1；终审 I2 裁定受理即返回）：前置同步判定后启动触发通道但
 *  不等待——bridge_call 固定 5s 超时，慢同步/备份若 await 会把「仍在后台执行」误报成
 *  app busy；triggered=true=已受理执行，业务结果经宿主状态行呈现（runner 内部
 *  recordStatus/onError），触发失败不冒泡到工具响应（仅防未处理 rejection），绝不返回
 *  vault 数据，MCP 侧不轮询 */
export function createMcpTriggers(io: McpTriggerIo): Pick<McpBridgeDeps, 'triggerSync' | 'triggerBackup'> {
  function fire(run: () => Promise<unknown>): void {
    void Promise.resolve()
      .then(run)
      .catch(() => {})
  }
  return {
    triggerSync: async () => {
      const blocked = io.guard()
      if (blocked) return blocked
      fire(io.runSync)
      return { triggered: true }
    },
    triggerBackup: async () => {
      const blocked = io.guard()
      if (blocked) return blocked
      fire(io.runBackup)
      return { triggered: true }
    },
  }
}

/** 装配（App.vue 专用）：listen/inject 注入便于测试；返回卸载函数 */
export async function startMcpBridge(
  deps: McpBridgeDeps,
  io: {
    listen: (event: string, cb: (e: { payload: McpRequestPayload }) => void) => Promise<() => void>
    invoke: (cmd: string, args: unknown) => Promise<void>
  },
): Promise<() => void> {
  const unlisten = await io.listen('mcp://req', (e) => {
    // fire-and-forget 回传链补 catch（审查 Minor）：回传失败只告警不产生未处理 rejection
    void handleMcpRequest(deps, e.payload)
      .then((r) =>
        io.invoke('mcp_respond', {
          id: e.payload.id,
          ok: r.ok,
          result: r.ok ? r.result : null,
          error: r.ok ? null : r.error,
        }),
      )
      .catch((err) => console.warn('[mcp] mcp_respond failed', err))
  })
  return unlisten
}
