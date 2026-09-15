# TOTP 全量端到端验证方案（agent browse / 2026-09-15）

## 目标

用 control-browser（In-App Browser + Playwright 兼容层）对构建产物（chrome-mv3 / firefox-mv2）做**全量功能点端到端验证**：应验尽验、该 mock 的 mock 好、不阻塞。

## Mock 策略（基础设施层）

产物 HTML 依赖 `chrome.*` 扩展上下文，普通浏览器不可用。构建后向 `popup.html` / `options.html` `<head>` 前置注入**增强版 chrome shim**（Node 脚本自动注入，测试专用、不进 git）：

| Mock 点 | 实现 | 服务于 |
|---|---|---|
| `chrome.storage.local` | 内存 Map + `get/set/remove` + 真实 `onChanged` 派发 | vault/settings 读写、pendingOtpauth、跨上下文通知 |
| `chrome.storage.sync` | 内存 Map + `getBytesInUse`（QUOTA_BYTES=102400） | 浏览器同步卡 |
| `chrome.tabs.query` | 返回 `?tabUrl=` 参数 URL | popup URL 过滤 |
| `chrome.runtime.sendMessage/onMessage` | 内存事件总线 | 剪贴板清除调度、sync-push |
| `chrome.contextMenus/alarms/offscreen/notifications/permissions` | no-op + 调用记录（`window.__calls`） | 右键菜单/alarm 触发审计 |
| `window.fetch` | 可编程 mock（`window.__mockFetch(urlPattern, responder)`），未命中走真 fetch | 云同步 5 后端、图标 URL 拉取 |
| `navigator.clipboard.writeText` | 捕获到 `window.__clipboard` | 复制验证码 / HOTP 递增 |
| `?seedVault=base64(json)` | 加载前注入 vault 明文 | 条目渲染、列表交互 |
| `?seedKeys=base64(json)` | 加载前注入任意 storage 键（pendingOtpauth/settings 等） | 右键菜单消费、设置态 |
| `?tabUrl=...` | 配合 tabs.query | URL 过滤 |

**不可 mock 的边界**（记录为限制，不阻塞）：
- 文件上传（IAB 不支持 file chooser）→ 导入类用**粘贴/URI 文本入口**验证，文件入口（Aegis 文件/备份文件恢复）改由 core 单测覆盖声明
- `chrome.contextMenus` 真实菜单渲染、offscreen 真实清剪贴板 → 用调用记录审计验证"注册/调度发生"
- Tauri 桌面（DPAPI/tray/全局快捷键）→ 完全超出浏览器，声明不在本轮

## 验证矩阵

### Phase 1 — popup（约 18 项）

| # | 功能点 | 验证方法 | 判定 |
|---|---|---|---|
| P1-1 | 空 vault 渲染 | snapshot | 显示"暂无条目" |
| P1-2 | TOTP SHA1 当前码 | 页内独立 recompute 对比 UI 文本 | 数值一致 |
| P1-3 | TOTP SHA256 | 同上（secret 为 RFC 6238 SHA256 向量的 base32） | 一致 |
| P1-4 | TOTP SHA512 | 同上 | 一致 |
| P1-5 | Steam 5 位 | 页内按 Steam 语义 recompute（RFC4648 解码） | 一致且 5 位 |
| P1-6 | HOTP 显示 counter 码 | 固定 counter recompute | 一致 |
| P1-7 | HOTP 复制递增 counter | clipboard mock 捕获 + storage counter+1 | 剪贴板=当前码 且 counter=1 |
| P1-8 | 倒计时环 | 读剩余秒数文本，sleep 后重读 | 递减且周期重置 |
| P1-9 | 搜索过滤（issuer/label/大小写） | fill 搜索框读列表 | 命中唯一 |
| P1-10 | URL 过滤命中（baseDomain） | tabUrl=github.com | "匹配 1 条"仅 GitHub |
| P1-11 | URL 过滤 fallback | tabUrl=example.com | "无匹配显示全部" |
| P1-12 | 过滤开关关闭 | 点 checkbox | 全显 |
| P1-13 | otpauth 粘贴导入预填 | fill textarea→导入→读表单 11 字段 | 全部正确 |
| P1-14 | 非法 otpauth 报错 | 粘贴垃圾文本→导入 | 中文错误常显 |
| P1-15 | ext+otpauth 协议回调 | `?uri=ext+otpauth://...` | label/secret 预填 |
| P1-16 | pendingOtpauth 右键菜单消费 | seedKeys 注入→加载 | 预填且键被清除 |
| P1-17 | 删除二次确认 | 点删除→确认 | 条目消失 |
| P1-18 | secret 揭示（masked） | 点 🔑 | 弹前 4+后 4 字符 |

