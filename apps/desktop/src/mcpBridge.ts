import { computeEntryCode, entryMatchesUrl, type OtpEntry } from '@totp/core'

/** 响应载荷（mcp_respond 契约，与 Rust BridgeShared 对齐） */
export type McpResult = { ok: true; result: unknown } | { ok: false; error: string }

export interface McpBridgeDeps {
  /** 解锁则返回当前条目；锁定/未就绪抛错（文案即 MCP 错误文案） */
  requireEntries: () => readonly OtpEntry[]
  tagsOf: (e: OtpEntry) => string[]
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
    return { ok: false, error: `unknown tool: ${payload.tool}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
