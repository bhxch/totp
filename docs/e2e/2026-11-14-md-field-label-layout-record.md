# 2026-11-14 MD 字段浮动标签几何回归 真机走查

用户报障「切到英文后设置页 `Interface language` 换行两行、压住下方 `English`」，
连带排查同族字段（MdTextField / 其余 MdSelect）的同类问题。桌面 debug 构建
（tauri-mcp 驱动真 WebView2，127.0.0.1:9223）真机实证，并新增可复跑的
`scripts/ui-layout-e2e.mjs` 作长期回归守卫。

## 走查方式

- 桌面 debug 构建（`apps/desktop/src-tauri/target/debug/totp-desktop.exe`，mcp-bridge 仅
  `#[cfg(debug_assertions)]` 装配）+ 同起 vite dev server（devUrl `http://localhost:1420`）。
- 驱动：`tauri-mcp driver-session start --port 9223` → `webview-execute-js` 在真 webview 里
  量测 `getBoundingClientRect()`（真像素，jsdom 无布局、单测只能钉结构与 CSS 声明）。
- 数据：本机 `%APPDATA%\com.totp.desktop` 无存量数据（新目录，无金库、无锁定页），
  走查后删除；测试数据仅语言档位切换，无真实条目。

## 根因

`MdSelect` / `MdTextField` 的浮动 label 是**绝对定位**（`left:16px; top:8px`），不参与字段
固有宽度计算；字段宽度只随「当前值」收缩。于是：

- 短值 + 长 label → 字段容不下 label → label 折成两行 → 第二行压住下方值行
  （浮动态 label 带 y8..40，值行 y24..48，重叠 12px）；
- 固定宽度字段（`width: 140px` 等）→ label 直接折行压值，或被省略号裁切读不全。

## 修法（组件层）

1. **宽度占位 sizer**：字段内加零高度、不可见、`aria-hidden` 的占位元素，逐项承载
   「标签 + 各选项文案」（块级 `width: max-content`，纵向堆叠 → 父级 max-content 取**最大值**
   而非求和）。字段固有宽度因此恒为 `max(标签, 最宽选项)`：
   - 标签恒容得下 → 不再折行压值；
   - 切换选中项**宽度不再跳变**（此前随选中值收缩）；
   - 选项值不再被省略号截断（自动宽度容器）。
2. **label 单行化**：`white-space: nowrap` + `text-overflow: ellipsis` + `max-width: calc(100% - 16px)`
   ——字段被容器压得极窄时按 M3「标签裁切」语义省略号截断，不再换行压值。
3. **MdTextField 同款**：此前无 sizer、无 nowrap，是同族缺陷未闭环，一并补齐。

## 修法（调用点层）

固定宽度字段的宽度改按**静置态标签（body-large 16px）** 重新定宽（此前按浮动态 12px 或拍脑袋值）：

| 调用点 | 原宽 | 新宽 | 依据 |
|---|---|---|---|
| `ReleaseCard` `.release-min` | 140px | 205px | 静置标签「minutes (0 = disabled)」16px ≈ 172px + 内边距 32px |
| `DevtoolsCard` `.devtools-port` | 140px | 235px | 静置标签「Debug port (default 9222)」16px ≈ 201px + 32px |
| `McpServerCard` `.pattern-input` | 240px | 300px | 静置标签「Add pattern, * wildcard supported」16px ≈ 261px + 32px（该字段常态空值，标签即提示） |
| `EntryForm` `.rule-strategy` | 128px | 165px | 容得下最长选项「Base domain」 |
| `BatchPastePanel` `.choice` | 168px | 176px | 容得下最长选项「Overwrite existing」（定宽保多行对齐） |
| `SecurityCard` `.kdf-select` | 260px | 300px | 容得下最长选项「Slower, more brute-force resistant」 |
| `McpServerCard` `.mode-select` | 280px | 350px | 容得下最长选项「Token only (any client holding the token)」 |
| `BackupCard` `.profile-select` | max 280px | max 300px | 同上最长选项 |
| `ImportCard` `.format-select` | max 320px | max 360px | 容得下最长选项「TOTP Authenticator (plain/external share)」 |

