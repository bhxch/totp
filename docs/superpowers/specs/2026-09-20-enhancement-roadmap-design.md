# 设计：功能增强路线图（vs Aegis 对比后选型）

日期：2026-09-20
状态：已与需求方对齐，待实施（按批次逐个出实施计划）

## 背景与目标

2026-09-20 完成与 Aegis Authenticator 的全面功能对比后，确定补齐方向。共性能力（TOTP/HOTP、AES-GCM vault、图标包生态、Steam 码）本项目已对齐或更强，需补的是：**数据可携性出口**（目前唯一导出是自有 `.totpbackup`，无法迁出）、**录入便捷性**（无 QR 识别、无批量新增）、**个别算法与导入格式**（Yandex、Authenticator Plus）、**体验细节**（纯黑主题、图标兜底）与 **i18n**（全中文硬编码）。

目标：按 5 个批次 + i18n 前置机制，补齐上述能力；每批独立可发布。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 批次顺序 | **i18n D1 机制先行 → 批① 导出与扫码互通 → 批② QR 与智能录入 → 批③ Yandex + Authenticator Plus → 批④ 体验打磨 → i18n D2 收尾** |
| 批量新增入口形态 | **新增弹窗双 Tab**（手动填写 / 智能粘贴），文本与图片统一粘贴、解析结果列表勾选入库 |
| i18n 方案 | **vue-i18n**，zh 为源语言兼回退、en 为首目标语言；**不用 chrome.i18n**（桌面端无此 API，两壳共享 ui 包资源） |
| QR 生成库（批①） | **uqr**（纯 TS、体积小）：只取 QR 矩阵，渲染自绘 canvas |
| QR 解码库（批②） | **jsQR**（纯 JS、无 wasm、SW 可用）：otpauth 场景是清晰屏幕图像，无需 zxing-wasm |
| 权威源对齐 | Yandex 算法与 Authenticator Plus 解密均**移植自 Aegis 源码**（Apache-2.0，注明出处），用其测试向量写单测 |
| 权限原则 | **零新增 manifest 权限**优先；批② C4 若 activeTab 方案验证不通过，先降级（暂缺该入口）回报再议，不擅自扩权 |
| 新代码约定 | i18n D1 落地后所有新组件直接写 `t()` key，不再产生硬编码中文文案 |

## §1 i18n D1：机制先行

- vue-i18n 引入 `packages/ui`，资源 `packages/ui/src/i18n/locales/{zh,en}/*.json` 按模块拆分；zh 为源语言兼回退。
- 语言默认跟随 `navigator.language`，SettingsPage 新增手动覆盖项（settings 新字段 `locale?: 'auto' | 'zh' | 'en'`）。
- D1 交付物：依赖 + 目录约定 + 示范性抽取 1–2 个模块（NavigationShell、LockScreen），其余组件留待 D2。
- 本 spec 后续所有批次的新组件一律 `t()` key。

## §2 批①：导出与扫码互通

### 2.1 core 导出模块 `packages/core/src/export/`

- `exportOtpauthText(vault): string`：每行一条 `buildOtpUri`；HOTP 恒带 counter；Steam 走 `otpauth://steam/`；换行分隔。
- `exportAegisVault(vault, { mode: 'plain' } | { mode: 'encrypted'; password }): object|string`：对齐 Aegis vault JSON schema（版本字段实施时以 Aegis 官方源码/样例文件核对后固化）。加密侧复用 `import/aegis.ts` 已验证的 scrypt + AES-GCM 原语反写。

### 2.2 多标签 → Aegis 单 group 映射

Aegis 条目 group 为单值：取条目 `tagIds` 的**第一个 tag 名**写入 group，其余丢弃并计入导出报告提示（格式天花板，明示而非静默）。

### 2.3 UI：导出卡片

格式四选一：`.totpbackup`（现状）/ otpauth URI 文本 / Aegis 明文 JSON / Aegis 加密 JSON。

- Aegis 加密口令：**每次导出时输入，不默认保存**；可选「存入保管区」复用。
- 两种明文导出：二次确认 + 明示明文风险文案。
- 下载：扩展端浏览器下载，桌面端 Tauri 保存。

### 2.4 单条二维码展示

- 生成：uqr 出矩阵，自绘 canvas（白底黑码，纠错等级 M）。
- 入口：列表行右键菜单加「显示二维码」、options 列表行内按钮、popup 行内按钮；三处共用同一 Dialog 组件。
- Dialog 内容：QR + issuer/label + **固定警示「二维码包含完整密钥，请勿截图或分享」**。
- 展示不消耗 HOTP counter；Steam/Yandex 等特殊类型走各自 URI 格式，支持它们的移动端应用可直接扫码录入。

### 2.5 多选二维码拼版（仅 options 管理页）

- CodesPage 加「选择模式」：行首 checkbox，选中后底部浮动操作条显示「生成二维码(N)」+ 取消。popup 不做多选（宽度不适合）。
- 大图：canvas，白底；列数按条数自适应（≤4→2 列、≤9→3 列、其余 4 列）；每格 = QR + 下方 issuer/label 黑字标签。
- **默认仅 Dialog 内展示，不落盘**；控件内「保存图片」按钮：扩展端 `a[download]` 存 PNG（无需 downloads 权限），桌面端 Tauri 保存路径对话框。

### 2.6 验收

- round-trip：`exportOtpauthText` → uriBatch 导入器逐字段恒等；`exportAegisVault` → 本项目 Aegis 导入器（含加密）可解密读取且条目一致。
- 导出报告含「丢弃标签」提示；单条 QR 组件测试 + 拼版列数自适应单测。

