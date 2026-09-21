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
