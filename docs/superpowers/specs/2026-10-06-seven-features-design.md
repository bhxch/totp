# 七项特性批次设计（P1–P6）

日期：2026-10-06
状态：已报批（P1–P5 设计 + P6 spike 计划获口头批准，待 spec 审阅）
覆盖需求：Aegis 图标包上限、tab 行优化、扩展端快捷新增、WinAuth 粘贴文本、Windows 安全架构、miniapp/popup 统一与条目布局重构、扩展端 pin

## 0. 背景与已确认决策

用户提出 7 项需求，拆解为 6 个子项目（P1–P6）。探索确认的关键现状：

- 图标包 500 上限在 `packages/ui/src/iconImport.ts`（`MAX_MEMBERS=500` 整包拒绝、`DEFAULT_MAX=500` store trim，另有 zip ≤10MB / 解压 ≤8MiB / 单图 ≤50KB 防炸弹预算）；`iconStore.ts` 将所有图标存单个 `icons.json`，每次 add 全量序列化。
- "tab 行"= 验证码页 `TagFilterRow.vue`（标签 chips + 任一/全部 `MdSegmentedButton` + "管理标签" chip）。
- 扩展端 background 已有两个右键菜单（选中 otpauth 文本、识别图片二维码）+ `action.openPopup()` 能力探测 + `pendingOtpauth` 预填链路。
- WinAuth 文件导入（.wauth，PBKDF2+Blowfish，DPAPI 层）已完整实现于 `packages/core/src/import/winauth.ts`；缺"粘贴文本"通道。
- Windows 侧为传统 DPAPI（CryptProtectData 包裹 DEK，附加熵 `com.totp.desktop/os-auto-unlock/dek`）+ NSIS 打包；全仓无 MSIX/AppContainer 代码；内存 DEK 槽在 `session_vaults.rs`（进程内存明文）。
- `OtpListItem.vue` 为三端共用（桌面 CodesPage、扩展 popup、MiniApp）；全仓无 toast 体系（仅页面级轻提示）。
- popup（360×480）功能多（新建表单/粘贴导入/URL 过滤/条目右键菜单），MiniApp（320×420 无边框）仅搜索+列表+pin+自动隐藏。

**用户已确认的 4 个决策**：

| 决策点 | 结论 |
|--------|------|
| P4 "tab 栏"含义 | 标签筛选 tab 行（chips + 任一/全部切换，无"管理标签"按钮），非五页导航 |
| P7 pin 含义 | pin = 点扩展图标弹 popup（对应桌面托盘弹 mini），无需常驻窗口 |
| P1 图标包上限 | 字节预算也大幅放宽（zip 50MB / 解压 64MiB / 单图 200KB），以"能进就进"为主，仅防明显炸弹 |
| P4 WinAuth 文本范围 | 对齐 WinAuth 官方源码的全部导出文本格式 |

**实施顺序**：P1 → P2 → P3 → P4 → P5 → P6（P6 spike 可提前并行）。依赖：P3 的布局与 toast 是 P4 的基础；P2 的文本解析器被 P5 复用。

---

## 1. P1 验证码页 tab 行优化

改动文件：`packages/ui/src/components/TagFilterRow.vue`（三端共用，一处改动两端生效）。

### 1.1 任一/全部切换 → 逻辑符号单击切换

- 移除 `MdSegmentedButton` 两段（"任一/全部"文字），替换为**单个 icon 按钮**。
- 组件增加 `manageable` prop（默认 true）：false 时隐藏"管理标签"入口，供 P4 快速取码面板复用同一组件（不另做精简版）。
- 按钮显示当前模式的逻辑符号：全部匹配（`tagFilterMode=all`）显示 **∧**（U+2227 LOGICAL AND）；任一匹配（`any`）显示 **∨**（U+2228 LOGICAL OR）。以文本字符渲染（系统字体覆盖充分，无需引入图标资源），字号与行内 icon 对齐。
- 单击切换 `all ↔ any`，写入 `settings.tagFilterMode`（持久化语义不变）。
- **说明气泡**：点击按钮时在按钮旁弹出小气泡，文案（zh/en 双语）：
  - all："全部匹配：条目需含所有选中标签" / "Match all: entry must have every selected tag"
  - any："任一匹配：条目含任一选中标签" / "Match any: entry must have at least one selected tag"
- 气泡关闭条件：点击气泡外任意处、再次点击按钮、切换标签选择。实现用自制 popover（`position: absolute` + 外部点击监听），不用 MdMenu（语义不符）。
- 选中标签 <2 时按钮禁用（保留现状语义，禁用时不弹气泡）。
- 保留 `aria-label`（"切换标签匹配模式"）保证可访问性。

