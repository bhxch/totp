# TOTP 工具 计划8：导入全量（19 格式 + SQLite + 映射方案保存）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对齐 Aegis 源码全部 importer 格式（在 P5 已有 aegis/winauth/URI/通用 4 类基础上补齐其余），通用映射方案命名保存/复用/随设置导出；ImportCard 支持 SQLite 数据库文件（sql.js 懒加载）。

**Architecture:** core `import/` 扩展各格式 parser（统一 ParsedEntry/ImportResult）；SQLite 经 sql.js（wasm，ui 包懒加载动态 import，不进主 bundle）；映射方案存 'importSchemes' 键（core settingsStore 同款模式）；ImportCard 增格式分派与方案管理 UI。

**Tech Stack:** sql.js（ui 运行时依赖，动态 import 懒加载）、fflate（解 zip，已依赖）。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（第 9 节；对齐 Aegis 源码 importers 目录 19 种）

## Global Constraints

- 沿用全部既有约束；core 运行时依赖仅 hash-wasm；sql.js 只进 ui 包依赖且必须动态 import（`await import('sql.js')`）保证懒加载
- **格式清单（对齐 Aegis importers 目录，括号为已实现）**：Aegis✅、WinAuth✅、GoogleAuthUri✅(uriBatch 覆盖 Plain text)、Steam(经 .wauth✅/SQLite)、2FAS、Bitwarden、EnteAuth、andOTP(明文/加密 fernet)、Stratum、ProtonAuthenticator、FreeOTP/FreeOTP+、TOTP Authenticator、Authy(SQLite)、BattleNet(SQLite)、Duo(SQLite)、MicrosoftAuth(SQLite)、AuthenticatorPlus(SQLite 加密)
- SQLite 类：用户从设备取出的 db 文件——**解密类（MicrosoftAuth 密码、AuthenticatorPlus 口令）支持口令解密；其余直读**；每格式 schema 以 Aegis 源码对应 Importer 为准研究对齐（表名/列名/字段口径），实现注释引用源文件
- 映射方案：`{ id, name, format: 'generic', rowsPath?: string, mapping: RowMapping }`，存 'importSchemes' 键（数组 JSON）；命名保存/列表/删除/应用；跨端随 storage 走
- 单条失败不阻断、嗅探失败明确报错的既有契约不变；sniffFormat 需扩展识别新格式特征键
- 涉及构建产物核对照旧

---

### Task 1: JSON 类格式 parser——2FAS/Bitwarden/Ente/Proton/Stratum（TDD）

**Files:**
- Create: `packages/core/src/import/apps/jsonApps.ts`
- Modify: `packages/core/src/import/sniff.ts`（sniffFormat 扩展）、`packages/core/src/index.ts`
- Test: `packages/core/test/importApps.test.ts`

**Interfaces:**
- Produces（每个签名统一 `importXxx(text: string): ImportResult`，结构以 Aegis 源码对应 Importer 的字段口径为准，实现前研究并注释引用源文件名）:
  - `importTwoFas(text)`：`{ services: [{ secret, account, issuer, digits, period, tokenType: 'TOTP'|'HOTP', counter, otpAudience? }] }`（2FAS 官方导出 schema；HOTP 取 counter）
  - `importBitwarden(text)`：Bitwarden JSON 导出 `{ items: [{ login: { totp, username }, name, notes }] }`——totp 字段是 otpauth URI（复用 parseOtpUri）或裸 secret（base32 判定：解码成功即裸 secret）；name→issuer、username→label
  - `importEnte(text)`：Ente Auth 导出 `{ enc: false, data: { assets? } }` 或直接数组——以 Ente 官方导出结构为准（research）
  - `importProton(text)`：Proton Authenticator 导出数组 [{ name, uri? secret?, ... }]（research）
  - `importStratum(text)`：Stratum `{ db: { items/conf? } }`（research，Aegis StratumImporter）
- sniffFormat 扩展：各格式特征键判定（在 aegis 判定后追加：2FAS→`services` 数组含 `secret`；Bitwarden→`items`+`encrypted`?；Ente→`enc` 键；Proton/Stratum 按研究结论）——判定顺序文档化进注释；无法可靠的格式留给 generic 映射（sniff 返回 null 时用户可手动选 generic，ImportCard Task 4 加手动格式选择）
- 研究要求：每个格式实现前抓取 Aegis 对应 Importer 源码（raw.githubusercontent.com/beemdevelopment/Aegis/master/app/src/main/java/com/beemdevelopment/aegis/importers/XxxImporter.java），注释引用；fixtures 内联构造（基于源码 schema）

