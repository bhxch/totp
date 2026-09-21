# 桌面 MCP 真机功能测试方案（plan17 手动验收）

日期：2026-09-21。被测对象：`apps/desktop`（main @ 1f91ebb，plan17 MCP 全量修复合入后）。
目标：以 tauri-mcp 驱动真机 UI，完成 plan17 遗留的 10 项手动验收（发布 gate）+ 2 条真机缺口，含通过 UI 录入 entry（自造 mock 数据）。

## 一、环境与基建

| 项 | 决定 |
|---|---|
| 应用运行方式 | `pnpm tauri dev`（debug 构建），工作目录 `apps/desktop` |
| UI 驱动 | `@hypothesi/tauri-mcp-server`（bin `mcp-server-tauri`，全局安装）+ 被测应用临时集成 `tauri-plugin-mcp-bridge` |
| bridge 集成 | **dev-only，release 零影响**：`Cargo.toml` 以 `[target.'cfg(debug_assertions)'.dependencies]` 引入插件；`lib.rs` 内 `#[cfg(debug_assertions)]` 注册（绑 127.0.0.1）；`tauri.dev.conf.json` 覆盖文件开 `withGlobalTauri`，经 `tauri dev --config` 使用，主 `tauri.conf.json` 不动 |
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
