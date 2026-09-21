# 桌面开发者能力（随机端口 / Remote Debug / 无头 MCP）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP 设置加随机端口按钮；设置内开启 WebView2 CDP 远程调试（默认关、红色警示）；CLI 参数 `--headless-mcp [--mcp-port n] [--mcp-token tok]` 以隐藏窗口运行完整前端+MCP server 并输出连接信息。

**Architecture:** 纯 CSS/组件层（随机端口）→ settings.json 新 `devtools` 键 + 启动最早处 `set_var`（remote debug）→ 新 `cli.rs` 解析 + `init_state_and_autostart` 内存覆盖 + main 窗口 `visible:false` + setup 按需 show（无头）。MCP 取数通道不变（Rust → main webview 前端）。

**Tech Stack:** Tauri 2（tauri.conf.json 窗口声明、tray、clipboard plugin）、`windows` crate（AttachConsole）、vitest（McpServerCard 若有测试）/ cargo test。

**Spec:** `docs/superpowers/specs/2026-09-21-desktop-devtools-headless-mcp-design.md`

## Global Constraints

- 端口允许范围恒为 1024–65535（`validate_port` 既有口径）；随机端口取 49152–65535。
- MCP server 与 devtools 均不得提供非 loopback 绑定。
- CLI 覆盖值仅本次运行生效，**不得回写 settings.json**。
- 解析失败 `eprintln!` + `std::process::exit(2)`。
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 必须在任何 WebView 创建前设置。

---

### Task 1: MCP 随机端口按钮（条目 1）

**Files:**
- Modify: `packages/ui/src/components/McpServerCard.vue`（`.cfg-row` 约 207-217 行 + style 约 286 行）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`（`mcpServer` 节点）

**Interfaces:**
- Consumes: 现有 `portText`/`onPortInput`/`onPortCommit`/`persist`
- Produces: 无接口变化

- [ ] **Step 1: 加按钮与处理函数**

script 段加：

```ts
/** 验收条目1：随机到 IANA 动态端口段 49152-65535，走 onPortCommit 同路径校验+持久化 */
function onRandomPort(): void {
  portText.value = String(49152 + Math.floor(Math.random() * (65535 - 49152 + 1)))
  void onPortCommit()
}
```

template 端口 `MdTextField` 后追加：

```html
<MdIconButton class="random-port" :title="t('mcpServer.randomPort')" :aria-label="t('mcpServer.randomPort')" @click="onRandomPort">⟳</MdIconButton>
```

i18n：`"randomPort": "随机端口"` / `"randomPort": "Random port"`。

- [ ] **Step 2: 验证**

Run: `pnpm --filter @totp/ui typecheck && pnpm --filter @totp/ui test`
Expected: 全绿。手动：点击按钮生成 49152–65535 内端口且失焦提交链路正常。

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/McpServerCard.vue packages/ui/src/i18n/locales
git commit -m "feat(desktop): MCP端口一键随机（动态端口段49152-65535）（验收条目1）"
```

### Task 2: devtools 配置的 Rust 读取与环境注入

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（settings 读取 helper 附近，约 59-115 行区域）

**Interfaces:**
- Consumes: settings.json 合并写既有 helper（`read_shortcut_from_settings` 同口径）
- Produces: `read_devtools_from_settings_text(text: &str) -> (bool, u16)`（纯函数，供单测）；`apply_devtools_env() -> ()`

- [ ] **Step 1: 写失败测试**

在 lib.rs 既有 `#[cfg(test)] mod tests` 内加：

```rust
#[test]
fn devtools_config_parse() {
    // 缺省：关
    assert_eq!(read_devtools_from_settings_text("{}"), (false, 9222));
    // 开启 + 自定义端口
    assert_eq!(
        read_devtools_from_settings_text(r#"{"devtools":{"enabled":true,"port":9333}}"#),
        (true, 9333),
    );
    // 非法端口回落默认
    assert_eq!(
        read_devtools_from_settings_text(r#"{"devtools":{"enabled":true,"port":80}}"#),
        (true, 9222),
    );
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/desktop/src-tauri && cargo test devtools_config_parse`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现**

lib.rs（settings helper 区域）：

