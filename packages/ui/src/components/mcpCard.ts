/** MCP 配置（与 Rust McpConfig 契约对齐，camelCase） */
export interface McpConfigDto {
  enabled: boolean
  mode: 'token' | 'wildcard' | 'exact' | 'alwaysAsk'
  port: number
  token: string
  whitelist: string[]
}

/** MCP 平台能力（桌面宿主桥接 mcp_get_config / mcp_set_config / mcp_regenerate_token 命令） */
export interface McpPlatform {
  getConfig: () => Promise<McpConfigDto>
  setConfig: (cfg: McpConfigDto) => Promise<void>
  regenerateToken: () => Promise<string>
}

/** 客户端授权四档（label 为 i18n key，组件侧经 t() 出文案；locale 切换联动） */
export const MCP_MODE_OPTIONS: ReadonlyArray<{ value: McpConfigDto['mode']; key: string }> = [
  { value: 'token', key: 'mcpServer.modeToken' },
  { value: 'wildcard', key: 'mcpServer.modeWildcard' },
  { value: 'exact', key: 'mcpServer.modeExact' },
  { value: 'alwaysAsk', key: 'mcpServer.modeAlwaysAsk' },
]

/** 客户端连接片段：给 AI 客户端配置文件粘贴用（token 不内嵌——卡片上另行复制，永不落入片段） */
export function connectionSnippet(cfg: Pick<McpConfigDto, 'port'>): string {
  return JSON.stringify({ mcpServers: { totp: { url: `http://127.0.0.1:${cfg.port}/mcp`, headers: { Authorization: 'Bearer <MCP token>' } } } }, null, 2)
}
