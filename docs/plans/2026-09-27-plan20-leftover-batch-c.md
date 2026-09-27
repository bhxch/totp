# 批次 C:遗留清理·一致性/卫生批 实施计划(plan20)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛 backlog B12-B17/B21 一致性与卫生项,并落地 i18n 无引用键校验脚本,防止死键再积累。

**Architecture:** 全部为「删副本/删死代码/一行受控化/脚本工具」级改动,无新抽象。C7(makePlatform fake 收编)按 spec 明确**不在本批**(挂起到下个 UI 功能批,见任务 8 的范围说明)。C8(B21 偶败)为调查型任务,允许「无法复现→记录观察」的结论。

**Tech Stack:** TypeScript / Vue 3 / vitest / Rust(serde) / Node ESM 脚本。

**Spec:** `docs/plans/2026-09-27-leftover-cleanup-design.md`(§4 批次 C 表 C1-C9)。执行者需同时读 spec。

## Global Constraints

- 每任务原子 commit;`git add` 只加本任务文件。
- C5(C 删 Deserialize)涉及 Rust:每任务后跑 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml release_policy` 定向组;批次收尾跑全量 cargo 三件套(fmt/clippy/test)。
- i18n 修改 zh/en 双文件同步。
- 定向测试命令:core= `pnpm --filter @totp/core exec vitest run <file>`;ui= `pnpm --filter @totp/ui exec vitest run <file>`;extension= `pnpm --filter @totp/extension exec vitest run <file>`。

---

### Task 1: C1 删除 droppedTagCount 死字段与死分支

**Files:**
- Modify: `packages/core/src/export/aegisVault.ts:15-25,75,100`
- Modify: `packages/ui/src/components/BackupCard.vue:181-189`(okWithDropped)及调用点
- Modify: `packages/core/test/exportAegisEncrypted.test.ts:48`、`packages/core/test/exportAegisPlaintext.test.ts:32,97`
- Modify: `packages/ui/test/BackupCard.export.test.ts:85`(注释)
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`(exportedWithDropped 键)

**Interfaces:**
- Produces: `AegisExportReport` 收窄为 `{ usedGroups: string[] }`——唯一外部消费方 BackupCard 同步改,无其他调用方(rg 已核 8 处引用全在清单内)。

- [ ] **Step 1: 复核引用面**

Run: `rg -n "droppedTagCount|exportedWithDropped" --glob '!docs/**' .`
Expected: 命中恰为上列文件;`exportedWithDropped` 在 zh/en common.json 各 1 行。多于清单则停下核对。

- [ ] **Step 2: 改 core 接口与实现**

`aegisVault.ts:15-20` 接口改为:

```ts
export interface AegisExportReport {
  /** 实际写入的 group 名（去重，条目顺序） */
  usedGroups: string[]
}
```

(删除 droppedTagCount 字段及其「遗留字段…恒 0」注释。)`:75` 与 `:100` 两处初始化改为:

```ts
  const report: AegisExportReport = { usedGroups: [] }
```

- [ ] **Step 3: 改 core 测试(先红后绿在本步合并完成——删断言即生效)**

`exportAegisEncrypted.test.ts:48` 删除 `expect(report.droppedTagCount).toBe(0)` 行;`exportAegisPlaintext.test.ts:32` 删除该行及其尾注;`:97` 同删。三处删除后 `droppedTagCount` 在 core 测试零残留。

- [ ] **Step 4: 改 BackupCard 死分支**

`BackupCard.vue:181-189` 整函数替换(调用点同步改传参——`rg -n okWithDropped packages/ui/src/components/BackupCard.vue` 找到全部调用,把 `okWithDropped(saved, report)` 改 `onExported(saved)`):

```ts
/** 文本导出反馈：取消=hint;Aegis 条目 groups 数组支持多标签后无标签丢弃(原 droppedTagCount
 *  恒 0 死分支已随 C1 删除) */
function onExported(saved: boolean): void {
  msg.value = saved ? t('backupCard.exported') : t('backupCard.canceled')
  msgKind.value = saved ? 'ok' : 'hint'
}
```

