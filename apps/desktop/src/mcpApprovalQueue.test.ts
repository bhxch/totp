import { describe, expect, it, vi } from 'vitest'
import { createMcpApprovalQueue, type McpApprovalAction, type McpApprovalEvent } from './mcpApprovalQueue'

/** fake 事件与时钟注入 harness：receipts 记录回执，advance 推进假时钟 */
function harness(respond?: (ident: string, action: McpApprovalAction) => Promise<void> | void) {
  let t = 0
  const receipts: Array<{ ident: string; action: McpApprovalAction }> = []
  const q = createMcpApprovalQueue({
    respond: respond ?? ((ident, action) => { receipts.push({ ident, action }) }),
    now: () => t,
  })
  const advance = (ms: number) => { t += ms }
  return { q, receipts, advance }
}
const ev = (ident: string, tool = 'list_accounts'): McpApprovalEvent => ({ ident, tool })

describe('createMcpApprovalQueue', () => {
  it('入队顺序 FIFO：current 恒为队首，size 计数', () => {
    const { q } = harness()
    expect(q.current.value).toBeNull()
    expect(q.size.value).toBe(0)
    q.enqueue(ev('a'))
    q.enqueue(ev('b'))
    q.enqueue(ev('c'))
    expect(q.current.value?.ident).toBe('a')
    expect(q.size.value).toBe(3)
  })

  it('同 ident 10s 窗口内重复 → 就地更新不重复入队（保持位次）', () => {
    const { q, advance } = harness()
    q.enqueue(ev('a', 'tool-old'))
    q.enqueue(ev('b'))
    advance(5_000)
    q.enqueue(ev('a', 'tool-new'))
    expect(q.size.value).toBe(2)
    expect(q.current.value).toEqual({ ident: 'a', tool: 'tool-new' })
  })

  it('resolve 弹出队首并回执，current 前移到下一个', () => {
    const { q, receipts } = harness()
    q.enqueue(ev('a'))
    q.enqueue(ev('b'))
    q.resolve('a', 'once')
    expect(receipts).toEqual([{ ident: 'a', action: 'once' }])
    expect(q.current.value?.ident).toBe('b')
    expect(q.size.value).toBe(1)
  })

  it('resolve ident 不匹配或空队列 → no-op 不回执（防错位/过期点击）', () => {
    const { q, receipts } = harness()
    q.enqueue(ev('a'))
    q.resolve('nope', 'deny')
    expect(receipts).toEqual([])
    expect(q.size.value).toBe(1)
    q.resolve('a', 'deny')
    q.resolve('a', 'deny') // 空队列再点
    expect(receipts).toEqual([{ ident: 'a', action: 'deny' }])
    expect(q.size.value).toBe(0)
  })

  it('close = deny 当前队首并弹出（进冷却），剩余队列继续', () => {
    const { q, receipts } = harness()
    q.enqueue(ev('a'))
    q.enqueue(ev('b'))
    q.close()
    expect(receipts).toEqual([{ ident: 'a', action: 'deny' }])
    expect(q.current.value?.ident).toBe('b')
    expect(q.size.value).toBe(1)
  })

  it('空队列 close 安全：不回执不抛错', () => {
    const { q, receipts } = harness()
    expect(() => q.close()).not.toThrow()
    expect(receipts).toEqual([])
    expect(q.current.value).toBeNull()
  })

  it('已裁定离队后的重试：窗口内被挡（不复活），过 10s 窗口可再入队', () => {
    const { q, advance } = harness()
    q.enqueue(ev('a'))
    q.resolve('a', 'deny')
    advance(5_000)
    q.enqueue(ev('a'))
    expect(q.size.value).toBe(0) // 窗口内重试被去重挡下
    advance(5_000) // 距上次入队恰 10s：窗口期已过
    q.enqueue(ev('a'))
    expect(q.current.value?.ident).toBe('a')
  })

  it('先弹出再回执（清窗防连点重复回执）', () => {
    const { q, receipts } = harness()
    q.enqueue(ev('a'))
    q.resolve('a', 'trust')
    q.resolve('a', 'trust') // 连点第二次：队首已弹，ident 不再匹配
    expect(receipts).toEqual([{ ident: 'a', action: 'trust' }])
  })

  it('回执失败仅告警不中断（先弹出已落地，不产生未处理 rejection）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const respond = vi.fn(() => Promise.reject(new Error('rpc down')))
    const { q } = harness(respond)
    q.enqueue(ev('a'))
    expect(() => q.resolve('a', 'deny')).not.toThrow()
    expect(q.size.value).toBe(0) // 弹出不受回执失败影响
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledWith('[mcp] mcp_approval_response failed', expect.any(Error))
    warn.mockRestore()
  })
})

