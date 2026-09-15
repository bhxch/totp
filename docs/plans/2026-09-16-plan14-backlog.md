# TOTP 工具 计划14:重设计 backlog 收尾(md 接线 / tokens 按需加载 / a11y)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 闭环 spec §11 三项 backlog——①存量原生控件接线 md 组件(消除组件层双轨);②tokens.css 按需加载(默认种子内联兜底,其余 9 种子懒加载);③md 组件 a11y 专项(focus trap/aria/方向键)。

**Architecture:** 接线按「md 组件渲染原生元素」的特性平替(button→MdButton、checkbox→MdCheckbox、text input→MdTextField、icon→MdIconButton),`<select>` 无 md 对应**保持原生**(YAGNI,不在本计划造 MdSelect);tokens 拆分为 base(无 `[data-color]` 限定的 blue 兜底块)+ palettes(9 种子),useTheme 动态 `import()` palettes chunk,未加载时由 base 兜底渲染成 blue;MdList/MdListItem 确认无自然消费场景(分组行/设置行都含交互子元素,不合法地塞进 button 型 list item),按 spec §11 预授权**删除**。

**Tech Stack:** 既有栈(vue3.5/vitest/vite),无新依赖。

**Spec:** `docs/plans/2026-09-15-frontend-redesign-design.md` §8/§10/§11 + 终审报告 deferred minors(2026-09-16 前端重设计收尾)

## Global Constraints

- 组件样式只引用 `--md-sys-color-*` 变量;MdButton 新增 danger 形态用 error token,不引入新变量。
- 存量测试语义保持:md 组件渲染原生元素,现有 `find('button')/find('input')` 断言大体存活;允许更新选择器/计数,不允许删行为断言;每个接线任务结束时 `pnpm --filter @totp/ui test` 与 `pnpm -r typecheck` 全绿。
- tokens 拆分后:base 恒被入口引入;palettes chunk 仅在 color≠blue 时动态加载;任何种子在 palettes 未加载时以 blue 值兜底显示(不允许 transparent/未定义变量);themeTokens 测试改写后仍须断言「35 角色齐全、明暗成对、auto 双 media、9 种子完整、兜底块与 blue 等值」。
- a11y 按 WAI-ARIA 1.2:dialog focus trap + Esc + 焦点还原(已有)补 Tab 循环;switch 用 `role="switch"`+`aria-checked`;textfield 错误态 `aria-invalid`+`aria-describedby`;segmented 方向键移动选中;menu `role="menu"`/`menuitem`。
- popup 体积:JS 口径不回退;初始 CSS 相对基线(29fabc0 的产物)下降(tokens 拆分收益),数值写进 commit message。
- commit 符合 Angular 规范,先 why 后 what;不动 docs/(计划完成由控制方回写 §11 闭环)。

---

### Task 1: md 组件 a11y 专项(TDD)

**Files:**
- Modify: `packages/ui/src/components/md/MdDialog.vue`、`MdTextField.vue`、`MdSwitch.vue`、`MdCheckbox.vue`、`MdSegmentedButton.vue`、`MdMenu.vue`
- Test: 对应 `packages/ui/test/md/*.test.ts` 追加用例

**Interfaces(行为契约):**
- MdDialog:open 期间 Tab/Shift+Tab 在对话框内循环(focus trap;首焦点=对话框容器,遍历可聚焦元素);已有 Esc/遮罩/焦点还原不变。
- MdTextField:`error` 非空时 input 加 `aria-invalid="true"` 与 `aria-describedby` 指向 error 文案元素 id(组件内生成唯一 id);无 error 时两属性不渲染。
- MdSwitch:内部 input 加 `role="switch"`(aria-checked 由 checkbox 原生语义映射)+ 显式 `ariaLabel` prop 落到 input 的 `aria-label`(修复「父传 aria-label 落在根 label」缺陷;不传则不加)。
- MdCheckbox:同上,新增 `ariaLabel?: string` 落到 input。
- MdSegmentedButton:根容器 `role="radiogroup"`(已拟 radio 语义保留),左/右方向键把选中移动到相邻 option 并 emit;焦点跟随选中项(roving tabindex:选中段 tabindex=0,其余 -1)。
- MdMenu:根 `role="menu"`,菜单项由消费方传——MdListItem 加 `role="menuitem"` 可选 prop?裁定:MdMenu 渲染自身 wrapper `role="menu"`,对 slot 内 `button` 不强制;**MdListItem 本任务随 Task 2 删除,不动其 role**。

