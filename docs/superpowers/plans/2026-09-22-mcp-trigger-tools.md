# MCP 触发器工具与工具暴露面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP server 新增 `trigger_backup`/`trigger_sync` 触发器工具（action 类，默认不暴露），设置页增加「暴露工具」勾选组，工具级门控叠加在现有四档客户端门控之上；存量两工具与默认行为零变化。

**Architecture:** Rust 侧 `McpConfig` 增 `exposedTools` 与静态工具注册表（`read`/`action` 两类）；action 工具在非 token 档走新的工具级逐次确认通道（复用 bridge oneshot 机制 + 审批队列 UI，60s 超时 fail-closed）；前端 mcpBridge 增两个触发分支（只返回受理状态，绝不返回 vault 数据）；设置页 McpServerCard 按 `EntryForm.vue` 勾选范式渲染暴露面。

**Tech Stack:** Rust（rmcp 3.x + axum + tauri event/命令）、TypeScript/Vue3、vitest、`cargo test`。

**Spec:** `docs/superpowers/specs/2026-09-22-sync-ux-mcp-tools-design.md` §6（同步内核部分见姊妹计划 `2026-09-22-sync-core-ux.md`；触发器只依赖现有 `cloudSync.run('manual')` 与备份通道，可与该计划并行/任意顺序执行）

## Global Constraints

- **存量兼容是硬约束**：`exposedTools` 默认 `["list_accounts","get_code"]`；未配置该字段的存量 settings.json 反序列化自动补默认；read 工具现有门控行为完全不变。
- 触发器**绝不返回 vault 数据**：只返回 `{ triggered: boolean, reason?: string }`。
- action 工具确认：token 档免确认；wildcard/exact/alwaysAsk 档逐次确认；确认超时 60s fail-closed；无头模式（隐藏窗口无人确认）恒拒绝。
- 首连审批（客户端级）语义不变；工具级确认与客户端级审批是两个独立维度，都要过。
- 锁定态前置检查返回结构化 reason：`vault locked` / `no backup secret`，不重试不猜测。
- 文案 zh/en 双语 i18n（`mcpServer.exposed*`、`mcpConsent.tool*` 键）。
- 测试：`cargo test`（apps/desktop/src-tauri）、`pnpm --filter @totp/desktop... ` 目录内 vitest（`cd apps/desktop && pnpm exec vitest run src/mcpBridge.test.ts`）、每任务收尾 `pnpm -r run typecheck`。
- 提交原子化，Angular 规范。

---