describe('createMcpApprovalQueue 工具级确认（spec §6.2，T7）', () => {
  it('工具确认：FIFO 顺序决定并回调；同 ident 不同 id 各自独立入队（B23，不去重不顶替）', () => {
    const { q } = harness()
    const decided: Array<{ id: number; allow: boolean }> = []
    const record = (id: number) => (allow: boolean) => {
      decided.push({ id, allow })
    }
    q.queueToolConfirmation({ id: 1, ident: 'a', tool: 'trigger_sync' }, record(1))
    q.queueToolConfirmation({ id: 2, ident: 'b', tool: 'trigger_backup' }, record(2))
    // 同 ident 窗口内的新确认（曾按 ident 顶替 id 1）：独立入队，无自动拒绝
    q.queueToolConfirmation({ id: 3, ident: 'a', tool: 'trigger_sync' }, record(3))
    expect(q.size.value).toBe(3)
    expect(decided).toEqual([])
    expect(q.current.value).toEqual({ id: 1, ident: 'a', tool: 'trigger_sync' })
    // FIFO：队首 id 1 先裁；非队首 id no-op（防错位）
    q.resolveTool(3, true)
    expect(decided).toEqual([])
    q.resolveTool(1, true)
    q.resolveTool(2, true)
    q.resolveTool(3, true)
    expect(decided).toEqual([
      { id: 1, allow: true },
      { id: 2, allow: true },
      { id: 3, allow: true },
    ])
    expect(q.size.value).toBe(0)
  })

  it('B23 回归：同 ident 两个不同 id 工具确认 2s 内先后入队 → 各自独立裁定且回执 id 各自正确', () => {
    const { q, advance } = harness()
    const decided: Array<{ id: number; allow: boolean }> = []
    const record = (id: number) => (allow: boolean) => {
      decided.push({ id, allow })
    }
    // 同一客户端（ident 相同）2s 内连续两次 tools/call trigger_backup：两次是独立请求
    // （Rust 侧各持独立 oneshot id），都应获得用户裁定，不得被 10s 同 ident 去重窗合并/顶替
    q.queueToolConfirmation({ id: 1, ident: 'a', tool: 'trigger_backup' }, record(1))
    advance(2_000)
    q.queueToolConfirmation({ id: 2, ident: 'a', tool: 'trigger_backup' }, record(2))
    // 两个确认都入队（FIFO），任何一方都不得被自动拒绝
    expect(q.size.value).toBe(2)
    expect(decided).toEqual([])
    expect(q.current.value).toEqual({ id: 1, ident: 'a', tool: 'trigger_backup' })
    // 裁定第一个（Deny）：只有 id 1 被回执，id 2 仍在队首等待
    q.resolveTool(1, false)
    expect(decided).toEqual([{ id: 1, allow: false }])
    expect(q.current.value).toEqual({ id: 2, ident: 'a', tool: 'trigger_backup' })
    // 裁定第二个（Allow）：id 2 正常回执
    q.resolveTool(2, true)
    expect(decided).toEqual([
      { id: 1, allow: false },
      { id: 2, allow: true },
    ])
    expect(q.size.value).toBe(0)
  })

  it('拒绝路径：resolveTool(false) 与 close（Esc/遮罩）均回调 allow=false', () => {
    const { q, advance } = harness()
    const decided: boolean[] = []
    q.queueToolConfirmation({ id: 7, ident: 'a', tool: 'trigger_sync' }, (allow) => {
      decided.push(allow)
    })
    q.resolveTool(7, false)
    expect(decided).toEqual([false])
    advance(10_000) // 推进时钟（工具确认不去重，此处仅模拟时间流逝）
    q.queueToolConfirmation({ id: 8, ident: 'a', tool: 'trigger_sync' }, (allow) => {
      decided.push(allow)
    })
    q.close()
    expect(decided).toEqual([false, false])
    expect(q.size.value).toBe(0)
  })

  it('首连审批裁定后 10s 内同 ident 工具确认照常入队（主流程不吞）', () => {
    const { q } = harness()
    const decided: boolean[] = []
    q.enqueue(ev('a'))
    q.resolve('a', 'once') // 首连批准
    q.queueToolConfirmation({ id: 5, ident: 'a', tool: 'trigger_sync' }, (allow) => {
      decided.push(allow)
    })
    expect(q.size.value).toBe(1)
    expect(q.current.value).toEqual({ id: 5, ident: 'a', tool: 'trigger_sync' })
    q.resolveTool(5, true)
    expect(decided).toEqual([true])
  })

  it('首连审批与工具确认同一 FIFO 串行：工具确认排队时 resolve(ident) 不误弹', () => {
    const { q } = harness()
    const decided: boolean[] = []
    q.queueToolConfirmation({ id: 9, ident: 'a', tool: 'trigger_sync' }, (allow) => {
      decided.push(allow)
    })
    q.enqueue(ev('b'))
    // 队首是工具确认时，首连回执路径不得弹出（id/通道不匹配一律 no-op）
    q.resolve('a', 'trust')
    expect(q.size.value).toBe(2)
    expect(q.current.value).toEqual({ id: 9, ident: 'a', tool: 'trigger_sync' })
    q.resolveTool(9, false)
    expect(q.current.value?.ident).toBe('b')
    expect(decided).toEqual([false])
  })

  it('dispose：全部未决工具确认立即回 false，队列与去重窗口清空（卸载不悬挂未决 id）', () => {
    const { q, advance } = harness()
    const decided: Array<{ id: number; allow: boolean }> = []
    const record = (id: number) => (allow: boolean) => {
      decided.push({ id, allow })
    }
    q.enqueue(ev('c')) // 首连审批无 id 无 oneshot：清空即可，无回执
    q.queueToolConfirmation({ id: 11, ident: 'a', tool: 'trigger_sync' }, record(11))
    q.queueToolConfirmation({ id: 12, ident: 'b', tool: 'trigger_backup' }, record(12))
    q.dispose()
    expect(decided).toEqual([
      { id: 11, allow: false },
      { id: 12, allow: false },
    ])
    expect(q.size.value).toBe(0)
    expect(q.current.value).toBeNull()
    // 去重窗口一并清空：dispose 后同 ident 重入队不受旧窗口阻挡
    advance(0)
    q.queueToolConfirmation({ id: 13, ident: 'a', tool: 'trigger_sync' }, record(13))
    expect(q.current.value).toEqual({ id: 13, ident: 'a', tool: 'trigger_sync' })
  })

  it('裁定离队后 10s 内同 ident 新工具确认照常入队（逐次即焚，每次调用都重新问）；迟到 resolveTool 双重消费被挡', () => {
    const { q, advance } = harness()
    const decided: Array<{ id: number; allow: boolean }> = []
    const record = (id: number) => (allow: boolean) => {
      decided.push({ id, allow })
    }
    q.queueToolConfirmation({ id: 20, ident: 'a', tool: 'trigger_sync' }, record(20))
    q.resolveTool(20, true)
    expect(decided).toEqual([{ id: 20, allow: true }])
    advance(1_000) // 离队后 10s 窗口内（曾按 ident 去重挡下并自动拒绝，B23）：现在照常入队
    q.queueToolConfirmation({ id: 21, ident: 'a', tool: 'trigger_sync' }, record(21))
    expect(q.size.value).toBe(1)
    expect(q.current.value).toEqual({ id: 21, ident: 'a', tool: 'trigger_sync' })
    q.resolveTool(21, true)
    expect(decided).toEqual([
      { id: 20, allow: true },
      { id: 21, allow: true },
    ])
    // id 21 已裁定消费：迟到的 resolveTool no-op（双重消费被挡）
    q.resolveTool(21, false)
    expect(decided).toEqual([
      { id: 20, allow: true },
      { id: 21, allow: true },
    ])
    expect(q.size.value).toBe(0)
  })
})