- [ ] **Step 1: 研究 + 失败测试（每格式 ≥2 用例：正常样本 + 坏条目不阻断）→ 实现 → 通过 → Commit**

Run: `pnpm --filter @totp/core test`

```bash
git add packages/core/
git commit -m "feat(core): 2FAS/Bitwarden/Ente/Proton/Stratum导入(对齐Aegis口径)"
```

---

### Task 2: FreeOTP/TOTP Authenticator/andOTP（TDD）

**Files:**
- Create: `packages/core/src/import/apps/miscApps.ts`
- Modify: sniff/index
- Test: `packages/core/test/importMisc.test.ts`

**Interfaces:**
- `importFreeOtp(text)`：FreeOTP+ JSON `{ tokens: [{ issuer, label, secret(经 totpParams), digits, period, algo, counter? }] }`——FreeOTP+ 的 secret 是 base64 并包在 params 池里（Aegis FreeOtpPlusImporter 逻辑：tokens 内 `secret` 为索引、`sortIndex`? ——以源码为准研究并实现池解析）
- `importFreeOtpLegacy(text)`：旧版 FreeOTP（Google 机器 JSON，键无空格）——与 Plus 区分由 sniff 或独立函数
- `importTotpAuthenticator(text)`：TOTP Authenticator `{ tokens: [{ secret, label, issuer }] }`
- `importAndOtp(text, password?)`：明文 `{ entries: [{ secret, label, issuer, digits, period, type, counter, encoding }] }`；加密版 fernet（andOTP 加密备份 AES-256-CBC+PBKDF2？以 Aegis AndOtpImporter 为准研究；口令错误→中文错误）——若 fernet 实现成本超预期，明文先行+加密版明确报「暂不支持加密备份，请用明文导出」并在报告声明（裁定允许，M2 后续补）
- fixtures 内联；每格式 ≥2 用例

- [ ] **Step 1: 研究 + TDD → Commit**

```bash
git add packages/core/
git commit -m "feat(core): FreeOTP/Plus与TOTPAuthenticator与andOTP导入"
```

---

### Task 3: SQLite 类——sql.js 懒加载执行器 + Authy/BattleNet/Duo/Microsoft/AuthPlus（TDD）

**Files:**
- Create: `packages/core/src/import/sqlite.ts`（纯函数：给定查询结果行数组→ParsedEntry，无 wasm 依赖，可 TDD）
- Create: `packages/ui/src/sqliteLoader.ts`（动态 import sql.js + loadDb(bytes): Promise<Query>）
- Modify: `packages/ui/package.json`（+sql.js、@types/sql.js devDep）
- Modify: `packages/core/src/import/sniff.ts`（SQLite 文件头 `SQLite format 3\0` 判定→'sqlite'；具体 app 由表结构区分）
- Test: `packages/core/test/importSqlite.test.ts`（行数组→ParsedEntry 纯函数部分）

**Interfaces:**
- Produces:
  ```ts
  // sqlite.ts（core，纯函数）
  export function authyRowsToEntries(rows: Array<Record<string, unknown>>): ImportResult   // Authy accounts 表：name/secret/digits/period? (Aegis AuthyImporter: accounts 表 original_name, dec_secret? —— 以源码为准)
  export function battleNetRowsToEntries(rows): ImportResult
  export function duoRowsToEntries(rows): ImportResult   // duo_accounts/projects/accounts_devices? —— 源码为准
  export function msAuthRowsToEntries(rows, password?: string): ImportResult  // Microsoft Authenticator: accounts+tokens 表，misc 密码 PBKDF2 解密（Aegis MicrosoftAuthImporter）
  export function authPlusRowsToEntries(rows, password?: string): ImportResult // Authenticator Plus: 加密 SQLCipher 口令——sql.js 无法解 SQLCipher，裁定：提示「请先在原应用导出明文/不加密格式」→ 该格式仅支持经其他途径；报告声明
  ```
- sqliteLoader（ui）：`async openSqlite(bytes: Uint8Array): Promise<{ query(sql: string, params?: unknown[]): Array<Record<string, unknown>> }>`——`await import('sql.js')` initSqliteJs→new Database(bytes)；wasm 路径：`locateFile` 指向 CDN（jsdelivr sql.js@版本）并注释（离线场景限制报告声明）——**裁定：用 CDN wasm；桌面/插件离线时 SQLite 导入不可用并明确报错**
- research 要求同前（Aegis 各 Importer 源码+引用）

