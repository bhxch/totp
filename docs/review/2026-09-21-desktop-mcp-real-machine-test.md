# 桌面 MCP 真机功能测试方案（plan17 手动验收）

日期：2026-09-21。被测对象：`apps/desktop`（main @ 1f91ebb，plan17 MCP 全量修复合入后）。
目标：以 tauri-mcp 驱动真机 UI，完成 plan17 遗留的 10 项手动验收（发布 gate）+ 2 条真机缺口，含通过 UI 录入 entry（自造 mock 数据）。

## 一、环境与基建

| 项 | 决定 |
|---|---|
| 应用运行方式 | `pnpm tauri dev`（debug 构建），工作目录 `apps/desktop` |
| UI 驱动 | `@hypothesi/tauri-mcp-cli`（bin `tauri-mcp`，全局安装）+ 被测应用集成 `tauri-plugin-mcp-bridge` |
| bridge 集成 | **dev-only 激活，release 零影响**：`Cargo.toml` 普通依赖（cargo 不支持 `cfg(debug_assertions)` target 选择器）+ `lib.rs` 内 `#[cfg(debug_assertions)]` 门控注册（绑 127.0.0.1）；`tauri.conf.json` 开 `withGlobalTauri`（应用不加载远程内容，暴露面可控）；`capabilities/default.json` 授 `mcp-bridge:default`（**webview 侧 `plugin:mcp-bridge|script_result` 回传必须授权，否则 eval 全部 2s 超时——本次最大坑**）；`vite.config.ts` watch 排除 `src-tauri/target`（cargo 构建期 EBUSY 会打崩 dev server） |
| 数据目录 | `%APPDATA%\com.totp.desktop`（dev 与 release 同目录；当前仅有 settings.json，已备份至 `E:/tmp/cc/totp-realtest-backup-settings.json`） |
| MCP 协议验证 | 复用 `scripts/mcp-e2e.mjs`（裸 fetch）+ `mcporter`（真实 MCP 客户端）做真连替代验证 |

## 二、Mock 数据（自造，全部 RFC 6238 附录 B 测试向量派生）

| 条目 | 录入路径 | secret / 参数 | 用途 |
|---|---|---|---|
| GitLab / alice@example.com | 智能粘贴 otpauth URI | `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` SHA1/6/30 | 批量录入 + 无规则不命中 url 过滤 |
| Example / bob@example.com | 智能粘贴 | RFC SHA256 向量（64 字符）SHA256/8/60 | 非默认参数算法 |
| HOTPTest / counter | 智能粘贴 | `otpauth://hotp/...&counter=0` | hotp 窥视不推进 counter |
| GitHub / alice@gh | 手动表单 | RFC SHA1 向量 `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` | 手动路径 + URL 匹配规则 baseDomain github.com |
| Steam / steamuser | 手动表单 | RFC 向量，类型选 Steam（固定 5 位） | 特殊类型表单 |

码值正确性：取码同时用 `node:crypto`（HMAC-SHA1/256 + 动态截断）按 RFC 6238 独立计算比对。

## 三、用例 ↔ 验收清单映射

| # | 用例 | 覆盖验收项 |
|---|---|---|
| TC0 | dev 启动、driver session `connected:true` | 前置 |
| TC1 | 设置页「MCP 服务器」卡片存在且默认关闭（截图+DOM） | 验收 1 |
| TC2 | 启用→token 生成→运行态「运行中」→ `scripts/mcp-e2e.mjs` 全 PASS（先切「仅 Token」档避开审批） | 验收 2 |
| TC3 | 录入 5 条 mock 条目（智能粘贴 3 + 手动 2），列表显示、码滚动 | 本任务新增 |
| TC4 | `list_accounts(url=https://github.com/x)` 只回 GitHub 条目；不带 url 回全部 | 验收 7 |
| TC5 | 输出契约：list/get_code 全字段无 `secret`/`pin`；码值与独立计算一致；hotp 连取两次 counter 不推进 | 验收 8 + 正确性 |
| TC6 | 审批流（wildcard 白名单空）：e2e 调用触发应用内弹窗（截图）→「仅本次」→ 15min 内免弹；再触发→Esc=deny→60s 冷却内不弹；再触发→「加入白名单」→ settings.json `mcp.whitelist` 含 mcp-e2e，后续免确认 | 验收 4+5 |
| TC7 | token 轮换：「重新生成」确认→旧 token 401→新 token PASS | 验收 9 |
| TC8 | 加密+锁定：安全页启用加密（口令 Test-Pw!）→ 重启应用（顺带验证「重启后保持锁定」）→ get_code 得 vault locked → UI 解锁恢复 | 验收 3 |
| TC9 | alwaysAsk 档：调用触发弹窗→「仅本次」可调；重启（once 存内存即清）→ 再调再次弹窗 | 验收 6 |
| TC10 | 托盘隐藏态：主窗隐藏到托盘 → get_code 仍成功 → 托盘恢复 | 缺口：托盘存活性 |
| TC11 | mcporter 真实 MCP 客户端真连（HTTP + Bearer）list+get_code 成功；产出 ZCode `.mcp.json` 连接片段供用户终验 | 验收 10（终验主体自动化，ZCode 真连留连接片段） |
| TC12 | 防火墙提示观察（127.0.0.1 绑定通常不触发，记录即可） | 缺口 |