```rust
/// 验收条目4：WebView 远程调试配置（settings.json `devtools` 键；明文区——须在无解锁态可读）。
/// 返回 (enabled, port)；缺省 (false, 9222)，enabled=true 而 port<1024 时端口回落 9222
fn read_devtools_from_settings_text(text: &str) -> (bool, u16) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return (false, 9222) };
    let Some(d) = v.get("devtools") else { return (false, 9222) };
    let enabled = d.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
    let port = d.get("port").and_then(|x| x.as_u64()).filter(|p| (1024..=65535).contains(p)).unwrap_or(9222) as u16;
    (enabled, port)
}

/// 须在任何 WebView 创建前调用（run() 最早期）；settings.json 路径按
/// Windows app_data_dir 规则 %APPDATA%/{identifier} 解析（mac/linux 无 CDP 端口通道，恒 no-op）
fn apply_devtools_env() {
    #[cfg(windows)]
    {
        let Ok(appdata) = std::env::var("APPDATA") else { return };
        let Ok(conf) = include_str!("../tauri.conf.json").parse::<serde_json::Value>() else { return };
        let Some(id) = conf["identifier"].as_str() else { return };
        let Ok(text) = std::fs::read_to_string(std::path::Path::new(&appdata).join(id).join("settings.json")) else { return };
        let (enabled, port) = read_devtools_from_settings_text(&text);
        if enabled {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", format!("--remote-debugging-port={port}"));
        }
    }
}
```

run() 最开头调用 `apply_devtools_env();`（`let mut builder` 之前）。

注意：`include_str!("../tauri.conf.json")` 解析取顶层 `"identifier"`（实际值 `com.totp.desktop`，tauri.conf.json:5）；依赖 `serde_json`（已是依赖）。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/desktop/src-tauri && cargo test devtools_config_parse`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): devtools配置读取与WEBVIEW2远程调试端口注入（验收条目4）"
```

### Task 3: devtools feature 与设置 UI

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`（tauri features）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（新增保存命令 + invoke_handler 注册）
- Modify: `packages/ui/src/pages/SettingsPage.vue`（桌面专属区，McpServerCard 渲染点约 167-169 行旁）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`

**Interfaces:**
- Consumes: settings.json 合并写既有 helper；SettingsPage 桌面专属渲染分支（`platform` 判定同 McpServerCard）
- Produces: tauri 命令 `devtools_get_config() -> {enabled, port}`、`devtools_set_config(enabled: bool, port: u16) -> ()`

- [ ] **Step 1: Cargo feature**

`tauri = { version = "2", features = ["tray-icon"] }` 的 features 改为 `["tray-icon", "devtools"]`。

- [ ] **Step 2: Rust 命令**

```rust
/// devtools 设置读/写（明文 settings.json；读经 settings_path + 文本解析，写走
/// read-modify-write 合并既有键——同 write_shortcut_to_settings(lib.rs:99) 的合并口径，
/// 不得整文件覆盖丢外来键）
#[tauri::command]
fn devtools_get_config<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    let text = settings_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "{}".into());
    let (enabled, port) = read_devtools_from_settings_text(&text);
    Ok(serde_json::json!({ "enabled": enabled, "port": port }))
}

#[tauri::command]
fn devtools_set_config<R: tauri::Runtime>(app: tauri::AppHandle<R>, enabled: bool, port: u16) -> Result<(), String> {
    if port < 1024 { return Err(format!("端口 {port} 不在允许范围 1024-65535")); }
    let path = settings_path(&app).ok_or("无法定位 settings.json")?;
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    root["devtools"] = serde_json::json!({ "enabled": enabled, "port": port });
    std::fs::write(&path, serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
```

（两命令注册进 `generate_handler!`；若 `write_shortcut_to_settings` 内部已有可复用的合并写私有函数，直接调用之并在注释标注。）

- [ ] **Step 3: 设置 UI**

SettingsPage 桌面专属区新增「开发者」卡片：

```html
<MdCard v-if="isDesktop" headline="开发者">
  <div class="row devtools-row">
    <div class="devtools-text">
      <div>{{ t('settings.devtoolsTitle') }}</div>
      <p class="devtools-warn">{{ t('settings.devtoolsWarn') }}</p>
    </div>
    <MdSwitch v-model="devtoolsEnabled" />
  </div>
  <div v-if="devtoolsEnabled" class="row">
    <MdTextField v-model="devtoolsPort" type="number" :label="t('settings.devtoolsPort')" @change="commitDevtools" />
    <span class="devtools-restart">{{ t('settings.devtoolsRestart') }}</span>
  </div>
</MdCard>
```

setup 段：onMounted `invoke('devtools_get_config')` 预填；`commitDevtools` 校验后 `invoke('devtools_set_config', { enabled, port })`。`.devtools-warn` 用 `color: var(--md-sys-color-error)`。
i18n：`devtoolsTitle`（WebView 远程调试）/ `devtoolsWarn`（**开放期间本机任意进程可经此端口读取窗口内明文密钥，仅限本机诊断，用完即关**）/ `devtoolsPort`（调试端口，默认 9222）/ `devtoolsRestart`（重启应用后生效）。