### Phase 2 — options（约 22 项）

| # | 功能点 | 验证方法 | 判定 |
|---|---|---|---|
| P2-1 | 全页渲染 | snapshot | 7 个卡区块齐全 |
| P2-2 | 添加条目 | 表单 fill→保存→读列表与 storage | 落库且渲染 |
| P2-3 | 编辑条目（改 issuer） | 编辑→改→保存 | 列表更新 |
| P2-4 | 删除条目 | 同 popup | 消失 |
| P2-5 | 创建分组 | 输入名称→创建 | 列表出现 |
| P2-6 | 分组指派条目 | 编辑表单选分组 | groupIds 更新 |
| P2-7 | 删除分组级联 | 删除分组 | 条目 groupIds 清理（I64） |
| P2-8 | 启用加密（Argon2id 真跑） | 设口令→启用→读 storage | vault 变密文（kdf 字段）+ security 键存在 |
| P2-9 | 锁定页渲染 | reload（无 DEK） | LockScreen 出现 |
| P2-10 | 口令解锁 | 输入口令→解锁 | 条目可见 |
| P2-11 | 错误口令拒绝 | 输错→解锁 | 中文错误且不解锁 |
| P2-12 | 更换口令 | 换口令→锁定→新口令解锁→旧口令拒绝 | 语义正确 |
| P2-13 | 移除口令守护缺失 | 读安全卡 | "口令不可移除"文案（C18） |
| P2-14 | PRF 入口能力探测 | Chrome UA 下读按钮态 | 可见可用（C17） |
| P2-15 | 剪贴板自动清空开关+Firefox 提示 | 读文案+toggle | 文案含"仅 Chrome/Edge"（I8） |
| P2-16 | 弹窗关闭延迟设置 | 改 spinbutton→读 settings | 持久化 |
| P2-17 | 备份模式 keepN 保留（I70） | keep→overwrite→keep | N 不回退 |
| P2-18 | 备份导出下载 | 立即备份→waitForEvent(download) | 收到 .totpbackup |
| P2-19 | 浏览器同步开关+状态 | toggle→读状态条 | 状态显示 |
| P2-20 | 云同步 5 后端字段+切换清空（M19/I11/I12） | 逐后端切换读字段 | 字段差异化+清空 |
| P2-21 | WebDAV 云同步 mock fetch 闭环 | mock fetch→立即同步→读状态 | 成功/失败路径文案 |
| P2-22 | URI 文本导入 | 导入卡选 URI 格式→粘贴→报告 | 落库计数正确 |

### Phase 3 — 跨切面（约 8 项）

| # | 功能点 | 验证方法 | 判定 |
|---|---|---|---|
| P3-1 | RFC 6238 全 6 向量（SHA1 8位） | 页内 WebCrypto recompute | 6/6 匹配 |
| P3-2 | RFC 6238 SHA256/SHA512 t=59 向量 | 同上 | 匹配 |
| P3-3 | 5 匹配策略（baseDomain/host/exact/startsWith/regex） | 页内直调 entryMatchesUrl 等价逻辑或逐 URL 断言 | 逐条正确 |
| P3-4 | chrome-mv3 manifest | 读文件 JSON | 8 权限+SW+popup/options |
| P3-5 | firefox-mv2 manifest | 同上 | gecko.id+protocol_handlers |
| P3-6 | contextMenus 注册审计 | background 加载读 __calls | create 被调用（C11） |
| P3-7 | 剪贴板 alarm 调度审计 | 通知 schedule→读 __calls/alarms | create 被调用（S5 路径） |
| P3-8 | 图标推荐气泡 | 表单 retype issuer=github → 等 700ms | 气泡出现（上游 watch 路径） |

## 执行纪律

- 每 cell：bootstrap → 复用/新建 tab → evaluate 驱动交互（Vue 响应式经 dispatchEvent 触发）→ 返回结构化结果
- Playwright locator click 在本产物上会超时（上轮已证）→ 统一用 `evaluate(el.click())`
- Argon2id（hash-wasm WASM）真跑约 1-2s，在 3s 预算内，必要时 waitForTimeout 补齐
- 每阶段结束立即记录 pass/fail，fail 不阻塞后续（记录后继续）
- 全部结果落 `docs/review/2026-09-15-e2e-verification-report.md`

## 产物与提交

- 增强版注入脚本：`scripts/inject-test-shim.mjs`（读源模板写入构建产物，测试专用）
- 报告：`docs/review/2026-09-15-e2e-verification-report.md`
- git：方案+报告+注入脚本各一个 commit
