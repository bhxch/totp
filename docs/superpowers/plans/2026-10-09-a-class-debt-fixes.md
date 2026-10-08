# A 类技术债小修批 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉 Phase 1/2 审查登记的全部剩余开发债（3 项），MD3 相关开发工作归零。

**Architecture:** 一项组件结构重构（MdChip removable 嵌套交互消除）+ 两项小修（测试基建串行化、hint 读屏关联）。

**Spec:** 无独立 spec——三项均为 Phase 1/2 审查已登记挂账，方案已在审查意见中给出。原 §2.12 挂账的"MdSelect option id 收口"已在 Phase 2 修复波完成（复审 ADDRESSED），本批不含。

## Global Constraints

覆盖率不低于 68.19/47.35；`pnpm -r test` 全绿 + `pnpm -r typecheck`；Rust 改动 `cargo fmt/clippy/test`；commit 原子化 Angular 中文；不提交 dist/.output/target；同仓库任务串行。

---

### Task 1: MdChip removable 结构重构（消除嵌套交互）

**Files:**
- Modify: `packages/ui/src/components/md/MdChip.vue`
- Modify: `packages/ui/test/MdChip.test.ts`、IconPickerDialog/IconPackImportDialog 相关测试（DOM 结构适配）

**Interfaces:** 对外 API 不变（`removable`/`removeLabel`/`disabled`/`@remove`/`@click`/`compact`/`selected` 全保留）；仅组件内部 DOM 结构变化。

**结构方案（终审与 Phase 2 审查共同给出的替代形态）：**
- 非 removable：**现状保持**（根 `<button>` 整体可点）——普通 chip 消费点（TagFilterRow 等）零影响。
- removable：根改非交互容器 `<span class="md-chip md-chip--removable">`（保留胶囊视觉：背景/圆角/边框/高度/padding），内部**两个兄弟 button**：
  - `<button class="md-chip__main">`：文本区，承接原根的 click/aria（selected → aria-pressed）、disabled 语义；
  - `<button class="md-chip__remove" aria-label="removeLabel">`：close 区（iconPaths.close 24px），命中 `::after inset:-8px`（兄弟结构无截留问题）；
  - 兄弟结构天然无嵌套交互违规，无需 z-index/命中层 hack。
- disabled：两 button 均 disabled。
- 样式：胶囊装饰移至根 span；两 button 透明背景（状态层保留 hover/active 8%/12% token）；close 区与主区以 padding 分界，视觉与现版一致（紧凑 28px/标准 32px 两档保持）。

- [ ] **Step 1: 失败测试** — MdChip.test：removable 时根为非交互容器、主/remove 为兄弟 button、无嵌套 button（`el.querySelector('button button')` 为 null 断言）、remove/click 事件语义不变、disabled 两钮齐禁。
- [ ] **Step 2: 跑失败** → 实现 → 跑绿。
- [ ] **Step 3: 消费方适配** — IconPickerDialog/IconPackImportDialog 测试选择器适配（语义断言不变）；全量 `pnpm -r test` + typecheck。
- [ ] **Step 4: 提交**

```bash
git commit -m "fix(ui): MdChip removable 改兄弟 button 结构消除嵌套交互

why: removable chip 为 button 嵌 MdIconButton，违反 HTML 内容模型
（nested-interactive serious），读屏暴露差（Phase 2 审查 I-1 登记）。
what: removable 形态根改非交互 span+主/删两兄弟 button（各带命中层，
无 hack）；非 removable 形态与对外 API 全不变。"
```

---

### Task 2: mini flake 串行化 + hint aria-describedby

**Files:**
- Modify: `apps/desktop/src-tauri/src/session_vaults.rs`（mini_dek_tests 串行守卫）
- Modify: `packages/ui/src/components/md/MdTextField.vue`、`md/MdSelect.vue`
- Test: 两者各自追加

**Interfaces:** hint 渲染元素带 id（`hint-${实例号}`），控件 `aria-describedby` 指向（error 时仍指向 error id 优先不变）。

- [ ] **Step 1（flake）**: session_vaults.rs 的 mini_dek_tests 模块加 `static TEST_LOCK: Mutex<()>`（或 std::sync::Mutex 常量起步），每个测试持守卫串行化（根因：并行测试共享全局 MINI_DEK 槽，cfd4639 引入）；`cargo test` 连跑 5 轮确认零 flake。
- [ ] **Step 2（hint）**: 两组件 hint 元素加 id（模块计数器先例），input/trigger `aria-describedby` 动态绑（error 优先、无 error 无 hint 时移除）；测试断言 describedby 指向 hint id。
- [ ] **Step 3:** 验证：`pnpm -r test` + typecheck + cargo 三连（test 多轮）。
- [ ] **Step 4: 提交（两笔）**

```bash
git commit -m "test(desktop): MINI_DEK 槽测试串行化消除并行竞态 flake

why: mini_dek_commands_enforce_window_label_ownership 并行共享全局槽
偶发失败（cfd4639 引入，Phase 2 批执行期 13 轮复现实录）。
what: mini_dek_tests 共享 Mutex 守卫串行化。"

git commit -m "feat(ui): hint 接入 aria-describedby 读屏关联

why: hint 文案有视觉但未对读屏暴露（Phase 2 审查挂账）。
what: 两组件 hint 元素 id 化并经 aria-describedby 关联（error 优先
语义不变）。"
```

---

## 收尾

全量 `pnpm -r test`/typecheck + cargo 三连；任务审查（单审查者看全批 diff）；真机观感项（MdChip removable 新结构观感）并入既有人工清单。
