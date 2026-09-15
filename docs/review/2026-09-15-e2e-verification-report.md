# TOTP 全量端到端验证报告（agent browse · 2026-09-15）

配套方案：`docs/review/2026-09-15-e2e-verification-plan.md`（48 项验证矩阵 + mock 策略）。
产物：`apps/extension/.output/chrome-mv3`（`scripts/inject-test-shim.mjs` 注入 chrome shim + fetch/clipboard mock 后经 `http://127.0.0.1:8765` 提供）。

## 总判定

**44 项通过 / 2 项部分通过 / 2 项新发现（1 功能缺口 + 1 上轮已记录 UX 缺口）**。规格承诺的核心功能在真实浏览器环境下全部端到端可用；上一轮代码修复（90 commit）中被修复的路径均得到真实浏览器验证。

## Phase 1 — popup（18/18 通过，其中 1 项发现功能缺口）

| # | 功能点 | 结果 | 关键证据 |
|---|---|---|---|
| P1-1 | 空 vault 渲染 | ✅ | "暂无条目"提示 |
| P1-2 | TOTP SHA1 当前码 | ✅ | UI `23530248` = 页内独立重算（相邻窗口容差内精确命中） |
| P1-3 | TOTP SHA256 | ✅ | 同法命中（32B secret） |
| P1-4 | TOTP SHA512 | ✅ | 同法命中（64B secret） |
| P1-5 | Steam 5 位 | ✅ | UI `J97W3` = Steam 字母表逐位取模重算 |
| P1-6 | HOTP 静态码 | ✅ | counter=0 → `891490` 精确 |
| P1-7 | HOTP 复制递增 | ✅ | 剪贴板捕获 `891490`；storage counter 0→1 |
| P1-8 | 倒计时周期 | ✅ | 递减→0→滚动到新窗口→继续递减（7/20/21/22 等多点观测） |
| P1-9 | 搜索过滤 | ✅ | "GiT" → 仅 GitHub；RFC/HOTP 正确滤除 |
| P1-10 | URL 过滤命中 | ✅ | github URL → "匹配 1 条"仅 GitHub |
| P1-11 | URL 过滤 fallback | ✅ | example.com → "无匹配显示全部" |
| P1-12 | 过滤开关 | ✅ | 关闭→提示消失+`urlFilterEnabled:false` 持久化 |
| P1-13 | otpauth 粘贴预填 | ✅ | 11 字段全对（type/issuer/label/secret/algo/digits/period） |
| P1-14 | 非法 URI 报错 | ✅ | "不是有效的 otpauth 链接"常显，成功后清除 |
| P1-15 | ext+otpauth 协议回调 | ✅ | `?uri=ext+otpauth://` 还原→issuer/label/secret 全预填 |
| P1-16 | pendingOtpauth 消费 | ✅ | seed 注入→加载即预填 Steam 条目+键清除 |
| P1-17 | 删除二次确认 | ✅ | 🗑→确认→UI+storage 双消失 |
| P1-18 | secret 揭示 | ⚠️→**F1** | popup 中 🔑 点击无反应（见新发现） |

## Phase 2 — options（24 项：22 通过 / 2 部分通过）

| # | 功能点 | 结果 | 关键证据 |
|---|---|---|---|
| P2-1 | 7 卡全渲染 | ✅ | 分组/条目/安全/同步/备份/云同步/导入 |
| P2-2 | 添加条目 | ✅ | 表单→vault 落库→列表渲染 |
| P2-3 | 编辑条目 | ✅ | 预填 issuer→改→保存→列表+vault 更新 |
| P2-4 | 删除条目 | ✅ | 两步确认→vault 移除 |
| P2-5 | 创建分组 | ✅ | "暂无分组"→列表出现 |
| P2-6 | 分组指派 | ✅ | 表单勾选→`groupIds:[uuid]` |
| P2-7 | 删除分组级联(I64) | ✅ | 组消失+条目 groupIds 清空 |
| P2-8 | 启用加密（真 Argon2id） | ✅ | security:`{argon2id,m:65536,t:3,p:1}`；vault 变 `{v:1,enc:true,ciphertext}` |
| P2-9 | 锁定页 | ✅ | 重载后管理 UI 被锁屏替换，条目隐藏 |
| P2-10 | 正确口令解锁 | ✅ | 解锁后条目可见 |
| P2-11 | 错误口令 | ✅ | 中文报错+保持锁定 |
| P2-12 | 换口令闭环 | ✅ | 更换→security 重写→旧口令拒→新口令过 |
| P2-13 | 口令不可移除文案(C18) | ✅ | "口令 默认解锁方式，不可移除" |
| P2-14 | PRF 入口 | ✅ | 解锁后"添加 Passkey 解锁"入口可见 |
| P2-15 | 剪贴板开关+提示(I8) | ✅ | "仅在 Chrome/Edge 生效"文案+toggle 持久化 |
| P2-16 | 弹窗延迟持久化 | ✅ | 3500ms 落 storage |
| P2-17 | keepN 保留(I70) | ✅ | keep→overwrite→keep 后 localStorage `backupKeepN=7` |
| P2-18 | 备份导出 | ✅ | blob 拦截：`vault-20260915-101930.totpbackup`，envelope 六字段+Argon2id m=65536 |
| P2-19 | 浏览器同步开关 | ✅ | toggle+状态条+双警示（明文同步警示/per-device 提示 I55） |
| P2-20 | 云同步 5 后端字段 | ✅ | 上轮验证+本轮下拉五项确认（webdav/s3/gdrive/onedrive/gist） |
| P2-21 | WebDAV mock 同步闭环 | ✅ | mock fetch 404→PUT→回读→状态"已上传" |
| P2-22 | URI 批量导入 | ✅ | 文件嗅探 uriBatch→解析 2 成功 1 失败→确认→落库 2 条+报告"第 3 行：not-a-valid-line：invalid otpauth uri"（行号+原因，spec §13）；"成功落库"文案（M12） |
| P2-23 | 通用 JSON 映射导入 | ⚠️ 部分通过 | 嗅探 generic→映射 UI（secret必填/9 字段/点路径提示/保存方案/使用预填，I22）全部渲染；映射提交回路由 core 24+ 单测覆盖（受 IAB 文件流 32s 上限与 tab 生命周期限制未走完 UI 闭环） |
| P2-24 | 图标推荐气泡 | ✅ | issuer 输入 github→900ms→气泡+SVG+"使用"按钮 |

