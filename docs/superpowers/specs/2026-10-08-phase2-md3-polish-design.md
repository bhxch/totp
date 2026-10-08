# Phase 2：MD3 合规收口与抛光批次设计

日期：2026-10-08
状态：已报批（待 spec 审阅）
前置：Phase 1（`2026-10-08-ui-compact-service-fixes-design.md` §2.1–§2.11）已落地 main（d8abd29..ba7bf63）；本批实施其 §2.12 挂账清单 + 执行期新增挂账
覆盖：token 存量替换、组件能力与 a11y、图标体系、宿主与文档、Rust nit 五组

## 0. 范围原则

- 全部为 Phase 1 已定性项的收口，无新功能；
- 真机回归依赖 Phase 1 人工清单（`docs/e2e/2026-10-08-md3-compact-checklist.md`）先行或并行建立基线；
- 不含：Rust 诊断本地化（failed detail 英文界面问题——Rust i18n 成本高收益低，按需另立）、CodesPage 列表层真机核对（依赖用户口令，随人工清单）。

## 1. 决策表（含推荐意见，报批时可改）

| # | 决策点 | 推荐 | 备选 |
|---|--------|------|------|
| D1 | 图标 SVG 化范围 | ＋(MdFab)/⠿(拖拽把手)/✕(MiniApp 隐藏钮)/×(IconPicker 删除钮) 换 Material Symbols SVG path，新建 `iconPaths.ts` 注册表（LockScreen `lockIcons.ts` 同模式）；**∧/∨ 保留文本字符**（逻辑符号语义，Material 无标准对应图标，系统字体渲染即正确表达） | 全换（含自绘 logic path，不推荐） |
| D2 | MdCheckbox label 字号 | 保持 body-medium(14) 加注释留档（与全库按钮 label 14 一致的桌面紧凑口径；MD3 基准 16 记 deviation） | 改 body-large |
| D3 | QrSheetDialog max-width 920px | 保留 + 头注释裁定（多码拼版特例，560dp 上限不适用） | 收窄 |
| D4 | failed detail 本地化 | 不做，文档留档（现状：detail 为 Rust 中文诊断直透 en 界面） | Rust i18n |
| D5 | state-layer 混入基色 | 统一 on-surface（EntryForm `.recommend-item` 现为 primary 基色，一并收敛） | 保留 primary |
| D6 | elevation token | generate.mjs 生成 `--md-sys-elevation-{level0..level5}` 六档（M3 官方阴影值），替换存量阴影字面量 | 仅加 token 不替换 |

## 2. 改动设计

### 2.1 T1 主题层收口

1. **state-layer 存量替换**：Phase 1 产的 `--md-sys-state-layer-hover/pressed` 已在新增代码生效；存量约 20 处 `color-mix(... 8%/12%, transparent)` 字面量全量替换为 `var(--md-sys-state-layer-hover/pressed)`（含色值混入形态按 D5 统一）。rg 清点 + 逐文件替换。
2. **elevation token**（D6）：generate.mjs `base` 增 elevation 块（level0=none、level1=`0 1px 3px 1px rgba(0,0,0,.15)` 等 M3 官方值）；存量阴影字面量（MdCard elevated、ToastHost、TagFilterRow 气泡、MiniApp 等）替换引用。重跑 theme 生成。
3. **auto 模式首帧防闪**：三端 html 内联补 `@media (prefers-color-scheme: dark){ html[data-mode='auto']{background:#1b1b1f} }`（Phase 1 终审 Minor-7）；mini.html light 值 `#fff`→`#fefbff`（1/255 色差收口）。多 palette 首帧色差维持现状（首帧仅默认种子，CSS 装载后接管——Phase 1 已裁定）。

### 2.2 T2 组件能力与 a11y

