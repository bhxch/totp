# 全量依赖升级（前端 + Rust）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 pnpm workspace（4 前端包）与 Rust crate（tauri 桌面端）的全部直接依赖升至最新稳定版，修复适配点，保持全部测试/构建/覆盖率 gate 通过。

**Architecture:** 按风险分层串行推进：Rust 兼容批 → tauri 2.12 三件套联动（windows 0.62 + webview2-com 0.39 必须同批）→ Rust 跨版本适配 → 前端 semver 批 → vite 8+vitest 5 合批（vitest 5 要求 vite>=6.4 且 vitest 2 不兼容 vite 8，无法拆分）→ TS 6 + vue-tsc 3 → vue-router 5 → wxt 0.21 → 图标/主题数据重生成 → 全量验证与 gate 校准。同仓库任务全部串行执行（前例：同仓库修复子代理并行会互相踩工作区）。

**Tech Stack:** pnpm 10 workspace / Node 24（本机 24.16.0，CI node-version 22 浮动最新）/ Vite 8（Rolldown）/ Vitest 5 / TypeScript 6 / Vue 3.5 / WXT 0.21 / Tauri 2.12 / windows 0.62。

**Spec:** 会话内依赖评估报告（用户 2026-10-09 提供的调查）+ 三份子代理 breaking-changes 情报（2026-10-09 实查）。对原评估报告的两处修正，以情报为准：
1. **TypeScript 目标为 6.0.3，不是 7.0.2**。官方博客明确 TS 7.0 不提供程序化 API，Vue/Volar（vue-tsc）生态只能用 TS 6.0；TS 7 待 7.1 API 落地后再评估（列入决策清单）。
2. **rustls 0.23.37 → 0.23.45 是安全修复**（RUSTSEC-2026-0285 / GHSA-2mjx-qc3c-rqvc，TLS 1.3 握手跨加密层级边界），优先级提升。

## Global Constraints

