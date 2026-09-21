#!/usr/bin/env node
/** plan17 MCP E2E：对运行中的 desktop 应用验证 401 门 → initialize → tools/list →
 *  tools/call 成功链路（list_accounts → get_code）与错误路径。
 *
 *  前置条件（不满足时工具调用阶段会 FAIL，运行时输出里有对应指引）：
 *  1. dev/build 应用在运行，设置页已启用 MCP 服务器，token 从设置页复制；
 *  2. 金库已解锁（锁定时 get_code 返回 vault locked）；
 *  3. 授权档位为 wildcard/exact/alwaysAsk 且白名单未含本客户端时，首个 tools/call 即得
 *     "approval pending"——需先在应用内批准 mcp-e2e 客户端，或临时切换授权模式为 token 后重跑。
 *
 *  用法：node scripts/mcp-e2e.mjs <token> [port=47215]
 *  断言：未带 token 401；initialize 得 serverInfo.name=totp-desktop；tools/list 恰含两工具；
 *  list_accounts 是数组且每项字段严格 ⊆ {id,issuer,label,type,tags}（多余键=泄密嫌疑，FAIL）；
 *  get_code(首条账户) code 非空字符串（hotp 另含 counter/note，totp/steam/yandex 另含
 *  expires_in_seconds/period）；库为空时跳过成功链路并在汇总标注 skipped；
 *  get_code(不存在 id) 错误文案对齐真实实现（unknown account_id: x; call list_accounts first）。 */
const [token, port = '47215'] = process.argv.slice(2)
if (!token) { console.error('usage: node scripts/mcp-e2e.mjs <token> [port]'); process.exit(1) }
const base = `http://127.0.0.1:${port}/mcp`

console.log('前置条件：应用运行中 + 设置页已启用 MCP（token 从设置页复制）+ 金库已解锁。')
console.log('wildcard/exact/alwaysAsk 档且白名单未含本客户端时，首个工具调用会得 "approval pending"：')
console.log('请在应用内批准 mcp-e2e 客户端，或临时切换授权模式为 token 后重跑。')
console.log('')

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
let skipped = 0
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fail++ }

// list_accounts 公开字段白名单（与 mcpBridge.ts toPublic 的安全契约对齐，勿增删）：
// 发现 secret/pin/algorithm/counter 等多余键即泄密嫌疑，FAIL
const ACCOUNT_KEYS = new Set(['id', 'issuer', 'label', 'type', 'tags'])

/** tools/call 失败形态 → 错误文案。兼容 JSON-RPC error（rmcp McpError 实际形态）
 *  与 isError:true + content 文案两种；两种皆无则视为成功（返回空串） */
function errorTextOf(res) {
  const j = res.json
  if (j?.error?.message) return j.error.message
  if (j?.result?.isError) {
    const t = (j.result.content ?? []).map((c) => c.text ?? '').join(' ')
    if (t) return t
  }
  return ''
}

/** tools/call 成功载荷：CallToolResult.content[0].text 为后端 result 的 JSON 字符串
 *  （bridge_call → ContentBlock::text(result.to_string())），兜底 structuredContent */
function payloadOf(res) {
  const r = res.json?.result
  if (!r || r.isError) return null
  const text = (r.content ?? []).find((c) => c.type === 'text')?.text
  if (typeof text === 'string') {
    try { return JSON.parse(text) } catch { return text }
  }
  return r.structuredContent ?? null
}

let approvalHintShown = false
/** 工具调用 + approval pending 诊断：命中即输出指引再 FAIL，不裸断言失败 */
async function callTool(id, name, args) {
  const res = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  const errText = errorTextOf(res)
  if (!approvalHintShown && errText.includes('approval pending')) {
    approvalHintShown = true
    console.warn('[提示] 工具调用被门控拦截（approval pending）：在应用内批准 mcp-e2e 客户端，或临时切换授权模式为 token 后重跑。')
  }
  return { res, errText }
}

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

// 4) tools/call list_accounts（无参）→ 公开字段白名单断言（安全契约，多余键即 FAIL）
const la = await callTool(3, 'list_accounts', {})
check('list_accounts 无错误', !la.errText)
const laPayload = la.errText ? null : payloadOf(la.res)
const accounts = Array.isArray(laPayload?.accounts) ? laPayload.accounts : null
check('list_accounts → accounts 数组', accounts !== null)
if (accounts) {
  check('每项字段严格 ⊆ {id,issuer,label,type,tags} 且含 id',
    accounts.every((a) => a && typeof a === 'object'
      && Object.keys(a).every((k) => ACCOUNT_KEYS.has(k))
      && typeof a.id === 'string' && a.id.length > 0))
}

// 5) get_code 成功链路：对返回的第一条账户取码。库为空则明确 skipped（不静默通过）
const first = accounts?.[0]
if (!first) {
  skipped++
  console.warn('[skipped] 库中无账户，跳过 get_code 成功链路（在应用导入至少一条账户后重跑）')
} else {
  const gc = await callTool(4, 'get_code', { account_id: first.id })
  check('get_code 无错误', !gc.errText)
  const p = gc.errText ? null : payloadOf(gc.res)
  check(`get_code(${first.type}) → code 非空字符串`, typeof p?.code === 'string' && p.code.length > 0)
  if (first.type === 'hotp') {
    // hotp：counter 被 peek 不推进，附 note 说明（mcpBridge.ts handleMcpRequest）
    check('hotp 另含 counter/note', p != null && 'counter' in p && 'note' in p)
  } else {
    // totp/steam/yandex 同形状：{code, expires_in_seconds, period}
    check(`${first.type} 另含 expires_in_seconds/period`, p != null && 'expires_in_seconds' in p && 'period' in p)
  }
}

// 6) 未知账户 → 错误文案对齐真实实现（McpBridge: unknown account_id: x; call list_accounts first），
//    文案须含 list_accounts 建议（形态兼容 JSON-RPC error / isError 两种）
const unknown = await callTool(5, 'get_code', { account_id: 'nonexistent-e2e' })
check('unknown account_id 文案', unknown.errText.includes('unknown account_id'))
check('错误文案含 list_accounts 建议', unknown.errText.includes('list_accounts'))

console.log(`\n汇总：FAIL=${fail}${skipped ? `，skipped=${skipped}（库中无账户，get_code 成功链路未验证）` : ''}`)
// 不用 process.exit：fetch keep-alive 在 Windows 上 exit 时会触发 libuv 断言（退出码失真），
// 设 exitCode 让事件循环自然排空（undici keep-alive 数秒内释放）
process.exitCode = fail ? 1 : 0