- [ ] Step 1: 写失败测试(trap 循环:Tab 在末元素触发回到首元素;aria 断言;方向键改 modelValue);Step 2 红;Step 3 实现;Step 4 绿+typecheck;Step 5 commit:

```bash
git add packages/ui/src/components/md packages/ui/test/md
git commit -m "fix(ui): md组件a11y专项(dialog焦点陷阱/textfield错误aria/switch角色/segmented方向键)

why: 终审 deferred minors 指出读屏不可达与键盘导航缺口(spec §11 a11y 项)。
what: 六组件按 WAI-ARIA 1.2 补语义与键盘行为,行为契约见计划14 Task1。"
```

---

### Task 2: 删除 MdList / MdListItem

**Files:**
- Delete: `packages/ui/src/components/md/MdList.vue`、`MdListItem.vue`、`packages/ui/test/md/` 对应测试(如在 mdOverlays/mdButtons 内则摘除用例)
- Modify: `packages/ui/src/index.ts`

- [ ] Step 1: rg 确认全仓无消费(仅 index.ts 与测试);Step 2: 删除+导出清理;Step 3: 全量测试绿;Step 4 commit:

```bash
git add -A packages/ui
git commit -m "refactor(ui): 删除无消费的MdList/MdListItem

why: spec §11 预授权——业务列表行均含交互子元素,不适用 button 型 list item,
两组件自建成起零消费,保留即双轨。
what: 删组件/导出/测试。"
```

---

### Task 3: tokens.css 按需加载(默认种子兜底)

**Files:**
- Modify: `packages/ui/src/theme/generate.mjs`(双产物)、`packages/ui/src/theme/useTheme.ts`(动态加载)、各入口不改(base 仍经原 tokens.css 引入)
- Test: `packages/ui/test/themeTokens.test.ts` 改写 + `useTheme.test.ts` 追加

**设计(锁定,不再议):**
- `tokens.css`(base,恒载):color-scheme 4 声明 + **无 `[data-color]` 限定的明/暗/auto×media 块,值=blue**(即默认种子即兜底);不再有 `[data-color="blue"]` 专属块。
- `tokens-palettes.css`(懒载):9 个非默认种子 × light/dark/auto×media,`[data-color=id][data-mode=…]` 限定(特异度高于 base,加载后自然覆盖兜底)。
- `useTheme.ts`:模块级 `ensurePalettes(color)`——`color==='blue'` 直接返回;否则动态 `import('./tokens-palettes.css')`(模块级 promise 缓存,多次调用只载一次);color.set 在写 settings 前不 await(兜底为 blue,加载完成自动换色,ms 级);watchEffect 内 fire-and-forget 调用(覆盖「设置加载即为非默认种子」的首载路径)。
- FOUC 内联脚本与 html 不变。

- [ ] Step 1: 改写 themeTokens 测试(base 无色限定块=blue 值逐角色断言;9 种子文件齐全;auto media;**palettes 文件不含 blue**)+ useTheme 测试(color 设为 teal 后 `import` 被触发——用 `vi.mock` 断言动态导入调用);Step 2 红;Step 3 实现 generate.mjs 双产物(改脚本重跑生成)+useTheme;Step 4 绿+typecheck;Step 5:

```bash
git add packages/ui/src/theme packages/ui/test
git commit -m "feat(ui): tokens按需加载(默认种子内联兜底+9种子懒载chunk)

why: spec §11——popup 必载 CSS 因 tokens 全量膨胀(+60.6KB),需收窄首载体积。
what: generate.mjs 拆 base(blue兜底,无色限定)/palettes(9种子)双产物,useTheme 动态加载。"
```

- [ ] Step 6: 体积核对(方法同计划13 T13 worktree 基线 29fabc0):记录 popup 初始 CSS 前后数值,写入上一 commit 的 amend message 或本任务说明(控制方汇总)。

---

### Task 4: 接线 I — 验证码域(CodesPage/GroupManagerDialog/SearchBar/OtpListItem/RevealDialog)

**Files:**
- Modify: `packages/ui/src/pages/CodesPage.vue`、`packages/ui/src/components/GroupManagerDialog.vue`、`SearchBar.vue`、`OtpListItem.vue`、`RevealDialog.vue`
- Test: 对应测试文件选择器适配

