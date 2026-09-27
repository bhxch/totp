# 批次 A:遗留清理·立即批 实施计划(plan18)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 更正 README 过时限制、backlog 划线,并收敛重构(2026-09-26,16 项)留下的 7 处小尾巴。

**Architecture:** 纯文档更正 + S 级代码收敛(importFileFilters 常量化+镜像断言、i18n 死键、App.vue i18n 接入、偏好类型合一、extension 归一化委托)。不改任何行为语义(除 importFileFilters 补 `.jsonl` 的展示层对齐)。

**Tech Stack:** TypeScript / Vue 3 / vitest / vue-i18n / pnpm monorepo。

**Spec:** `docs/plans/2026-09-27-leftover-cleanup-design.md`(§2 L1、§3 批次 A、§4 批次 A 表 A1-A7)。本计划论证自 spec,执行者需同时读 spec §1-§4。

## Global Constraints

- 每任务原子 commit;`git add` 只加本任务文件,禁止 `git add -A`/`git add .`;提交前 `git status --short` 确认无夹带。
- commit message 遵循 Angular 规范,标题尾缀 `(batch A)` 或正文注明任务号。
- 全仓门禁由批次末统一跑(`pnpm typecheck && pnpm -r --no-bail run test`);任务内只跑定向测试。
- README 已知限制的 ②⑤⑥ 三行本批不动(由批次 D 对应任务 F3/F5/F6 同步更新);本批只处理已过时的 ③ 行。
- i18n 修改必须 zh/en 双文件同步,键序一致。

---

### Task 1: 更正 README 已知限制③(部分失败推进基线——已过时)

**Files:**
- Modify: `README.md:361`

**Interfaces:** 无代码接口。产出:README 该行删除(审查 I8 后"部分失败不推进基线"已是行为事实,不再是已知限制)。

- [ ] **Step 1: 删除过时行**

删除 `README.md:361` 整行:

```markdown
- **桌面自动备份部分失败仍会推进基线**：任一目录写入失败时基线照常前进且状态行记「成功」，后续不再自动重试，需手动备份补写
```

依据(现状代码已与此行矛盾):`apps/desktop/src/autoBackup.ts:98-102`「仅全部启用源成功才写 lastBackupHash(部分/全部失败不写基线,下轮同内容也会重试)」;`apps/desktop/src/backupPlatform.ts:101-103` 同口径。

- [ ] **Step 2: 验证其余四行与现状一致**

Run: `rg -n "手动云同步不设内容门|Google Drive|重启后保持锁定|Firefox（MV3）|云端列表无分页" README.md`
Expected: 剩余 5 行(①②④⑤⑥)仍存在。②⑤⑥ 由批次 D 更新,本任务不动;④ 前半"开关当前无效果"已过时但由批次 D Task F2 一并更正,此处不动。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): 删除已过时的「部分失败仍推进基线」限制(batch A)

