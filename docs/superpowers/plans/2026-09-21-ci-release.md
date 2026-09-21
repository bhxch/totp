# CI 与发布流水线 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三条 GitHub Actions 流水线——PR 门禁（ci）、tag 触发正式发布（release，desktop 三平台 + 扩展双产物）、每日滚动 nightly——外加版本单一来源 bump 脚本。

**Architecture:** 可复用构建 workflow（`workflow_call`）承载三平台桌面构建与扩展打包；release/nightly 两条触发 workflow 复用它，仅发布策略不同（正式 Release vs 固定 `nightly` prerelease 滚动覆盖）。版本真源 = 根 `package.json`，`pnpm bump` 同步 4 处。

**Tech Stack:** GitHub Actions（pnpm/action-setup、actions/setup-node、dtolnay/rust-toolchain、Swatinem/rust-cache、actions/upload/download-artifact、softprops/action-gh-release）、Tauri 2 CLI、WXT CLI。

**Spec:** `docs/superpowers/specs/2026-09-21-ci-release-design.md`

## Global Constraints

- pnpm 锁文件版本 9.0 → CI 一律 `pnpm/action-setup@v4`（默认读 packageManager；需在根 package.json 补 `"packageManager": "pnpm@9.x"`，以本地 `pnpm --version` 实际值填写）+ Node 22（`actions/setup-node@v4`，`node-version: 22`）。
- 版本一致性：release tag `vX.Y.Z` 必须等于根 package.json `version`，不等则 gate fail。
- 产物文件名：正式版用原始名；nightly 一律附加 `<YYYYMMDD>.<shortsha>`。
- 无签名/updater/商店直发（spec §3 已知限制）；所有产物发布前生成 `sha256sums.txt`。
- firefox gecko id 占位 `totp-tools@example.local` 首次发布前必须定稿（Task 5 阻断项）。

---

### Task 1: 版本 bump 脚本

**Files:**
- Create: `scripts/bump.mjs`
- Modify: 根 `package.json`（scripts 加 `"bump": "node scripts/bump.mjs"`；补 `packageManager` 字段）

**Interfaces:**
- Consumes: 4 个版本落点文件
- Produces: `pnpm bump <x.y.z>`（写 4 处）、`pnpm bump --check <x.y.z>`（全部已是该版本 exit 0，否则 exit 1，供 CI gate）

- [ ] **Step 1: 写脚本**

`scripts/bump.mjs`：

```js
#!/usr/bin/env node
// 版本单一来源：根 package.json → 同步 4 处落点（验收条目6 spec §1）
// 用法: node scripts/bump.mjs <x.y.z> | --check <x.y.z>
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const check = args[0] === '--check'
const version = args[check ? 1 : 0]
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('用法: pnpm bump <x.y.z> [--check]')
  process.exit(2)
}

const jsonFiles = ['package.json', 'apps/desktop/package.json', 'apps/extension/package.json', 'apps/desktop/src-tauri/tauri.conf.json']
const cargoFile = 'apps/desktop/src-tauri/Cargo.toml'
let dirty = false

for (const rel of jsonFiles) {
  const p = resolve(root, rel)
  const json = JSON.parse(readFileSync(p, 'utf8'))
  if (json.version === version) continue
  if (check) { console.error(`${rel} 版本为 ${json.version}，期望 ${version}`); dirty = true; continue }
  json.version = version
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n')
  console.log(`${rel} → ${version}`)
}

const cargo = readFileSync(resolve(root, cargoFile), 'utf8')
const cargoRe = /^(version\s*=\s*)"[^"]*"/m
const cargoCur = cargo.match(cargoRe)?.[1]
if (cargoCur && !cargo.includes(`version = "${version}"`)) {
  if (check) { console.error(`${cargoFile} 版本非 ${version}`); dirty = true }
  else { writeFileSync(resolve(root, cargoFile), cargo.replace(cargoRe, `version = "${version}"`)); console.log(`${cargoFile} → ${version}`) }
}

process.exit(dirty ? 1 : 0)
```

（实现时核对 Cargo.toml 的 version 行位置——若非首个 `version =` 行，收紧正则到 `[package]` 段。）

- [ ] **Step 2: 冒烟验证**

Run: `pnpm bump 0.1.0 --check`
Expected: exit 0（当前全部 0.1.0）。再 `pnpm bump 0.1.1` 后 `git diff --stat` 恰 4 文件，随后 `git checkout -- .` 还原。

- [ ] **Step 3: Commit**

```bash
git add scripts/bump.mjs package.json
git commit -m "build: 版本单一来源bump脚本与packageManager声明（验收条目6）"
```

### Task 2: 可复用构建 workflow