- [ ] **Step 4: 验证**

Run: `cd apps/desktop/src-tauri && cargo check && cargo test && cd ../.. && pnpm typecheck && pnpm test`
Expected: 全绿。手动：开启+重启后 `curl http://127.0.0.1:9222/json` 有响应；关闭+重启后无。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri packages/ui/src/pages/SettingsPage.vue packages/ui/src/i18n/locales
git commit -m "feat(desktop): 设置内WebView远程调试开关（默认关+高危警示，devtools feature）（验收条目4）"
```

### Task 4: CLI 参数解析模块

**Files:**
- Create: `apps/desktop/src-tauri/src/cli.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`mod cli;`）

**Interfaces:**
- Consumes: 无
- Produces: `cli::CliOpts { headless_mcp: bool, mcp_port: Option<u16>, mcp_token: Option<String> }`、`cli::parse_args(args: &[String]) -> Result<CliOpts, String>`、`cli::mcp_override(opts: &CliOpts) -> Option<(Option<u16>, Option<String>)>`

- [ ] **Step 1: 写实现与单测（同文件 TDD 一体）**

`cli.rs`：

```rust
//! 无头 MCP 启动参数解析（验收条目13）。仅三个参数，解析失败返回 Err（run 里 stderr+exit(2)）。

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CliOpts {
    pub headless_mcp: bool,
    pub mcp_port: Option<u16>,
    pub mcp_token: Option<String>,
}

pub fn parse_args(args: &[String]) -> Result<CliOpts, String> {
    let mut opts = CliOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--headless-mcp" => opts.headless_mcp = true,
            "--mcp-port" => {
                i += 1;
                let v = args.get(i).ok_or("--mcp-port 缺少值")?;
                let p: u16 = v.parse().map_err(|_| format!("--mcp-port 非法: {v}"))?;
                if p < 1024 {
                    return Err(format!("--mcp-port {p} 不在允许范围 1024-65535"));
                }
                opts.mcp_port = Some(p);
            }
            "--mcp-token" => {
                i += 1;
                let v = args.get(i).ok_or("--mcp-token 缺少值")?;
                if v.len() < 16 {
                    return Err("--mcp-token 过短（至少 16 字符）".into());
                }
                opts.mcp_token = Some(v.clone());
            }
            other => return Err(format!("未知参数: {other}")),
        }
        i += 1;
    }
    if !opts.headless_mcp && (opts.mcp_port.is_some() || opts.mcp_token.is_some()) {
        return Err("--mcp-port/--mcp-token 仅在 --headless-mcp 下有效".into());
    }
    Ok(opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> { v.iter().map(|x| x.to_string()).collect() }

    #[test]
    fn default_empty() { assert_eq!(parse_args(&[]).unwrap(), CliOpts::default()); }

    #[test]
    fn headless_only() {
        assert!(parse_args(&s(&["--headless-mcp"])).unwrap().headless_mcp);
    }

    #[test]
    fn port_and_token() {
        let o = parse_args(&s(&["--headless-mcp", "--mcp-port", "47216", "--mcp-token", "0123456789abcdef"])).unwrap();
        assert_eq!(o.mcp_port, Some(47216));
        assert_eq!(o.mcp_token.as_deref(), Some("0123456789abcdef"));
    }

    #[test]
    fn rejects_low_port_and_short_token_and_unknown() {
        assert!(parse_args(&s(&["--headless-mcp", "--mcp-port", "80"])).is_err());
        assert!(parse_args(&s(&["--headless-mcp", "--mcp-token", "short"])).is_err());
        assert!(parse_args(&s(&["--verbose"])).is_err());
        assert!(parse_args(&s(&["--mcp-port", "47216"])).is_err()); // 缺 headless
        assert!(parse_args(&s(&["--mcp-port"])).is_err()); // 缺值
    }
}
```

lib.rs 顶部加 `mod cli;`。

- [ ] **Step 2: 运行**

Run: `cd apps/desktop/src-tauri && cargo test cli::`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/cli.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): 无头MCP启动参数解析模块（验收条目13）"
```

### Task 5: 无头模式集成（窗口/MCP 覆盖/输出/托盘）

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs`（`init_state_and_autostart` 签名与逻辑；同步修其 tests 内既有调用）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（run()、setup、托盘菜单）
- Modify: `apps/desktop/src-tauri/tauri.conf.json`（main 窗口 `visible: false`）
- Modify: `apps/desktop/src-tauri/Cargo.toml`（`[target.'cfg(windows)'.dependencies] windows`（如依赖树无现成版本））

**Interfaces:**
- Consumes: `cli::CliOpts`（Task 4）、`load_mcp_config_inner`
- Produces: `McpOverride { port: Option<u16>, token: Option<String> }`；`init_state_and_autostart(app, ov: &McpOverride)`

