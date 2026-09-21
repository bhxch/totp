import { computed, shallowRef } from 'vue'

/** 审批事件载荷（mcp://approval，与 Rust 侧对齐） */
export interface McpApprovalEvent {
  ident: string
  tool: string
}

/** 审批裁定动作（三键统一走 mcp_approval_response 回执） */
export type McpApprovalAction = 'deny' | 'once' | 'trust'

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
 * - 同 ident 10s 去重：窗口内重复事件只就地更新已排队项（不重复入队、不抢位次）；
 *   已裁定离队后的窗口内重试同样被挡（过窗口期的重试可再入队，仍给用户裁定机会）
 * - 先弹出队首再回执（清窗防连点重复回执）
 * - 关闭=deny 回执进 Rust 侧 DENY_COOLDOWN 60s 冷却，不是静默丢弃——否则 "approval
 *   pending" 诱导 AI 每 10s 重试、对话框反复重开抢焦点
 * - 审批无会话无 TTL；回执失败仅告警不中断（客户端重试会再次弹审批窗，用户可再裁定） */
export function createMcpApprovalQueue(deps: McpApprovalQueueDeps) {
  const now = deps.now ?? Date.now
  // shallowRef + 整组替换（storeWrap 教训：深 ref 会对值做 reactive 深代理，成员 ref 语义全失）
  const queue = shallowRef<McpApprovalEvent[]>([])
  /** 队首待审批；null=无待审批 */
  const current = computed(() => queue.value[0] ?? null)
  /** 排队中的审批数（含队首） */
  const size = computed(() => queue.value.length)
  // 同 ident 上次入队/更新时刻：按 ident 各自独立判定（原单槽位 lastApproval 在 A/B
  // 交错时 B 入队会顶掉 A 的窗口记录，致 A 窗口内重试漏过去重）
  const lastSeen = new Map<string, number>()

  /** 审批事件入队：同 ident 10s 窗口内 → 就地更新已排队项；窗口外 → 追加队尾 */
  function enqueue(event: McpApprovalEvent): void {
    const t = now()
    const last = lastSeen.get(event.ident)
    if (last !== undefined && t - last < MCP_APPROVAL_DEDUPE_MS) {
      // 窗口内重复：仅更新已排队项载荷（保持位次、刷新窗口）；已离队的重试被窗口挡下（原语义：忽略）
      const idx = queue.value.findIndex((e) => e.ident === event.ident)
      if (idx >= 0) {
        const next = [...queue.value]
        next[idx] = event
        queue.value = next
        lastSeen.set(event.ident, t)
      }
      return
    }
    lastSeen.set(event.ident, t)
    queue.value = [...queue.value, event]
  }

  /** 裁定队首：ident 不匹配/空队列一律 no-op（防错位与过期点击回执）；
   *  先弹出再回执（清窗防连点重复回执） */
  function resolve(ident: string, action: McpApprovalAction): void {
    const head = queue.value[0]
    if (!head || head.ident !== ident) return
    queue.value = queue.value.slice(1)
    // 回执失败仅告警不中断（客户端重试会再次弹审批窗，用户可再裁定）
    Promise.resolve(deps.respond(ident, action)).catch((e) => console.warn('[mcp] mcp_approval_response failed', e))
  }

  /** 关闭（Esc/遮罩）= 对队首 deny 回执后弹出（进 60s 冷却，非静默弃单），剩余队列继续；
   *  空队列安全 no-op */
  function close(): void {
    const head = queue.value[0]
    if (head) resolve(head.ident, 'deny')
  }

  return { current, size, enqueue, resolve, close }
}
