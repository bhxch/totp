import { describe, expect, it } from 'vitest'
import { connectionSnippet, MCP_MODE_OPTIONS, randomDynamicPort, serverStatus, type McpConfigDto } from '../src/components/mcpCard'

describe('connectionSnippet', () => {
  it('输出含本机 127.0.0.1 地址与端口（客户端粘贴用）', () => {
    const s = connectionSnippet({ port: 47215 })
    expect(s).toContain('http://127.0.0.1:47215/mcp')
    expect(s).toContain('Bearer <MCP token>')
  })
  it('永不内嵌真实 token（安全断言：连接片段不含 token 字段与值）', () => {
    const cfg: McpConfigDto = { enabled: true, mode: 'token', port: 47215, token: 'super-secret-token', whitelist: ['Claude*'] }
    const s = connectionSnippet(cfg)
    expect(s).not.toContain('super-secret-token')
    expect(s).not.toContain('"token"')
  })
  it('输出为合法 JSON：mcpServers.totp.url 指向 /mcp 且带 Bearer 头', () => {
    const parsed = JSON.parse(connectionSnippet({ port: 47215 })) as {
      mcpServers: { totp: { url: string; headers: Record<string, string> } }
    }
    expect(parsed.mcpServers.totp.url).toBe('http://127.0.0.1:47215/mcp')
    expect(parsed.mcpServers.totp.headers.Authorization).toBe('Bearer <MCP token>')
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