**接线规则(全计划统一):**
- 操作按钮→`MdButton`(主操作 filled、次操作 tonal、弱化 text;**危险动作(确认删除/删除分组)新增 `danger` prop:text 形+error 色**,本任务给 MdButton 加 `danger?: boolean`);图标钮(🔑/复制/编辑/删除小钮)→`MdIconButton`。
- 文本输入→`MdTextField`(SearchBar 搜索框、GroupManager 新建组名/重命名行内输入、RevealDialog 无输入不动);`type="checkbox"`→`MdCheckbox`(SearchBar 搜 secret)。
- `<select>` 保留原生;行内布局允许为浮动 label 微调,不改网格结构。

- [ ] Step 1: 测试适配(先跑现状测试,记录因类名/结构需更新的断言并更新,行为断言不减);Step 2 实现 MdButton danger 形+五文件接线;Step 3 全量绿+typecheck;Step 4 commit:

```bash
git add packages/ui
git commit -m "refactor(ui): 验证码域控件接线md组件(按钮/图标钮/输入/复选)

why: spec §11 接线专项——消除原生控件与 md 组件双轨(验证码域五文件)。
what: MdButton增danger形态;CodesPage/GroupManagerDialog/SearchBar/OtpListItem/RevealDialog平替。"
```

---

### Task 5: 接线 II — LockScreen + EntryForm

**Files:**
- Modify: `packages/ui/src/components/LockScreen.vue`、`EntryForm.vue`
- Test: `LockScreen.test.ts`、`EntryForm.test.ts` 适配

**要点:** LockScreen 口令输入(含显示/切换)→MdTextField(type=password 可用);解锁/解锁按钮→MdButton(filled,全宽);EntryForm:label/issuer/secret/note/counter 文本输入→MdTextField,算法/位数/周期/类型 `<select>` 保持原生(仅套既有布局),提交/取消→MdButton(filled/text),checkbox(如有)→MdCheckbox。**EntryForm.test 的表单填充断言逐条保语义适配**(经 `find('input')` 的仍命中 MdTextField 内部 input)。

- [ ] commit:

```bash
git add packages/ui
git commit -m "refactor(ui): LockScreen/EntryForm控件接线md组件

why: spec §11 接线专项(解锁与表单两大高频面)。
what: 口令/文本输入→MdTextField、按钮→MdButton;select保留原生。"
```

---

### Task 6: 接线 III — 五卡(Security/Backup/Cloud/Sync/Import)

**Files:**
- Modify: `packages/ui/src/components/SecurityCard.vue`、`BackupCard.vue`、`CloudCard.vue`、`SyncCard.vue`、`ImportCard.vue`
- Test: 五卡测试适配

**要点:** 卡内操作按钮→MdButton/MdIconButton(变体按语义:确认类 filled、次级 tonal、危险 danger);开关型 `checkbox`→MdCheckbox(语义即勾选,不改成 Switch 以免行为/测试语义漂移);文本输入(平台名/地址/密钥字段)→MdTextField;`<select>`(后端平台选择等)保持原生。ImportCard 23 处为最大面,分两次 commit(Import 单独一个)。

- [ ] commit ×2:

```bash
git add packages/ui
git commit -m "refactor(ui): Security/Backup/Cloud/Sync卡控件接线md组件

why: spec §11 接线专项(安全与数据四卡)。
what: 按钮/checkbox/文本输入平替,select保留原生。"
git add packages/ui
git commit -m "refactor(ui): ImportCard控件接线md组件

why: spec §11 接线专项(最大单卡23处)。
what: 按钮/文本输入/checkbox平替,平台select保留原生。"
```

---

### Task 7: 收尾验证(spec §11 闭环材料)

**Files:** 无新代码;控制方负责 docs 回写

- [ ] Step 1: `pnpm -r test && pnpm -r typecheck`;`pnpm --filter @totp/desktop build && pnpm --filter @totp/extension build`;rg 复核:`rg -n "<button(?![^>]*md-)" packages/ui/src --glob '*.vue'` 业务组件零原生 button(允许 select;md/ 目录与 NavigationShell 内部实现除外);Step 2: popup 体积对比(基线 29fabc0 worktree 法);Step 3: 结果汇总回报(控制方回写 spec §11 闭环 + 浏览器复验)。

## Self-Review 记录

- **Spec 覆盖**:§11 三项→T3(按需加载)/T4-6(接线)/T1(a11y);MdList 删除→T2;§8 验收口径(体积/测试)→T3 Step6/T7。无缺口。
- **占位符**:无;接线规则统一写在 T4 并被 T5/T6 引用为同一规则块(非「同 Task N」式引用,规则本身完整)。
- **类型一致性**:MdButton danger 为新增 prop,不破坏既有变体契约;ensurePalettes 仅内部使用;35 角色断言口径与 plan13 勘误后一致。