- [ ] **Step 1: mcp_server.rs 覆盖参数**

```rust
/// 无头模式 CLI 内存覆盖（验收条目13）：仅本次运行生效，不回写 settings.json
#[derive(Debug, Default, Clone)]
pub struct McpOverride {
    pub port: Option<u16>,
    pub token: Option<String>,
}

pub fn init_state_and_autostart(app: &mut tauri::App, ov: &McpOverride) -> Result<(), String> {
    // ...现有 state 构造不变...
    let mut cfg = load_mcp_config_inner(&state.settings_file);
    let overridden = ov.port.is_some() || ov.token.is_some();
    if let Some(p) = ov.port { cfg.port = p; }
    if let Some(t) = &ov.token { cfg.token = t.clone(); }
    if overridden { cfg.enabled = true; }
    app.manage(state);
    if cfg.enabled {
        // ...现有 start_server 分支不变（错误 eprintln 不拦启动）...
        // 覆盖运行时补一条 stdout 连接信息（run() 里统一打印亦可，二选一勿重复）
    }
    Ok(())
}
```

同步修正 tests 模块中的既有调用为 `init_state_and_autostart(app, &McpOverride::default())`。

- [ ] **Step 2: lib.rs run() 集成**

```rust
pub fn run() {
    let cli = match cli::parse_args(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(c) => c,
        Err(e) => { eprintln!("参数错误: {e}"); std::process::exit(2); }
    };
    #[cfg(windows)]
    if cli.headless_mcp {
        attach_parent_console(); // windows_subsystem=windows 下尽力接管父控制台，使 println 可见
    }
    apply_devtools_env(); // Task 2 已置于最前——保持两者顺序：CLI 解析 → console → devtools env
    let override_ = mcp_server::McpOverride { port: cli.mcp_port, token: cli.mcp_token.clone() };
    // ...builder 链不变，setup 内：
    //   mcp_server::init_state_and_autostart(app, &override_)?;
    //   if cli.headless_mcp {
    //       println!("MCP: http://127.0.0.1:{}  token: {}  gate: {:?}", cfg.port, cfg.token, cfg.mode);
    //   } else if let Some(w) = app.get_webview_window("main") { let _ = w.show(); }
```

`cfg` 从 `load_mcp_config_inner` 拿（init_state_and_autostart 返回后由 run 侧重读一次，或让该函数返回 cfg——实现时选改动最小者并保持两者一致）。

`attach_parent_console`（lib.rs 顶部）：

```rust
#[cfg(windows)]
fn attach_parent_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    // GUI 子系统无宿主控制台；附加失败（如从 GUI 启动）静默——托盘「复制连接信息」兜底
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}
```

Cargo.toml（依赖树若已含 windows crate，用 `cargo tree -p windows` 确认版本后显式声明同版本）：

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = ["Win32_System_Console"] }
```

托盘菜单：`cli.headless_mcp` 时在 show-main 之前插入 `copy-mcp-info` 项（"复制 MCP 连接信息"），`on_menu_event` 命中后 `app.clipboard().write_text(format!("MCP: http://127.0.0.1:{port}  token: {token}"))`（tauri_plugin_clipboard_manager 的 Manager 扩展；实现时按插件真实 API 对齐）。

- [ ] **Step 3: tauri.conf.json 窗口改可见性**

main 窗口加/改 `"visible": false`。验证非 headless 无闪现（setup 同步 show 在首帧前）；若实测有闪现，回退本步改用 setup 里 headless 时 `hide()` 方案并在此记录。

- [ ] **Step 4: 全量验证**

Run: `cd apps/desktop/src-tauri && cargo check && cargo test && cd ../.. && pnpm typecheck && pnpm test`
Expected: 全绿。

- [ ] **Step 5: 手动验收**

1. 终端启动 `pnpm tauri dev -- -- --headless-mcp`（参数透传格式以 tauri CLI 为准；release exe 直接 `totp-desktop.exe --headless-mcp`）→ stdout 打印连接信息、无窗口。
2. 外部 MCP 客户端（或 `scripts/mcp-e2e.mjs` 改造）连 `http://127.0.0.1:<port>`，带 Bearer token 调 `list_accounts`（已绑 OS 自动解锁时返回条目；未绑定时 `vault locked`）。
3. 托盘「复制 MCP 连接信息」→ 粘贴可见地址+token。
4. 正常双击启动：窗口出现、无闪现、无多余 stdout。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(desktop): 无头模式运行MCP server（隐藏窗口+CLI覆盖+连接信息输出）（验收条目13）"
```