- [ ] **Step 1: core 纯函数 TDD（fixtures 行数组内联，schema 依研究）→ sqliteLoader（build 验收：动态 import 不进主 bundle——核对 build 产物 chunk 分离）→ Commit**

Run: `pnpm --filter @totp/core test && pnpm -r run typecheck && pnpm --filter @totp/extension build`

```bash
git add packages/ pnpm-lock.yaml
git commit -m "feat(core,ui): SQLite类导入(Authy/BattleNet/Duo/MSAuth)+sql.js懒加载执行器"
```

---

### Task 4: 映射方案保存/复用（TDD）

**Files:**
- Create: `packages/core/src/import/schemes.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/schemes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ImportScheme { id: string; name: string; rowsPath?: string; mapping: RowMapping; createdAt: number }
  export function normalizeSchemes(x: unknown): ImportScheme[]  // 容错解析（坏条目丢弃、去重 id）
  export function upsertScheme(schemes: ImportScheme[], s: ImportScheme): ImportScheme[]  // 同 id 覆盖
  export function removeScheme(schemes: ImportScheme[], id: string): ImportScheme[]
  export function matchSchemes(schemes: ImportScheme[], sampleKeys: string[]): ImportScheme[]  // mapping 的路径首段与 sampleKeys 交集数排序（推荐复用）
  export const SCHEMES_KEY = 'importSchemes'
  ```
- ImportCard 接线：generic 映射页增「保存方案」（命名输入）与方案下拉（应用：填 rowsPath+mapping；删除按钮）——store 直读写 SCHEMES 键（ui 端 ImportCard props 扩展 schemes 能力或经 platform；取简单者：ImportCard 增可选 prop `schemesApi?: { load(): Promise<ImportScheme[]>; save(s: ImportScheme[]): Promise<void> }`，三端组装 adapter 直读写）

- [ ] **Step 1: core TDD（6 用例）→ ImportCard 接线（+2 用例：保存方案后下拉出现、应用方案回填映射）→ Commit**

Run: `pnpm test && pnpm -r run typecheck`

```bash
git add packages/ pnpm-lock.yaml
git commit -m "feat(core,ui): 导入映射方案保存/复用/推荐"
```

---

### Task 5: ImportCard 全格式接线（分派 + 手动格式选择 + SQLite 入口）

**Files:**
- Modify: `packages/ui/src/components/ImportCard.vue`、`packages/ui/src/index.ts`
- Modify: `apps/extension/entrypoints/options/App.vue`、`apps/desktop/src/App.vue`（platform.readImportFile accept 扩展 .db/.sqlitedb；sqliteLoader 注入）
- Test: `packages/ui/test/ImportCard.test.ts`（追加）

**Interfaces:**
- ImportCard 分派扩展：sniffFormat 后按格式调对应 importXxx（Task 1-3 全部）；'sqlite'→platform.sqliteOpen?（platform 增可选 `runSqlite?: (bytes: Uint8Array) => Promise<{ query(...) }>`，desktop/extension 组装 sqliteLoader）→ 按表结构自动探测（尝试各格式已知表名）→ rows 交对应 rowsToEntries；口令类（msAuth/authPlus）复用口令页
- picked 页增「手动指定格式」下拉（嗅探失败/误判时用户自选，含 generic→进映射页）
- 报告页不变

- [ ] **Step 1: 追加测试（2FAS 文本全链路→entries 落库；手动指定格式路径）→ 实现 → 三端接线+产物核对（sql.js chunk 分离）→ Commit**

Run: `pnpm test && pnpm -r run typecheck && pnpm --filter @totp/extension build && pnpm --filter @totp/desktop tauri build`

```bash
git add packages/ apps/ pnpm-lock.yaml
git commit -m "feat(ui): ImportCard全格式分派/手动格式选择/SQLite入口"
```

---

### Task 6: 回归 + README

**Files:**
- Modify: `README.md`（导入段更新：19 格式清单、SQLite 说明（来源设备 db、CDN wasm 依赖）、映射方案保存复用、Authenticator Plus 限制）

- [ ] **Step 1: 回归（pnpm test / typecheck / 双 build）→ README → Commit**

```bash
git add README.md
git commit -m "docs: README导入段更新为全格式清单"
```
