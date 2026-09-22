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
 * - 同 ident 10s 去重：窗口内重复事件只就地更新已排队项（不重复入队、不抢位次）；
 *   已裁定离队后的窗口内重试同样被挡（过窗口期的重试可再入队，仍给用户裁定机会）。
 *   去重键按通道隔离（T7）：首连批准后立即调用 action 工具是主流程，跨通道共享窗口
 *   会吞掉首次工具确认致其 Rust 侧 60s 超时
 * - 先弹出队首再回执（清窗防连点重复回执）
 * - 关闭=deny 回执进 Rust 侧 DENY_COOLDOWN 60s 冷却，不是静默丢弃——否则 "approval
 *   pending" 诱导 AI 每 10s 重试、对话框反复重开抢焦点
 * - 审批无会话无 TTL；回执失败仅告警不中断（客户端重试会再次弹审批窗，用户可再裁定）
 *
 * 工具级确认（spec §6.2，T7）共用同一 FIFO 与 10s 同 ident 去重口径，差异仅在：
 * 回执走 onDecide(allow)（宿主转 mcp_respond），close=deny 即 allow=false，逐次即焚；
 * 就地更新顶掉旧确认时旧 id 立即回 false 快速失败（Rust oneshot 不悬挂等 60s 超时） */
export function createMcpApprovalQueue(deps: McpApprovalQueueDeps) {
  const now = deps.now ?? Date.now
  // shallowRef + 整组替换（storeWrap 教训：深 ref 会对值做 reactive 深代理，成员 ref 语义全失）
  const queue = shallowRef<McpConsentItem[]>([])
  /** 队首待裁定项；null=无待裁定 */
  const current = computed(() => queue.value[0] ?? null)
  /** 排队中的待裁定数（含队首） */
  const size = computed(() => queue.value.length)
  // 去重键 = 通道前缀 + ident：各通道各自独立 10s 窗口（原单 map 按 ident 在 A/B 交错时
  // 会串窗口，跨通道共享更会吞主流程首次工具确认）
  const lastSeen = new Map<string, number>()
  /** 工具确认裁定回调登记（按 id）：入队登记、裁定/顶替/清算时消费恰一次 */
  const pendingDecide = new Map<number, McpToolDecide>()

  const dedupeKey = (e: McpConsentItem): string => ('id' in e ? `tool:${e.ident}` : `conn:${e.ident}`)

  /** 通用入队：同键 10s 窗口内 → 就地更新已排队项（onDisplaced 收到被顶掉的旧载荷，
   *  供工具确认对旧 id 快速回执）；窗口外 → 追加队尾。返回是否实际入队（窗口内重试
   *  且已离队被挡 → false，调用方需自行收敛该载荷的待决状态，见 Minor 1） */
  function upsert(item: McpConsentItem, onDisplaced?: (old: McpConsentItem) => void): boolean {
    const t = now()
    const key = dedupeKey(item)
    const last = lastSeen.get(key)
    if (last !== undefined && t - last < MCP_APPROVAL_DEDUPE_MS) {
      // 窗口内重复：仅更新已排队项载荷（保持位次、刷新窗口）；已离队的重试被窗口挡下（原语义：忽略）
      const idx = queue.value.findIndex((e) => dedupeKey(e) === key)
      if (idx >= 0) {
        const old = queue.value[idx]!
        const next = [...queue.value]
        next[idx] = item
        queue.value = next
        lastSeen.set(key, t)
        onDisplaced?.(old)
        return true
      }
      return false
    }
    lastSeen.set(key, t)
    queue.value = [...queue.value, item]
    return true
  }

  /** 审批事件入队：同 ident 10s 窗口内 → 就地更新已排队项；窗口外 → 追加队尾 */
  function enqueue(event: McpApprovalEvent): void {
    upsert({ ...event })
  }

  /** 工具级确认入队（spec §6.2）：与首连审批同一 FIFO/10s 去重口径；同 ident 窗口内
   *  重复事件就地更新（被顶掉的旧 id 立即回调 false 快速失败）；窗口内重试且已离队被挡
   *  时新 id 也立即回 false（审查 Minor 1：否则 onDecide 闭包泄漏且该 id 白等 Rust 60s 超时） */
  function queueToolConfirmation(payload: McpToolConfirmEvent, onDecide: McpToolDecide): void {
    pendingDecide.set(payload.id, onDecide)
    const queued = upsert({ ...payload }, (old) => {
      if (!('id' in old)) return
      const displaced = pendingDecide.get(old.id)
      pendingDecide.delete(old.id)
      if (displaced) safeDecide(displaced, false)
    })
    if (!queued) {
      pendingDecide.delete(payload.id)
      safeDecide(onDecide, false)
    }
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
