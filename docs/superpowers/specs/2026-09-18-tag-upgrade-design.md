# 设计：分组（Group）全面升级为标签（Tag）

日期：2026-09-18
状态：已与需求方对齐，待实施

## 背景与目标

现分组（Group）体系为「条目多对多、筛选单选」：`entry.groupIds: string[]` 已支持一条目属多组，但筛选端只有 CodesPage 单选 chips，Popup 完全没有分组概念，外部导入器对源格式中的分组键零处理。

目标：

1. 将 Group 语义全面升级为 Tag（标签），管理端、筛选端、编辑端一致。
2. Popup 与管理页均支持 tag 过滤，多选 + AND/OR 可切换。
3. 外部软件配置导入时，把源格式中的分组键（分组/文件夹）导入为 tag。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 存储兼容策略 | **直接重写，零迁移**——项目未发布，vault JSON 键名一步到位改新，不写读时兼容代码 |
| 过滤形态 | **统一多选**（popup 与管理页同一交互），行首提供 AND/OR 切换按钮 |
| 选中态持久化 | **做成设置项**：`rememberTagFilter` 开关（默认关），开则选中集合持久化、跨打开/跨页面保留 |

## §1 数据模型（core）

`packages/core/src/model.ts`：

- `Group` → `Tag { id: string; name: string }`。**删除 `order` 字段**：现状 order 仅创建时赋值、从不提供排序编辑，tag 展示改为按名称 `localeCompare` 字母序，顺序可预测。
- `OtpEntry.groupIds: string[]` → `tagIds: string[]`。
- `Vault.groups: Group[]` → `tags: Tag[]`。
- `Vault.version: 1` → `2`。不写任何迁移代码。

`packages/core/src/vault.ts`：

- `addGroup/renameGroup/removeGroup` → `addTag/renameTag/removeTag`；`removeTag` 仍负责清理所有条目中的悬空引用。
- **同名唯一**：名称 trim + 大小写不敏感查重。避免筛选 chips 出现重复词。
- `addTag` 与 `ensureTag` 均返回 `{ vault, tagId }`：`addTag` 遇同名**复用现有 tag**（幂等）；`ensureTag` 查重命中复用、未命中创建——供导入路径与 EntryForm 内联建 tag 批量落库。

## §2 标签过滤引擎（core）

新模块 `packages/core/src/tags/filter.ts`，core `index.ts` 加 `export *`：

```ts
type TagFilterMode = 'any' | 'all'
function filterByTags(entries: OtpEntry[], selectedTagIds: ReadonlySet<string>, mode: TagFilterMode): OtpEntry[]
```

- `any` = 并集（条目命中任一选中 tag）；
- `all` = 交集（条目包含全部选中 tag）；
- **悬空 tagId 一律视为不命中**，不做防御性修复。
- 纯函数、无浏览器 API 依赖，CodesPage 与 Popup 共用。

## §3 UI（ui 包 + 扩展 Popup）

### 共享组件 `TagFilterRow`

- props：`tags / selectedIds / mode`，v-model 双向。
- 行首 AND/OR 切换按钮：**仅 ≥2 个 tag 选中时可用**，否则禁用并维持当前模式；当前生效模式有可视标识。
- 后接 MdChip 多选点选（点选切换选中集合）；「全部」chip 一键清空选择。
- CodesPage 与 Popup 复用同一组件，交互完全一致。

### 管理页 CodesPage

- `groupFilter: string | null` → `selectedTagIds: Set<string>` + `tagFilterMode`。
- 沿用现有悬空分组 watch 模式：tags 被删除/同步后，自动从选中集合剔除失效 id。
- 过滤链路：搜索 → tag 过滤 → 列表（与现状组合顺序一致，把单选分组判定换成 `filterByTags`）。
- GroupManagerDialog → TagManagerDialog：增/改/删能力不变（删 = 清引用）。

### Popup（apps/extension）

- SearchBar 下方插入 `TagFilterRow`。visible 链路：**全库 → 搜索 → tag 过滤 → URL 过滤**。
- URL 零匹配回退语义修订：从「显示全部」改为「**回退到 tag 过滤后的集合**」——tag 过滤始终被尊重。
- 选中态行为由设置项控制（见下）；AND/OR 模式始终持久化（偏好属性）。
- Popup 不做 tag 管理（增删改只在 options 端）。