**Files:**
- Create: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: 各包既有 `build`/`test` 脚本、`pnpm tauri build`
- Produces: artifacts：`desktop-windows-<suffix>`、`desktop-macos-<suffix>`、`desktop-linux-<suffix>`、`extension-chromium-<suffix>`、`extension-firefox-<suffix>`（suffix = `nightly` 或 `release`，由 input 决定）

- [ ] **Step 1: 写 workflow**

```yaml
name: build
on:
  workflow_call:
    inputs:
      ref:        { type: string, required: true }
      suffix:     { type: string, required: true }   # nightly | release
      nightly:    { type: boolean, required: false, default: false }

permissions:
  contents: read

env:
  DATE_TAG: ""   # nightly 文件名日期戳由各 job 内计算注入

jobs:
  desktop-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ inputs.ref }}" }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: apps/desktop/src-tauri }
      - run: pnpm install --frozen-lockfile
      - run: pnpm tauri build
        working-directory: apps/desktop
      - name: Rename with nightly tag
        if: ${{ inputs.nightly }}
        shell: pwsh
        run: |
          $tag = "$(Get-Date -Format yyyyMMdd).$($env:GITHUB_SHA.Substring(0,7))"
          Get-ChildItem apps/desktop/src-tauri/target/release/bundle/nsis/*.exe |
            Rename-Item -NewName { $_.Name -replace '\.exe$', ".$tag.exe" }
      - uses: actions/upload-artifact@v4
        with: { name: desktop-windows-${{ inputs.suffix }}, path: apps/desktop/src-tauri/target/release/bundle/nsis/*.exe, if-no-files-found: error }

  desktop-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ inputs.ref }}" }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: aarch64-apple-darwin,x86_64-apple-darwin }
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: apps/desktop/src-tauri }
      - run: pnpm install --frozen-lockfile
      - run: pnpm tauri build -- --target universal-apple-darwin
        working-directory: apps/desktop
      - name: Rename with nightly tag
        if: ${{ inputs.nightly }}
        run: |
          tag="$(date +%Y%m%d).${GITHUB_SHA::7}"
          cd apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg
          for f in *.dmg; do mv "$f" "${f%.dmg}.$tag.dmg"; done
      - uses: actions/upload-artifact@v4
        with: { name: desktop-macos-${{ inputs.suffix }}, path: apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg, if-no-files-found: error }

  desktop-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ inputs.ref }}" }
      - run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: apps/desktop/src-tauri }
      - run: pnpm install --frozen-lockfile
      - run: pnpm tauri build -- --bundles deb,appimage
        working-directory: apps/desktop
      - name: Rename with nightly tag
        if: ${{ inputs.nightly }}
        run: |
          tag="$(date +%Y%m%d).${GITHUB_SHA::7}"
          cd apps/desktop/src-tauri/target/release/bundle
          for f in deb/*.deb appimage/*.AppImage; do [ -f "$f" ] && mv "$f" "$(dirname $f)/$(basename $f | sed -E "s/\.(deb|AppImage)$/.$tag.\1/")"; done
      - uses: actions/upload-artifact@v4
        with:
          name: desktop-linux-${{ inputs.suffix }}
          path: |
            apps/desktop/src-tauri/target/release/bundle/deb/*.deb
            apps/desktop/src-tauri/target/release/bundle/appimage/*.AppImage
          if-no-files-found: error

  extension:
    runs-on: ubuntu-latest
    strategy:
      matrix: { browser: [chrome, firefox] }
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ inputs.ref }}" }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec wxt build -b ${{ matrix.browser }}
        working-directory: apps/extension
      - name: Zip
        run: |
          tag=""
          if [ "${{ inputs.nightly }}" = "true" ]; then tag=".$(date +%Y%m%d).${GITHUB_SHA::7}"; fi
          cd apps/extension/.output/${{ matrix.browser }}-mv3
          zip -r "$OLDPWD/totp-extension-${{ matrix.browser }}${tag}.zip" .
      - uses: actions/upload-artifact@v4
        with: { name: extension-${{ matrix.browser }}-${{ inputs.suffix }}, path: apps/extension/totp-extension-*.zip, if-no-files-found: error }
```

实现时核对两处：包名（`apps/desktop/package.json`、`apps/extension/package.json` 的真实 `name`，上文 `@totp/desktop`/`@totp-extension` 为占位）；Tauri bundle 路径（NSIS 在 `target/release/bundle/nsis`，universal mac 在 `target/universal-apple-darwin/...`）。

- [ ] **Step 2: YAML 语法校验**