### Task 1: McpConfig.exposedTools 字段与默认值

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs:23-45`（McpConfig + Default）
- Test: `apps/desktop/src-tauri/src/mcp_server.rs` tests 模块（追加）

**Interfaces:**
- Produces: `McpConfig.exposed_tools: Vec<String>`（serde camelCase → `exposedTools`；缺省字段反序列化补默认）

- [ ] **Step 1: Write the failing test**（追加到 tests 模块）

```rust
#[test]
fn exposed_tools_default_and_roundtrip() {
    // 存量 settings.json 无 exposedTools 字段 → 反序列化补默认（只读两工具）
    let legacy: McpConfig = serde_json::from_str(
        r#"{"enabled":true,"mode":"wildcard","port":47215,"token":"t","whitelist":[]}"#,
    ).unwrap();
    assert_eq!(legacy.exposed_tools, default_exposed_tools());
    // 全缺省
    let d = McpConfig::default();
    assert_eq!(d.exposed_tools, vec!["list_accounts".to_string(), "get_code".to_string()]);
    // 写读往返保留自定义暴露面
    let dir = std::env::temp_dir().join("mcp-exposed-test");
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("settings.json");
    let mut cfg = McpConfig::default();
    cfg.exposed_tools = vec!["list_accounts".into(), "trigger_sync".into()];
    save_mcp_config_inner(&f, &cfg).unwrap();
    assert_eq!(load_mcp_config_inner(&f).exposed_tools, cfg.exposed_tools);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test exposed_tools`
Expected: FAIL（无 exposed_tools 字段）

- [ ] **Step 3: Implement**

```rust
/// 工具暴露面默认值（spec §6.3）：仅两个只读工具；action 触发器默认关闭。
/// 序列化为 camelCase `exposedTools`；存量 settings.json 缺字段经 serde default 补齐——存量用户行为零变化
fn default_exposed_tools() -> Vec<String> {
    vec!["list_accounts".to_string(), "get_code".to_string()]
}

pub struct McpConfig {
    // ...既有字段不动...
    /// 暴露给 MCP 客户端的工具名列表（每请求重读即时生效；未知名在保存时滤除，见 save 侧校验）
    #[serde(default = "default_exposed_tools")]
    pub exposed_tools: Vec<String>,
}
```

`Default for McpConfig` 中 `exposed_tools: default_exposed_tools()`。保存侧校验：在 `save_mcp_config_inner` 入口加一行过滤（防手改 settings.json 注入未知名）：

```rust
let mut cfg = cfg.clone();
cfg.exposed_tools.retain(|t| tool_kind(t).is_some());
```

（`tool_kind` 在 Task 2 定义——本任务先以其签名占位编译不通过的话，把 Task 2 的注册表函数并入本任务提交；两函数都很小，合并提交合法。）

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test exposed_tools && cargo test mcp_config`
Expected: PASS（含既有配置 roundtrip 回归）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs
git commit -m "feat(desktop): MCP配置exposedTools暴露面字段（默认只读两工具+保存侧校验）"
```

---

### Task 2: 工具注册表与暴露面门控（纯函数）

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs`（若 Task 1 未并入则在此处加 `tool_kind`；gated_call 增暴露面检查）
- Test: 同文件 tests 模块

**Interfaces:**
- Produces: `ToolKind { Read, Action }`、`tool_kind(tool: &str) -> Option<ToolKind>`、`exposure_check(cfg: &McpConfig, tool: &str) -> Result<(), &'static str>`（gated_call 内每请求调用）

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn tool_registry_and_exposure() {
    assert_eq!(tool_kind("list_accounts"), Some(ToolKind::Read));
    assert_eq!(tool_kind("get_code"), Some(ToolKind::Read));
    assert_eq!(tool_kind("trigger_backup"), Some(ToolKind::Action));
    assert_eq!(tool_kind("trigger_sync"), Some(ToolKind::Action));
    assert_eq!(tool_kind("nope"), None);

    let cfg = McpConfig::default(); // exposed = 只读两工具
    assert_eq!(exposure_check(&cfg, "list_accounts"), Ok(()));
    assert_eq!(exposure_check(&cfg, "trigger_sync"), Err("tool disabled: not in exposed tools"));
    let mut cfg2 = McpConfig::default();
    cfg2.exposed_tools.push("trigger_sync".into());
    assert_eq!(exposure_check(&cfg2, "trigger_sync"), Ok(()));
    assert!(matches!(exposure_check(&cfg2, "nope"), Err(_)));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test tool_registry`
Expected: FAIL

- [ ] **Step 3: Implement**

```rust
/// 工具静态注册表（spec §6.2）：kind 决定门控强度；未知名 None（客户端调未知工具的
/// unknown tool 语义由 rmcp 层处理，此处只服务已定义工具的门控与保存侧过滤）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    /// 只读：现有门控行为完全不变
    Read,
    /// 触发写操作（备份/同步）：默认不暴露；非 token 档逐次确认
    Action,
}

pub fn tool_kind(tool: &str) -> Option<ToolKind> {
    match tool {
        "list_accounts" | "get_code" => Some(ToolKind::Read),
        "trigger_backup" | "trigger_sync" => Some(ToolKind::Action),
        _ => None,
    }
}

/// 暴露面门控（纯函数，gated_call 每请求调用；设置页勾选改动即时生效）
pub fn exposure_check(cfg: &McpConfig, tool: &str) -> Result<(), &'static str> {
    if tool_kind(tool).is_none() {
        return Err("unknown tool");
    }
    if !cfg.exposed_tools.iter().any(|t| t == tool) {
        return Err("tool disabled: not in exposed tools");
    }
    Ok(())
}
```

`gated_call`（`mcp_server.rs:442`）在 `if !cfg.enabled` 检查之后、`decide_gate` 之前插入：

```rust
exposure_check(&cfg, tool)
    .map_err(|e| McpError::invalid_params(e.to_string(), None))?;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test tool_registry && cargo test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs
