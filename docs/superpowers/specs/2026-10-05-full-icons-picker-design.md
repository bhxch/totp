# 设计：内置图标库全量化 + 选择器标签与来源筛选

日期：2026-10-05
状态：已评审（对话内确认，含两轮修订）

## 背景与目标

现状（2026-09-22 裁定后）：内置库为 Simple Icons 精选 **218 项**（CC0 单色 path）+
58 条别名；`IconPickerDialog` 仅显示内置图标、格子无可见标签（仅 title/aria-label）；
图标包 zip 导入后图标落库（stored）但**无任何入口可选、不可管理**——用户无法使用、
无法区分来源、无法删除。

目标：

1. 保持 Simple Icons CC0 路线与上游下架跳过机制，**全量收录**（上游 16.31.0 实测
   3460 项）；精选 218 项同步打包不变，全量集懒加载。
2. 选择器网格显示**可见标签**（图标 + 下方文字）。
3. 图标**来源筛选**：内置 / 上传 / 各导入包（按包独立，含整包删除）。
4. 包导入改为**对话框流程**：自定义包名（预填 zip 文件名）+ 已有包一键填入覆盖。
5. 服务商**自动推荐纳入自定义包图标**（builtin 与 stored 混排）。

本设计显式推翻上版「218 项 / <300KB」体积约束；CC0 单色、单色使用、商标免责、
接受上游下架的合规路线不变。

## 现状与相关代码

- `scripts/gen-builtin-icons.mjs` → `packages/core/src/icons/builtin.json`
  （218 项 + 58 别名，232KB；白名单 + 上游下架警告跳过 + 别名悬空校验）。
- `packages/core/src/icons/registry.ts`：`getBuiltinIcons` / `suggestIcons`
  （normalize + 莱文斯坦阈值 + 包含命中）/ `normalizeIssuer`；`IconRef`
  （builtin/stored/url）。
- `packages/ui/src/iconStore.ts`：`Record<string, string>` id→dataUrl，单键
  `'icons'` 整体 JSON 持久化；`iconView(ref, icons)` 同步解析 builtin path，
  URL 缓存走 `urlcache:` 前缀。
- `packages/ui/src/iconImport.ts`：`importIconPackZip(bytes, icons)`——png 按
  `normalizeIssuer(文件名)` 落库，不产生任何条目引用（现状缺口，本设计修复）。
- `packages/ui/src/components/IconPickerDialog.vue`：仅 builtin 网格（44px 格，
  无标签），搜索复用 `suggestIcons`。
- `packages/ui/src/components/EntryForm.vue`：服务商输入防抖推荐气泡
  （`suggestIcons(v, 3)`）；图标包 zip 选定后立即导入（无命名环节）；
  `applyBuiltinIcon` 只产生 builtin 引用。

## 设计

### 1. 数据管线：精选同步 + 全量懒加载

- **精选集不变**：`gen-builtin-icons.mjs` 白名单逻辑、`builtin.json`（218 + 别名）
  继续同步打包，供列表渲染、推荐、`iconView` 同步路径。
- **新增全量产物**：同一脚本追加生成 `packages/ui/src/assets/icons-full.json`：
  `{ icons: Record<slug, { id, title, path }> }`，simple-icons 全量 3460 项
  （**含**精选 218，同 id 同 path）。预估约 3.5MB；脚本断言 <5MB 防上游膨胀。
  放 ui 包：纯资产由 Vite/WXT `?url` 导出发出，扩展与桌面端（均 Vite 系）同一
  按需 fetch 机制；core 保持无异步。
- **core 注册表**：新增 `registerIcons(icons: BuiltinIcon[])`——合并进 `ICONS`
  map，幂等；此后 `getBuiltinIcons` / `iconView` / `suggestIcons` 自然覆盖全量，
  同步签名不变。
- **懒加载器**（ui 层，如 `fullIcons.ts`）：`ensureFullIcons()` 缓存 promise
  一次性 fetch + `registerIcons`；失败清缓存允许重试。模块级响应式标志
  `fullIconsReady`；依赖 builtin path 解析的计算属性（OtpListItem 图标等）将其
  纳入依赖——全量注册后非精选 builtin 引用从「首字母回退」自动补渲染真图。
- **推荐区候选集**：issuer 模糊推荐（EntryForm 气泡与 picker 顶部推荐区）的
  **builtin** 候选用同步精选集（不依赖全量加载完成）；stored（包/上传）候选
  始终参与（修订二，见 §5）；全量加载完成后，推荐与搜索均自然覆盖全量
  （registerIcons 合并后单一注册表）；加载完成前 builtin 推荐候选即精选集，
  不依赖加载。中文别名仅作用于精选
  （全量集不含别名，非精选品牌按英文 title 匹配）。

### 2. iconStore 包注册表（按包独立来源）

- 新增存储键 `'iconpacks'`：`Record<normKey, { name: string; iconIds: string[] }>`；
  `normKey = normalizeIssuer(包名)` 作**身份**（"Aegis"/"aegis" 同包），`name` 为
  **显示名**（保留用户输入原名，重导同名时更新）。
- **来源归属为派生判定，零迁移**：id ∈ 某包 `iconIds` → 归该包；否则（手动上传
  的 uuid 键、历史孤儿导入）→ 归「上传」桶。不写任何迁移数据。
- **同名重导 = 整包替换**：写入新集合前，删除旧 `iconIds` 中不在新集合的图标；
  都在的覆盖内容；注册表 `iconIds` 收敛为新集合全集。
- **删除整包** `removePack(normKey)`：移除该包全部图标 + 注册表条目；引用悬空的
  条目走现有回退（首字母），删除前由 UI confirm。