why: 审查 I8 后 autoBackup.ts/backupPlatform.ts 均为「仅全部源成功才写
lastBackupHash,部分失败不推进、下轮重试」,该行描述的是修复前状态。
what: 删除 README 已知限制中该行。"
```

---

### Task 2: backlog 划线回写(S3/S5/S6)

**Files:**
- Modify: `docs/plans/2026-09-22-review-backlog.md:45,47,48,100-101`

**Interfaces:** 无代码接口。产出:backlog 活文档三条目划线,落地记录补 S5 行。

- [ ] **Step 1: 划线 S3/S5/S6**

参照同文件 B19/B20 已划线格式(`~~原文~~` + 加粗修复说明),把:

```markdown
| S3 | CloudCard 缺 mergedDegraded 专用文案 | 降级合并时卡内显示「已合并」与 runner 摘要「降级合并」不一致;状态行 ACTION_LABEL_KEY 补分支即可 | 终审 Minor |
```

改为:

```markdown
| S3 | ~~CloudCard 缺 mergedDegraded 专用文案~~ | **已落地（2026-09-26 R1 文案表合并,复用 cloudRunner.action.mergedDegraded 同键,cloudSyncShared.ts:24;原记录 a106d39）** | 终审 Minor |
```

S5(47 行)改为:

```markdown
| S5 | ~~测试 fixture 旧口径 hash~~ | **已落地（2026-09-26 R15,core 侧 23 处测试 fixture 全量迁 contentHashVault——cloudSync/multiTarget/twoDevice/canonical;ui cloudRunner.test 无 contentHash 直引,复核无残留）** | 终审修复波复审 |
```

S6(48 行)改为:

```markdown
| S6 | ~~cloudRunner.noChange 死键~~ | **已落地（zh/en 删除 a106d39;2026-09-27 复核 rg 无残留）** | 终审修复波 |
```

- [ ] **Step 2: 落地记录区补 S5 行**

在第 100-101 行的落地记录表追加一行(S3/S6 已有):

```markdown
| S5 测试 fixture 旧口径 hash | core 23 处迁 contentHashVault(随 R15) | (R15 批次) |
```

- [ ] **Step 3: 验证**

Run: `rg -n "noChange" packages/ui/src packages/ui/src/i18n`
Expected: 无输出。Run: `rg -n "contentHash\b" packages/core/test/cloudSync.test.ts | head -3`
Expected: 命中的均为 `contentHashVault` 行(无旧 `contentHash(` 调用)。

- [ ] **Step 4: Commit**

```bash
git add docs/plans/2026-09-22-review-backlog.md
git commit -m "docs(backlog): S3/S5/S6 划线(已随 R1/R15 落地)(batch A)

why: 三项经 2026-09-27 复核已分别由 R1 文案表合并与 R15 fixture 迁移完成。
what: backlog 活文档划线并补 S5 落地记录。"
```

---

### Task 3: desktop importFileFilters 补 `.jsonl` + 常量化 + 三端镜像断言

**Files:**
- Modify: `apps/desktop/src/backupPlatform.ts:90-94`
- Test: `apps/desktop/src/backupPlatform.test.ts`(追加用例;文件已存在)

**Interfaces:**
- Consumes: Rust 侧常量 `IMPORT_TEXT_EXTENSIONS`/`IMPORT_BINARY_EXTENSIONS`(`apps/desktop/src-tauri/src/dialog_grants.rs:162,165`,带点前缀)。
- Produces: `packages/ui` 无涉;desktop 内 `importFileFilters()` 使用的派生常量 `IMPORT_TEXT_EXTS`/`IMPORT_BINARY_EXTS`(无点、`as const`)。测试经 `node:fs` 读 Rust 源做集合互验(模式参照 `packages/ui/test/md/mdInputs.test.ts` 的 readFileSync 源码断言先例)。

- [ ] **Step 1: 写失败测试(镜像断言)**

在 `apps/desktop/src/backupPlatform.test.ts` 末尾追加(desktop vitest 为 node/jsdom 环境,`node:fs` 可用):

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IMPORT_BINARY_EXTS, IMPORT_TEXT_EXTS } from './backupPlatform'

/** A3 三端对齐:desktop 对话框过滤器与 Rust 导入白名单(dialog_grants.rs)集合互验。
 *  Rust 常量带点('.json'),desktop 过滤器不带点('json'),比较时归一去点。 */
describe('importFileFilters 与 Rust 导入白名单镜像(batch A)', () => {
  it('文本组+二进制组与 Rust IMPORT_TEXT/BINARY_EXTENSIONS 集合一致(含 .jsonl)', () => {
    const rustSrc = readFileSync(join(__dirname, '../src-tauri/src/dialog_grants.rs'), 'utf8')
    const grab = (name: string): string[] => {
      const start = rustSrc.indexOf(`const ${name}`)
      expect(start).toBeGreaterThanOrEqual(0)
      const open = rustSrc.indexOf('[', start)
      const close = rustSrc.indexOf(']', open)
      return rustSrc
        .slice(open + 1, close)
        .split(',')
        .map((s) => s.trim().replaceAll('"', '').replaceAll("'", '').replace(/^\./, ''))
        .filter((s) => s.length > 0)
    }
    const rustAll = [...grab('IMPORT_TEXT_EXTENSIONS'), ...grab('IMPORT_BINARY_EXTENSIONS')].sort()
    const tsAll = [...IMPORT_TEXT_EXTS, ...IMPORT_BINARY_EXTS].sort()
    expect(tsAll).toEqual(rustAll)
    expect(tsAll).toContain('jsonl')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/desktop exec vitest run src/backupPlatform.test.ts -t "镜像"`
Expected: FAIL(`IMPORT_TEXT_EXTS` 未导出)。

- [ ] **Step 3: 常量化并补 `.jsonl`**

`apps/desktop/src/backupPlatform.ts:90-94` 改为:

```typescript
  // 导入对话框过滤器:A3 单点化——文本组+二进制组与 Rust dialog_grants.rs 的
  // IMPORT_TEXT_EXTENSIONS/IMPORT_BINARY_EXTENSIONS 集合互验(见 backupPlatform.test.ts 镜像用例),
  // 防三端漂移(R11 历史漂移:Rust/extension 已含 .jsonl 而 desktop 过滤器缺)。
  // .db 经文本读取报 UTF-8 错时由 ImportCard 转字节入口复查(见 read_import_file_bytes_os);AP .zip 走字节通道
  const importFileFilters = (): DialogFilterSpec[] => [
    { name: tr('desktop.filterImport'), extensions: [...IMPORT_TEXT_EXTS, ...IMPORT_BINARY_EXTS] },
  ]
```

并在文件顶部(platform 工厂外)新增导出常量(不带点,与 Rust 带点形态在测试中归一比较):

```typescript
/** A3 导入扩展名单点(与 src-tauri/src/dialog_grants.rs 白名单镜像互验;不带点形态供 DialogFilterSpec) */
export const IMPORT_TEXT_EXTS = ['json', 'jsonl', 'wauth', 'xml', 'txt', 'aegis'] as const
export const IMPORT_BINARY_EXTS = ['db', 'sqlitedb', 'sqlite', 'zip'] as const
```

同时删除原 90-91 行旧注释("与 Rust 端 read_import_file_os 扩展名白名单一致(.json/.wauth/.xml/.txt/.aegis)"——旧口径已失真)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/desktop exec vitest run src/backupPlatform.test.ts`
Expected: PASS(既有用例 + 新镜像用例全绿;desktop 全量 336 例不受影响)。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/backupPlatform.ts apps/desktop/src/backupPlatform.test.ts
git commit -m "fix(desktop): 导入对话框过滤器补 .jsonl 并与 Rust 白名单镜像互验(batch A)

why: R11 后 Rust/extension 白名单均含 .jsonl 而 desktop 过滤器缺,三端漂移
(用户切「所有文件」仍可导入,展示层不一致);旧注释已失真。
what: importFileFilters 改文本组+二进制组派生常量,补 .jsonl,新增 vitest
镜像用例读 dialog_grants.rs 常量做集合断言。"
```

---

### Task 4: 删除 i18n 死键 cloudCard.action* 四键

**Files:**
- Modify: `packages/ui/src/i18n/locales/zh/common.json:329-332`
- Modify: `packages/ui/src/i18n/locales/en/common.json:329-332`

**Interfaces:** 无。前提已核实:全仓(locales 外)无任何 `cloudCard.action` 引用;现役键为 `cloudRunner.action.*`(cloudSyncShared.ts:19-24 单点消费)。

- [ ] **Step 1: 复核零引用**

Run: `rg -n "cloudCard\.action" --glob '!**/locales/**' .`
Expected: 无输出。若有输出,停下核对该引用是否为动态拼接键,不得盲删。

- [ ] **Step 2: zh/en 各删四行**

zh(329-332)删除:

```json
    "actionUploaded": "已上传",
    "actionDownloaded": "已下载",
    "actionMerged": "已合并",
    "actionInSync": "已是最新",
```

en(329-332)删除:

```json
    "actionUploaded": "Uploaded",
    "actionDownloaded": "Downloaded",
    "actionMerged": "Merged",
    "actionInSync": "Up to date",
```

- [ ] **Step 3: 验证**

Run: `pnpm --filter @totp/ui exec vitest run test/importFormatsI18n.test.ts && pnpm --filter @totp/ui test`
Expected: ui 全量测试绿(i18n JSON 无 schema 测试,删除后 vue-i18n 按需查键,无缺失影响)。

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "chore(ui): 删除 cloudCard.action* 四个死 i18n 键(batch A)

why: R1 文案表合并后状态行动作键统一走 cloudRunner.action.* 单点,
cloudCard.action* 零引用(rg 复核)。
what: zh/en common.json 各删 4 行。"
```

---

### Task 5: 主窗 App.vue 接入共享 useDesktopI18n

**Files:**
- Modify: `apps/desktop/src/App.vue:5,6,30-47`
- Test: 既有 `apps/desktop` 全量测试兜底(desktopShell.test 覆盖 mountI18n 行为)

**Interfaces:**
- Consumes: `useDesktopI18n(): DesktopI18n`(`apps/desktop/src/desktopShell.ts:48-64`,R13 已落位,MiniApp.vue:23 已消费)。
- Produces: 无新接口;App.vue 内联 i18n 胶水(30-47 行)删除,`DesktopShellDeps.mountI18n`(desktopShell.ts:242)签名不变。

- [ ] **Step 1: 替换内联段**

`App.vue:5` 导入中删除 `createAppI18n`(保留 LockScreen/NavigationShell 等):

```typescript
import { LockScreen, NavigationShell, type IconStore, type VueStore } from '@totp/ui'
```

新增(并入既有 desktopShell 导入块,若已有该块则加成员):

```typescript
import { useDesktopI18n } from './desktopShell'
```

删除 30-47 行整段(`appForI18n`/`i18nInstalled`/`i18nRef`/`tr`/`mountI18n` 五个声明),原位替换为:

```typescript
// i18n 胶水收敛至 desktopShell.useDesktopI18n(R13,与 MiniApp 同款实现):
// app 引用在 setup 同步段捕获;插件只能装入一次,mountI18n 重复调用为 no-op
const { tr, mountI18n } = useDesktopI18n()
```

`shell` 装配(105-115 行)与 `mountI18n` 传参不变。

- [ ] **Step 2: 清理孤儿导入**

Run: `rg -n "getCurrentInstance|shallowRef" apps/desktop/src/App.vue`
Expected: 若删段后无其他使用,从 vue 导入中移除对应符号;仍有使用则保留。

- [ ] **Step 3: 验证**

Run: `pnpm --filter @totp/desktop exec vue-tsc --noEmit && pnpm --filter @totp/desktop test`
Expected: typecheck 绿 + desktop 全量测试绿(desktopShell.test 的 mountI18n/i18n 用例不受影响——共享实现即原实现)。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "refactor(desktop): 主窗 App.vue 接入共享 useDesktopI18n(batch A)

why: R13 抽出的 i18n 胶水仅 MiniApp 接入,主窗仍持 18 行内联副本(当时
App.vue 不在 R13 允许清单)。
what: 删内联五声明改一行解构,行为不变(desktopShell.test 兜底)。"
```

---

### Task 6: ui 偏好类型合一(AutoPrefsShape)

**Files:**
- Modify: `packages/ui/src/components/backupPlatform.ts:3-8`
- Modify: `packages/ui/src/components/cloudPlatform.ts:54-55`
- Modify: `packages/ui/src/index.ts:46`(追加 AutoPrefsShape 导出)
- Modify: `apps/desktop/src/desktopPrefs.ts:25-29`(私有 ChannelAutoPrefsShape 改别名)
- Test: 既有全量兜底(纯类型改动,无运行时变化)

**Interfaces:**
- Produces: `packages/ui` 新导出 `interface AutoPrefsShape { onChange: boolean; onInterval: boolean; intervalMinutes: number }`;`BackupAutoPrefs`/`CloudAutoPrefs` 均 `extends AutoPrefsShape`(成员集不变,消费方零改动)。
- Consumes: `normalizeAutoPrefs<P extends BackupAutoPrefs>`(backupPlatform.ts:92)约束不变——BackupAutoPrefs extends Shape 后仍兼容。

- [ ] **Step 1: 定义共享形状并让两接口继承**

`backupPlatform.ts:3-8` 改为:

```typescript
/** 自动偏好共用形状(batch A 类型合一):BackupAutoPrefs/CloudAutoPrefs 同构三字段,
 *  归一化(normalizeAutoPrefs)/状态文本(formatAutoStatusText)经本形状约束 */
export interface AutoPrefsShape {
  onChange: boolean
  onInterval: boolean
  intervalMinutes: number
}

/** 自动备份偏好(D2):onChange=变更后自动备份;onInterval=定时自动备份;intervalMinutes=定时间隔(分钟) */
export interface BackupAutoPrefs extends AutoPrefsShape {}
```

`cloudPlatform.ts:54-55` 改为:

```typescript
/** 云同步自动触发偏好(变更触发/间隔触发及间隔分钟数;与 BackupAutoPrefs 共用 AutoPrefsShape) */
export interface CloudAutoPrefs extends AutoPrefsShape {}
```

(顶部补 `import type { AutoPrefsShape } from './backupPlatform'`。)

- [ ] **Step 2: 导出面与 desktopPrefs 收口**

`packages/ui/src/index.ts:46` 附近的类型导出区追加:

```typescript
export type { AutoPrefsShape } from './components/backupPlatform'
```

`apps/desktop/src/desktopPrefs.ts:25-29` 私有接口 `ChannelAutoPrefsShape` 整体替换为别名(删原 interface 定义):

```typescript
type ChannelAutoPrefsShape = AutoPrefsShape
```

(:18 的 `@totp/ui` 类型导入追加 `AutoPrefsShape`。)

- [ ] **Step 3: 验证**

Run: `pnpm --filter @totp/ui exec vue-tsc --noEmit && pnpm --filter @totp/desktop exec vue-tsc --noEmit && pnpm --filter @totp/extension exec vue-tsc --noEmit && pnpm -r --no-bail run test`
Expected: 三包 typecheck 绿 + 全量测试绿(纯类型收敛,零运行时差异)。

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/backupPlatform.ts packages/ui/src/components/cloudPlatform.ts packages/ui/src/index.ts apps/desktop/src/desktopPrefs.ts
git commit -m "refactor(ui): BackupAutoPrefs/CloudAutoPrefs 合一为 AutoPrefsShape(batch A)

why: 两接口三字段同构,归一化函数 R14 已单点而类型仍双份,漂移面残留。
what: 新增 AutoPrefsShape 两接口 extends;desktopPrefs 私有形状改别名;
纯类型改动零运行时差异。"
```

---

### Task 7: extension 归一化副本委托 ui 单点

**Files:**
- Modify: `apps/extension/src/optionsPlatforms.ts:79-91`

**Interfaces:**
- Consumes: `normalizeAutoPrefs<P extends BackupAutoPrefs>(x: unknown, fallback: P): P`(`@totp/ui` 导出,index.ts:64;CloudAutoPrefs extends BackupAutoPrefs 结构兼容)。
- Produces: `normalizeCloudAutoPrefs(parsed)` 私有函数签名不变,实现改一行委托。

- [ ] **Step 1: 改委托**

`optionsPlatforms.ts:82-91` 的函数体替换(注释同步):

```typescript
/** 归一化经 ui normalizeAutoPrefs 单点(batch A,与 desktop loadChannelPrefs 同源):
 *  布尔严格 === true 判定;间隔非法/<15min 回落 fallback 间隔(60) */
function normalizeCloudAutoPrefs(parsed: unknown): CloudAutoPrefs {
  return normalizeAutoPrefs(parsed, DEFAULT_CLOUD_AUTO_PREFS)
}
```

顶部 `@totp/ui` 导入块追加值导入 `normalizeAutoPrefs`(该块当前仅类型导入,需拆出值导入或合并为混合导入,按 tsconfig verbatimModuleSyntax 现状处理)。

- [ ] **Step 2: 语义差确认**

Run: `rg -n "MIN_AUTO_INTERVAL_MINUTES" packages/ui/src/components/backupPlatform.ts`
Expected: 单点钳制下限 15 与副本注释语义一致(布尔严格判定、`Number.isInteger`、`>= 15`);若发现语义差(如副本无 Number.isInteger),停下对照归一化测试再改,不得静默变更行为。

- [ ] **Step 3: 验证**

Run: `pnpm --filter @totp/extension exec vue-tsc --noEmit && pnpm --filter @totp/extension test`
Expected: typecheck 绿 + extension 全量(280 例)绿;钳制行为用例(optionsApp.test 中 CloudAutoPrefs 读写相关)不回归。

- [ ] **Step 4: Commit**

```bash
git add apps/extension/src/optionsPlatforms.ts
git commit -m "refactor(extension): normalizeCloudAutoPrefs 委托 ui normalizeAutoPrefs 单点(batch A)

why: R14 下沉归一化单点后 extension 仍持最后一份 15min 钳制副本(当时
optionsPlatforms.ts 不在允许清单),「三份归一化全并」剩此一里。
what: 函数体改一行委托,签名与消费接口不变。"
```

---

## 批次收尾

- [ ] 全仓门禁:`pnpm typecheck && pnpm -r --no-bail run test`,全绿后批次 A 完成。
- 批次 A 不含 Rust 改动,无需 cargo 检查。