git commit -m "feat(desktop): MCP工具注册表(read/action)与暴露面门控"
```

---

### Task 3: action 工具逐次确认通道（60s 超时 fail-closed）

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs`（gated_call 增 action 分支；新增 `tool_confirm`）
- Test: 同文件 tests 模块

**Interfaces:**
- Consumes: Task 2 `ToolKind`；既有 `bridge_call`（`mcp_server.rs:239-268`）的 alloc/oneshot 机制
- Produces: `action_confirm_required(kind: ToolKind, mode: GateMode) -> bool`（纯函数）；`tool_confirm(app, bridge, ident, tool) -> Result<bool, String>`（emit `mcp://tool-approval {id, ident, tool}` → 前端经既有 `mcp_respond` 命令回 `{ok:true, result:bool}`；60s 超时）

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn action_confirm_matrix() {
    // token 档：action 免确认（持有 token 即主人）
    assert!(!action_confirm_required(ToolKind::Action, GateMode::Token));
    // 其余档：逐次确认
    assert!(action_confirm_required(ToolKind::Action, GateMode::Wildcard));
    assert!(action_confirm_required(ToolKind::Action, GateMode::Exact));
    assert!(action_confirm_required(ToolKind::Action, GateMode::AlwaysAsk));
    // read：任何档都不加确认
    assert!(!action_confirm_required(ToolKind::Read, GateMode::AlwaysAsk));
}

#[tokio::test]
async fn tool_confirm_timeout_fails_closed() {
    // 不接前端：60s 窗口内无响应 → Err（用 pause 时间或缩短窗口注入测试；实现须把秒数作参数）
    let app: tauri::AppHandle = test_app_handle(); // 复用既有 tests 模块的 app handle 构造 helper；无则 emit 失败路径已覆盖 Err
    let bridge = std::sync::Arc::new(BridgeShared::default());
    let r = tool_confirm_with(&app, &bridge, "claude", "trigger_sync", std::time::Duration::from_millis(50)).await;
    assert!(r.is_err()); // 超时/事件通道不可用一律拒绝
}
```

（`tool_confirm` 对外固定 60s，内部委托 `tool_confirm_with(secs)` 便于测试；app handle helper 以 tests 模块既有构造为准，若无则只保留 emit 失败路径的单测。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test action_confirm && cargo test tool_confirm`
Expected: FAIL

- [ ] **Step 3: Implement**

```rust
/// action 工具是否需要逐次桌面确认（spec §6.2）：token 档免（持有 token 即主人）；read 恒否
pub fn action_confirm_required(kind: ToolKind, mode: GateMode) -> bool {
    kind == ToolKind::Action && mode != GateMode::Token
}

pub const TOOL_CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 工具级逐次确认：emit mcp://tool-approval（前端审批队列弹「允许执行 <tool>？」Allow/Deny），
/// 响应复用既有 mcp_respond 命令与 BridgeShared oneshot。超时/通道失败/用户拒绝一律不放行（fail-closed）。
/// 无头模式确认事件发往隐藏窗口=无人响应→超时拒绝，符合既有无头设计裁定（应配 token 档）。
async fn tool_confirm(
    app: &tauri::AppHandle,
    bridge: &BridgeShared,
    ident: &str,
    tool: &str,
) -> Result<bool, String> {
    tool_confirm_with(app, bridge, ident, tool, TOOL_CONFIRM_TIMEOUT).await
}

async fn tool_confirm_with(
    app: &tauri::AppHandle,
    bridge: &BridgeShared,
    ident: &str,
    tool: &str,
    timeout: std::time::Duration,
) -> Result<bool, String> {
    use tauri::Emitter;
    let id = bridge.alloc_id();
    let (tx, rx) = tokio::sync::oneshot::channel();
    bridge.insert(id, tx);
    let emit = app.emit_to("main", "mcp://tool-approval",
        serde_json::json!({ "id": id, "ident": ident, "tool": tool }));
    if let Err(e) = emit {
        bridge.take(id);
        return Err(format!("confirm dialog unavailable: {e}"));
    }
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(v))) => Ok(v.as_bool() == Some(true)),
        _ => {
            bridge.take(id);
            Err("tool confirmation timed out or failed".into())
        }
    }
}
```

