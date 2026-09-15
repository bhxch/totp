# 前端重设计:Material Design 3 + 多页导航 + 主题系统 — 设计文档

- 日期:2026-09-15
- 状态:已评审通过(设计对话逐节确认),待实现
- 关联:[2026-09-13-totp-tool-design.md](./2026-09-13-totp-tool-design.md)(总 spec)、docs/review/ 下 E2E 与代码评审报告

## 1. 背景与目标

现状:`packages/ui` 的 `VaultManager.vue` 将分组管理、条目列表、搜索、表单、安全、浏览器同步、备份、云同步、导入九大功能堆在单页;全仓库无路由、无 UI 库、无 CSS 变量,颜色全部硬编码(`#fff`/`#222`/`#d9534f` 等),不支持深色模式与主题定制。

目标:

1. 按 Vue 3 最佳实践重构信息架构:功能分区成页,不再堆单页;视觉采用 Google Material Design 3(MD3)。
2. 支持深色 / 浅色 / 自动(跟随系统)三种主题模式。
3. 支持主题色设置:预置色板 → 构建期生成全套颜色方案 → CSS 变量配置。

覆盖范围:桌面主窗口、桌面 mini 窗口、扩展 popup、扩展 options 四个入口。数据层(`packages/core`、`packages/ui/src/store.ts`、`useOtpCodes`)与安全语义零改动。

## 2. 关键决策

| # | 决策 | 否决项及理由 |
|---|---|---|
| D1 | **MD3 令牌 + 自建组件**:`@material/material-color-utilities` 仅作 devDependency 生成色彩方案,组件按 MD3 规范自建 | Vuetify 3(体积大,popup 敏感;默认样式主导视觉,与现有组件冲突大)、@material/web(Vue 集成层薄,深度定制繁琐) |
| D2 | **5 页信息架构**:验证码 / 导入 / 同步 / 安全 / 设置 | 6 页方案(条目管理独立成页,跨页跳转多)、4 页方案(单页密度高,违背拆页初衷) |
| D3 | **预置色板静态生成**:10 个种子色构建期生成,运行时零调色依赖 | 运行时调色(+30KB 依赖、变量动态注入)、双轨制(两套机制维护成本) |
| D4 | **vue-router@4 仅用于桌面主窗口与扩展 options**(hash history);popup 与 mini 不进 router | 全入口上 router(popup 体积与启动速度无谓受损)、纯状态切页(深链/前进后退无着落,非最佳实践) |
| D5 | **主题偏好持久化走 AppSettings**(现有类型化合并模式自动兜底新字段),另维护 localStorage 镜像做首帧防闪 | 单独存储(多一套读写路径)、仅靠异步设置(首帧闪错主题) |

## 3. 总体架构

新增代码全部落在 `packages/ui`(桌面与扩展共享层),不新建包:

```
packages/ui/src/
├── theme/                    # 主题系统(§4)
│   ├── generate.mjs          # 构建期脚本:种子色 × 明暗 → tokens.css
│   ├── tokens.css            # 产物,提交入库
│   ├── useTheme.ts           # 组合式函数:读/写 settings,写 data-mode/data-color
│   └── palette.ts            # 色板清单(10 种子色 id/色值/名称)、默认值常量
├── components/md/            # MD3 基础展示组件,无业务逻辑(§6)
├── pages/                    # 新增:五个页面 + 导航壳(§5)
└── components/               # 现有组件改造(§7)
```

- 入口接线:桌面 `App.vue` 与扩展 `options/App.vue` 变为「LockScreen 覆盖层 + NavigationShell(router-view)」;popup 与 mini 保持现状结构,仅 token 化换肤。
- 路由统一 `createWebHashHistory`(扩展 options 只支持 hash,Tauri 自定义协议下 hash 同样最稳)。

## 4. 主题系统

### 4.1 色板(种子色)

全部取自 Material 色阶中对比度达标的深种子色,保证浅/深两套方案色调跨度充足:

| id | 种子色 | 定位 |
|---|---|---|
| `blue` | #0B57D0 | **默认**,Google Blue,安全工具的稳态色 |
| `indigo` | #4355B9 | 冷静专业 |
| `teal` | #00796B | 清爽,与「验证通过」语义呼应 |
| `green` | #2E7D32 | 安全/通过语义 |
| `amber` | #9A6A00 | 暖调、可读性优先的暗琥珀 |
| `orange` | #E8590C | 高辨识度暖色 |
| `red` | #C5221F | 强警示(仅作主题色,错误色始终独立) |
| `violet` | #6750A4 | MD3 官方 baseline 种子 |
| `pink` | #B32784 | 高饱和点缀 |
| `slate` | #5F6368 | 近中性,单色克制风 |

