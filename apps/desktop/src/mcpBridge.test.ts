import { describe, expect, it, vi } from 'vitest'
import { createMcpTriggers, filterAccounts, handleMcpRequest, startMcpBridge, type McpBridgeDeps, type McpRequestPayload } from './mcpBridge'
import type { OtpEntry } from '@totp/core'

const mkEntry = (o: Partial<OtpEntry>): OtpEntry => ({
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'a@x.com', secret: 'GEZDGNBVGY3TQOJQ',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0, ...o,
})

describe('filterAccounts', () => {
  const entries = [
    mkEntry({ uuid: '1', issuer: 'GitHub', label: 'a@x.com' }),
    mkEntry({ uuid: '2', issuer: 'GitLab', label: 'b@x.com', matchRules: [{ strategy: 'baseDomain', pattern: 'gitlab.com' }] }),
  ]
  it('文本 filter 命中 issuer/label', () => {
    expect(filterAccounts(entries, 'github', undefined).map((e) => e.uuid)).toEqual(['1'])
  })
  it('url 走 match 引擎', () => {
    expect(filterAccounts(entries, undefined, 'https://gitlab.com/u/1').map((e) => e.uuid)).toEqual(['2'])
  })
  it('filter 与 url 取交集', () => {
    expect(filterAccounts(entries, 'gitlab', 'https://gitlab.com/u/1').map((e) => e.uuid)).toEqual(['2'])
    expect(filterAccounts(entries, 'github', 'https://gitlab.com/u/1')).toEqual([])
  })
})