## §3 批②：QR 与智能录入（C0→C4 递进）

### C0 智能粘贴文本

- EntryForm 弹窗改双 Tab：「手动填写」（现状）/「智能粘贴」。
- 智能粘贴 Tab：textarea（onPaste 同时接管图片项）+ 拖拽区；文本走 core 既有 sniff + normalize + dedup 管线（粘贴场景仅文本类嗅探器：uriBatch / 通用 JSON，文件类格式不涉及）。
- 解析结果卡片列表：服务 / 账户 / 类型 / 状态（ok、疑似重复默认跳过、冲突行内选择 skip/replace/merge）；底部「添加 N 条」批量落库（复用导入落库路径）。

### C1 解码核心

`packages/ui/src/qr/decodeQr.ts`：输入 paste/drop/file/dataUrl，内部 OffscreenCanvas 取 ImageData → jsQR → 返回 otpauth URI 文本（单图取第一个码，接口返回数组留扩展）。

### C2 表单集成

「手动填写」Tab 加「从图片识别」按钮（选图 / 粘贴）：解码成功后按 otpauth URI 预填表单各字段（type/issuer/label/secret/algorithm/digits/period/counter），走既有确认保存。

### C3 批量图片

智能粘贴 Tab 支持一次多图：逐张解码，与文本结果合并进同一预览列表。

### C4 网页右键识别（零新增权限）

- `contextMenus` 增加 image 右键项「识别图中的验证码二维码」。
- background（SW）+ OffscreenCanvas + jsQR 解码（jsQR 纯 JS，SW 可 import）。
- 成功：系统通知 → 点击经既有 `?uri=` 预填通道进弹窗确认；失败：失败通知。
- 权限：依赖既有 `activeTab`（右键点击即授予该 tab 临时源权限，background 可 fetch 该图）。**实施第一步先验证此 grant 行为；不通过则本入口暂缺，回报需求方再议是否加 `scripting` 权限，不默认扩权。**

### 验收

decodeQr 固定样例图单测；双 Tab 流转 / 批量勾选组件测试；扩展 shim 冒烟（右键菜单 → 通知 → 预填）。

## §4 批③：Yandex 算法 + Authenticator Plus 导入

### 4.1 Yandex（core）

- `packages/core/src/otp/yandex.ts`：第四种类型，算法对齐 Aegis `YandexAuthOTP`（Apache-2.0，保留出处注释），pin 码可选。
- URI 形态与参数：实施时按 Aegis 解析器源码核实后固化进 spec 级注释。
- EntryForm 类型下拉加「Yandex」，pin 字段（可选）；导入器侧不涉及（源格式罕见，暂无专导入器）。

### 4.2 Authenticator Plus 导入（core）

- `packages/core/src/import/authenticatorPlus.ts`：对齐 Aegis `AuthenticatorPlusImporter.java`——加密 zip 内为 `Accounts.txt`（otpauth URI 逐行文本），解出后直接复用 `importUriBatch`；**无 SQLite、无 group 映射**。
- **技术风险**：fflate 不支持 WinZip AES 加密 zip → 自实现 AE-1/AE-2 解密 + zip 结构解析（`zipRead.ts`）；参数对不上 Aegis/zip4j 实现时回报。

### 验收

Aegis 测试向量驱动的 Yandex 单测；AP 样例导出文件导入单测；两者均含负例（错误口令/损坏文件）。

## §5 批④：体验打磨

- **AMOLED 纯黑主题**：现有 10 子色 × 明/暗/自动体系加「纯黑」档：表面色系覆盖为 #000 系、primary 不动，走现有 material-color-utilities tokens 管线 + 手工覆盖。
- **首字母图标兜底**：`OtpListItem` 无图标时渲染 issuer 首字符圆标，底色按 issuer 哈希从 10 子色的 container 色中选取；纯展示层，不写入 vault。

## §6 i18n D2：全量收尾

- packages/ui 全组件 + 扩展/桌面两端壳层全量抽串；en 资源补齐；测试适配（vue-i18n 测试插件固定 zh locale，现有中文断言基本不动）。
- 验收：`rg` 扫描组件层无硬编码中文文案（代码注释与测试文件除外）。

## §7 执行顺序与交付方式

1. i18n D1 → 2. 批① → 3. 批② → 4. 批③ → 5. 批④ → 6. i18n D2。

每批独立可发布、独立 commit 系列，批间无阻塞；每批启动前用 writing-plans 出该批实施计划（延续 `docs/superpowers/plans/` 惯例）。测试以当前 core/ui/extension 三层 1300+ 用例全绿为基线，只增不减。

## §8 非目标

- 生物识别、屏幕捕获防护：浏览器/桌面平台不适用；Passkey PRF、DPAPI、失焦隐藏已覆盖对应场景。
- mOTP、favicon 自动抓取、Google Authenticator migration QR 导出、其余厂商特殊算法。
- 新增 manifest 权限（§3 C4 的 `scripting` 例外需回报需求方确认后才可加）。

## §9 风险与降级

| 风险 | 应对 |
|---|---|
| C4 activeTab grant 下 background fetch 图片不可行 | 降级为暂缺该入口，回报再议，不默认扩权 |
| fflate 不支持 WinZip AES zip（批③） | 自实现 AE-1/AE-2；参数对不上 Aegis 实现时回报 |
| uqr 库维护度低 | 生成接口隔离在 QR 渲染封装层，可无感替换 |
| Aegis vault schema 细节与假设不符（批①） | 实施时以官方源码/样例文件核对后才固化导出实现 |
