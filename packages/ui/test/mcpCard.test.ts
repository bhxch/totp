import { describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import McpServerCard from '../src/components/McpServerCard.vue'
import {
  connectionSnippet,
  DEFAULT_EXPOSED_TOOLS,
  MCP_MODE_OPTIONS,
  MCP_TOOLS,
  randomDynamicPort,
  sanitizeExposedTools,
  serverStatus,
  type McpConfigDto,
} from '../src/components/mcpCard'
import { createTestI18n } from './helpers/i18n'

describe('connectionSnippet', () => {
  it('token 非空：嵌入真实 token，复制片段即可直接使用（2026-09-23 用户决策：片段嵌真 token）', () => {
    const cfg: McpConfigDto = { enabled: true, mode: 'token', port: 47215, token: 'super-secret-token', whitelist: ['Claude*'], exposedTools: ['list_accounts'] }
    const s = connectionSnippet(cfg)
    expect(s).toContain('Bearer super-secret-token')
    expect(s).not.toContain('<MCP token>')
  })
  it('token 为空（未启用/未生成）：输出占位符引导，不输出空 Bearer', () => {
    const s = connectionSnippet({ port: 47215, token: '' })
    expect(s).toContain('Bearer <MCP token>')
    expect(s).not.toContain('Bearer "')
    expect(s).not.toContain('Bearer "}"')
  })
  it('输出为合法 JSON：mcpServers.totp.url 指向 /mcp 且带 Authorization 头', () => {
    const parsed = JSON.parse(connectionSnippet({ port: 47215, token: 'tok' })) as {
      mcpServers: { totp: { url: string; headers: Record<string, string> } }
    }
    expect(parsed.mcpServers.totp.url).toBe('http://127.0.0.1:47215/mcp')
    expect(parsed.mcpServers.totp.headers.Authorization).toBe('Bearer tok')
  })
})

describe('MCP_MODE_OPTIONS', () => {
  it('四档齐全且 key 全以 mcpServer. 开头（i18n 契约）', () => {
    expect(MCP_MODE_OPTIONS.map((o) => o.value)).toEqual(['token', 'wildcard', 'exact', 'alwaysAsk'])
    for (const o of MCP_MODE_OPTIONS) expect(o.key.startsWith('mcpServer.')).toBe(true)
  })
})

describe('serverStatus', () => {
  it('running 恒优先：enabled 与 lastError 均让位于实际监听态（重启瞬态不误报）', () => {
    expect(serverStatus({ enabled: true }, true, null)).toEqual({ key: 'mcpServer.statusRunning', tone: 'ok' })
    expect(serverStatus({ enabled: false }, true, 'boom')).toEqual({ key: 'mcpServer.statusRunning', tone: 'ok' })
  })
  it('enabled 且启动失败：错误文案携带原始错误参数（autostart 失败用户可见的关键路径）', () => {
    const s = serverStatus({ enabled: true }, false, 'bind 127.0.0.1:47215 failed: AddrInUse')
    expect(s).toEqual({
      key: 'mcpServer.statusFailed',
      params: { error: 'bind 127.0.0.1:47215 failed: AddrInUse' },
      tone: 'error',
    })
  })
  it('enabled 无错误未运行：启动中（stop→start 重启间隙的瞬态）', () => {
    expect(serverStatus({ enabled: true }, false, null)).toEqual({ key: 'mcpServer.statusStarting', tone: 'pending' })
  })
  it('未启用：已停止且不展示历史错误（服务本就有意关闭，错误色会误导）', () => {
    expect(serverStatus({ enabled: false }, false, 'stale error')).toEqual({ key: 'mcpServer.statusStopped', tone: 'muted' })
  })
  it('全部 key 以 mcpServer. 开头（i18n 契约）', () => {
    const keys = [
      serverStatus({ enabled: true }, true, null),
      serverStatus({ enabled: true }, false, 'e'),
      serverStatus({ enabled: true }, false, null),
      serverStatus({ enabled: false }, false, null),
    ].map((s) => s.key)
    for (const k of keys) expect(k.startsWith('mcpServer.')).toBe(true)
  })
})

describe('randomDynamicPort', () => {
  it('rng 恒 0：落在动态段下端点 49152（IANA 动态段下界）', () => {
    expect(randomDynamicPort(() => 0)).toBe(49152)
  })
  it('rng 恒 1 / 0.999…：钳制在动态段上端点 65535，不越界', () => {
    expect(randomDynamicPort(() => 1)).toBe(65535)
    expect(randomDynamicPort(() => 0.99999999999999)).toBe(65535)
  })
  it('rng 0.5 落段中点附近（映射线性可达全段）', () => {
    expect(randomDynamicPort(() => 0.5)).toBe(49152 + 8192)
  })
  it('默认 Math.random 多次采样均为 [49152, 65535] 内的整数', () => {
    for (let i = 0; i < 500; i++) {
      const p = randomDynamicPort()
      expect(Number.isInteger(p)).toBe(true)
      expect(p).toBeGreaterThanOrEqual(49152)
      expect(p).toBeLessThanOrEqual(65535)
    }
  })
})

describe('sanitizeExposedTools', () => {
  it('滤未知名、去重、保持已知顺序（与 Rust save 侧 retain 同口径）', () => {
    expect(sanitizeExposedTools(['get_code', 'nope', 'trigger_sync', 'get_code'])).toEqual(['get_code', 'trigger_sync'])
    expect(sanitizeExposedTools([])).toEqual([])
  })
  it('全部未知名 → 空（不会把脏数据写回暴露面）', () => {
    expect(sanitizeExposedTools(['bogus', 'nope'])).toEqual([])
  })
})

describe('MCP_TOOLS', () => {
  it('read 两个 + action 两个（spec §6.2 门控元数据契约）', () => {
    expect(MCP_TOOLS.filter((t) => t.kind === 'read').map((t) => t.name).sort()).toEqual(['get_code', 'list_accounts'])
    expect(MCP_TOOLS.filter((t) => t.kind === 'action').map((t) => t.name).sort()).toEqual(['trigger_backup', 'trigger_sync'])
  })
  it('key 全以 mcpServer. 开头且 DEFAULT_EXPOSED_TOOLS 恰为只读两工具（存量用户行为零变化）', () => {
    for (const t of MCP_TOOLS) expect(t.key.startsWith('mcpServer.')).toBe(true)
    expect(DEFAULT_EXPOSED_TOOLS).toEqual(['list_accounts', 'get_code'])
  })
})

describe('McpServerCard 暴露工具勾选组（DTO 往返）', () => {
  /** 卡片勾选组行序恒为 MCP_TOOLS 顺序：list_accounts / get_code / trigger_backup / trigger_sync */
  function checkedFlags(w: VueWrapper): boolean[] {
    return w.findAll('.tool-check input').map((b) => (b.element as HTMLInputElement).checked)
  }
  function mkPlatform(getConfigRet: Record<string, unknown>) {
    return {
      getConfig: vi.fn().mockResolvedValue(getConfigRet),
      setConfig: vi.fn().mockResolvedValue(undefined),
      regenerateToken: vi.fn().mockResolvedValue('new-token'),
      revokeApprovals: vi.fn().mockResolvedValue(0),
      copyText: vi.fn().mockResolvedValue(undefined),
    }
  }
  const base = { enabled: true, mode: 'token', port: 47215, token: 'tok', whitelist: [], running: true, lastError: null }

  it('getConfig 返回 exposedTools 初始化卡片勾选态；action 行附写操作警示文案', async () => {
    const platform = mkPlatform({ ...base, exposedTools: ['list_accounts', 'trigger_sync'] })
    const w = mount(McpServerCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await vi.waitFor(() => expect(w.find('.exposed-tools').exists()).toBe(true))
    expect(checkedFlags(w)).toEqual([true, false, false, true])
    // action 两行各附一条警示（read 行没有）
    expect(w.findAll('.tool-hint')).toHaveLength(2)
    expect(w.text()).toContain('触发写操作，仅 token 档免确认')
  })

  it('勾选变更走 setConfig 整体回写，载荷携带 sanitize 后的 exposedTools（防 Rust default 重置勾选）', async () => {
    const platform = mkPlatform({ ...base, exposedTools: ['list_accounts', 'trigger_sync'] })
    const w = mount(McpServerCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await vi.waitFor(() => expect(w.find('.exposed-tools').exists()).toBe(true))
    const boxes = w.findAll('.tool-check input')
    await boxes[1]!.setValue(true) // 勾上 get_code
    await vi.waitFor(() => expect(platform.setConfig).toHaveBeenCalledTimes(1))
    const payload = platform.setConfig.mock.calls[0]?.[0] as McpConfigDto | undefined
    expect(payload?.exposedTools).toEqual(['list_accounts', 'get_code', 'trigger_sync'])
  })

  it('取消勾选同样整体回写且载荷携带该值（勾选永不静默丢失）', async () => {
    const platform = mkPlatform({ ...base, exposedTools: ['list_accounts', 'trigger_sync'] })
    const w = mount(McpServerCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await vi.waitFor(() => expect(w.find('.exposed-tools').exists()).toBe(true))
    const boxes = w.findAll('.tool-check input')
    await boxes[0]!.setValue(false) // 取消 list_accounts
    await vi.waitFor(() => expect(platform.setConfig).toHaveBeenCalledTimes(1))
    const payload = platform.setConfig.mock.calls[0]?.[0] as McpConfigDto | undefined
    expect(payload?.exposedTools).toEqual(['trigger_sync'])
  })

  it('老桥接载荷缺 exposedTools：初始化兜底默认只读档，后续回写不丢字段', async () => {
    const platform = mkPlatform({ ...base }) // 无 exposedTools 字段（模拟桥接漂移）
    const w = mount(McpServerCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await vi.waitFor(() => expect(w.find('.exposed-tools').exists()).toBe(true))
    expect(checkedFlags(w)).toEqual([true, true, false, false])
    const boxes = w.findAll('.tool-check input')
    await boxes[3]!.setValue(true) // 勾上 trigger_sync
    await vi.waitFor(() => expect(platform.setConfig).toHaveBeenCalledTimes(1))
    const payload = platform.setConfig.mock.calls[0]?.[0] as McpConfigDto | undefined
    expect(payload?.exposedTools).toEqual(['list_accounts', 'get_code', 'trigger_sync'])
  })
})

describe('McpServerCard 空 token 防护', () => {
  const base = { enabled: false, mode: 'token', port: 47215, token: '', whitelist: [], running: false, lastError: null }
  function mkPlatform() {
    return {
      getConfig: vi.fn().mockResolvedValue({ ...base, exposedTools: ['list_accounts', 'get_code'] }),
      setConfig: vi.fn().mockResolvedValue(undefined),
      regenerateToken: vi.fn().mockResolvedValue('new-token'),
      revokeApprovals: vi.fn().mockResolvedValue(0),
      copyText: vi.fn().mockResolvedValue(undefined),
    }
  }
  it('token 为空：显示占位提示、复制按钮置灰、不调用 copyText', async () => {
    const platform = mkPlatform()
    const w = mount(McpServerCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await vi.waitFor(() => expect(w.find('.token-block').exists()).toBe(true))
    expect(w.text()).toContain('（启用后自动生成）')
    const copyBtn = w.findAll('.token-block button').find((b) => b.text().includes('复制'))!
    expect((copyBtn.element as HTMLButtonElement).disabled).toBe(true)
    await copyBtn.trigger('click')
    expect(platform.copyText).not.toHaveBeenCalled()
  })
})