describe('handleMcpRequest', () => {
  const entries = [mkEntry({ uuid: '1' }), mkEntry({ uuid: '2', type: 'hotp', counter: 3 })]
  /** 只喂条目的 deps 快捷工厂（触发器成员给无害实现，非本组用例焦点） */
  const depsOf = (list: OtpEntry[]): McpBridgeDeps => ({
    requireEntries: () => list,
    tagsOf: () => [],
    triggerSync: async () => ({ triggered: true }),
    triggerBackup: async () => ({ triggered: true }),
  })
  const deps = (locked: boolean): McpBridgeDeps => ({
    requireEntries: () => {
      if (locked) throw new Error('vault locked')
      return entries
    },
    tagsOf: () => ['work'],
    triggerSync: async () => ({ triggered: true }),
    triggerBackup: async () => ({ triggered: true }),
  })
  it('锁定 → vault locked 错误', async () => {
    const r = await handleMcpRequest(deps(true), { id: 1, tool: 'list_accounts', args: {} })
    expect(r).toEqual({ ok: false, error: 'vault locked' })
  })
  it('list_accounts 输出无 secret/pin', async () => {
    const r = await handleMcpRequest(deps(false), { id: 1, tool: 'list_accounts', args: {} })
    expect(r.ok).toBe(true)
    const list = (r as { ok: true; result: { accounts: { id: string; tags: string[] }[] } }).result.accounts
    expect(list[0]).not.toHaveProperty('secret')
    expect(list[0]!.tags).toEqual(['work'])
  })
  it('list_accounts 所有账户字段 ⊆ {id, issuer, label, type, tags}（含 pin/matchRules 泄漏隔离）', async () => {
    const risky = [
      mkEntry({ uuid: 'r1', matchRules: [{ strategy: 'baseDomain', pattern: 'x.com' }], pin: '1234' }),
      mkEntry({ uuid: 'r2', type: 'hotp', counter: 7, note: 'secret note' }),
    ]
    const r = await handleMcpRequest(
      depsOf(risky),
      { id: 1, tool: 'list_accounts', args: {} },
    )
    expect(r.ok).toBe(true)
    const accounts = (r as { ok: true; result: { accounts: Record<string, unknown>[] } }).result.accounts
    expect(accounts).toHaveLength(2)
    for (const a of accounts) {
      expect(Object.keys(a).every((k) => ['id', 'issuer', 'label', 'type', 'tags'].includes(k))).toBe(true)
    }
  })
  it('get_code hotp 窥视不推进', async () => {
    const r = await handleMcpRequest(deps(false), { id: 2, tool: 'get_code', args: { account_id: '2' } })
    expect(r.ok).toBe(true)
    const out = (r as { result: { code: string; counter: number; note?: string } }).result
    expect(out.counter).toBe(3)
    expect(out.note).toContain('not advanced')
  })
  it('steam 条目 get_code 走 computeEntryCode 分发（5 位 steam 字符集）', async () => {
    // steam.ts 确认输出形态：STEAM_ALPHABET='23456789BCDFGHJKMNPQRTVWXY'（数字 2-9 + 大写字母，5 位）
    const r = await handleMcpRequest(
      depsOf([mkEntry({ uuid: 's1', type: 'steam', secret: 'GEZDGNBVGY3TQOJQ' })]),
      { id: 5, tool: 'get_code', args: { account_id: 's1' } },
    )
    expect(r.ok).toBe(true)
    const code = (r as { ok: true; result: { code: string } }).result.code
    expect(code).toMatch(/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/)
  })
  it('yandex 条目 get_code 输出键集 ⊆ {code, expires_in_seconds, period}（不泄漏 pin）', async () => {
    const pin = '428913'
    // yandex secret 校验要求恰 16 字节 = 26 个 base32 字符（GEZDGNBVGY3TQOJQ 仅 10B 会被拒）
    const r = await handleMcpRequest(
      depsOf([mkEntry({ uuid: 'y1', type: 'yandex', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY', pin })]),
      { id: 6, tool: 'get_code', args: { account_id: 'y1' } },
    )
    expect(r.ok).toBe(true)
    const out = (r as { ok: true; result: Record<string, unknown> }).result
    expect(Object.keys(out).every((k) => ['code', 'expires_in_seconds', 'period'].includes(k))).toBe(true)
    // pin 不得以任何输出值形态外泄（键集白名单已隔离，此断言防未来字段误加）
    for (const v of Object.values(out)) {
      expect(String(v)).not.toContain(pin)
    }
  })
  it('未知 account_id → 错误附提示', async () => {
    const r = await handleMcpRequest(deps(false), { id: 3, tool: 'get_code', args: { account_id: 'nope' } })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('list_accounts')
  })
  it('未知 tool → 错误', async () => {
    const r = await handleMcpRequest(deps(false), { id: 4, tool: 'delete_all', args: {} })
    expect(r.ok).toBe(false)
  })
})

describe('handleMcpRequest 触发器（spec §6.1，T5）', () => {
  it('trigger_sync：透传 deps 结果（含 reason）', async () => {
    const deps = {
      requireEntries: () => [],
      tagsOf: () => [],
      triggerSync: async () => ({ triggered: false, reason: 'vault locked' }),
      triggerBackup: async () => ({ triggered: true }),
    } satisfies McpBridgeDeps
    const r = await handleMcpRequest(deps, { id: 1, tool: 'trigger_sync', args: {} })
    expect(r).toEqual({ ok: true, result: { triggered: false, reason: 'vault locked' } })
  })
  it('trigger_backup：触发成功只回受理状态', async () => {
    const deps = {
      requireEntries: () => [],
      tagsOf: () => [],
      triggerSync: async () => ({ triggered: true }),
      triggerBackup: async () => ({ triggered: true }),
    } satisfies McpBridgeDeps
    const r = await handleMcpRequest(deps, { id: 2, tool: 'trigger_backup', args: {} })
    expect(r).toEqual({ ok: true, result: { triggered: true } })
  })
  it('未知工具仍报 unknown tool（回归）', async () => {
    const deps = {
      requireEntries: () => [],
      tagsOf: () => [],
      triggerSync: async () => ({ triggered: true }),
      triggerBackup: async () => ({ triggered: true }),
    } satisfies McpBridgeDeps
    expect((await handleMcpRequest(deps, { id: 3, tool: 'x', args: {} })).ok).toBe(false)
  })
})

describe('createMcpTriggers（spec §6.1 + 终审 I2 受理即返回）', () => {
  const blocked = { triggered: false as const, reason: 'vault locked' }
  it('前置不满足 → 结构化 reason，不启动触发通道', async () => {
    const runSync = vi.fn(() => Promise.resolve())
    const runBackup = vi.fn(() => Promise.resolve())
    const t = createMcpTriggers({ guard: () => blocked, runSync, runBackup })
    await expect(t.triggerSync()).resolves.toEqual({ triggered: false, reason: 'vault locked' })
    await expect(t.triggerBackup()).resolves.toEqual({ triggered: false, reason: 'vault locked' })
    expect(runSync).not.toHaveBeenCalled()
    expect(runBackup).not.toHaveBeenCalled()
  })

  it('受理即返回：triggered:true 不等待触发通道完成（deferred 未决即返回）', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const runSync = vi.fn(() => gate)
    const t = createMcpTriggers({ guard: () => null, runSync, runBackup: () => Promise.resolve() })
    const r = await t.triggerSync()
    expect(r).toEqual({ triggered: true }) // 同步通道仍挂起（gate 未放行）即已返回受理态
    expect(runSync).toHaveBeenCalledTimes(1)
    release()
  })

  it('触发通道失败不冒泡到工具响应、不产生未处理 rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boom = Promise.reject(new Error('net down'))
    const t = createMcpTriggers({ guard: () => null, runSync: () => boom, runBackup: () => Promise.reject(new Error('disk full')) })
    await expect(t.triggerSync()).resolves.toEqual({ triggered: true })
    await expect(t.triggerBackup()).resolves.toEqual({ triggered: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).not.toHaveBeenCalled() // 静默兜底：错误由 runner 内部 recordStatus/onError 呈现
    warn.mockRestore()
  })
})

describe('startMcpBridge', () => {
  /** fake io：捕获 listen 回调与 invoke 调用，手动触发事件驱动整条链路 */
  async function bridgeHarness(lockedRef: { locked: boolean }) {
    const entries = [mkEntry({ uuid: '1' })]
    const unlisten = vi.fn()
    const listeners: Array<(e: { payload: McpRequestPayload }) => void> = []
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
    const stop = await startMcpBridge(
      {
        requireEntries: () => {
          if (lockedRef.locked) throw new Error('vault locked')
          return entries
        },
        tagsOf: () => ['work'],
        triggerSync: async () => ({ triggered: true }),
        triggerBackup: async () => ({ triggered: true }),
      },
      {
        listen: (_event, cb) => {
          listeners.push(cb)
          return Promise.resolve(unlisten)
        },
        invoke: (cmd, args) => {
          calls.push({ cmd, args: args as Record<string, unknown> })
          return Promise.resolve()
        },
      },
    )
    return { stop, listeners, calls, unlisten }
  }
  /** flush 微任务：handleMcpRequest → invoke 的 then 链落地 */
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('事件触发 → invoke("mcp_respond", ...) 回传结果；锁定 → ok:false；返回 unlisten', async () => {
    const { stop, listeners, calls, unlisten } = await bridgeHarness({ locked: false })
    expect(listeners).toHaveLength(1)

    listeners[0]!({ payload: { id: 9, tool: 'list_accounts', args: {} } })
    await flush()
    expect(calls[0]).toEqual({
      cmd: 'mcp_respond',
      args: {
        id: 9,
        ok: true,
        result: { accounts: [{ id: '1', issuer: 'GitHub', label: 'a@x.com', type: 'totp', tags: ['work'] }] },
        error: null,
      },
    })

    listeners[0]!({ payload: { id: 10, tool: 'get_code', args: { account_id: 'nope' } } })
    await flush()
    expect(calls[1]!.cmd).toBe('mcp_respond')
    expect(calls[1]!.args.id).toBe(10)
    expect(calls[1]!.args.ok).toBe(false)
    expect(calls[1]!.args.result).toBeNull()
    expect(String(calls[1]!.args.error)).toContain('unknown account_id')
  })

  it('锁定态触发 → ok:false + vault locked 错误回传', async () => {
    const { listeners, calls } = await bridgeHarness({ locked: true })
    listeners[0]!({ payload: { id: 11, tool: 'list_accounts', args: {} } })
    await flush()
    expect(calls[0]).toEqual({ cmd: 'mcp_respond', args: { id: 11, ok: false, result: null, error: 'vault locked' } })
  })

  it('totp 条目 get_code 成功响应键集严格为 {code, expires_in_seconds, period}', async () => {
    // mkEntry 默认 totp：digits 6 / period 30；经 startMcpBridge 事件链路驱动
    const { listeners, calls } = await bridgeHarness({ locked: false })
    listeners[0]!({ payload: { id: 12, tool: 'get_code', args: { account_id: '1' } } })
    await flush()
    expect(calls[0]!.cmd).toBe('mcp_respond')
    expect(calls[0]!.args.ok).toBe(true)
    const out = calls[0]!.args.result as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual(['code', 'expires_in_seconds', 'period'])
    expect(out.code).toMatch(/^\d{6}$/)
    const sec = out.expires_in_seconds
    expect(Number.isInteger(sec)).toBe(true)
    expect(sec).toBeGreaterThanOrEqual(1)
    expect(sec).toBeLessThanOrEqual(30)
    expect(out.period).toBe(30)
  })

  it('卸载函数即 listen 返回的 unlisten', async () => {
    const { stop, unlisten } = await bridgeHarness({ locked: false })
    expect(stop).toBe(unlisten)
    stop()
    expect(unlisten).toHaveBeenCalledOnce()
  })
})
