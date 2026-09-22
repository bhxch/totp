/** MCP 配置（与 Rust McpConfig 契约对齐，camelCase） */
export interface McpConfigDto {
  enabled: boolean
  mode: 'token' | 'wildcard' | 'exact' | 'alwaysAsk'
  port: number
  token: string
  whitelist: string[]
  /** 工具暴露面（spec §6.3）：不在清单的工具调用返回 tool disabled；保存前经 sanitizeExposedTools 滤净。
   * 回写载荷必须携带本字段——Rust 侧缺字段走 serde default，会静默重置用户勾选 */
  exposedTools: string[]
}

/** mcp_get_config 返回：配置平铺 + 运行态（与 Rust McpConfigWithStatus flatten 契约对齐） */
export interface McpConfigWithStatusDto extends McpConfigDto {
  /** 服务当前监听在位（enabled=true 但 false 时须看 lastError 对账） */
  running: boolean
  /** 最近一次启动失败/异常退出原因，null=无 */
  lastError: string | null
}

/** MCP 平台能力（桌面宿主桥接 mcp_get_config / mcp_set_config / mcp_regenerate_token / mcp_revoke_approvals 命令） */
export interface McpPlatform {
  getConfig: () => Promise<McpConfigWithStatusDto>
  setConfig: (cfg: McpConfigDto) => Promise<void>
  regenerateToken: () => Promise<string>
  /** 吊销全部一次性授权（once 批准 + deny 冷却），返回清空条目数 */
  revokeApprovals: () => Promise<number>
  /** 复制走宿主通道（桌面=暂存剪贴板 + 自动清空；Task 9 审查：卡片不得自行 navigator.clipboard） */
  copyText: (value: string) => Promise<void>
}

/** 客户端授权四档（label 为 i18n key，组件侧经 t() 出文案；locale 切换联动） */
export const MCP_MODE_OPTIONS: ReadonlyArray<{ value: McpConfigDto['mode']; key: string }> = [
  { value: 'token', key: 'mcpServer.modeToken' },
  { value: 'wildcard', key: 'mcpServer.modeWildcard' },
  { value: 'exact', key: 'mcpServer.modeExact' },
  { value: 'alwaysAsk', key: 'mcpServer.modeAlwaysAsk' },
]

/** MCP 工具清单（spec §6.2 门控元数据）：read=现有只读门控不变；action=触发写操作、更严门控
 * （token 档放行，其余档逐次桌面确认）。key 为 i18n 键（组件侧经 t() 出文案），顺序即设置页勾选组行序 */
export const MCP_TOOLS = [
  { name: 'list_accounts', kind: 'read', key: 'mcpServer.toolListAccounts' },
  { name: 'get_code', kind: 'read', key: 'mcpServer.toolGetCode' },
  { name: 'trigger_backup', kind: 'action', key: 'mcpServer.toolTriggerBackup' },
  { name: 'trigger_sync', kind: 'action', key: 'mcpServer.toolTriggerSync' },
] as const

/** 默认暴露面（与 Rust default_exposed_tools 对齐）：只读两工具，存量用户行为零变化 */
export const DEFAULT_EXPOSED_TOOLS: string[] = ['list_accounts', 'get_code']

/** 暴露面保存前净化：滤未知名 + 按 MCP_TOOLS 已知顺序去重（与 Rust save 侧 retain 同口径） */
export function sanitizeExposedTools(list: string[]): string[] {
  const known = new Set(MCP_TOOLS.map((t) => t.name))
  return MCP_TOOLS.map((t) => t.name).filter((n) => list.includes(n) && known.has(n))
}

/** 服务运行态色调：ok=运行中；error=启动失败；pending=启动中（瞬态）；muted=已停止 */
export type ServerStatusTone = 'ok' | 'error' | 'pending' | 'muted'
export interface ServerStatus {
  key: string
  params?: Record<string, string>
  tone: ServerStatusTone
}

/** 服务运行态判定（纯函数，UI 呈现以此对账）：
 * running 恒优先（开关切换/重启的瞬态以实际监听为准）；
 * enabled 且未运行：有 lastError 即启动失败（错误色，autostart 失败用户可见的关键路径），
 * 无错误为「启动中」瞬态；未启用一律「已停止」，不展示历史错误（服务本就有意关闭） */
export function serverStatus(cfg: Pick<McpConfigDto, 'enabled'>, running: boolean, lastError: string | null): ServerStatus {
  if (running) return { key: 'mcpServer.statusRunning', tone: 'ok' }
  if (cfg.enabled) {
    if (lastError) return { key: 'mcpServer.statusFailed', params: { error: lastError }, tone: 'error' }
    return { key: 'mcpServer.statusStarting', tone: 'pending' }
  }
  return { key: 'mcpServer.statusStopped', tone: 'muted' }
}

/** 客户端连接片段：给 AI 客户端配置文件粘贴用（token 不内嵌——卡片上另行复制，永不落入片段） */
export function connectionSnippet(cfg: Pick<McpConfigDto, 'port'>): string {
  return JSON.stringify({ mcpServers: { totp: { url: `http://127.0.0.1:${cfg.port}/mcp`, headers: { Authorization: 'Bearer <MCP token>' } } } }, null, 2)
}

/** IANA 动态端口段边界（49152-65535）：随机端口一键的取值范围 */
export const DYNAMIC_PORT_MIN = 49152
export const DYNAMIC_PORT_MAX = 65535

/** 验收条目1：随机取 IANA 动态端口段内一个端口（rng 可注入便于测试，默认 Math.random）。
 * rng 恰为 1（注入边界）时 floor 会落到段外右端点，钳制回上端点保证值域恒 [MIN, MAX] */
export function randomDynamicPort(rng: () => number = Math.random): number {
  const span = DYNAMIC_PORT_MAX - DYNAMIC_PORT_MIN + 1
  return DYNAMIC_PORT_MIN + Math.min(Math.floor(rng() * span), span - 1)
}