`gated_call` 在 `decide_gate` match 之后、`bridge_call` 之前插入：

```rust
let kind = tool_kind(tool).expect("exposure_check guarantees known tool");
if action_confirm_required(kind, cfg.mode) {
    match tool_confirm(&self.app, &self.bridge, &ident, tool).await {
        Ok(true) => {}
        Ok(false) => {
            return Err(McpError::invalid_params("tool call denied by user in the TOTP app", None));
        }
        Err(e) => return Err(McpError::invalid_params(e, None)),
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs
git commit -m "feat(desktop): action类MCP工具逐次确认通道（60s超时fail-closed）"
```

---

### Task 4: 触发器工具定义（Rust #[tool]）

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs`（`#[tool_router] impl TotpMcp` 块 `mcp_server.rs:503-536` 追加两个方法）
- Test: 同文件 tests 模块（门控路径已被 Task 1-3 覆盖；此处补暴露面×确认矩阵的集成断言）

**Interfaces:**
- Produces: `trigger_backup`/`trigger_sync` 两个 rmcp 工具，入参空结构体 `TriggerParams {}`

- [ ] **Step 1: Write the failing test**（集成断言：构造 TotpMcp 经 rmcp 调用不可行则断言注册存在——`tool_kind` 已覆盖；本任务测试聚焦参数 schema 编译与 exposed 组合行为，若 rmcp 宏展开无法单测则仅 `cargo test` 编译回归）

- [ ] **Step 2: Implement**

```rust
#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct TriggerParams {}

#[tool(description = "Trigger a backup to all enabled local directory sources. Returns {triggered, reason?}. Never returns vault data.")]
async fn trigger_backup(
    &self,
    Parameters(_p): Parameters<TriggerParams>,
    context: RequestContext<RoleServer>,
) -> Result<CallToolResult, McpError> {
    let result = self.gated_call(&context, "trigger_backup", serde_json::json!({})).await?;
    Ok(CallToolResult::success(vec![ContentBlock::text(result.to_string())]))
}

#[tool(description = "Trigger a manual cloud sync across enabled targets. Returns {triggered, reason?}. Never returns vault data.")]
async fn trigger_sync(
    &self,
    Parameters(_p): Parameters<TriggerParams>,
    context: RequestContext<RoleServer>,
) -> Result<CallToolResult, McpError> {
    let result = self.gated_call(&context, "trigger_sync", serde_json::json!({})).await?;
    Ok(CallToolResult::success(vec![ContentBlock::text(result.to_string())]))
}
```

- [ ] **Step 3: Run build & tests**

Run: `cd apps/desktop/src-tauri && cargo test && cargo build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs
git commit -m "feat(desktop): MCP触发器工具trigger_backup/trigger_sync定义（action类）"
```

---

### Task 5: mcpBridge 触发分支与前端依赖注入

**Files:**
- Modify: `apps/desktop/src/mcpBridge.ts`（`McpBridgeDeps` 增两回调；`handleMcpRequest` 增两分支；`McpRequestPayload.args` 联合类型放宽）
- Test: `apps/desktop/src/mcpBridge.test.ts`（追加）

**Interfaces:**
- Produces: `McpBridgeDeps.triggerSync(): Promise<{ triggered: boolean; reason?: string }>`、`McpBridgeDeps.triggerBackup(): Promise<{ triggered: boolean; reason?: string }>`（App.vue Task 6 装配）

- [ ] **Step 1: Write the failing test**（追加到既有 mcpBridge.test.ts）

