# 设计：GitHub CI 与发布流水线（验收条目 6）

## 背景与目标

建立 CI：PR 门禁 + daily build（滚动 nightly）+ release build（版本 tag 触发），
产物覆盖桌面端三平台与两个浏览器扩展（chromium/firefox）。

## 现状

- **零 CI 基建**（无 .github/），根 scripts 仅 test/typecheck 聚合。
- 版本号 `0.1.0` 散在 4 处手动同步：`apps/desktop/package.json`、
  `apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml`、
  `apps/extension/package.json`。
- 桌面端 bundle 仅 `["nsis"]`（tauri.conf.json）；无签名、无 updater。
- 扩展：WXT，默认 chrome 产物，firefox 分支已注入占位 gecko id
  `totp-tools@example.local`（**发布前需定稿**）；无 zip/打包脚本。
- 工具链：pnpm v9（lockfile 9.0）、无 node/rust 版本锁定文件。

## 设计

### §1 版本单一来源

- 根 `package.json` `version` 为唯一真源。
- 新增 `scripts/bump.mjs`：`pnpm bump <version>` 同步写 4 处
  （含 Cargo.toml 的 `^version` 行），幂等，diff 可 review。
- release tag `vX.Y.Z` 必须等于根版本——CI 校验 job，不匹配直接 fail。

### §2 工作流结构（.github/workflows/）

**ci.yml**（PR + 主支 push）：

- pnpm install → `pnpm typecheck` → `pnpm test`（全 workspace）。
- Rust 侧：`cargo fmt --check` + `cargo clippy` + `cargo test`（src-tauri）。
- 缓存：pnpm store、Swatinem/rust-cache。

**release.yml**（push tag `v*`）：

1. `gate` job：tag 与根版本一致性校验。
2. `desktop` 矩阵（三平台各自原生构建）：
   - windows-latest → `tauri build`（NSIS `.exe` setup）
   - macos-latest → `--target universal-apple-darwin`（`.dmg`，aarch64+x86_64）
   - ubuntu-latest → `tauri build`（`.deb` + `.appimage`；apt 装 webkit2gtk-4.1 等 Tauri v2 依赖）
3. `extension` job（ubuntu）：`wxt build -b chrome` 与 `-b firefox`，
   `.output/*-mv3` 分别 zip → `totp-extension-chromium-<ver>.zip` / `totp-extension-firefox-<ver>.zip`。
4. `publish` job：download 全部 artifact → 生成 `sha256sums.txt` →
   GitHub Release（tag 对应，正式版全量产物）。

**nightly.yml**（每日 cron 一次 + workflow_dispatch 手动）：

- 与 release 同构建矩阵（复用可复用 workflow 或 composite action，避免两份维护）。
- `publish`：删除旧 `nightly` prerelease → 新建固定 `nightly` release
  （滚动覆盖，单份）；产物文件名附加 `<date>.<shortsha>`（如
  `totp-desktop_0.1.0-20260921.abc1234-x64-setup.exe`）便于区分。
- `concurrency: { group: nightly, cancel-in-progress: true }`（旧构建被新一日取代）。

### §3 明示不做（已知限制）

- **无代码签名**：Windows 无 Authenticode（SmartScreen 告警）、macOS 无 Developer ID
  （Gatekeeper 需右键打开或 `xattr -c`）。证书到位后在 release.yml 补 signing steps。
- **无自动 updater**（tauri updater 需签名密钥与清单托管，后续独立需求）。
- **不直发浏览器商店**：zip 人工上传 Chrome Web Store / AMO（直发需商店 API secrets）。
- firefox gecko id 占位符需在首次发布前定稿为真实扩展 ID。

### §4 验收策略

workflow 无法本地全验，按序推进：ci.yml 先行（验证 runner 上 pnpm/rust 可用）→
release.yml 用空 tag 在测试仓库阶段手动 dispatch 验收 → nightly cron 观察一轮。

## 非目标

- 代码签名、updater、商店自动发布。
- 性能/体积回归 CI（后续可加 bundle size 门禁）。
- mac/linux 本地开发体验保障（CI 先跑通，本地构建脚本不在本期）。