### 1.2 管理标签 → icon 按钮 + tooltip

- "管理标签" chip 改为 icon 按钮（M3 `sell`/标签 icon），`MdTooltip` 悬浮提示"管理标签"。
- 点击行为不变：打开 `TagManagerDialog`（props/emit 不变）。

### 1.3 测试

- TagFilterRow 组件测试更新：符号渲染与模式对应、单击切换、气泡出现/外部点击折叠、<2 标签禁用、管理标签按钮触发 dialog。

---

## 2. P2 导入增强

### 2.1 图标包上限放宽 + iconStore 存储布局改造

`packages/ui/src/iconImport.ts` 常量调整：

| 防线 | 现值 | 新值 |
|------|------|------|
| `MAX_MEMBERS`（zip 成员数整包拒绝） | 500 | 65536 |
| zip 输入大小 | 10MB | 50MB |
| 解压产出预算 | 8MiB | 64MiB |
| 单图标大小 | 50KB | 200KB |
| `DEFAULT_MAX`（store 容量 trim，超出计 skipped） | 500 | 65536 |

`packages/ui/src/iconStore.ts` 存储布局改造（必要配套，否则放开后导入退化为 O(n²) 写放大）：

- 布局从单键 `icons`（id→dataUrl 大 JSON）改为**每图标独立键 `icon:<id>`**；`iconpacks` 包注册表键不变；导入路径聚合为**批量一次写**（新增 `addIcons(batch)` 类接口，循环导入改为单事务）。
- **迁移**：首次读取时若旧 `icons` 键存在且非空，拆分写入 `icon:<id>` 各键后删除旧键；迁移幂等（旧键删除后不再触发）。
- URL 图标缓存（`urlcache:` 前缀、单文件 200KB 上限）不动。
- 配额：扩展端已有 `unlimitedStorage`，桌面端为文件存储，均无容量风险。

测试：iconImport 边界用例更新（499/500/501 成员、预算边界值、单图 199KB/201KB）；iconStore 迁移用例（旧格式→新键、幂等、混合状态）；批量导入落盘次数断言。

### 2.2 WinAuth 粘贴文本导入

- core 新增 WinAuth 文本嗅探解析器（`packages/core/src/import/` 下新文件），挂入 `parsePastedText` 嗅探链；BatchPastePanel 与 EntryForm 剪贴板导入自动获得能力，UI 不需要改。
- 支持范围（**实现时对照 WinAuth 官方源码 winauth/winauth 对齐，不凭记忆猜格式**）：
  1. `otpauth://totp|hotp/...`（已有解析，不重复实现）
  2. WinAuth 导出的 Steam 条目文本（`steam://` 变体 / Steam transfer key 粘贴块），对接 core 现有 Steam OTP 模型
  3. 纯 base32 secret 行、"名称 + secret"行格式
  4. WinAuth 添加条目接受的其他粘贴格式（如 Battle.net restore XML），以源码为准圈定
- 嗅探优先级注意与现有格式的冲突（base32 行易误判，须有明确行结构特征才命中）；不确定时归入 suspect 待人工确认（沿用 BatchPastePanel 的 new/suspect/conflict 判定）。
- 现有 `.wauth` 文件导入完全不动。

测试：解析器单测（以 WinAuth 源码导出逻辑构造样例文本，逐格式断言）；嗅探冲突回归（现有各格式解析不劣化）。

---

## 3. P3 条目布局重构 + toast 体系

### 3.1 OtpListItem 新布局（Aegis 式两行）

```
┌─────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░  ← 行顶细进度条     │
│ [头像] 服务商/名称★         ← 第一行，超长跑马灯  │
│        1 2 3  4 5 6     [▣][✎][🗑] ← 第二行     │
└─────────────────────────────────────────┘
```

- **第一行**：`issuer/label`（斜杠连接；label 为空时只显示 issuer；issuer 为空同理）。pinned 星标保留在行首。头像 36px 圆形保留在左侧（跨两行）。
- **超长跑马灯**：文本溢出时启用 CSS 往返滚动（`translateX` alternate，约 8s/来回），未溢出不滚动（用 scrollWidth/clientWidth 判定）；仅第一行生效。
- **第二行**：大号验证码（保持打码 `••• •••`、双击揭示 8s 自动打回的现有机制）。
- **行顶进度条**：2px 细条，宽度 = remaining/period；保持每秒离散步进（不引入 CSS 补间，沿用性能取向）；周期最后 1/3 转红（urgent 语义保留）；**环形倒计时与剩余秒数数字取消**。
- **行内复制按钮删除**（三端统一，单击行=复制不变）。
- **操作按钮按端区分**：
  - popup、MiniApp：行内无任何操作按钮（`showQr=false` 且不再渲染编辑/删除 slot）
  - CodesPage：行内显示二维码/编辑/删除（沿用 hover/focus-within 显示；删除两击确认保留）