```ts
it('trigger_sync：透传 deps 结果（含 reason）', async () => {
  const deps = { requireEntries: () => [], tagsOf: () => [], triggerSync: async () => ({ triggered: false, reason: 'vault locked' }), triggerBackup: async () => ({ triggered: true }) }
  const r = await handleMcpRequest(deps, { id: 1, tool: 'trigger_sync', args: {} })
  expect(r).toEqual({ ok: true, result: { triggered: false, reason: 'vault locked' } })
})
it('trigger_backup：触发成功只回受理状态', async () => {
  const deps = { requireEntries: () => [], tagsOf: () => [], triggerSync: async () => ({ triggered: true }), triggerBackup: async () => ({ triggered: true }) }
  const r = await handleMcpRequest(deps, { id: 2, tool: 'trigger_backup', args: {} })
  expect(r).toEqual({ ok: true, result: { triggered: true } })
})
it('未知工具仍报 unknown tool（回归）', async () => {
  const deps = { requireEntries: () => [], tagsOf: () => [], triggerSync: async () => ({ triggered: true }), triggerBackup: async () => ({ triggered: true }) }
  expect((await handleMcpRequest(deps, { id: 3, tool: 'x', args: {} })).ok).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run src/mcpBridge.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`McpBridgeDeps` 追加（标注安全契约注释）：

```ts
  /** 触发器（spec §6.1）：只回受理状态，绝不返回 vault 数据；前置不满足回结构化 reason */
  triggerSync: () => Promise<{ triggered: boolean; reason?: string }>
  triggerBackup: () => Promise<{ triggered: boolean; reason?: string }>
```

`handleMcpRequest` 在 `get_code` 分支后追加：

```ts
    if (payload.tool === 'trigger_sync') return { ok: true, result: await deps.triggerSync() }
    if (payload.tool === 'trigger_backup') return { ok: true, result: await deps.triggerBackup() }
```

- [ ] **Step 4: Run test to verify it passes + 既有测试适配**（既有测试的 deps 对象补两个回调；`startMcpBridge` 消费方在 Task 6 适配）

Run: `cd apps/desktop && pnpm exec vitest run src/mcpBridge.test.ts && pnpm -r run typecheck`
Expected: PASS（typecheck 若因 App.vue 未适配报错，属 Task 6 范围——本任务先把 `startMcpBridge` 的调用处临时透传空实现会引入假绿，**禁止**；正确做法：deps 类型新增字段为必填会让 App.vue 编译失败，把 Task 5/6 合并为一个 commit 提交）

- [ ] **Step 5: Commit**（与 Task 6 合并提交）

---

### Task 6: 桌面装配（App.vue deps + autoBackup 手动备份入口）

**Files:**
- Modify: `apps/desktop/src/autoBackup.ts`（`createDesktopAutoRunner` 返回值增 `runBackupNow(): Promise<void>`——复用既有备份通道守护与执行体，reason='manual' 语义）
- Modify: `apps/desktop/src/App.vue`（`startMcpBridge` deps 补 `triggerSync`/`triggerBackup` 实现）

**Interfaces:**
- Produces: 触发实现（reason 与 spec §6.1 对齐）

- [ ] **Step 1: Implement autoBackup.runBackupNow**（在返回对象上加方法，内部走既有 `prefsGate` 之外的直接执行路径：`decideAutoRun` 守护照常，跳过即静默返回——bridge 侧前置检查已给出结构化 reason，此处静默不重复）

- [ ] **Step 2: App.vue 装配**（`startMcpBridge` 调用处补：

```ts
triggerSync: async () => {
  const s = store.value
  if (!s || s.locked.value) return { triggered: false, reason: 'vault locked' }
  if (s.backupSecret.value === null) return { triggered: false, reason: 'no backup secret' }
  await cloudSync.run('manual')
  return { triggered: true }
},
triggerBackup: async () => {
  const s = store.value
  if (!s || s.locked.value) return { triggered: false, reason: 'vault locked' }
  if (s.backupSecret.value === null) return { triggered: false, reason: 'no backup secret' }
  await auto.runBackupNow()
  return { triggered: true }
},
```

（`cloudSync`/`auto` 为 App.vue 既有实例；`no enabled sources`/`no primary target` 类原因由 runner recordStatus 记录、MCP 侧不重复判定——triggered=true 语义为「已受理执行」。）

- [ ] **Step 3: Run tests + typecheck**

Run: `cd apps/desktop && pnpm exec vitest run src/mcpBridge.test.ts src/autoBackup.test.ts && pnpm -r run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**（Task 5+6 一个 commit）