执行顺序：TC0→TC1→TC2→TC3→TC4→TC5→TC6→TC7→TC8→TC9→TC10→TC11→TC12。
时序注意：审批弹窗事件桥 5s 超时——TC6 用后台异步发请求 + 轮询 DOM 点按钮，不能串行等待。

## 四、风险与回退

- crates.io 走 ustc 镜像，插件新增依赖编译约 1-2 分钟（增量）。
- dev 与 release 共享数据目录：已备份 settings.json；金库为测试自建，测完如需还原删除整个目录即可。
- 审批 5s 超时窗口：脚本先行（见 TC6 注）。
- 若 `withGlobalTauri` 覆盖未生效（老版 tauri-cli 行为差异），回退为直接改主 conf 并在测后还原。

## 五、产出

- 本文档记录逐项结果（✅/❌+证据）。
- 证据截图入库 `docs/review/assets/2026-09-21-desktop-mcp/`。
- 提交拆分：①测试方案 ②dev-only bridge 基建 ③报告（含证据图）。

---

## 六、执行结果（2026-09-21 真机完成，main @ 48b5e2d + 测试基建）

**总结论：plan17 手动验收 10 项全部通过（第 10 项以官方 MCP SDK 真实客户端 mcporter 真连取码为主体验证，ZCode 会话内终验留连接片段），2 条真机缺口（托盘隐藏态取码、防火墙提示）亦过。发布 gate 解除。**

### 关键发现（对产品的真实价值）

1. **【真 Bug，已修】`capabilities/default.json` 未授权 `mcp-bridge:default`**：Tauri 2 权限系统会拒绝 webview 侧 `plugin:mcp-bridge|script_result` 回传，症状为 tauri-mcp 一切 webview 操作（eval/截图/读日志）2 秒超时，而后端命令（backend_state/list_windows）正常。Rust 侧无任何告警，属静默失败。修复已随测试基建提交（48b5e2d）。
2. **Hyper-V/WSL 隐藏端口保留段**：本机 TCP 47210-47220（含默认端口 47215）被动态保留，bind 报 10048（os error）但 `netstat`/`Get-NetTCPConnection`/`netsh excludedportrange` 均不可见。真机验证了产品的两道防线：设置卡片正确显示「Start failed: bind ... 10048」错误横幅（fail-closed）；改端口为 48215 后 change 即重启生效、服务 Running。用户机器若命中保留段，按卡片错误改端口即可恢复。
3. **Esc deny 自动化经验**：合成 `KeyboardEvent`（isTrusted=false 的 window/element 派发）无法关闭 MdDialog，`webview-keyboard press Escape`（真实键注入）有效。deny 回执链路（Esc → onApprovalAction('deny') → 60s 冷却 → 重调得 denied 文案）已实证。
4. **审批时序对自动化友好**：NeedsApproval 是「立即回 -32602 pending 错误 + 弹窗，批准后重调才成功」，不阻塞等待——无需异步竞态脚本。

### 逐项结果