Run: `node -e "const y=require('js-yaml')" 2>/dev/null || npx --yes js-yaml .github/workflows/build.yml`
Expected: 解析无错（或用 actionlint：`npx --yes actionlint .github/workflows/build.yml`）

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "build(ci): 可复用三平台桌面与扩展构建workflow（验收条目6）"
```

### Task 3: PR 门禁 ci.yml

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 写 workflow**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

permissions:
  contents: read

jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev
      - uses: dtolnay/rust-toolchain@stable
        with: { components: clippy, rustfmt }
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: apps/desktop/src-tauri }
      - run: cargo fmt --check
        working-directory: apps/desktop/src-tauri
      - run: cargo clippy -- -D warnings
        working-directory: apps/desktop/src-tauri
      - run: cargo test
        working-directory: apps/desktop/src-tauri
```

注意：`cargo clippy -D warnings` 若存量告警多，首跑可先降为 `cargo clippy`（不挡），并在本仓库清理告警后收紧——把决定记录在本任务完成说明里。

- [ ] **Step 2: 推送验证**

推到分支开 PR 观察 run；修复 runner 环境差异（如 pnpm 版本、缺失系统库）直至全绿。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "build(ci): PR门禁（typecheck/test/fmt/clippy/cargo test）（验收条目6）"
```

### Task 4: release.yml 与 nightly.yml

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/nightly.yml`

**Interfaces:**
- Consumes: build.yml（`uses: ./.github/workflows/build.yml`）
- Produces: GitHub Release（tag 版）与固定 `nightly` prerelease

- [ ] **Step 1: release.yml**

```yaml
name: release
on:
  push: { tags: ["v*"] }

permissions:
  contents: write

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: tag == 根 package.json version
        run: |
          ver="v$(node -p "require('./package.json').version")"
          [ "$ver" = "${GITHUB_REF_NAME}" ] || { echo "tag ${GITHUB_REF_NAME} != $ver"; exit 1; }
  build:
    needs: gate
    uses: ./.github/workflows/build.yml
    with: { ref: "${{ github.ref_name }}", suffix: release, nightly: false }
  publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { path: artifacts, merge-multiple: true }
      - name: sha256
        run: cd artifacts && sha256sum * > ../sha256sums.txt
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            artifacts/*
            sha256sums.txt
          generate_release_notes: true
```

- [ ] **Step 2: nightly.yml**

```yaml
name: nightly
on:
  schedule: [{ cron: "0 16 * * *" }]   # UTC 16:00 = 北京 0 点
  workflow_dispatch: {}

permissions:
  contents: write

concurrency:
  group: nightly
  cancel-in-progress: true

jobs:
  build:
    uses: ./.github/workflows/build.yml
    with: { ref: main, suffix: nightly, nightly: true }
  publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { path: artifacts, merge-multiple: true }
      - name: sha256
        run: cd artifacts && sha256sum * > ../sha256sums.txt
      - uses: actions/github-script@v7
        with:
          script: |
            // 删除旧 nightly release（保留 tag 由下步重建）
            const rel = await github.rest.repos.getReleaseByTag({ owner: context.repo.owner, repo: context.repo.repo, tag: 'nightly' }).catch(() => null)
            if (rel) await github.rest.repos.deleteRelease({ owner: context.repo.owner, repo: context.repo.repo, release_id: rel.data.id })
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: nightly
          name: Nightly Build
          prerelease: true
          body: ${{ github.event.head_commit.message || '自动构建' }}
          files: |
            artifacts/*
            sha256sums.txt
```

- [ ] **Step 3: 验证策略（无法本地全验）**

1. push 后手动 `workflow_dispatch` 不适用于 release（tag 触发）——在测试 tag（如 `v0.1.1-rc.1`）上验证 gate 与 build。
2. nightly 用手动 `workflow_dispatch` 触发一次验收。
3. 逐个修 runner 差异（路径/包名/系统库），直至产物齐 6 类 + sha256sums。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/nightly.yml
git commit -m "build(ci): tag正式发布与每日滚动nightly流水线（验收条目6）"
```

### Task 5: 发布阻断项定稿

**Files:**
- Modify: `apps/extension/wxt.config.ts`（gecko id）

**Interfaces:**
- Consumes: 无
- Produces: 正式 firefox 扩展 ID

- [ ] **Step 1: 定稿 gecko id**

向用户确认正式扩展 ID（形如 `totp-tools@<你的域名>`，域名需可控；无域名可用 `totp-tools@users.noreply.github.com` 变体——AMO 接受任意邮箱形 ID 但不可再改）。替换 `wxt.config.ts` 占位并删除 TODO 注释。

- [ ] **Step 2: 重新构建验证**

Run: `pnpm --filter @totp/extension exec wxt build -b firefox && rg -n "browser_specific_settings" -A 3 apps/extension/.output/firefox-mv3/manifest.json`
Expected: manifest 含定稿 ID

- [ ] **Step 3: Commit**

```bash
git add apps/extension/wxt.config.ts
git commit -m "build(ext): 定稿firefox扩展gecko id（发布阻断项）"
```