```bash
git add apps/desktop/src/mcpBridge.ts apps/desktop/src/mcpBridge.test.ts apps/desktop/src/autoBackup.ts apps/desktop/src/App.vue
git commit -m "feat(desktop): MCP触发器前端桥分支与桌面装配（锁定态结构化reason）"
```

---

### Task 7: 工具确认对话框（审批队列扩展 + i18n）

**Files:**
- Modify: `apps/desktop/src/mcpApprovalQueue.ts`（增 `queueToolConfirmation(payload: {id, ident, tool}, onDecide)`：同一 FIFO 与 10s 同 ident 去重口径）
- Modify: `apps/desktop/src/McpConsentDialog.vue`（增工具确认形态：标题「允许执行 <tool>？」+ Allow/Deny 两键——无 trust/once 梯度，逐次即焚）
- Modify: `apps/desktop/src/App.vue`（监听 `mcp://tool-approval` → 入队 → 决定后 `invoke('mcp_respond', {id, ok:true, result: allow, error:null})`）
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`（`mcpConsent.toolConfirmTitle`、`mcpConsent.toolConfirmBody`、`mcpConsent.allow`、`mcpConsent.deny`）
- Test: `apps/desktop/src/mcpApprovalQueue.test.ts`（追加：工具确认入队/去重/决定回调）

**Interfaces:**
- Consumes: Task 3 的 `mcp://tool-approval` 事件载荷 `{id, ident, tool}`；既有 `mcp_respond` 命令

- [ ] **Step 1: Write the failing test**（仿既有 mcpApprovalQueue.test.ts 模式）

```ts
it('工具确认：FIFO 顺序决定并回调；同 ident 10s 去重', async () => {})
it('拒绝路径回调 allow=false', async () => {})
```

- [ ] **Step 2: Run to verify fail → Implement → Run to verify pass**

