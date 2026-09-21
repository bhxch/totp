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
  // with_json_response(true) 下为纯 JSON；若服务端回 SSE（text/event-stream），解析 data: 行
  let json = null
  try { json = JSON.parse(text) } catch {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'))
    if (dataLine) { try { json = JSON.parse(dataLine.slice(5).trim()) } catch { /* ignore */ } }
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, json }
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

process.exit(fail ? 1 : 0)