## 全量排查（浏览器矩阵，真实组件 + 真实 i18n + 真实 CSS）

枚举应用内 **14 处 MdSelect + 14 处窄容器 MdTextField**，在真实 Chromium 里按各调用点的真实
容器宽度约束渲染，中英双语各量测一轮（标签行数 / 标签压值行 / 标签裁切 / 值裁切）：

- 修复前（英文态）：`entryForm.strategy` 值截断、`mcpServer.mode` 值截断、
  `releaseCard.minutes` 与 `devtoolsCard.port` **标签被裁切**；语言下拉**标签两行压值**。
- 修复后：中英双语 **28/28 全通过**（0 换行、0 重叠、0 裁切）。

## 真机实测数据

| 场景 | 指标 | 修复前 | 修复后 |
|---|---|---|---|
| 设置页语言下拉（英文选中 English） | label 行数 | **2** | 1 |
| 同上 | label 底 vs 值行顶 | **重叠 12px** | 间隔 **3.5px**（overlap −3.5px） |
| 同上 | 字段宽度 | 110px（容不下标签） | 163px（= max(标签 16px 133px, 最宽选项) + 内边距 32px） |
| 释放策略「minutes (0 = disabled)」 | 标签 | 140px 内**裁切** | 205px 完整显示 |
| devtools「Debug port (default 9222)」 | 标签 | 140px 内**裁切** | 235px 完整显示 |
| MCP「Add pattern, * wildcard supported」 | 标签 | 240px 内**裁切** | 300px 完整显示 |
| 切语言（zh→en）后设置页 | 6 字段 × 3 项几何不变量 | — | 全 ✅ |

## 结论：D8 ✅

| # | 场景 | 结果 | 证据/说明 |
|---|---|---|---|
| D8 | 设置页语言下拉英文态标签不换行、不压值行 | ✅ | 真机 `labelLines=1`、`overlap=−3.5px`、字段 163px |
| D8 | 切换语言（zh→en）全链路复测 | ✅ | e2e 脚本点选 English → 复测 6 字段全 ✅（截图 `settings-english.png`） |
| D8 | codes/import/sync/security/settings 五路由全字段几何巡检 | ✅ | `scripts/ui-layout-e2e.mjs` 汇总 **FAIL=0**（import 页需先选文件才出字段 → SKIP） |
| D8 | 释放/devtools/MCP 三处固定宽字段标签完整性 | ✅ | 真机「标签未被裁切」全 PASS（宽度按静置态标签重定） |
| D8 | 中英双语全量字段矩阵 | ✅ | 浏览器矩阵 28 用例 × 2 语言 = 0 换行 / 0 重叠 / 0 裁切 |

## 环境坑与已知限制

- **截图伪影**：mcp-bridge 的 `webview-screenshot` 对部分合成层（如 MdSegmentedButton 的分段项）
  拍成灰色块，但 `webview-execute-js` 量到的 computed style 正常（背景 `#dce2f9`、文字深色）——
  是截图通道的渲染限制，非产品缺陷。
- **导入页无字段**：导入页需先选文件才渲染格式/方案下拉，e2e 中记 SKIP（非缺陷）。
- **真机 e2e 前置**：debug 构建（mcp-bridge 仅 debug 装配）+ 同起 vite dev server +
  杀掉已装 release 版（否则单实例让位，dev 实例直接退出）+ 不锁屏（LogonUI 下 WebView2 挂起）。
- **值被省略号裁切**记 WARN 不判负：固定宽度容器里的取舍，完整文案在展开菜单可见。

## 复跑

```bash
cd F:/browser/totp
node scripts/ui-layout-e2e.mjs            # 汇总 FAIL=0 即通过；截图落 .temp/e2e/ui-layout/
```

脚本自检 driver-session（未连上则拉起），逐路由巡检 + 设置页语言切换复测，
退出码沿用 `scripts/mcp-e2e.mjs` 约定（`process.exitCode = fail ? 1 : 0`）。