### 4.2 生成管道

`packages/ui/src/theme/generate.mjs`:对每个种子色 × 明/暗调用 material-color-utilities(`theme/sourceColor` → tonal palette → scheme)生成完整 MD3 色彩方案,写入 `tokens.css` 并提交入库(CI 与他人克隆无需跑脚本;改色板时手动重跑)。error 系列不随种子变化,统一 MD3 基线错误色。

### 4.3 Token 集

每种子 × 明暗两套,同名不同值,命名 `--md-sys-color-*`,34 角色/套:

- primary / on-primary / primary-container / on-primary-container
- secondary、tertiary、error 各自同构 4 件套
- surface / surface-dim / surface-bright / surface-container-lowest / -low / surface-container / -high / -highest / on-surface / on-surface-variant
- outline / outline-variant / inverse-surface / inverse-on-surface / inverse-primary / shadow / scrim

组件样式**只允许**引用这些变量,禁止硬编码色值(含 rgba 装饰色,用 surface/outline 变量或既有 token 派生)。

### 4.4 运行时切换(零依赖)

纯 CSS 属性选择器矩阵,JS 只改 `<html>` 上的 `data-mode` / `data-color`:

```css
[data-color="blue"][data-mode="light"] { /* 蓝浅色 40 变量 */ }
[data-color="blue"][data-mode="dark"]  { /* 蓝深色 40 变量 */ }
@media (prefers-color-scheme: light) {
  [data-color="blue"][data-mode="auto"] { /* 蓝浅色 */ }
}
@media (prefers-color-scheme: dark) {
  [data-color="blue"][data-mode="auto"] { /* 蓝深色 */ }
}
/* × 10 种子色 */
```

### 4.5 首帧防闪(FOUC)

设置异步加载(桌面 AppData JSON、扩展 chrome.storage),首帧可能拿不到主题。机制:

- `useTheme` 切换主题时,同步写 localStorage 镜像(key `themePref`,内容 `{mode, color}`);
- 各入口 `index.html` head 内联数行脚本:启动瞬间读镜像并设置 `data-*` 属性;异步设置加载后以正式设置为准校正(不一致时以 AppSettings 为准并回写镜像)。

### 4.6 设置字段与 useTheme

`AppSettings`(packages/core `vaultStore.ts`)新增,走现有类型化合并兜底:

- `themeMode: 'light' | 'dark' | 'auto'`,默认 `'auto'`
- `themeColor: string`(种子色 id,必须是 palette 内合法值,非法回退 `'blue'`),默认 `'blue'`

`useTheme()` 暴露:`mode`(ref,双向)、`color`(ref,双向)、`resolvedMode`(computed,auto 解析结果,供设置页展示当前生效模式)。写入时同时 `commitSettings()` 与 localStorage 镜像。

## 5. 页面设计

**导航壳 `NavigationShell.vue`**:桌面主窗口与扩展 options 同构复用。宽窗口(≥600px)MD3 Navigation Rail(左侧竖排 5 目的地);窄窗口自动切顶部 MD3 Tabs。路由:`/codes`(默认重定向)、`/import`、`/sync`、`/security`、`/settings`。LockScreen 仍为全屏覆盖层,不受路由影响。popup「设置」入口跳 options(带 hash 深链)。

| 页面 | 内容(现组件去向) |
|---|---|
| **验证码** `/codes` | 条目列表 + SearchBar;分组从独立卡片降为列表上方一行筛选 chips(全部/各分组)+「管理分组」入口开对话框(建/改名/删,即现「分组管理」卡);「＋添加」为 MD3 FAB,EntryForm 装入 MD3 Dialog;reveal 模态、右键菜单分别换 MD3 Dialog / Menu 风格;置顶/复制/reveal/右键/HOTP 复制递增语义不变 |
| **导入** `/import` | ImportCard 整卡迁移,MD3 分区:映射方案管理 / 文件导入 / 批量 URI |
| **同步** `/sync` | BackupCard + CloudCard + SyncCard 三区块同页分置(本地备份 / 云同步 / 浏览器同步),同域合页、区块分明 |
| **安全** `/security` | SecurityCard:加密开关、换口令、passkey、DPAPI、剪贴板自动清除 |
| **设置** `/settings` | **外观区(新)**:主题模式三选(MdSegmentedButton:自动/浅色/深色)+ 主题色板选择器(10 色圆点,点击即换、所见即所得,当前选中带勾);通用区:失焦自动隐藏(桌面)、popup 关闭延迟与 URL 过滤(扩展);各设置项按平台可用性显隐,复用现有 platform 缺省即不渲染的模式 |