### 设置项（core/storage/vaultStore.ts + SettingsPage）

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `tagFilterMode` | `'any' \| 'all'` | `'any'` | AND/OR 过滤模式，始终持久化，popup 与管理页共享 |
| `rememberTagFilter` | `boolean` | `false` | 「记住标签筛选」开关，SettingsPage 提供勾选 |
| `lastTagFilterIds` | `string[]` | `[]` | 选中集合持久化载体；仅 `rememberTagFilter` 开启时读写 |

- 开关开启：popup 与 CodesPage 读写同一份 `lastTagFilterIds`——popup 关闭再开、跨页面均保留上次选择；开关关闭：选中态仅会话内有效，**已存值不清除**（重新开启即恢复）。
- 字段校验走 `loadSettings` 现有 DEFAULT_SETTINGS 合并 + 类型守卫兜底模式。
- 悬空 tag 清理对持久化选择同样生效。

### EntryForm

- 分组复选框列表 → tag 复选框列表（现有 `toggleGroup` 模式平移为 `toggleTag`）。
- 新增**内联快速建 tag**：小输入框 + 回车（或按钮），走 `ensureTag` 创建并自动勾选——补上「建分组必须先开管理弹层」的断点。
- 提交时过滤未填写的空 tag。

## §4 导入器映射（core/import）

### 中间类型

`ParsedEntry` 增可选字段 `tags?: string[]`：保留源格式中的原始名称，仅 trim，不做大小写归一。

### 四个有分组键的格式补映射

| 源格式 | 源字段 | 映射方式 |
|---|---|---|
| Aegis | `db.groups[]` + 条目 `groupid` | uuid→name 查表 |
| 2FAS | `groups[]` + 服务 `groupId` | id→name 查表 |
| Bitwarden | `folders[]` + 条目 `folderId` | id→name 查表 |
| andOTP | 条目 `tags: string[]` | 直接取数组 |

- 其余格式（FreeOTP / Proton / Stratum / TOTP Authenticator / WinAuth / uriBatch / generic）源格式无分组键，不动。
- 查表 miss 容错：条目引用的 groupid/folderId 在分组表中不存在时**静默丢弃该 tag**，不报错不建空 tag。

### 落库

导入结果收集全部 tag 名 → 逐个 `ensureTag` 建入 vault → 条目挂 id。

### 冲突管线

- `conflict.ts`：新增条目携带导入 tags；`replace` 策略 tags 取**并集**（现有 ∪ 导入，不丢任何一边）；`skip` 不动。
- `dedup.ts`：相同性键**不含 tags**——沿用 groupIds 的既有理由（来源分组不是内容相同性依据），注释同步更新。

## §5 波及面确认（无需改动项）

- 备份/云同步/桌面端：vault JSON 经 envelope 整体透传，无 groups 显式引用，键名变化自动随行；桌面与扩展共用 ui/core，自动生效。
- matchRules、图标、PRF、加密层、剪贴板清理均不涉及。

## §6 测试

- **core**：tag CRUD（同名复用幂等、remove 清引用）；`filterByTags` any/all + 悬空 id；四导入器 tag 映射（含查表 miss）；conflict replace 并集、skip 不动；dedup 不受影响。
- **ui**：`TagFilterRow`（多选切换 / AND-OR 按钮禁用态 / 悬空清理）；CodesPage 搜索+tag 组合链路；EntryForm 内联建 tag。
- **extension**：popup 全链路（搜索 → tag → URL + 零匹配回退尊重 tag 过滤）；`rememberTagFilter` 开/关两种选中态行为。
- 收尾：全包 `vue-tsc` + vitest 全绿；用户可见文案「分组」→「标签」全量替换（含 aria-label、title、提示语）。

## 边界语义速查

| 场景 | 语义 |
|---|---|
| 同名 tag（trim + casefold 相同） | 复用现有，不建第二个 |
| 条目引用已删除的 tag | removeTag 时已清理；残留悬空 id 视为不命中 |
| URL 过滤零匹配 | 回退到 tag 过滤后的集合（tag 始终尊重） |
| 导入 replace 冲突 | tags 并集；skip 不动 |
| dedup 判重 | 不看 tags |
| AND/OR 切换 | ≥2 选中才可用；模式全局持久 |
| rememberTagFilter 关闭 | 选中态会话内有效；不清除已存值 |