`BackupCard.export.test.ts:85` 注释「core exportAegisPlaintext 目前恒置 droppedTagCount=0,okWithDropped 的 >0 提示分支为防御保留」改为「C1 后 AegisExportReport 无 droppedTagCount,导出反馈仅 成功/取消 两态」。

- [ ] **Step 5: 删 i18n 死键**

zh/en common.json 各删除一行:

```json
      "exportedWithDropped": "已导出，{count} 个多余标签未导出",
```

(en 行文案为对应英文;先 `rg -n exportedWithDropped packages/ui/src/i18n/locales` 取精确行号再删。)

- [ ] **Step 6: 验证**

Run: `pnpm --filter @totp/core exec vue-tsc --noEmit 2>/dev/null; pnpm --filter @totp/core typecheck && pnpm --filter @totp/core exec vitest run test/exportAegisEncrypted.test.ts test/exportAegisPlaintext.test.ts && pnpm --filter @totp/ui typecheck && pnpm --filter @totp/ui exec vitest run test/BackupCard.export.test.ts`
Expected: typecheck 与定向测试全绿。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/export/aegisVault.ts packages/core/test/exportAegisEncrypted.test.ts packages/core/test/exportAegisPlaintext.test.ts packages/ui/src/components/BackupCard.vue packages/ui/test/BackupCard.export.test.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "refactor(core): 删除 AegisExportReport.droppedTagCount 死字段与 BackupCard 死分支(C1)(batch C)