- 保留能力：HOTP 复制递增、多选拼版、拖拽把手/序号（`#lead` slot 不变）、右键事件上抛。

### 3.2 全局 toast 体系

- `packages/ui` 新增 `ToastHost.vue` + `useToast()` composable（模块级事件总线，App 挂载 ToastHost 单例）。
- 样式：底部居中悬浮、深色底白字、3s 自动消失、aria-live polite、支持 success/error 两态；同 key 的 toast 后到者替换先到者并刷新计时（不堆叠）。
- 接入点：
  - **CodesPage + popup**：单击条目复制、右键"复制验证码"→ toast"已复制"；复制失败 → error toast（替代现有横幅）。
  - **MiniApp 不接 toast**：保留"复制后 500ms 自动隐藏"作为反馈（窗口即将消失，toast 无意义）。
  - CodesPage batchToast（批量入库提示）迁移到新体系后删除页面级实现。

### 3.3 CodesPage 右键菜单

条目右键菜单变为：**复制验证码（新）** / 编辑 / 显示二维码 / 复制 otpauth URI / **删除（新，两击确认）** / 置顶切换。

### 3.4 测试

- OtpListItem 组件测试更新（布局结构、进度条比例、跑马灯启用条件、按钮按端显隐）。
- useToast 单测（订阅/自动消失/多 toast 排队策略）。
- 三端手动冒烟清单（桌面 CodesPage/Mini、扩展 popup/options）。

---

## 4. P4 miniapp/popup 功能统一 + pin

### 4.1 共享快速取码面板

`packages/ui` 新增 `QuickCodesPanel.vue`，**MiniApp 与扩展 popup 装配同一组件**，"popup 跟 miniapp 一样"由组件同一性保证：

- 组成：SearchBar + TagFilterRow 精简版（chips + ∧/∨ 切换，**无"管理标签"按钮**）+ 条目列表（P3 新布局）。
- props 开关：`tagRow`（开/关）、`urlFilter`（仅扩展 popup 开启）、`showOps`（恒 false）。
- **冻结**：面板内搜索与 tab 行 `position: sticky` 置顶，仅列表滚动；**主窗口 CodesPage 的搜索 + tab 行同样冻结**（对应需求"主页面的验证码页也要冻结"）。
- 锁定态不进面板（popup 显示 LockScreen、miniapp 显示"不可用"占位，宿主自理）。
- 排序沿用 `sortEntries`/`sortMiniEntries` 现口径（pinned 优先）。

### 4.2 popup 改造（`apps/extension/entrypoints/popup/App.vue`）

- 结构变为：header + QuickCodesPanel（tagRow+urlFilter 开）+ LockScreen（锁定时）。
- header：标题 + **"打开主界面"按钮**（→ `options.html#/codes`）+ 设置齿轮（→ `#/settings`，保留）。原"添加"按钮改为跳主界面新增（不再内联打开表单）。
- **功能挪移清单**：

| popup 现有功能 | 去向 |
|----------------|------|
| URL 站点过滤（四级回退过滤） | **保留**在面板（`urlFilter` prop） |
| otpauth 粘贴导入 `<details>` 折叠框 | **移除**：浏览器右键菜单（P5）承担，批量粘贴在主界面态 |
| 内联新建表单 manual/paste 双 tab | **移除常驻入口**；仅快捷新增预填时渲染 EntryForm 作为确认态（见 4.4）；BatchPastePanel 从 popup 移除 |
| 条目右键菜单（编辑/二维码/复制 URI/置顶） | **移除**：条目管理统一在主界面态（options CodesPage） |
| OtpQrDialog | 从 popup 移除 |
| "已复制"横幅 | 换成 toast（P3 体系；popup 自动关闭前 3s 内可见） |

- 已有机制保留：点击复制 + 延迟自动关窗、HOTP 递增、DEK 会话共享（`dekSession`）、storage.onChanged 双端同步。

### 4.3 MiniApp 改造（`apps/desktop/src/MiniApp.vue`）