- Rust MSRV：本机 rustc 1.98.1、CI dtolnay stable（2026-09-22 pin）均满足全部目标 crate MSRV（getrandom 0.4 需 1.85）。
- windows crate 锁定 `^0.62`（解析 0.62.2），**不要碰 0.100.0**（官方预告的下一代全家桶统一版，MSRV 1.95 + Rust 2024）。
- tauri 3.0.0-alpha、@tauri-apps/* 3.0.0-alpha（npm next）、@material 等一切 prerelease 不在范围。
- @vitest/coverage-v8 与 vitest 必须严格同版本（5.0.3 peer 精确锁定）。
- tauri JS 插件包与 Rust 插件 crate 成对同版本号升级（tauri-plugins-workspace 同步发版）。
- 不升级 @types/node 跨 22 线（CI 与 build.yml 用 node 22；24/26 线列入决策清单）。
- 所有 commit 遵循 Angular 规范，原子化，逐任务提交。
- 临时产物放 `.temp/`（已 gitignore）。
- material-color-utilities 0.4.0 的 ESM barrel 缺 .js 扩展缺陷（上游 issue #195 open）只影响纯 Node 直跑（generate.mjs）；vitest 内经 vite 解析不受影响。

---

### Task 1: Rust 兼容批（rustls 安全修复 + tokio/zeroize/rmcp）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.lock`（仅 lock 层，Cargo.toml 不动——这些依赖在 toml 中均为宽松版本号）

**Interfaces:**
- Consumes: 无
- Produces: Cargo.lock 中 rustls 0.23.45、tokio 1.53.2、zeroize 1.9.1、rmcp 3.5.1；后续任务在此 lock 基线上继续

- [ ] **Step 1: 逐包定向 update（避免全量 update 带入 webview2-com 双套并存）**

```bash
cd apps/desktop/src-tauri
cargo update -p rustls -p tokio -p zeroize -p rmcp
```

Expected: lock 中 rustls 0.23.37→0.23.45、tokio 1.53.1→1.53.2、zeroize 1.9.0→1.9.1、rmcp 3.4.0→3.5.1；`git diff Cargo.lock | grep -E "^\+version" | sort | uniq` 核对无意外连带升级（webview2-com 仍在 0.38.2、windows 仍在 0.61.3）。

- [ ] **Step 2: 验证编译与测试**

```bash
cd apps/desktop/src-tauri
cargo clippy -- -D warnings 2>&1 | tail -5
cargo test 2>&1 | tail -15
```

Expected: clippy 零警告；cargo test 全绿（rmcp 3.5.1 行为变化点：HTTP Origin 校验强化——若 mcp_server 测试挂 Origin 相关断言，按 3.5.1 语义修测试或补充 Origin 头，属预期适配）。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.lock
git commit -m "chore(deps): rust 兼容批升级 rustls 0.23.45/tokio 1.53.2/zeroize 1.9.1/rmcp 3.5.1

rustls 0.23.45 修复 RUSTSEC-2026-0285（TLS1.3 握手跨加密层级边界）；
其余为 semver 内补丁步进，逐包定向 update 避免全量连带。"
```

### Task 2: tauri 2.12 三件套联动（tauri+五插件+webview2-com 0.39+windows 0.62）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml:83-111`（webview2-com "0.38"→"0.39"、windows "0.61"→"0.62"，并重写 83-92 行注释）
- Modify: `apps/desktop/src-tauri/Cargo.lock`
- Verify: `apps/desktop/src-tauri/src/lib.rs:573-598`（try_suspend_window，预期零代码改动）

**Interfaces:**
- Consumes: Task 1 的 lock 基线
- Produces: tauri 2.12.2 + tauri-build 2.7.1 + 五插件（clipboard 2.4.1/dialog 2.8.1/fs 2.6.0/global-shortcut 2.4.0/single-instance 2.5.2）+ webview2-com 0.39.1 + windows 0.62.2 同源（windows-core 统一 0.62.x）

- [ ] **Step 1: 改 Cargo.toml 显式声明段**

`webview2-com = "0.38"` → `webview2-com = "0.39"`；`windows = { version = "0.61", features = [...] }` → `"0.62"`。重写 Cargo.toml:83-92 注释为：释放策略暂停档依赖 TrySuspend；webview2-com 0.39.1 内部 windows-core 0.62 与显式 windows 0.62 同源，Interface::cast 跨 crate 可用；tauri 2.12 传递依赖已要求 webview2-com ^0.39 + windows ^0.62，原"保持 0.61"决策基于 tauri 2.11 依赖树，随 2.12 联动推翻（0.62 元数据刷新仅 WinRT 侧，Win32 签名无变化）。

- [ ] **Step 2: 逐包定向 update**

```bash
cd apps/desktop/src-tauri
cargo update -p tauri -p tauri-build \
  -p tauri-plugin-clipboard-manager -p tauri-plugin-dialog \
  -p tauri-plugin-fs -p tauri-plugin-global-shortcut \
  -p tauri-plugin-single-instance \
  -p webview2-com -p windows -p windows-core
```

Expected: tauri 2.12.2、tauri-build 2.7.1、五插件至目标版本、webview2-com 0.39.1、windows 0.62.2、windows-core 统一 0.62.x（0.61.2 退出树或仅被旧传递依赖残留——用 `cargo tree -i windows-core` 确认单一版本）。

- [ ] **Step 3: 编译 + clippy + 测试**

```bash
cd apps/desktop/src-tauri
cargo clippy -- -D warnings 2>&1 | tail -5
cargo test 2>&1 | tail -15
```

Expected: windows 0.62 Win32 元数据无签名变化，预期零代码适配；若个别 API 报错按编译器提示修。`Interface::cast`（lib.rs:587）依赖 windows-core 同源，Step 2 已保证。

- [ ] **Step 4: Cargo.toml 注释核对**

确认 Cargo.toml 不再残留"保持 0.61 不升 0.62"的过时表述；`cargo tree -i webview2-com` 输出确认 0.39.1 单版本。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "chore(deps): tauri 2.12 三件套联动升级（+windows 0.62/webview2-com 0.39）

tauri 2.12 传递依赖要求 webview2-com ^0.39 + windows ^0.62，原 0.61 锁定
基于 tauri 2.11 依赖树随联动推翻；0.39.1 基于 windows-core 0.62 恢复
Interface::cast 跨 crate 同源假设，TrySuspend 链路编译期+真机双重验证。"
```

### Task 3: Rust 跨版本适配（getrandom 0.4/base64 0.23/sha2 0.11/keyring 4）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml:29,61,116,121-124`
- Modify: `apps/desktop/src-tauri/src/elevation_service.rs:562-570,618-625`（sha2 io::Write 移除适配）
- Modify: `apps/desktop/src-tauri/src/platform_security.rs:333-339`（keyring Error match 核对）
- Modify: `apps/desktop/src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: Task 2 的 lock 基线
- Produces: getrandom 0.4.3 / base64 0.23.1 / sha2 0.11.0 / keyring 4.2.0；sha256_file_hex 输出契约不变（TOCTOU 双读哈希 hex 一致）

- [ ] **Step 1: 改 Cargo.toml 四处版本号**

- `getrandom = "0.3"` → `"0.4"`（代码已用 `getrandom::fill`，0.4 同名零适配；dialog_grants.rs:47-51、mcp_server.rs:195-199）
- `base64 = "0.22"` → `"0.23"`（Engine API 不变；全仓 decode 错误均为 map_err/ok_or 形态，无 InvalidLastSymbol 穷举匹配；注意 0.23 默认 feature 含 simd-unsafe，保持默认即可）
- `sha2 = "0.10"` → `"0.11"`
- macos 段 `keyring = "3"` → `"4"`；linux 段 `keyring = { version = "3", features = ["sync-secret-service"] }` → `keyring = "4"`（**v4 无此 feature，v1 模式自动选平台默认 store，Linux 即 Secret Service**；Entry::new/set_password/get_password/delete_credential 与 Error::NoEntry 均保留）

- [ ] **Step 2: sha2 0.11 适配——digest 0.11 移除 io::Read/Write 支持**

`elevation_service.rs` 两处 `sha256_file_hex`（:562-570、:618-625）现形态为 `Sha256::new()` + `std::io::copy(&mut reader, &mut hasher)`（依赖 digest 0.10 的 io::Write impl）。改为显式读循环（零新依赖，同时去掉 `use sha2::Digest;` 中不再需要的 io 路径假设）：

```rust
let mut hasher = sha2::Sha256::new();
let mut buf = [0u8; 65536];
loop {
    let n = reader.read(&mut buf)?;
    if n == 0 {
        break;
    }
    hasher.update(&buf[..n]);
}
let digest = hasher.finalize();
```

两处（`sha256_file_hex` 与 `sha256_file_hex_shared`）同改；`use sha2::Digest;`（:14）保留（new/update/finalize 来自 Digest trait）。确认函数内 reader 变量类型具备 `std::io::Read`（原为 BufReader/File）。

- [ ] **Step 3: keyring 错误 match 核对**

`platform_security.rs:333-339` `os_auto_forget` 的 `match ... keyring::Error::NoEntry`：确认 match 是否已含 `_ =>` 通配臂。v4 Error 枚举新增变体且 `#[non_exhaustive]`——若无通配臂则补 `other => Err(other.to_string())` 形态的兜底臂（保持既有错误信息语义）。

- [ ] **Step 4: 更新 + 编译 + 测试**

```bash
cd apps/desktop/src-tauri
cargo update -p getrandom -p base64 -p sha2 -p digest
cargo clippy -- -D warnings 2>&1 | tail -5
cargo test 2>&1 | tail -15
```

Expected: getrandom 解析 0.4.3、base64 0.23.1、sha2 0.11.0（digest 0.11.2+，0.11.0/0.11.1 已 yanked 不受影响）；elevation_service 哈希测试组（TOCTOU 双读 hex 断言）全绿证明输出契约不变。keyring 仅 mac/linux 编译：本机 Windows 不编译该分支，由 Task 10 的 Linux CI（ubuntu cargo test 编译 linux 分支）覆盖。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/elevation_service.rs apps/desktop/src-tauri/src/platform_security.rs
git commit -m "chore(deps): rust 跨版本适配 getrandom 0.4/base64 0.23/sha2 0.11/keyring 4

sha2 0.11（digest 0.11 移除 io::Write）改显式读循环，hex 输出契约由
TOCTOU 双读哈希测试守护；keyring 4 删除已不存在的 sync-secret-service
feature（v1 模式自动选平台默认 store）；getrandom 代码已用 fill 零适配。"
```

### Task 4: 前端 semver 兼容批（vue patch 线 + @types/node + tauri JS 五包）

**Files:**
- Modify: `apps/desktop/package.json`、`apps/extension/package.json`、`packages/ui/package.json`、根 `package.json`（由 pnpm update 落盘）
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: 无（独立于 Rust 线）
- Produces: vue 3.5.43、vue-i18n 11.4.13、@vue/test-utils 2.5.1、@types/node 22.20.5、@tauri-apps/api 2.12.2、plugin-clipboard-manager 2.4.1、plugin-dialog 2.8.1、plugin-fs 2.6.0、@tauri-apps/cli 2.12.1（前端调用面零变化）

- [ ] **Step 1: 定向 update（分两档，不波及其他）**

```bash
cd E:\repos\0000\browser\totp
# semver 内即达最新：vue 3.5.43 / vue-i18n 11.4.13 / @vue/test-utils 2.5.1 / @types/node 22.20.5
pnpm update -r vue vue-i18n @vue/test-utils @types/node
# 宽范围 ^2.0.0 需 --latest 落到最新 2.x（--latest 只作用于列出的包名）
pnpm update -r --latest @tauri-apps/api @tauri-apps/plugin-clipboard-manager \
  @tauri-apps/plugin-dialog @tauri-apps/plugin-fs @tauri-apps/cli
```

注：@types/node 绝不带 --latest（latest tag 是 26.6.4，会跨线；CI 用 node 22，锁 22 线）。tauri CLI latest 为 2.12.1。

- [ ] **Step 2: 验证**

```bash
pnpm --filter @totp/extension exec wxt prepare
pnpm typecheck 2>&1 | tail -5
pnpm test 2>&1 | tail -10
```

Expected: typecheck 零错误、测试全绿。

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml apps/desktop/package.json apps/extension/package.json packages/ui/package.json
git commit -m "chore(deps): 前端 semver 兼容批（vue patch 线/@types/node 22/tauri JS 五包 2.x 最新）"
```

### Task 5: vite 8 + vitest 5 合批迁移（+plugin-vue 6/jsdom 30/coverage-v8）

**Files:**
- Modify: `package.json`（根 vitest）、`apps/desktop/package.json`、`apps/extension/package.json`、`packages/core/package.json`、`packages/ui/package.json`
- Modify: `apps/desktop/vite.config.ts`（如 Rolldown 选项警告需调整）、各 `vitest.config.ts`（如 coverage 选项废弃报警需调整）、`packages/ui/src/theme/generate.mjs` 头注释（mcu 版本表述——若 Task 9 未先做则本次顺带改）
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 4 的前端基线
- Produces: vite 8.3.4 + @vitejs/plugin-vue 6.0.9 + vitest 5.0.3 + @vitest/coverage-v8 5.0.3 + jsdom 30.1.2 全 workspace 统一

- [ ] **Step 1: 一次性安装目标版本**

```bash
cd E:\repos\0000\browser\totp
pnpm add -r -D vite@^8.3.4 @vitejs/plugin-vue@^6.0.9 vitest@^5.0.3 @vitest/coverage-v8@5.0.3 jsdom@^30.1.2
```

注：`-r` 递归各包按既有 devDependencies 落位；@vitest/coverage-v8 必须精确 5.0.3（peer 锁定）。根 package.json 的 vitest devDep 同步升级（根 vitest.config.ts 跑 scripts 测试）。wxt 0.19 的 vite peer（^5）与 vite 8 冲突——若 pnpm 因 extension 的 wxt 报 peer 冲突，则本步先跳过 extension 的 vite 落位，把 extension 的完整链迁移并入 Task 8（wxt 0.21 显式声明 vite peer），本任务只升 desktop/ui/core 三包 + 根；Task 8 完成后回归验证四包。

- [ ] **Step 2: desktop 构建验证（vite 8 Rolldown 链路）**

```bash
pnpm --filter @totp/desktop build 2>&1 | tail -20
```

Expected: 构建成功。注意项：vite 8 `build.rollupOptions` 废弃自动转 `rolldownOptions`（有警告则改配置字段名）；CJS interop 统一与 `?url` 导入（fullIcons.ts/sqliteLoader.ts）在 Rolldown 下正常产出。

- [ ] **Step 3: 全部测试（vitest 5 链路）**

```bash
pnpm test 2>&1 | tail -20
```

Expected: 全绿。已知行为变化排查点：① clearMocks 默认 true（依赖 mock 调用累积的断言会变）；② vi.mock/vi.hoisted 非顶层作用域 throw（现有 26 处 vi.hoisted 均在顶层，预期无恙）；③ fake timers mock Temporal；④ `toThrow("")` 语义变化。失败用例逐个按新语义修测试（不是回退 vitest）。

- [ ] **Step 4: 覆盖率与 gate 校准**

```bash
pnpm run test:coverage 2>&1 | tail -30
```

对比各包 thresholds（desktop 98/94、core 99.4/98.1、ui 95.6/89.5、extension 96.5/91.9）：coverage-v8 5 的统计口径变化（include/exclude 按项目根精确匹配、glob 阈值不继承 perFile）可能造成百分比位移。若跌破且定性为口径差异（排除文件未被正确匹配所致），修各包 vitest.config.ts 的 exclude/include 匹配写法；若为真实口径整体位移，按先例减 0.5pp 边际重校准 thresholds 并在 commit message 记录新旧实测值。

- [ ] **Step 5: Commit**

```bash
git add -A package.json pnpm-lock.yaml apps/*/package.json packages/*/package.json apps/desktop/vite.config.ts apps/desktop/vitest.config.ts packages/core/vitest.config.ts packages/ui/vitest.config.ts apps/extension/vitest.config.ts
git commit -m "chore(deps): vite 8+vitest 5 合批迁移（Rolldown 默认/clearMocks 默认开/coverage 口径重校准）

vitest 5 要求 vite>=6.4 且 vitest 2 不兼容 vite 8，二者不可拆批；
 Rolldown 下 rollupOptions 自动转换，?url 导入产出核对无误。"
```

### Task 6: TypeScript 6.0.3 + vue-tsc 3.3.12

**Files:**
- Modify: 根 `package.json` + 各包 `package.json`（typescript、vue-tsc）
- Modify: `tsconfig.base.json` 及各包 tsconfig（仅当 TS6 新默认值要求时）

**Interfaces:**
- Consumes: Task 5 基线
- Produces: typescript 6.0.3、vue-tsc 3.3.12 全 workspace 统一；typecheck 链全绿

- [ ] **Step 1: 安装**

```bash
cd E:\repos\0000\browser\totp
pnpm add -r -D typescript@~6.0.3 vue-tsc@^3.3.12
```

注：TS 用 `~6.0.3` 锁 6.0 线（6.x 内 minor 可能破坏，官方 @typescript/typescript6 兼容包佐证 6.0 是独立维护线）；**不升 7.0.2**（官方明确 Volar/vue-tsc 只支持 TS 6.0，TS 7 无程序化 API）。

- [ ] **Step 2: typecheck 验证**

```bash
pnpm typecheck 2>&1 | tail -15
```

Expected: 四包全绿。排查点：TS6/TS7 家族默认值变化（strict 默认开、module 默认 esnext、types 默认 []——本项目 tsconfig.base.json 已显式声明这些，预期无影响）；vue-tsc 3 强制 Hybrid Mode、新增严格选项（strictSlotChildren 等）默认不开启。

- [ ] **Step 3: 测试回归**

```bash
pnpm test 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.base.json apps/*/package.json packages/*/package.json apps/*/tsconfig.json packages/*/tsconfig.json
git commit -m "chore(deps): typescript 6.0.3+vue-tsc 3.3.12（TS 7 无程序化 API 不兼容 Volar 生态）"
```

### Task 7: vue-router 5.4.0

**Files:**
- Modify: `apps/desktop/package.json`、`apps/extension/package.json`、`packages/ui/package.json`、`pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 6 基线
- Produces: vue-router 5.4.0；hash 路由/catch-all redirect/懒加载行为不变

- [ ] **Step 1: 安装**

```bash
cd E:\repos\0000\browser\totp
pnpm update -r --latest vue-router
```

Expected: 5.4.0。官方定位 "boring release" 无 breaking（唯一例外 IIFE 构建内联 devtools-api，本项目不用）。

- [ ] **Step 2: 验证**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm test 2>&1 | tail -5
```

重点：ui 包 NavigationShell 两个路由测试（createMemoryHistory + catch-all redirect）与 desktop/extension 的 createWebHashHistory 装配。verbatimModuleSyntax 下 RouteRecordRaw 类型导入形态不变。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json apps/extension/package.json packages/ui/package.json pnpm-lock.yaml
git commit -m "chore(deps): vue-router 5.4.0（官方无 breaking 的 boring release）"
```

### Task 8: wxt 0.21.4 + @types/chrome 0.3.4（extension 构建链迁移）

**Files:**
- Modify: `apps/extension/package.json`（wxt 0.21.4、@types/chrome 0.3.4、**新增显式 vite devDep**、@wxt-dev/module-vue 最新 1.x）
- Modify: `apps/extension/wxt.config.ts`（如顶层 manifestVersion 语义变化则适配）
- Modify: `apps/extension/tsconfig.json`（.wxt 生成物路径/类型引用变化）
- Modify: `apps/extension/test/helpers/defineBackground.ts`（若 defineBackground 消解语义变化）

**Interfaces:**
- Consumes: Task 5 的 vite 8（wxt 0.21 peer ^6.3.4||^7||^8 满足）
- Produces: wxt 0.21.4 构建链；MV3 双浏览器产物契约不变（.output/chrome-mv3、.output/firefox-mv3、background firefox=scripts event page、gecko id/strict_min_version 140）

- [ ] **Step 1: 安装**

```bash
cd E:\repos\0000\browser\totp\apps\extension
pnpm add -D wxt@^0.21.4 @types/chrome@^0.3.4 vite@^8.3.4
pnpm update @wxt-dev/module-vue
pnpm install
```

注：wxt 0.21 将 vite/web-ext/typescript 转 peer，vite 必须显式声明（Task 5 时 extension 未落 vite 的补救点）；web-ext 不装（本仓无 dev 自动开浏览器需求）。

- [ ] **Step 2: prepare + 双浏览器构建**

```bash
cd E:\repos\0000\browser\totp\apps\extension
pnpm exec wxt prepare
pnpm exec wxt build -b chrome 2>&1 | tail -10
pnpm exec wxt build -b firefox 2>&1 | tail -10
```

Expected: 产物目录仍为 .output/chrome-mv3 与 .output/firefox-mv3（生产构建无 -dev 后缀）。核对 manifest.json：chrome 含 offscreen 权限、firefox 无 offscreen + gecko id + strict_min_version 140.0 + MV3 background scripts 形态（对照 build.yml Assert MV3 artifacts 脚本的断言项）。若 dev 构建目录模板变化（0.20 起 dev 加 -dev 后缀）不影响本仓（本仓只用生产 build）。

- [ ] **Step 3: 类型与测试**

```bash
cd E:\repos\0000\browser\totp\apps\extension
pnpm typecheck 2>&1 | tail -10
pnpm test 2>&1 | tail -10
```

排查点：tsconfig `types: ["wxt/browser", "chrome"]` 与 `.wxt/wxt.d.ts` 引用在 0.21 下是否仍有效（0.20 类型重组为 @wxt-dev/browser 提供——prepare 生成物结构变化则按实际调整 include/types）；defineBackground 全局消解语义与 test/helpers/defineBackground.ts stub 兼容性；background.ts 的 16 个相关测试。

- [ ] **Step 4: CI 断言脚本本地预演**

```bash
cd E:\repos\0000\browser\totp\apps\extension
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('.output/firefox-mv3/manifest.json','utf8'));console.log(JSON.stringify({mv:m.manifest_version,bg:m.background,g:m.browser_specific_settings&&m.browser_specific_settings.gecko},null,1))"
```

Expected: manifest_version 3、background.scripts 数组非空（firefox event page）、gecko id totp@bhxch.github.io、strict_min_version 140.0。

- [ ] **Step 5: Commit**

```bash
git add apps/extension
git commit -m "chore(deps): wxt 0.21.4+@types/chrome 0.3.4（vite 转 peer 显式声明，MV3 产物契约回归验证）"
```

### Task 9: simple-icons 16.34.0 + material-color-utilities 0.4.0 重生成

**Files:**
- Modify: `packages/core/package.json`（simple-icons 16.34.0）、`packages/ui/package.json`（mcu 0.4.0 或维持 0.2.7，见 Step 3 分支）
- Modify: `scripts/gen-builtin-icons.mjs`（如 CJS 入口变化）
- Modify: `packages/core/src/icons/builtin.json`、`packages/ui/src/assets/icons-full.json`（重生成产物）
- Modify: `packages/ui/src/theme/generate.mjs` + `packages/ui/src/theme/tokens.css` + `tokens-palettes.css`（mcu 升级时）+ `packages/ui/test/themeTokens.test.ts`（如 API 变化）
- Create（分支 B）: `packages/ui/src/theme/mcu-esm-loader.mjs`（Node register hook 补 .js 扩展名）

**Interfaces:**
- Consumes: Task 6 的 TS 基线（themeTokens.test.ts 在 vitest 5 下跑）
- Produces: 图标数据 16.34.0（新增 alphaXiv/Godox/Hypit/SumUp 四图标，无移除更名）；tokens.css 数值与 0.2.7 产物逐值一致

- [ ] **Step 1: simple-icons 升级 + 重生成**

```bash
cd E:\repos\0000\browser\totp
pnpm --filter @totp/core add -D simple-icons@16.34.0
node scripts/gen-builtin-icons.mjs
git diff --stat packages/core/src/icons/builtin.json packages/ui/src/assets/icons-full.json
pnpm test 2>&1 | tail -5
```

Expected: 16.31→16.34 仅四图标新增、无移除（情报核实）；builtin.json 精选 218 项 slug 无变化、icons-full.json 条目 +4；icons-full.json <5MB 断言通过；core/ui 测试全绿（图标注册表按 slug 索引，slug 未变则零影响）。gen 脚本 CJS require 入口若报错，查 16.34 的 exports.require 是否保留并适配。

- [ ] **Step 2: mcu 0.4.0 尝试升级（分支 A：loader 方案）**

```bash
cd E:\repos\0000\browser\totp\packages\ui
pnpm add -D @material/material-color-utilities@0.4.0
node src/theme/generate.mjs
```

预期失败：barrel 内部 import 缺 .js 扩展（上游 issue #195 open）。写 `mcu-esm-loader.mjs` Node module.register resolve hook：对 resolve 失败的 file:// URL（node_modules 内 @material/material-color-utilities 包内部相对导入）尝试追加 `.js`/`/index.js` 再试。generate.mjs 顶部 `register('./mcu-esm-loader.mjs', import.meta.url)` 后直跑。API 面：`argbFromHex/hexFromArgb/themeFromSourceColor` 签名 0.2.7↔0.4.0 完全一致；`scheme.props[p]`（Scheme 实例经典角色 props）0.4.0 标 DEPRECATED 但仍可用——先零改动跑通，再视警告决定是否换 `scheme[p]` getter 写法（DynamicScheme 角色 getter 0.4.0 直接暴露）。

- [ ] **Step 3: 产物一致性断言**

```bash
cd E:\repos\0000\browser\totp
git diff --stat packages/ui/src/theme/tokens.css packages/ui/src/theme/tokens-palettes.css
pnpm --filter @totp/ui test 2>&1 | tail -5
```

Expected: `git diff` 零变化或仅注释行差异（themeFromSourceColor 同种子同 tone 表输出必须逐值一致，themeTokens.test.ts 会重算断言）。若数值漂移——0.4.0 色板算法变化——则停下：输出 diff 全量给评审，不得静默接受颜色变化（MD3 tokens 是全 UI 视觉基线）。分支 A 两轮尝试（loader 调试上限 30 分钟）失败则回退分支 B：`pnpm --filter @totp/ui add -D @material/material-color-utilities@0.2.7` 维持现状，把"mcu 0.4.0 因上游 ESM 缺陷 + 产物漂移风险暂缓"写入决策清单，并仍更新 generate.mjs:7-9 注释为经查证的现状描述。

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json packages/ui/package.json scripts/gen-builtin-icons.mjs packages/core/src/icons/builtin.json packages/ui/src/assets/icons-full.json packages/ui/src/theme packages/ui/test/themeTokens.test.ts pnpm-lock.yaml
git commit -m "chore(deps): simple-icons 16.34.0 图标数据重生成（+mcu 0.4.0 ESM loader 直跑方案）

16.31→16.34 仅新增 alphaXiv/Godox/Hypit/SumUp 四图标无移除更名；
tokens.css 产物经 themeTokens 测试逐值断言与 0.2.7 一致。"
```

（若走分支 B：commit message 改为"simple-icons 16.34.0 图标数据重生成（mcu 0.4.0 因上游 ESM 缺陷暂缓，见决策清单）"，不加 loader 文件。）

### Task 10: 全量验证 + coverage gate 校准 + 真机构建

**Files:**
- Modify: `.github/workflows/ci.yml:101`（coverage-rust gate 数值，仅当实测偏移）
- Modify: 各包 `vitest.config.ts` thresholds（仅当实测偏移）

**Interfaces:**
- Consumes: Task 1-9 全部完成态
- Produces: 全绿验证记录（写入 e2e 文档）；最终 gate 数值

- [ ] **Step 1: 前端全量**

```bash
cd E:\repos\0000\browser\totp
pnpm --filter @totp/extension exec wxt prepare
pnpm typecheck 2>&1 | tail -5
pnpm check:i18n
node scripts/bump.mjs --check
pnpm test 2>&1 | tail -10
pnpm run test:coverage 2>&1 | tail -30
```

- [ ] **Step 2: Rust 全量**

```bash
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy -- -D warnings 2>&1 | tail -5
cargo test 2>&1 | tail -15
```

- [ ] **Step 3: Rust 覆盖率 gate（本地 Windows 口径）**

```bash
cd E:\repos\0000\browser\totp
node scripts/rust-coverage.mjs 2>&1 | tail -10
```

对比 CI gate（lines 67.65 / branches 46.27）：windows 0.62/sha2 读循环等代码变化可能位移实测值。跌破则按先例减 0.5pp 边际重校准 ci.yml:101 数值并记录；上升则保持不动（gate 只防回退不追高）。

- [ ] **Step 4: 真机构建**

```bash
cd E:\repos\0000\browser\totp\apps\desktop
pnpm tauri build 2>&1 | tail -15
```

Expected: NSIS 安装包产出（tauri 2.12 + windows 0.62 的完整 release 链）。产物替换 E:\app\totp-desktop.exe 供 e2e（旧件备份 E:\tmp\cc\dep-upgrade-20261009\）。

- [ ] **Step 5: Commit（如有 gate 校准）**

```bash
git add .github/workflows/ci.yml packages/*/vitest.config.ts apps/*/vitest.config.ts
git commit -m "chore(ci): 依赖升级后覆盖率 gate 重校准（记录新旧实测口径）"
```

---

## 执行后置阶段（非本计划任务，主会话执行）

1. **Code review**：superpowers:requesting-code-review，覆盖全部 diff（9 个 commit）。修复所有发现后重验。
2. **e2e 真机走查**：tauri-mcp-cli 驱动，重点面——TrySuspend 释放策略暂停档（windows 0.62 迁移行为面）、全局快捷键 ALT+SHIFT+T（global-shortcut 2.4）、托盘 i18n、mini 窗口尺寸持久化、MCP 服务器启停（rmcp 3.5.1）、设置页/加密强度/授权档位回归。记录文档 docs/e2e/2026-10-09-dependency-upgrade.md。
3. **推送 + CI**：push origin main，等 ci 4 job 全绿（web/rust/coverage-web/coverage-rust）。
4. **触发 nightly**：workflow_dispatch force（确保无变更检查不跳过），确认三平台 + 双扩展构建发布成功。
5. **handoff 文档**：handoff 技能压缩本会话，含需用户决策事项。