桌面主窗口 header 现有「失焦自动隐藏 / 隐藏到托盘」迁入设置页与 Rail 底部(隐藏到托盘保留为 Rail 底部动作)。

## 6. MD3 基础组件集

新建 `packages/ui/src/components/md/`,展示组件、无业务逻辑,样式只引用 `--md-sys-color-*`:

| 组件 | 变体 | 使用处 |
|---|---|---|
| MdButton | filled / tonal / outlined / text;MdIconButton | 全局 |
| MdCard | outlined / elevated | 各页区块 |
| MdDialog | 基础对话框(遮罩+surface 容器) | EntryForm、reveal、分组管理、确认删除 |
| MdSwitch / MdCheckbox | — | 设置页、SearchBar 搜 secret、各卡片开关 |
| MdTextField | filled 风格,支持 label/error | EntryForm、SearchBar、各表单 |
| MdMenu | 锚定定位菜单 | 右键菜单 |
| MdFab | 小型 | 验证码页「添加」 |
| MdChip | assist/filter | 分组筛选行 |
| MdList / MdListItem | — | 条目列表、设置项列表 |
| MdNavigationRail / MdTabs | 响应式切换 | NavigationShell |
| MdSegmentedButton | 单选 | 主题模式三选 |

## 7. 现有组件改造清单

| 现状 | 去向 |
|---|---|
| `VaultManager.vue`(289 行,九功能堆叠) | **拆解散场**:条目列表逻辑归 `pages/CodesPage.vue`;分组管理提为 `GroupManagerDialog.vue`;六卡片按 §5 迁入各页;列表/搜索/置顶/reveal/右键/HOTP 行为语义不变 |
| `OtpListItem.vue` / `SearchBar.vue` / `LockScreen.vue` / `EntryForm.vue` | 样式 token 化 + 换用 md/ 组件,逻辑不动 |
| 桌面 `App.vue` | 收敛为:平台适配器(platform 对象,不动)+ LockScreen/NavigationShell 接线 |
| 扩展 `options/App.vue` | 同构 NavigationShell + router-view |
| 扩展 `popup/App.vue`、桌面 `MiniApp.vue` | 不进 router,仅 token 化换肤;行为与体积敏感度保持 |
| `store.ts` / `useOtpCodes` / 各 platform 类型 | 零改动(仅 AppSettings 增两字段) |

## 8. 测试策略

- **新增**:generate.mjs 产物校验测试(§4.3 清单 34 变量每套齐全、明暗成对、10 种子完整;关键角色对 surface 对比度抽查);`useTheme` 属性写入与 localStorage 镜像;`loadSettings` 对 `themeMode/themeColor` 的类型兜底与非法色回退。
- **存量**:17 个组件测试保持通过;断言以行为为主,个别因 DOM 结构调整的选择器更新。测试中主题相关断言只依赖 CSS 变量存在性,不依赖具体色值。
- **验收**:每入口 typecheck + vitest;popup 打包体积对比基线(不允许因 md/ 组件显著回退);真机过一遍四入口 × 明暗 × 两种子色。

## 9. 实施顺序(每步可独立提交)

1. **主题底座**:generate.mjs + tokens.css + palette.ts + useTheme + AppSettings 两字段 + FOUC 内联脚本;全局硬编码色值替换为 token。
2. **md/ 基础组件集**:按 §6 逐个实现,配组件测试。
3. **布局壳 + router + 桌面 5 页拆分**:NavigationShell、五个 pages、VaultManager 拆解。
4. **扩展侧**:options 同构接入;popup / mini token 化换肤。
5. **测试补齐与清理**:新增测试、存量修正、删除散场代码、体积核对。

## 10. 边界与非目标

- 不做运行时动态取色、自定义种子色输入(预置色板之外的需求留待后续)。
- 不做 MD3 动态色(Material You 壁纸取色)、表达层动效规范全套(仅组件级标准过渡)。
- 不做 i18n、不改数据层/加密/同步语义。
- popup / mini 不进 router,不上 Navigation(Rail/Tabs)。