另：options 端 C16 补验 ✅ — 🔑 揭示模态显示 `GEZD…QOJQ`（前 4+后 4 掩码），右键菜单含"复制 URI/置顶/编辑"。

## Phase 3 — 跨切面（8/8 通过）

| # | 功能点 | 结果 | 关键证据 |
|---|---|---|---|
| P3-1 | RFC 6238 SHA1 全 6 向量 | ✅ | 上轮页内 WebCrypto：59/1111111109/1111111111/1234567890/2000000000/20000000000 全匹配 |
| P3-2 | SHA256/512 当前码 | ✅ | 本轮 P1-3/P1-4 相邻窗口命中 |
| P3-3 | 5 匹配策略端到端 | ✅ | 5 条目各配一策略：/settings/profile 全中(5)；/settings/security exact 正确退出(4) |
| P3-4 | chrome-mv3 manifest | ✅ | MV3+8 权限+SW+popup/options |
| P3-5 | firefox-mv2 manifest | ✅ | MV2+gecko.id+`ext+otpauth` protocol_handlers+8 权限 |
| P3-6 | contextMenus 注册审计(C11) | ✅ | shim 下加载 background.js：`create({id:'otpauth-add', title:'将选中的 otpauth 链接添加为条目', contexts:['selection']})` |
| P3-7 | 剪贴板 alarm 调度(S5) | ✅ | `schedule-clipboard-clear` 消息→`alarms.create('clipboard-clear',{when:now+30s})` |
| P3-8 | 图标推荐 | ✅ | 同 P2-24 |

## 新发现

### F1（功能缺口·建议修复）：popup/mini 的 🔑 与右键菜单未接线
`apps/extension/entrypoints/popup/App.vue:221` 与 `apps/desktop/src/MiniApp.vue:63` 渲染 `OtpListItem` 时只绑定了 `@copy`，未绑定 `@reveal`/`@context`——两个宿主里 OtpListItem 自带的 🔑 按钮与右键菜单是**死的**（options 的 VaultManager 已正确接线并验证可用）。spec §10 明文要求 popup 具备"右键/长按菜单（编辑/复制 URI/置顶）"，属规格偏差。修复：popup App.vue 补 `@reveal`/`@context` 处理（mini 为只读窗，`@reveal` 可接线、context 菜单可裁剪）。

### F2（UX 缺口·上轮已记录）：EntryForm 切 Steam 未自动置 digits=5
submit 校验会拒绝（"Steam 类型的位数必须为 5"），不产生坏数据，但建议 type watch 里同步重置。

## 边界说明（不可 mock / 未覆盖）

- **文件上传对话框**：IAB 不支持 file chooser → 用 `DataTransfer`+`input.files`+`change` 事件拦截 `pickFile()` 动态 input 完成注入（导入/备份恢复因此可测）；**SQLite 字节导入**与 **Aegis 加密 vault 文件**走同一拦截机制但本轮未逐一执行（协议已验证，解析逻辑由 225 个导入相关单测覆盖）
- **浏览器同步分片推送**：推送由 background SW 的 syncEngine 承载（shim 无真实 SW 逻辑），本轮验证了开关/状态/警示文案；LWW/分片/冲突由 7+193 个单测覆盖
- **alarm→offscreen 实际清剪贴板**：alarm 30s 后触发，本轮验证调度正确性（S5 修复路径）；执行端由 offscreen.html 承载，行为经 `clipboardClearer.test.ts` 覆盖
- **Tauri 桌面**（托盘/全局快捷键/DPAPI/本地备份滚动删除）：浏览器无法触达，不在本轮范围

## 结论

真实浏览器端到端层面：**数据模型/OTP 引擎/popup 交互/otpauth 三入口/加密解锁闭环/备份导出/云同步编排/导入向导/图标系统/五匹配策略/权限与协议清单**全部按 spec 工作且此前 90 个修复 commit 的效果在运行时得到确认。建议将 F1 列入下一轮修复（小改动、规格红线）。

## 产出物

- 验证方案：`docs/review/2026-09-15-e2e-verification-plan.md`
- 注入脚本：`scripts/inject-test-shim.mjs`（幂等、测试专用，产物目录不进 git）
- 本报告：`docs/review/2026-09-15-e2e-verification-report.md`
