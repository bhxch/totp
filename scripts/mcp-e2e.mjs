#!/usr/bin/env node
/** plan17 MCP E2E：对运行中的 desktop 应用验证 401 门 → initialize → tools/list → tools/call 错误路径。
 *  用法：先在设置页启用 MCP（token 从设置页复制），然后
 *  node scripts/mcp-e2e.mjs <token> [port=47215]
 *  断言：未带 token 401；带 token initialize 得 serverInfo.name=totp-desktop；
 *  tools/list 恰含 get_code/list_accounts；get_code(不存在 id) 响应含 unknown account_id。 */
const [token, port = '47215'] = process.argv.slice(2)
if (!token) { console.error('usage: node scripts/mcp-e2e.mjs <token> [port]'); process.exit(1) }
const base = `http://127.0.0.1:${port}/mcp`
// rmcp 3.4.0 默认 legacy session 模式：initialize 后服务端下发 mcp-session-id，
// 后续请求必须回传该 id，否则被拒（unexpected_message_response）
let sessionId = null
const post = async (body, withAuth = true) => {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  sessionId = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  // with_json_response(true) 下多为纯 JSON；rmcp 对 initialize 等仍可能回 SSE 事件流
  // （data: 空行作 keepalive，事件以空行分隔）——按事件块解析取首个 jsonrpc 载荷
  let json = null
  try { json = JSON.parse(text) } catch {
    json = parseSseJson(text)
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, json }
}
/** SSE 文本 → 首个含 jsonrpc 载荷的事件 JSON（空 data: keepalive 块跳过；多行 data 拼接） */
function parseSseJson(text) {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    try {
      const j = JSON.parse(data)
      if (j && typeof j === 'object' && ('result' in j || 'error' in j || 'method' in j)) return j
    } catch { /* 非载荷事件，试下一块 */ }
  }
  return null
}

let fail = 0
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fail++ }

// 1) 无 token → 401（Bearer 是第一道门）
const noAuth = await post({ jsonrpc: '2.0', id: 0, method: 'tools/list' }, false)
check('missing token → 401', noAuth.status === 401)

// 2) initialize 握手 → serverInfo.name = totp-desktop
const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-e2e', version: '0.0.1' } } })
check('initialize → serverInfo.name=totp-desktop', init.json?.result?.serverInfo?.name === 'totp-desktop')

// 2.5) 标准 Streamable HTTP 流程：initialize 成功后补发 notifications/initialized（通知无 id）
if (init.json?.result) {
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
}

// 3) tools/list 恰含两工具（带 initialize 下发的 mcp-session-id）。若仍被拒（404/400），
//    重发 notifications/initialized 后再试一次——兜底兼容严格 Streamable HTTP 形态
let tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
if (!(tools.status === 200 && tools.json?.result)) {
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
}
const names = (tools.json?.result?.tools ?? []).map((t) => t.name).sort()
check('tools == [get_code, list_accounts]', JSON.stringify(names) === JSON.stringify(['get_code', 'list_accounts']))

// 4) 未知账户 → 工具级错误文案含 unknown account_id（形态兼容 isError/JSON-RPC error 两种）
const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_code', arguments: { account_id: 'nonexistent' } } })
check('unknown account_id 文案', unknown.text.includes('unknown account_id'))

// 不用 process.exit：fetch keep-alive 在 Windows 上 exit 时会触发 libuv 断言（退出码失真），
// 设 exitCode 让事件循环自然排空（undici keep-alive 数秒内释放）
process.exitCode = fail ? 1 : 0