- 持久化：包注册表独立 `persistPacks()`（与 `'icons'` 键分开写，同一 adapter）。
- API 增量：`packs`（reactive 只读视图）、`upsertPack`、`removePack`。

### 3. 导入对话框 IconPackImportDialog（修订一）

选 zip 后不再立即导入，先弹对话框（复用 MdDialog 模式）：

- **包名输入**：预填 zip 文件名去扩展名，可改；空白名禁用确认。
- **已有包快捷填入**：下方列出包注册表既有显示名按钮，点击一键填入该名——确认
  后走「同名整包替换」实现覆盖。
- **覆盖提示**：输入 normalize 后命中既有包 → 输入框下提示「将覆盖已有包“X”」，
  防近似重复包。
- 职责边界：对话框纯收集名字（props：open / defaultName / existingPacks /
  busy / error；emit confirm(name) / close）；导入执行在 EntryForm（持有
  iconStore），busy/error 回传对话框内呈现。
- `importIconPackZip` 签名扩展：`(bytes, icons, pack: { name: string })`，
  返回增加 `packName`；内部完成落库 + `upsertPack`。

### 4. IconPickerDialog 改版

- **来源筛选 chips**：`全部 / 内置 / 上传 / <各包显示名…>`；空桶不显示（无上传
  图标则无「上传」，无导入包则无包 chip）。包 chip hover 出 ×（confirm 后
  `removePack`）。
- **可见标签**：cell = 图标 + 下方单行省略文字；builtin → title，stored → id
  （normalize 形态，不做美化）。cell 加宽（约 72px）。
- **搜索跨来源**：统一走演进后的 `suggestIcons`（§5，extra 传 stored id）——
  builtin（全量加载后含 3460 + 精选别名）与 stored id 同管线排名，再按当前
  chip 过滤。
- **懒加载态**：打开对话框触发 `ensureFullIcons()`；加载中 spinner，失败显示
  重试；未加载完成时「全部/内置」先显示精选 218 + 加载指示，完成后自动补全。
- **stored 可选**（修复缺口）：选中 stored → `IconRef{kind:'stored', id}`；
  builtin → `{kind:'builtin', id}`（含非精选）。
- **大列表窗口化**：手写行窗口化（滚动容器可视区间 + overscan，cell 定宽定高
  便于列数推算），无新依赖，复用现有 max-height 滚动容器。

### 5. core suggestIcons 演进（修订二）

- 返回类型演进为 `IconSuggestion = { id, title, source: 'builtin' | 'extra',
  path?: string }`（builtin 项带 path；直接改签名，调用点仅 2 个组件 + 测试，
  不留双 API）。
- 新增可选参数 `extra?: Array<{ id: string; title?: string }>`：与内置
  id/title/别名走同一 normalize + 莱文斯坦阈值 + 包含命中管线，合并排名。
- **同距离 tie-break：builtin 优先**（精选质量更稳），其次 id 字典序（现状）。
- ui 侧传入 stored 图标 id（本身已 normalize）作为 extra：EntryForm 推荐气泡、
  picker 推荐区均含 stored 候选；上限维持 3。
- `BuiltinIcon` 类型保留（builtin 集合形状不变）。

### 6. EntryForm 连带改动

- 导入入口：选 zip → 存 bytes + defaultName → 打开 `IconPackImportDialog`；
  confirm 后导入，沿用 `packMessage` 显示导入/跳过统计，错误留在对话框内。
- 推荐气泡 mixed 渲染：builtin 候选出 svg path、stored 候选出 `<img>`
  dataUrl，均带 title；选中走 `applyIcon(suggestion)` 按 source 产生对应
  IconRef（现 `applyBuiltinIcon` 扩展）。
- `props.icons` 组装形状变化：App 层（extension options/popup、desktop
  MiniApp）需同步传入 packs/注册表视图——**store.shape/导出快照守卫同步更新**
  （历史坑位）。

### 7. i18n

新增词条 zh/en 同步：chips 标签、对话框文案（标题/包名/快捷填入/覆盖提示/
确认/取消）、加载与重试、删除整包确认等。

## 验收

- gen 脚本幂等重跑 diff 为零；`icons-full.json` 存在且计数 = 上游图标全集；
  精选仍 218 项 + 58 别名；全量体积断言 <5MB。
- 单测：core `registerIcons` 幂等 / `suggestIcons` extra 混排与 tie-break /
  全量加载后 registry 覆盖；iconImport 包注册表 upsert 与同名替换（旧 id
  清理）；iconStore `upsertPack`/`removePack`/派生来源；对话框（预填、快捷
  填入、覆盖警示、空名禁用、confirm 载荷）；picker（chips 过滤、跨源搜索、
  标签渲染、懒加载态、stored 选择、窗口化区间）；EntryForm 导入流程与推荐
  气泡 mixed 渲染。现有 icon 相关测试全量回归。
- 真机清单：导入 aegis-icons zip → 命名对话框预填并可改 → 快捷填入既有包覆盖
  → 选择器按包筛选出带标签图标 → 服务商输入推荐出包图标 → 删除整包后引用条目
  回退首字母 → 重启后包归属保持 → 选择器首开加载流畅（本地资产）。

## 非目标

- URL 图标进选择器（urlcache 为条目级缓存，非可选来源）。
- 彩色官方 logo、运行时网络拉取图标集。
- stored 图标显示名美化（label 用 normalize id）。
- gzip/DecompressionStream 压缩传输（全量体积可接受后再议）。
- 内置集分类浏览、包内单个图标删除、包重命名。
