import { computed, shallowRef } from 'vue'

/** 审批事件载荷（mcp://approval，与 Rust 侧对齐） */
export interface McpApprovalEvent {
  ident: string
  tool: string
}

/** 工具级确认载荷（mcp://tool-approval，与 Rust 侧对齐）：id 为 Rust BridgeShared
 *  oneshot 键，裁定后必须经 mcp_respond 回 {id, ok:true, result:allow, error:null} 恰一次 */
export interface McpToolConfirmEvent {
  id: number
  ident: string
  tool: string
}

/** 队列项：首连审批与工具级确认共用同一 FIFO（单对话框串行，防两类弹窗互相抢位）；
 *  以是否携带 id 区分通道（id=Rust oneshot 键，决定回执与 UI 形态随之分流） */
export type McpConsentItem = McpApprovalEvent | McpToolConfirmEvent

/** 通道判定守卫：是否工具级确认（携带 Rust oneshot id）。宿主回执分流与对话框形态
 *  切换统一走此守卫（裸 `'id' in x` 收窄对结构超集联合会得到 unknown，不可直接用） */
export function isToolConfirmItem(item: McpConsentItem): item is McpToolConfirmEvent {
  return 'id' in item
}

/** 审批裁定动作（三键统一走 mcp_approval_response 回执） */
export type McpApprovalAction = 'deny' | 'once' | 'trust'

/** 工具确认裁定回调：allow=true → mcp_respond 回 result:true；false=拒绝（含 close/dispose） */
export type McpToolDecide = (allow: boolean) => void | Promise<void>

/** 同 ident 去重窗口：防 AI 客户端等待裁定期间高频重试轰炸 webview */
export const MCP_APPROVAL_DEDUPE_MS = 10_000

export interface McpApprovalQueueDeps {
  /** 回执注入（mcp_approval_response）：deny=冷却/once=限时放行/trust=入白名单 */
  respond: (ident: string, action: McpApprovalAction) => Promise<void> | void
  /** 时钟注入（测试钉死时间线），默认 Date.now */
  now?: () => number
}

/** 首连审批队列（原 App.vue 单槽位 approval 的并发根修）：对话框打开期间第二个不同
 *  ident 的审批事件曾直接覆盖前者，前者未获裁定可反复抢回，多客户端并发时弹窗乒乓；
 *  改为 FIFO 队列后每份审批都依次获得裁定。语义自原实现迁移：
 * - 同 ident 10s 去重（仅首连审批）：窗口内重复事件只就地更新已排队项（不重复入队、
 *   不抢位次）；已裁定离队后的窗口内重试同样被挡（过窗口期的重试可再入队，仍给用户
 *   裁定机会）。工具确认不做去重（见 queueToolConfirmation，B23）
 * - 先弹出队首再回执（清窗防连点重复回执）
 * - 关闭=deny 回执进 Rust 侧 DENY_COOLDOWN 60s 冷却，不是静默丢弃——否则 "approval
 *   pending" 诱导 AI 每 10s 重试、对话框反复重开抢焦点
 * - 审批无会话无 TTL；回执失败仅告警不中断（客户端重试会再次弹审批窗，用户可再裁定）
 *
 * 工具级确认（spec §6.2，T7）共用同一 FIFO，差异仅在：回执走 onDecide(allow)（宿主转
 * mcp_respond），close=deny 即 allow=false，逐次即焚；不走 10s 同 ident 去重——id 是 Rust
 * BridgeShared oneshot 键，一次 tools/call 唯一对应一次确认，同 ident 先后两次调用是两个
 * 独立请求而非重试（B23：按 ident 合并会把第一份确认顶掉自动拒绝、第二份离队窗口内被挡
 * 也被自动拒绝，均未等用户裁定）；防高频轰炸由「单对话框串行 + Rust 60s 超时 fail-closed +
 * dispose 清算」承担，逐次裁定语义不变 */
