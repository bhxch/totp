# TOTP 工具 计划12：otpauth 链接处理 + 右键菜单 + spec 勘误 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 兑现 spec 第 10 节 otpauth 承诺：Firefox `protocol_handlers` 原生注册 otpauth:// 链接直达录入；Chrome/Edge 替代路径（右键菜单「将选中 otpauth URI 添加为条目」+ popup 粘贴入口）；spec 文档勘误归拢（权限清单、enqueue、 IndexedDB、裁剪项登记）。

**Architecture:** WXT manifest `protocol_handlers`（Firefox 目标——WXT 多浏览器目标产物核对）；background contextMenus 选中文本匹配 otpauth:// 前缀→点击后经 storage 中转（`pendingOtpauth` 键）→popup/options 打开时读取并预填 EntryForm；spec 勘误为纯文档任务。

**Tech Stack:** 现有栈不变。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（第 10 节 otpauth 链接处理；Chrome 平台限制的替代路径）

## Global Constraints

- 沿用全部既有约束；manifest 变更必须产物核对（多浏览器目标）
- Firefox protocol_handlers 仅在 Firefox 构建目标生效（WXT `manifest.manifest_version`/浏览器差异按 WXT 文档——`protocol_handlers` 在 MV2/MV3 Firefox 均可；Chrome 产物不得含该字段（Chrome 会警告忽略，产物核对确认）
- otpauth URI 入口统一走 `parseOtpUri` 校验→EntryForm 预填（新建模式，type/issuer/label/secret 回填）——复用 newEntryFromUri 的解析但不直接落库（用户确认保存）
- spec 勘误项（Task 3）：§10 权限清单补 alarms/offscreen/unlimitedStorage/activeTab 已实际申请、§4 存储形态（StorageAdapter JSON 键而非 IndexedDB/icons 目录——P7 裁定）、§6 envelope 已勘误（P4 已做，核对）、§7 non-extractable CryptoKey IndexedDB 登记为 backlog（计划 11 未含）、§12 复制 30s 清剪贴板已实现（Chrome/Edge）、§10 popup 2s 关闭已实现、§15 Backlog 更新（已完成项划掉、新增：GA 旧版 SQLite/Steam Steamguard 导入、andOTP 加密、映射方案随备份导出、图标批量套用导入、双端独立加密禁用提示、syncEnabled 同步语义）

---

### Task 1: popup 粘贴入口 + otpauth URI 预填（TDD）

**Files:**
- Create: `packages/ui/src/otpauthFlow.ts`
- Modify: `packages/ui/src/components/EntryForm.vue`（接受 initial 形式的 URI 预填——或由宿主先 parse 构造 initial 对象，取宿主构造更简）
- Modify: `apps/extension/entrypoints/popup/App.vue`（表单区上方「粘贴 otpauth 链接导入」入口：textarea+按钮→parseOtpUri→构造 initial→creating=true）
- Test: `packages/ui/test/otpauthFlow.test.ts`

**Interfaces:**
- Produces: `parseUriToEntryData(uri: string): { data: EntryFormData & { algorithm; digits; period; counter? } } | { error: string }`——parseOtpUri→EntryFormData 形状（type/issuer/label/secret/algorithm/digits/period/counter/note:''/groupIds:[]/matchRules:[]/icon undefined）；错误→中文消息
- 测试：合法 totp/steam/hotp URI、非法 URI 错误

- [ ] **Step 1: TDD → popup 接线（EntryForm initial 支持预填对象——核对 EntryForm initial: OtpEntry 类型，预填需 OtpEntry 形状：补 uuid/order 等哑值即可）→ 验证 → Commit**

```bash
git add packages/
git commit -m "feat(ui): otpauth URI粘贴导入预填(popup入口)"
```

---

### Task 2: Firefox protocol_handlers + Chrome 右键菜单

**Files:**
- Modify: `apps/extension/wxt.config.ts`（Firefox 目标 protocol_handlers：`[{ protocol: 'otpauth', name: 'TOTP 验证码工具', href: '/popup/index.html?uri=%s' }]`——按 WXT target 差异配置语法核实）；popup main.ts 读取 query 参数 uri→同 Task 1 预填
- Modify: `apps/extension/entrypoints/background.ts`（contextMenus：`otpauth-add` 菜单项（contexts: ['selection']，点击时读 selectionText，otpauth:// 前缀→写 local `pendingOtpauth` 键→打开 popup（chrome.action.openPopup 仅 Chromium stable 可用性核实——不可用则 chrome.runtime.openOptionsPage 或 notifications 引导）；非 otpauth 选择不显示菜单——用 onClicked 内校验，菜单声明用 documentUrlPatterns 不可行则恒显示+点击校验提示）
- Modify: `apps/extension/entrypoints/popup/App.vue`（onMounted 读 local pendingOtpauth→预填+清除键）
- Test: 无自动化（manifest/菜单为宿主能力）——以 build 产物核对（chrome 目标无 protocol_handlers 或含但不报错、firefox 目标含）+ 手工清单

**Interfaces:**
- WXT 多目标：`pnpm --filter @totp/extension build -b firefox`（核实 WXT 的 firefox 目标命令与产物目录 .output/firefox-mv2）；产物核对：firefox 产物 manifest 含 protocol_handlers、chrome 产物不含（或 WXT 生成兼容形态）
- 右键菜单语义：selectionText 经 parseOtpUri 校验→合法写 pendingOtpauth + 打开 popup；非法→chrome.notifications 提示（需 notifications 权限——裁定：加 permissions notifications，最小合理）或简单 alert 不可用——用 notifications

- [ ] **Step 1: 实现 + 双目标产物核对 → Commit**

Run: `pnpm --filter @totp/extension build && pnpm --filter @totp/extension build -b firefox`（命令以 WXT 实际为准）

```bash
git add apps/extension/
git commit -m "feat(extension): Firefox otpauth协议注册与Chrome右键菜单导入"
```

---

### Task 3: spec 勘误归拢（纯文档）

**Files:**
- Modify: `docs/plans/2026-09-13-totp-tool-design.md`

- [ ] **Step 1: 勘误清单逐项落实（Task 描述 Global Constraints 列表）→ Commit**

Run: 无代码。核对 P4 已勘误 envelope 不重复。

```bash
git add docs/
git commit -m "docs: spec勘误归拢(权限清单/存储形态/backlog更新)"
```

---

### Task 4: 回归 + README

**Files:**
- Modify: `README.md`（插件功能段补：otpauth 链接（Firefox 协议注册/Chrome 右键+粘贴入口）、右键菜单导入）

- [ ] **Step 1: 回归（pnpm test / typecheck / 双 build + firefox 目标产物核对）→ README → Commit**

```bash
git add README.md
git commit -m "docs: README补充otpauth链接导入说明"
```