1. **MdChip `removable` + close 槽**：加 `removable` prop 与内部 close 按钮（close 触控目标 ≥44，emit `remove`）；IconPickerDialog/IconPackImportDialog 自绘 chips 全部替换为 MdChip（删自绘样式与命中 hack——Phase 1 的 `.picker-chip > button z-index` 修复随宿主消亡）。
2. **MdMenu/MdSelect 弹层共享样式**：抽 `md/menuSurface.ts`（或共享 CSS 文件）：min-width 112、padding 8px 0、容器 surface-container、item 48px 基线；两组件引用同一份。
3. **a11y 补齐**：MdSelect listbox 键盘高亮绑 `aria-activedescendant`；MdDialog headline 加 id + `aria-labelledby`。
4. **disabled hover 豁免**：MdTextField/MdSelect 的 hover 状态层选择器补 `:not([class*--disabled])`。
5. **菜单项 48 收口**：CloudCard `.menu-item` 36→48px（走共享 menuSurface 基线）。
6. **checkbox 列表根治**：`.md-checkbox` label 行 `min-height: 48px`（纵向列表命中带重叠根治，Phase 1 注释标注的 Phase 2 项）。
7. **hint 能力**：MdTextField/MdSelect 加可选 `hint` prop（常态 supporting text，body-small on-surface-variant；error 时被 error 文本取代）。
8. **MdCard elevated 阴影双层**：M3 level-1 双层阴影（`0 1px 2px 0 + 0 1px 3px 1px`）。
9. **wait_running 末次 sleep 修正**（Rust nit）：末次轮询失败后不再 sleep 即返回（预算精确 5s）。

### 2.3 T3 图标体系（D1）

- 新建 `packages/ui/src/components/iconPaths.ts`：`add`/`drag_indicator`/`close`/`visibility`/`visibility_off` path 数据（visibility 系从 `lockIcons.ts` 迁入合并，LockScreen 引用点同步迁移）。
- 替换点：MdFab `＋`→add、CodesPage `⠿`→drag_indicator、MiniApp `✕`→close、IconPicker `.chip-remove` ×→close（随 2.2.1 收口）。
- **∧/∨ 保留**（D1），TagFilterRow 注释留档语义取舍。
- 完成后全仓 rg 文本图标字符清点（除 ∧/∨ 与注释）。

### 2.4 T4 宿主与文档

1. **空态统一**：新建 `EmptyState.vue`（icon 可选 + 文案 + 统一 padding/字号/色），替换 CodesPage/TagManagerDialog/QuickCodesPanel+MiniApp 四处空态。
2. **托盘菜单 i18n**（Rust）：`setup_tray` 读当前 locale 取词（经既有 i18n bundle 或 Rust 侧最小 zh/en 映射表）；locale 变更时重建菜单。范围仅「显示主窗口/退出/复制 MCP 连接信息」+ tooltip。
3. **QrSheetDialog 920px 裁定注释**（D3）。
4. **spec 勘误**（Phase 1 文档）：contextMenu 归因（Boolean casting 实证）+ §2.9 mode-toggle 行补勘误注（40px 已在终审修复波落实）。

### 2.5 测试与验收

- 单测：MdChip removable/remove 事件、hint 渲染、aria 属性断言、EmptyState、token 存在性（elevation 系）、托盘 i18n 的 Rust 映射纯函数；
- 回归：全量 `pnpm -r test` + `typecheck`、cargo 三连、双浏览器构建、覆盖率不低于 68.19/47.35；
- 真机：并入 Phase 1 人工清单执行（新增条目：菜单项 48 观感、SVG 图标观感、托盘菜单语言）。

### 2.6 提交划分（预计 6-8 笔）

1. `feat(ui)` elevation token + state-layer/elevation/首帧存量替换（T1）
2. `feat(ui)` MdChip removable + IconPicker 系 chips 收口（T2.1+T3 部分）
3. `refactor(ui)` 菜单弹层共享样式 + menu-item 48 + disabled hover（T2.2/2.4/2.5）
4. `feat(ui)` a11y 补齐 + hint + MdCard 阴影（T2.3/2.7/2.8）
5. `refactor(ui)` iconPaths 注册表 + 文本图标替换（T3）
6. `feat(ui)` EmptyState 统一空态（T4.1）
7. `feat(desktop)` 托盘 i18n + wait_running nit（T4.2+T2.9）
8. `docs` QrSheet 裁定 + spec 勘误（T4.3/4.4）

## 3. 不做清单

- Rust 诊断本地化（D4）；CodesPage 列表层真机核对（人工清单）；∧/∨ SVG 化（D1 保留）；多 palette 首帧感知（维持默认种子首帧）。