| 用例 | 结果 | 证据/说明 |
|---|---|---|
| TC0 环境 | ✅ | dev 构建 + bridge 插件 + driver session `connected:true`（identifier com.totp.desktop） |
| TC1 卡片默认关 | ✅ | switch `checked:false`、状态「Stopped」；截图 tc1 |
| TC2 启用+e2e | ✅ | token 自动生成（掩码/显示切换正常）；`scripts/mcp-e2e.mjs` 8 断言全 PASS（EXIT=0）；运行态「Running」；截图 tc2 |
| TC3 录入 entry | ✅ | 智能粘贴 3 条（GitLab TOTP / Example SHA256-8-60 / HOTPTest counter=0）解析预览全部「New」入库；手动表单 2 条（GitHub + baseDomain github.com 规则、Steam 类型 5 字符）；列表 5 条全部滚码；截图 tc3 |
| TC4 url 过滤 | ✅ | `url=https://github.com/x/y` → 仅 GitHub（带规则）；GitLab（无规则）与 nomatch → 空数组（「无规则不命中」设计行为）；无 url → 全 5 条 |
| TC5 契约+正确性 | ✅ | GitHub 码与 RFC 6238 独立计算精确一致（099156）；Example（SHA256/40B key/period 60）一致（75065527）；MCP 与 UI 同窗一致（582734）；HOTP 双取同码且 `counter:0` + note「peeked, not advanced」；list 字段 ⊆ {id,issuer,label,tags,type}、get_code ⊆ {code,expires_in_seconds,period}（hotp 附 counter/note 属设计），无 secret/pin |
| TC6 审批流 | ✅ | pending 错误形态 = JSON-RPC `-32602 "approval pending..."`；弹窗含 ident/tool/三按钮（截图 tc6）；Allow once → 15min 内免弹重调成功；吊销（卡片「清除一次性授权」）→ 再调弹窗 → Esc=deny → 重调得 denied 文案且冷却内不弹；Add to whitelist → settings.json `mcp.whitelist:["mcp-e2e"]` → 免确认 |
| TC7 token 轮换 | ✅ | 「重新生成」确认后旧 token 立即 401；新 token e2e 全 PASS（含 get_code 成功链路） |
| TC8 加密+锁定 | ✅ | 启用加密（口令自造）；两次重启均出 LockScreen（lockOnRestart）；MCP 调用得 `-32602 "vault locked"`；UI 解锁后 MCP 恢复；截图 tc8 |
| TC9 alwaysAsk | ✅ | 档位切换生效；调用即弹窗 → Allow once → 成功；重启（once 存内存即清）后重调弹窗重现（截图 tc9）。注：完整 15min TTL 未实际等待，以「重启清空 once」等价验证过期路径 |
| TC10 托盘隐藏态 | ✅ | 「隐藏到托盘」后窗口 vis=False，webview 存活（JS 可执行），`list_accounts`+`get_code` 均成功返回真码 |
| TC11 真连 | ✅ | mcporter（官方 `@modelcontextprotocol/client` SDK + StreamableHTTP）真连：新客户端正确收到 approval pending → 应用内批准 → `list_accounts` 返回 5 条、`get_code` 取到真码 021449。ZCode 终验连接片段见下 |
| TC12 防火墙 | ✅ | 全程 127.0.0.1 loopback 绑定，未触发 Windows 防火墙提示（符合预期） |

### ZCode 真连配置片段（终验用）

在本项目 `.mcp.json`（或 ZCode MCP 配置）加入后重启会话，即可让 agent 直接调用 `list_accounts` / `get_code`：

```json
{
  "mcpServers": {
    "totp-desktop": {
      "type": "http",
      "url": "http://127.0.0.1:48215/mcp",
      "headers": { "Authorization": "Bearer <在应用设置页 MCP 卡片复制 Token>" }
    }
  }
}
```

> 端口注意：默认 47215；本机该段被 Hyper-V 动态保留，测试实例改用 48215。若 ZCode 连接报 10048 相关失败，在应用卡片换端口后同步改此 URL。首次连接若为 wildcard/exact/alwaysAsk 档，应用内会弹审批（一次「加入白名单」后免确认）。

### 环境与遗留状态

- 测试金库保留于 `%APPDATA%\com.totp.desktop`（5 条 mock 条目、加密口令 `Test-Pw!234`、MCP enabled@48215、token 为测试轮换值）；原始 settings.json 备份在 `E:/tmp/cc/totp-realtest-backup-settings.json`。不需要时删除整个目录即回到初始态。
- 测试辅助脚本（.temp/mcp-test/，不入库）：mcp-call.mjs / tc5-verify.mjs / tc6-call.mjs / compute-otp.mjs。
- dev 依赖的 `tauri-plugin-mcp-bridge` 已入库为测试基建（注册 cfg(debug_assertions) 门控，release 不激活；`withGlobalTauri` + `mcp-bridge:default` 对 release 生效但应用不加载远程内容，暴露面可接受——如不接受可在发布前 revert tauri.conf.json/capabilities 两行并保留 Cargo/lib.rs 结构）。
