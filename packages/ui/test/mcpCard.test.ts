import { describe, expect, it } from 'vitest'
import { connectionSnippet, MCP_MODE_OPTIONS, type McpConfigDto } from '../src/components/mcpCard'

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