export function createMcpApprovalQueue(deps: McpApprovalQueueDeps) {
  const now = deps.now ?? Date.now
  // shallowRef + 整组替换（storeWrap 教训：深 ref 会对值做 reactive 深代理，成员 ref 语义全失）
  const queue = shallowRef<McpConsentItem[]>([])
  /** 队首待裁定项；null=无待裁定 */
  const current = computed(() => queue.value[0] ?? null)
  /** 排队中的待裁定数（含队首） */
  const size = computed(() => queue.value.length)
  // 去重键 = 通道前缀 + ident：首连审批各自独立 10s 窗口（原单 map 按 ident 在 A/B 交错时
  // 会串窗口）；仅作用于首连审批（工具确认不进去重，见 queueToolConfirmation）
  const lastSeen = new Map<string, number>()
  /** 工具确认裁定回调登记（按 id）：入队登记、裁定/清算时消费恰一次 */
  const pendingDecide = new Map<number, McpToolDecide>()

  const dedupeKey = (e: McpConsentItem): string => `conn:${e.ident}`

  /** 首连审批入队：同 ident 10s 窗口内 → 就地更新已排队项（保持位次、刷新窗口）；
   *  已裁定离队后的窗口内重试被挡（原语义：忽略，过窗口期可再入队） */
  function enqueue(event: McpApprovalEvent): void {
    const t = now()
    const key = dedupeKey(event)
    const last = lastSeen.get(key)
    if (last !== undefined && t - last < MCP_APPROVAL_DEDUPE_MS) {
      const idx = queue.value.findIndex((e) => !('id' in e) && e.ident === event.ident)
      if (idx >= 0) {
        const next = [...queue.value]
        next[idx] = { ...event }
        queue.value = next
        lastSeen.set(key, t)
      }
      return
    }
    lastSeen.set(key, t)
    queue.value = [...queue.value, { ...event }]
  }

  /** 工具级确认入队（spec §6.2）：与首连审批同一 FIFO 串行（单对话框防互相抢位），但不做
   *  同 ident 去重——每次 tools/call 的 id 唯一（Rust alloc_id），逐次两键裁定语义要求每份
   *  确认都获得用户裁定（B23 回归）；裁定经 resolveTool 恰一次回执，迟到 id no-op */
  function queueToolConfirmation(payload: McpToolConfirmEvent, onDecide: McpToolDecide): void {
    pendingDecide.set(payload.id, onDecide)
    queue.value = [...queue.value, { ...payload }]
  }

  /** 裁定回调安全执行：同步调用恰一次（与 respond 同时机）；同步抛错或返回 Promise 拒绝
   *  均仅告警不中断（与回执失败同口径，不产生未处理 rejection） */
  function safeDecide(decide: McpToolDecide, allow: boolean): void {
    try {
      Promise.resolve(decide(allow)).catch((e) => console.warn('[mcp] tool confirm decide failed', e))
    } catch (e) {
      console.warn('[mcp] tool confirm decide failed', e)
    }
  }

  /** 裁定队首审批：ident 不匹配/空队列/队首是工具确认一律 no-op（防错位与过期点击回执）；
   *  先弹出再回执（清窗防连点重复回执） */
  function resolve(ident: string, action: McpApprovalAction): void {
    const head = queue.value[0]
    if (!head || 'id' in head || head.ident !== ident) return
    queue.value = queue.value.slice(1)
    // 回执失败仅告警不中断（客户端重试会再次弹审批窗，用户可再裁定）
    Promise.resolve(deps.respond(ident, action)).catch((e) => console.warn('[mcp] mcp_approval_response failed', e))
  }

  /** 裁定队首工具确认：id 不匹配/队首是首连审批一律 no-op；先弹出再回调恰一次 */
  function resolveTool(id: number, allow: boolean): void {
    const head = queue.value[0]
    if (!head || !('id' in head) || head.id !== id) return
    queue.value = queue.value.slice(1)
    const decide = pendingDecide.get(id)
    pendingDecide.delete(id)
    if (decide) safeDecide(decide, allow)
  }

  /** 关闭（Esc/遮罩）= 对队首按通道 deny：首连审批回执 deny 进 60s 冷却；工具确认回调
   *  allow=false（逐次即焚）。剩余队列继续；空队列安全 no-op */
  function close(): void {
    const head = queue.value[0]
    if (!head) return
    if ('id' in head) resolveTool(head.id, false)
    else resolve(head.ident, 'deny')
  }

  /** 卸载清算（宿主 onScopeDispose 调用）：全部未决工具确认立即回 false（不悬挂未决 id，
   *  Rust 60s 超时仅是兜底）；首连审批无 id 无 oneshot，随队列清空即可；去重窗口一并清空 */
  function dispose(): void {
    const pending = [...pendingDecide.entries()]
    pendingDecide.clear()
    queue.value = []
    lastSeen.clear()
    for (const [, decide] of pending) safeDecide(decide, false)
  }

  return { current, size, enqueue, queueToolConfirmation, resolve, resolveTool, close, dispose }
}