why: groups 数组支持多标签后 Aegis 导出无标签丢弃,字段恒 0、提示分支
不可达(接口注释自证遗留);死分支连带 exportedWithDropped 死键。
what: 接口收窄为 usedGroups 单字段,BackupCard 导出反馈改两态,测试断言
与 i18n 死键同步清理。"
```

---

### Task 2: C2 MdSwitch 受控化

**Files:**
- Modify: `packages/ui/src/components/md/MdSwitch.vue:1-16`
- Test: `packages/ui/test/md/mdInputs.test.ts:107-140`

**Interfaces:**
- Produces: MdSwitch props/emits 签名不变(`modelValue`/`update:modelValue`/`disabled`/`ariaLabel`);行为语义变化仅一处——**视觉纯由 props.modelValue 派生**(原为内部 ref 双真值源)。消费方(9 文件)零改动:已核实无依赖「先改视觉后回滚」的消费方,唯一含回滚的 McpServerCard.persist 走 cfg DTO 赋值,受控化后回滚更正确。

- [ ] **Step 1: 改写测试为受控语义(先红)**

`mdInputs.test.ts:107-140` 的 `MdSwitch` describe 替换为:

```ts
describe('MdSwitch', () => {
  it('点击只 emit update,不自行改视觉(受控)', async () => {
    const w = mount(MdSwitch, { props: { modelValue: false } })
    await w.find('input[type=checkbox]').setValue(true)
    expect(w.emitted('update:modelValue')![0]).toEqual([true])
    // 受控:父层未更新 modelValue 前,视觉保持未选中(C2 回滚语义)
    expect(w.classes()).not.toContain('md-switch--checked')
  })
  it('视觉纯由 modelValue 派生:props 变化驱动类切换', async () => {
    const w = mount(MdSwitch, { props: { modelValue: false } })
    expect(w.classes()).not.toContain('md-switch--checked')
    await w.setProps({ modelValue: true })
    expect(w.classes()).toContain('md-switch--checked')
  })
  it('父层回滚 modelValue → 视觉回退(B13 脱钩修复锁定)', async () => {
    const w = mount(MdSwitch, { props: { modelValue: true } })
    await w.find('input[type=checkbox]').setValue(false)
    expect(w.emitted('update:modelValue')![0]).toEqual([false])
    expect(w.classes()).toContain('md-switch--checked') // 父层拒绝时视觉不前进
    await w.setProps({ modelValue: false })
    expect(w.classes()).not.toContain('md-switch--checked')
  })
  it('disabled 时不触发 update', async () => {
    const w = mount(MdSwitch, { props: { modelValue: false, disabled: true } })
    expect(w.classes()).toContain('md-switch--disabled')
    await w.find('input[type=checkbox]').setValue(true)
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
  it('input 带 role=switch;ariaLabel 落到 input 的 aria-label;不传则不加', () => {
    const withLabel = mount(MdSwitch, { props: { modelValue: false, ariaLabel: '启用同步' } })
    const input = withLabel.find('input')
    expect(input.attributes('role')).toBe('switch')
    expect(input.attributes('aria-label')).toBe('启用同步')
    const withoutLabel = mount(MdSwitch, { props: { modelValue: false } })
    expect(withoutLabel.find('input').attributes('aria-label')).toBeUndefined()
  })
  it('未选中拇指 16dp/选中 24dp(M3 拇指随状态缩放):thumb 样式钩子存在且随 checked 切换类', async () => {
    const w = mount(MdSwitch, { props: { modelValue: false } })
    expect(w.find('.md-switch__thumb').exists()).toBe(true)
    expect(w.classes()).not.toContain('md-switch--checked')
    await w.setProps({ modelValue: true })
    expect(w.classes()).toContain('md-switch--checked')
    const src = readFileSync(join(__dirname, '../../src/components/md/MdSwitch.vue'), 'utf8')
    expect(src).toMatch(/\.md-switch__thumb\s*\{[^}]*width:\s*16px/)
    expect(src).toMatch(/\.md-switch--checked \.md-switch__thumb\s*\{[^}]*width:\s*24px/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/md/mdInputs.test.ts -t "MdSwitch"`
Expected: 前三个用例 FAIL(现状内部 ref 乐观改视觉)。

- [ ] **Step 3: 受控化实现**

`MdSwitch.vue` script 与模板改:

```vue
<script setup lang="ts">
const props = withDefaults(defineProps<{ modelValue: boolean; disabled?: boolean; ariaLabel?: string }>(), { modelValue: false, disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
// C2 受控化:删除内部 checked ref 与 watch 双真值源——视觉纯由 modelValue 派生,
// change 只 emit;父层拒绝/回滚(modelValue 未变)时开关视觉与真实状态一致。
// 已核实消费方无「乐观改视觉」依赖(McpServerCard 回滚走 cfg DTO 赋值,受控化后更正确)
function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).checked)
}
</script>
<template>
  <label class="md-switch" :class="{ 'md-switch--checked': props.modelValue, 'md-switch--disabled': disabled }">
    <input type="checkbox" class="md-switch__input" role="switch" :aria-label="ariaLabel" :checked="props.modelValue" :disabled="disabled" @change="onChange" />
    <span class="md-switch__track"><span class="md-switch__thumb" /></span>
  </label>
</template>
```

(scoped style 原样保留;`import { ref, watch } from 'vue'` 删除。)

- [ ] **Step 4: 跑测试确认通过 + 消费方回归**

Run: `pnpm --filter @totp/ui exec vitest run test/md/mdInputs.test.ts && pnpm --filter @totp/ui test`
Expected: 全绿(ui 全量 1062 例;BackupCard/CloudCard/McpServerCard/SecurityCard/SettingsPage 等消费方用例不回归)。

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/md/MdSwitch.vue packages/ui/test/md/mdInputs.test.ts
git commit -m "fix(ui): MdSwitch 受控化,消除回滚视觉脱钩(C2/B13)(batch C)

why: 内部 checked ref+watch 构成双真值源,父层拒绝/回滚(modelValue 未变)
时开关视觉停留新态与真实状态脱钩。
what: 删内部态,视觉与 :checked 纯由 props.modelValue 派生,change 只 emit;
测试改受控语义并新增回滚锁定用例;消费方签名不变零改动。"
```

---

### Task 3: C3 offscreen ack 消息吞异步 rejection

**Files:**
- Modify: `apps/extension/entrypoints/offscreen/offscreen.ts:27`
- Test: `apps/extension/test/offscreen.test.ts`(追加 1 用例)

**Interfaces:** 无签名变化;`ext.runtime.sendMessage` 的未处理 promise rejection 被 `.catch` 吸收。

- [ ] **Step 1: 追加失败测试**

`offscreen.test.ts` 的 describe「offscreen clear-clipboard 处理(B2-9/10)」内追加(仿既有用例 :49 的消息驱动手法):

```ts
  it('ack 的 sendMessage 返回 rejected promise:不产生 unhandled rejection,回执照发(C3)', async () => {
    // 现状 sync try/catch 捕获不到 promise rejection → unhandled rejection(vitest 下测试即失败)
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(new Error('SW closed'))
    await emitClearClipboard() // 按该文件既有驱动手段发送 {type:'clear-clipboard'} 并 flush
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'clear-clipboard-ack' })
  })
```

(`emitClearClipboard` 若与该文件既有驱动函数名不同,以文件内真实助手名为准替换;核心断言=sendMessage(ack) 被调用且测试进程无 unhandled rejection。)

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/extension exec vitest run test/offscreen.test.ts -t "C3"`
Expected: FAIL(unhandled rejection 报错)。

- [ ] **Step 3: 一行修复**

`offscreen.ts:27`:

```ts
    try { ext!.runtime.sendMessage({ type: 'clear-clipboard-ack' }) } catch { /* 忽略 */ }
```

改为:

```ts
    // C3:sendMessage 返回 promise,sync try/catch 捕获不到 rejection(MV3 SW 未就绪时)——
    // 显式 .catch 吸收,ack 是 fire-and-forget 兜底通道,失败可静默
    void ext!.runtime.sendMessage({ type: 'clear-clipboard-ack' }).catch(() => {})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/extension exec vitest run test/offscreen.test.ts`
Expected: 全绿(5+1 例)。

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/offscreen/offscreen.ts apps/extension/test/offscreen.test.ts
git commit -m "fix(extension): offscreen ack 消息改显式 catch 吸收异步 rejection(C3/B14)(batch C)

why: sync try/catch 包异步 sendMessage 捕获不到 promise rejection,
MV3 SW 未就绪时 unhandled rejection。
what: 改 void+catch 一行;新增 rejected promise 用例锁定。"
```

---

### Task 4: C4 删除 clearClipboardWithRetry 循环内死防御

**Files:**
- Modify: `apps/extension/entrypoints/background.ts:50-54`
- Test: 既有 `apps/extension/test/background.test.ts:274` describe 全组兜底

**Interfaces:** 无。前提(研究员核实):`ensureOffscreenDocument`(:31-41)内部已 catch 一切(createDocument 抛错即视为已存在),循环内 `try { await ensureOffscreenDocument() } catch { return }` 的 catch 不可达。

- [ ] **Step 1: 删死防御**

`background.ts` 循环体内:

```ts
    try {
      await ensureOffscreenDocument()
    } catch {
      // createDocument 失败（无 offscreen 权限等）：放弃本次
      return
    }
```

替换为:

```ts
    // C4:ensureOffscreenDocument 内层已吞一切(createDocument 抛错即视为已存在),
    // 此处 catch 不可达——删死防御;「无 offscreen 权限」场景由内层静默保留复用语义
    await ensureOffscreenDocument()
```

- [ ] **Step 2: 验证既有用例不回归**

Run: `pnpm --filter @totp/extension exec vitest run test/background.test.ts`
Expected: 全绿——特别确认 :323 用例「createDocument 失败(已存在/权限缺失):错误被吞,仍进入发送重试链(复用已存在文档)」仍通过(它锁定的正是内层吞错语义,不受本改动影响)。

- [ ] **Step 3: Commit**

```bash
git add apps/extension/entrypoints/background.ts
git commit -m "refactor(extension): 删除 clearClipboardWithRetry 循环内不可达 catch(C4/B15)(batch C)

why: ensureOffscreenDocument 内层已吞一切异常,循环内的 try/catch 死防御
永不可达,徒增「此处会放弃重试」的误导。
what: 改直调一行,语义注释移到调用处;既有 4 用例全绿兜底。"
```

---

### Task 5: C5+C6 ReleasePolicyConfig 删死 Deserialize 通道 + Default 单轨

**Files:**
- Modify: `apps/desktop/src-tauri/src/release_policy.rs:5-45`
- Modify: `apps/desktop/src-tauri/src/release_policy.rs` 测试区(约 :382/:385 两处 `serde_json::from_str::<ReleasePolicyConfig>`)

**Interfaces:**
- Produces: `ReleasePolicyConfig` 仅余 `Serialize`+`#[serde(rename_all = "camelCase")]`;`from_settings_text/from_section` 手写逐字段回退为**唯一**解析口径(既有裁定);`Default` impl 改调 default fns(值 5/30/false/true 不变)。
- 已核实:生产代码中 ReleasePolicyConfig 反序列化唯一入口是 from_settings_text;`serde_json::from_str::<ReleasePolicyConfig>` 仅测试区 :382/:385 使用(mcp_server.rs:1386 的 from_str 是 McpConfig,无关)。

- [ ] **Step 1: 改 struct 与 Default**

`release_policy.rs:5-45` 改为:

```rust
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePolicyConfig {
    /// 隐藏后多少分钟进入暂停档；0=禁用暂停档
    pub pause_minutes: u32,
    /// 暂停后多少分钟销毁；0=禁用销毁档（暂停禁用时从隐藏起算）
    pub destroy_minutes: u32,
    /// 暂停档同时锁定 vault（默认关）
    pub lock_on_pause: bool,
    /// 销毁档锁定 vault（默认开；关=DEK 暂存 Rust 内存、重建后回注）
    pub lock_on_destroy: bool,
}

fn default_pause_minutes() -> u32 {
    5
}
fn default_destroy_minutes() -> u32 {
    30
}
fn default_true() -> bool {
    true
}

/// C6:默认值单轨——impl Default 改调 default fns,5/30 不再两处手工维护
impl Default for ReleasePolicyConfig {
    fn default() -> Self {
        Self {
            pause_minutes: default_pause_minutes(),
            destroy_minutes: default_destroy_minutes(),
            lock_on_pause: false,
            lock_on_destroy: default_true(),
        }
    }
}
```

(删除 `#[serde(default = "...")]` 四个属性与 `Deserialize` derive——反序列化通道删除后 serde default 属性为死配置;`default_true` 保留供 Default impl。头注释 45-48 行「唯一手写处」说明保持。)

- [ ] **Step 2: 测试区改写**

`release_policy.rs` 测试区内两处 `serde_json::from_str::<ReleasePolicyConfig>`(约 :382/:385——`rg -n "from_str::<ReleasePolicyConfig>" apps/desktop/src-tauri/src/release_policy.rs` 定位):把「构造 JSON 文本→from_str 反序列化」的断言改走唯一口径 `from_section`:

```rust
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        let got = from_section(json.get("releasePolicy"));
```

断言值保持原测试期望不变(逐字段回退语义本来就由 from_section 承载)。同时核对 :377-393 附近 R9 加的「serde 通道键名锁定」测试:它锁定的是 **Serialize** 写节键名,保留不动;若其中有依赖 Deserialize 的断言,改为经 `serde_json::to_value(&cfg)` 断言键名。

- [ ] **Step 3: 验证**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml release_policy && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings 2>&1 | tail -3`
Expected: release_policy 测试组全绿(含 from_section 逐字段回退既有用例 :366-398);clippy 无警告。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/release_policy.rs
git commit -m "refactor(desktop): ReleasePolicyConfig 删死 Deserialize 通道+Default 单轨(C5/C6/B16/B17)(batch C)

why: 解析口径唯一走 from_section 手写逐字段回退(有意裁定,serde 无法
等价替代),derive(Deserialize) 与 serde default 属性在生产零调用方;
默认值 5/30 在 serde default fns 与 Default impl 两处手工维护。
what: derive 收窄为 Serialize;删 serde default 属性;Default impl 改调
default fns;测试区 from_str 反序列化改走 from_section 唯一口径。"
```

---

### Task 6: C8 B21 core 偶败调查与确定性化

**Files:**
- Modify: 复现定位后确定(候选 `packages/core/test/autoRun.test.ts` 或新增收口)
- 可 Modify: `packages/core/test/` 内定位到的用例文件

**Interfaces:** 无预设接口;产出=用例名与根因记录(写在 commit 正文),若可确定性化则改测试等待手法。

**这是调查型任务:** 允许结论为「无法稳定复现」,但必须留下复现脚本与证据。

- [ ] **Step 1: 并发复现抓用例名**

Run(工作区根,循环 10 次,每次记录失败用例名):

```bash
for i in $(seq 1 10); do pnpm -r --no-bail run test 2>&1 | grep -E "FAIL|✕|failed" | head -5; echo "--- round $i done"; done | tee .temp/b21-repro.log
```

(临时输出放 `.temp/`,已 gitignore。)已知手法参照:`packages/core` 中使用 fake timers 的仅 `autoRun.test.ts`(9 处,afterEach 有 `vi.useRealTimers()` 兜底);desktop 参照手法是 `autoBackup.test.ts:400-408` 的 `fireDebounceAndWait`(`advanceTimersByTimeAsync` 精确跨窗 + `vi.waitFor`)。

- [ ] **Step 2: 分支处置**

- **复现成功**:定位到用例后,若是 fake-timer 轮询悬崖,照 `fireDebounceAndWait` 手法改写该用例等待段;若是共享时间源/全局 mock 泄漏,加 `vi.restoreAllMocks()`/隔离。改后执行 Step 3。
- **无法复现**:在 `docs/plans/2026-09-27-leftover-cleanup-design.md` §4 C8 行追加一句「2026-09-XX 10 轮复现未捕获,继续观察」,跳过 Step 3/4(无 commit)。

- [ ] **Step 3: 稳定性验证**

Run: `for i in 1 2 3 4 5; do pnpm --filter @totp/core test 2>&1 | tail -1; done`
Expected: 5 连绿(并发口径再跑一次根 `pnpm -r --no-bail run test` 亦绿)。

- [ ] **Step 4: Commit(仅复现成功时)**

```bash
git add packages/core/test/<定位文件>
git commit -m "test(core): <用例名> 确定性化,消除负载型偶败(C8/B21)(batch C)

why: 多包并发负载下 <用例名> 偶败(.temp/b21-repro.log 证据);根因
<fake-timer 轮询悬崖/共享时间源>。
what: 参照 desktop autoBackup fireDebounceAndWait 手法收口等待段;5 连绿
+根并发口径验证。"
```

---

### Task 7: C9 i18n 无引用键校验脚本

**Files:**
- Create: `scripts/check-i18n-keys.mjs`
- Modify: `package.json`(根,scripts 增 `"check:i18n"`)

**Interfaces:**
- Produces: `node scripts/check-i18n-keys.mjs` 退出码 0=键集健康;非 0=存在问题并列出。CI 可后续接入(本任务不接,避免 CI 失败阻塞)。

- [ ] **Step 1: 写脚本**

新建 `scripts/check-i18n-keys.mjs`:

```js
#!/usr/bin/env node
// C9: i18n 键引用校验——扫 packages/ui/src 中以引号字面量出现的点分键串,
// 与 locales/{zh,en}/common.json 键集双向比对(缺键/无引用)。
// 引用判定用「字符串字面量出现」而非仅 t('...'):覆盖 cloudSyncShared 动作文案表
// 等常量键引用;非 i18n 的巧合字符串(如事件名)经 ALLOW 白名单豁免。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'packages', 'ui', 'src')

// 已知豁免(非 t() 消费的字符串巧合/计划中的键);增删需在 commit 正文说明
const ALLOW = new Set([
  // (首轮跑出的误报在此登记;空集为预期起点)
])

const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [p + k] : flat(v, `${p}${k}.`)))

const zh = JSON.parse(readFileSync(join(SRC, 'i18n/locales/zh/common.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(SRC, 'i18n/locales/en/common.json'), 'utf8'))
const zhKeys = new Set(flat(zh))
const enKeys = new Set(flat(en))

const refs = new Set()
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(vue|ts)$/.test(f)) {
      const src = readFileSync(p, 'utf8')
      // 点分键形如 '域.子键' 或 '域.子.孙';首段必须字母开头,排除相对/包导入路径
      for (const m of src.matchAll(/['"]([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g)) refs.add(m[1])
    }
  }
}
walk(SRC)

const problems = []
for (const r of refs) {
  if (ALLOW.has(r)) continue
  if (!zhKeys.has(r)) problems.push(`缺失(zh): ${r}`)
  if (!enKeys.has(r)) problems.push(`缺失(en): ${r}`)
}
for (const k of zhKeys) if (!refs.has(k) && !ALLOW.has(k)) problems.push(`无引用(zh): ${k}`)
for (const k of enKeys) if (!refs.has(k) && !ALLOW.has(k)) problems.push(`无引用(en): ${k}`)

if (problems.length > 0) {
  console.error(`i18n 键校验失败(${problems.length} 项):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`i18n 键校验通过: zh=${zhKeys.size} en=${enKeys.size} 引用=${refs.size}`)
```

- [ ] **Step 2: 首轮运行与白名单登记**

Run: `node scripts/check-i18n-keys.mjs`
Expected 处置:若报「无引用」死键,逐一人工核实——确属死键的当场删(可并入本任务 commit,注明来源);属字符串巧合误报的加入 `ALLOW` 并注释原因。循环直至退出码 0。若报大量「缺失」(脚本抓到的字符串本就不是 i18n 键),收紧正则(如要求键首段命中 locales 顶层 30 个命名空间之一:app/nav/lock/entryForm/…/popupFilter——实现为 `const NS = new Set(Object.keys(zh))`,匹配时校验 `r.split('.')[0] ∈ NS`),此为**预期调优点**。

- [ ] **Step 3: 挂 npm script**

根 `package.json` scripts 追加:

```json
    "check:i18n": "node scripts/check-i18n-keys.mjs",
```

- [ ] **Step 4: 验证**

Run: `pnpm check:i18n`
Expected: 退出码 0,输出统计行。

- [ ] **Step 5: Commit**

```bash
git add scripts/check-i18n-keys.mjs package.json packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "chore(scripts): 新增 i18n 无引用/缺失键校验脚本(C9)(batch C)

why: R1 合并文案表后残留 cloudCard.action* 死键靠人工 rg 才发现,
缺反向校验通道;键集漂移(漏翻/死键)应机器把关。
what: check-i18n-keys.mjs 双向比对引用字面量与 zh/en 键集,ALLOW 白名单
登记误报;pnpm check:i18n 入口。CI 接入另行裁定。"
```

---

### Task 8(范围说明,无步骤): C7 makePlatform fake 收编——挂起

按 spec §4 C7「不单开批,随下个 UI 功能批分批收编(一次一个文件验证工厂形态)」。本批仅保留 9 处清单供未来引用(rg `function makePlatform` packages/ui/test,9 命中,三家族:BackupPlatform 3 份逐字、CloudPlatform 3 份、SecurityPlatform 3 份)。**本批不建 helpers/fakes.ts**——无消费方的工厂是死代码。

---

## 批次收尾

- [ ] 全仓门禁:`pnpm typecheck && pnpm -r --no-bail run test` + `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml` + `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings` + `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` + `pnpm check:i18n`,全绿后批次 C 完成。