Run: `cd apps/desktop && pnpm exec vitest run src/mcpApprovalQueue.test.ts`
Expected: FAIL → PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/mcpApprovalQueue.ts apps/desktop/src/mcpApprovalQueue.test.ts apps/desktop/src/McpConsentDialog.vue apps/desktop/src/App.vue packages/ui/src/i18n
git commit -m "feat(desktop): MCP工具级确认对话框（逐次Allow/Deny，复用审批队列）"
```

---

### Task 8: 设置页暴露面勾选组

**Files:**
- Modify: `packages/ui/src/components/mcpCard.ts`（`McpConfigDto` 增 `exposedTools: string[]`；增 `MCP_TOOLS: ReadonlyArray<{ name: string; kind: 'read' | 'action'; key: string }>` 与 `sanitizeExposedTools(list: string[]): string[]`（滤未知名+去重，保存前调用））
- Modify: `packages/ui/src/components/McpServerCard.vue`（「暴露工具」勾选组：`v-for MdCheckbox` 仿 `EntryForm.vue:429-435`；action 行附说明文案；变更即随 `setConfig` 整体回写）
- Test: `packages/ui/src/components/mcpCard.test.ts`（既有文件追加）

**Interfaces:**
- Consumes: Task 1 的 serde 契约（camelCase `exposedTools`）

- [ ] **Step 1: Write the failing test**

```ts
it('sanitizeExposedTools：滤未知名、去重、保持已知顺序', () => {
  expect(sanitizeExposedTools(['get_code', 'nope', 'trigger_sync', 'get_code']))
    .toEqual(['get_code', 'trigger_sync'])
  expect(sanitizeExposedTools([])).toEqual([])
})
it('MCP_TOOLS 清单：read 两个 + action 两个', () => {
  expect(MCP_TOOLS.filter((t) => t.kind === 'read').map((t) => t.name).sort())
    .toEqual(['get_code', 'list_accounts'])
  expect(MCP_TOOLS.filter((t) => t.kind === 'action').map((t) => t.name).sort())
    .toEqual(['trigger_backup', 'trigger_sync'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/ui exec vitest run src/components/mcpCard.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**（mcpCard.ts：

```ts
export const MCP_TOOLS = [
  { name: 'list_accounts', kind: 'read', key: 'mcpServer.toolListAccounts' },
  { name: 'get_code', kind: 'read', key: 'mcpServer.toolGetCode' },
  { name: 'trigger_backup', kind: 'action', key: 'mcpServer.toolTriggerBackup' },
  { name: 'trigger_sync', kind: 'action', key: 'mcpServer.toolTriggerSync' },
] as const

export function sanitizeExposedTools(list: string[]): string[] {
  const known = new Set(MCP_TOOLS.map((t) => t.name))
  return MCP_TOOLS.map((t) => t.name).filter((n) => list.includes(n) && known.has(n))
}
```

McpServerCard.vue 勾选组：卡片内既有「客户端授权」区块之后插入新区块，label `t('mcpServer.exposedTitle')` + hint（action 行后缀 `t('mcpServer.exposedActionHint')`）；toggle 实现 `const toggleTool = (name: string, on: boolean) => { const set = new Set(edit.exposedTools); on ? set.add(name) : set.delete(name); edit.exposedTools = sanitizeExposedTools([...set]) }`，走卡片既有 `setConfig` 回写路径（即时生效语义与 mode/whitelist 一致）。）

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @totp/ui exec vitest run src/components/mcpCard.test.ts && pnpm -r run typecheck && cd apps/desktop/src-tauri && cargo test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/mcpCard.ts packages/ui/src/components/mcpCard.test.ts packages/ui/src/components/McpServerCard.vue packages/ui/src/i18n
git commit -m "feat(ui): MCP设置页暴露工具勾选组（默认只读，action附写操作警示）"
```

---

### Task 9: 设计文档勘误与验收对账

**Files:**
- Modify: `docs/plans/2026-09-21-mcp-server-design.md`（追加勘误段落，不改原文）
- Modify: `docs/superpowers/specs/2026-09-22-sync-ux-mcp-tools-design.md`（如实现与 spec 有偏差回写勘误）

- [ ] **Step 1: 追加勘误段**（内容要点：「只读边界」自 2026-09-22 起放宽为「默认只读 + 用户显式勾选的 action 工具（更严门控：非 token 档逐次确认 + 默认不暴露）」；引用 spec §6.2 门控矩阵与无头模式裁定）

- [ ] **Step 2: 验收对账**（对照 spec §6 逐条自查并在 PR 描述/commit message 引用；端到端手测路径：设置页勾选 trigger_sync → wildcard 档 MCP 调用 → 桌面弹确认 → Allow → 返回 `{triggered:true}`；Deny → 返回 denial 错误；token 档免确认）

- [ ] **Step 3: 全仓回归**

Run: `pnpm -r --no-bail run test && pnpm -r run typecheck && cd apps/desktop/src-tauri && cargo test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/plans/2026-09-21-mcp-server-design.md docs/superpowers/specs/2026-09-22-sync-ux-mcp-tools-design.md
git commit -m "docs(mcp): 只读边界勘误——默认只读+显式勾选action工具（更严门控）"
```

---

## Self-Review 记录

- Spec 覆盖：§6.1 工具定义→Task 4/5/6；§6.2 门控叠加→Task 2/3；§6.3 配置与设置页→Task 1/8；勘误→Task 9。§6.1 的 reason 清单（`vault locked`/`no backup secret`）在 Task 6 落地；`no enabled sources`/`no primary target` 由同步侧（姊妹计划 Task 8 抛错语义）承载。
- 类型一致性：`exposed_tools`（Rust snake_case → serde camelCase `exposedTools`）与 `McpConfigDto.exposedTools`（Task 8）一致；`mcp://tool-approval` 载荷 `{id, ident, tool}` 在 Task 3（发）与 Task 7（收）一致；`mcp_respond` 复用既有命令契约。
- 已知取舍：确认响应复用 `BridgeShared` oneshot（不新建通道，Rust 面最小）；`triggered:true` 语义为「已受理执行」而非「同步业务成功」——业务结果经 CloudCard/状态行呈现，MCP 侧不二次轮询。