- 装配 QuickCodesPanel（tagRow 开、urlFilter 关）。
- 保留：无边框标题栏/pin 置顶/失焦自动隐藏/复制后自动隐藏/锁定跟随/托盘锚定。tag 数据来自同一 vault store，无新增数据链路。

### 4.4 快捷新增确认态（与 P5 衔接）

- 右键快捷新增 → popup 打开 → `consumePendingOtpauth` → **popup 进入新增确认态**：渲染 EntryForm（manual tab，预填解析结果），确认落库；"更多信息/批量"引导跳主界面态。
- 这样满足"自动打开 popup、打开新增页"，又不把常驻新建入口放回 popup。

### 4.5 右键菜单直达主界面态

- background 新增顶层菜单项"打开主界面"（contexts: page/action）→ `tabs.create(options.html#/codes)`。
- 主界面态即 options（设置页）：`/codes` 落地验证码管理，`/settings` 为设置，路由现状不动。

### 4.6 测试

- QuickCodesPanel 组件测试（props 开关、冻结结构、过滤编排复用 `resolvePopupVisible`）。
- popup App 改造后 e2e（预填确认态、菜单跳转、URL 过滤保留）。
- 真机清单：popup/miniapp 双端对照检查（tab 行、冻结、无操作按钮、锁定态）。

---

## 5. P5 扩展端快捷新增

在现有 background 菜单与预填链路上补齐：

1. **data: URL 图片识别**：验证 MV3 SW `fetch("data:image/...")` 可行性（预期可行），补 `qr-decode-image` 菜单对 `data:` src 的处理测试；不可行时用 FileReader/OffscreenCanvas 回退（offscreen 文档已持 CLIPBOARD 授权，可扩展）。
2. **选中文本全格式**：`otpauth-add` 菜单不再只认 otpauth 链接——选中文本全文交给 P2 的 `parsePastedText` 嗅探；单条 → 预填确认态，多条 → 跳主界面态批量面板（popup 不放批量 UI）。
3. **自动进新增页**：确认 `consumePendingOtpauth` → 直接进入 4.4 新增确认态（渲染 EntryForm 预填），而非仅填折叠框。
4. **Firefox 回退**：`openPopup` 能力探测失败（Firefox）时发 `notifications` 引导（"已准备好添加，点击完成添加"），通知点击 → `tabs.create(popup.html?pending=1)`（popup.html 可作标签页打开，沿用 `ext+otpauth` 协议的先例）。

测试：background 消息处理单测（data: fetch、多格式文本分流）；真机 Chrome/Firefox 各一轮快捷新增全链路。

---

## 6. P6 Windows 安全架构（先 spike）

### 6.1 spike 问题清单

1. **DPAPI NG 形态覆盖**：`NCryptProtectSecret` + 保护描述符（如 `SID=S-1-...`、`LOCAL=user`、MSIX 包身份派生描述符）能否同时覆盖 MSIX 包身份与便携版自建 AppContainer 两种形态，实现比现附加熵方案更细粒度的 DEK 自动解密绑定。
2. **MSIX 打包链路**：Tauri 原生不支持 MSIX——`makeappx` 后处理 + AppxManifest（full trust）+ 签名（自签/CI 证书）是否可行、CI 成本。
3. **AppContainer 兼容性**：WebView2 在 AppContainer 内能否正常工作（决定便携版"直接可用 exe 也支持 AppContainer"的实现深度；含 WebView2 用户数据目录 ACL）。
4. **CryptProtectMemory 适用性**：`session_vaults.rs` 的 STASHED_DEK/MINI_DEK 内存槽是否值得上 `CryptProtectMemory`（同进程加密，防内存扫描；评估加密时机、锁库清槽交互、性能）。

### 6.2 spike 做法

- 文档调研（Microsoft Learn：DPAPI NG/MSIX/AppContainer/WebView2 loader）+ WinAuth 等先例源码；
- 最小 Rust 探针程序（`E:\tmp\cc` 下，不入仓）：验证描述符保护/解包、AppContainer 内启动 WebView2、CryptProtectMemory 往返；
- 产出：`docs/` 调研报告 + 推荐方案（含旧 DPAPI 数据迁移路径），**不动产品代码**，报批后才立设计。

---

## 7. 验收与提交划分

- 每个子项目独立原子 commit（feat/test/docs 分离），P1–P5 各含自动化测试；P4/P5 含真机 e2e 记录（沿用 docs(e2e) 惯例）。
- 覆盖率不低于 CI gate 现状（71/54）。
- P1–P5 全部落地后统一真机回归一轮（桌面 CodesPage/Mini、扩展 popup/options 双浏览器），再启动 P6 spike 报告评审。
