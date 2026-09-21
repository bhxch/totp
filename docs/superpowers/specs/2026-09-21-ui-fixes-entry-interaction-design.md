# 设计：UI 修复与 Entry 交互重构（验收条目 3/7/8/9/10/12）

## 背景与目标

验收反馈 4 处样式问题、1 处弹窗可访问性问题，以及 entry 列表交互重构需求：
验证码默认隐藏、单击复制、双击显示、移除查看 secret 入口、新增明确复制按钮。
目标：一次批量修复样式债，并把验证码的防旁观数字提升为默认行为（三端一致）。

## 现状与根因

| 条目 | 现象 | 根因 |
|---|---|---|
| 7 | 主题三态切换背景是直角矩形，与胶囊外框不匹配 | `packages/ui/src/components/md/MdSegmentedButton.vue`：容器 `.md-seg` 为 100px 胶囊描边，但 `.md-seg__item` 未设 border-radius，选中段 `secondary-container` 填充呈直角 |
| 8 | Theme color 与 Pure black (AMOLED) 间距异常 | `packages/ui/src/pages/SettingsPage.vue` 外观卡片内各 `.row` 之间无任何纵向间距（MdCard 内容区无 gap/rhythm），色点行（30px）与开关行高度不齐加剧观感 |
| 9 | 安全卡片两个 Unlock methods 按钮紧贴 | `packages/ui/src/components/SecurityCard.vue` `.unlock-methods` 容器无 flex column gap，两个 tonal 按钮（添加 Passkey / 启用 OS 解锁）上下堆叠紧贴 |
| 10 | 验证码字体应为无衬线黑体 | `OtpListItem.vue` 的 `.code` 目前为 `ui-monospace`（Windows 上 Consolas，偏细） |
| 12 | Edit entry 弹窗矮视口下无法滚动，底部内容不可达 | `packages/ui/src/components/md/MdDialog.vue` `.md-dialog` 无 `max-height`、无 `overflow-y`，超高内容被 scrim 居中后上下两端溢出裁切 |
| 3 | 验证码明文常显；缺明确复制按钮；🔑 查看 secret 按钮不要 | `OtpListItem.vue` 行内 🔑 reveal 按钮 + 6 位码常显；单击复制已存在 |

## 设计

### §1 分段按钮圆角（条目 7）

`MdSegmentedButton.vue`：

- `.md-seg__item:first-child { border-radius: 100px 0 0 100px; }`
- `.md-seg__item:last-child { border-radius: 0 100px 100px 0; }`
- 单 option 时（`:only-child`）全圆角。选中填充随 item 形状自然贴合胶囊。

### §2 外观卡片行间距（条目 8）

`SettingsPage.vue` 外观卡片：default slot 内容包一层 `div.appearance-rows`，
`display: flex; flex-direction: column; gap: 16px;`，并给色点行与开关行统一 `min-height` 对齐。
不改 MdCard 全局布局（避免波及所有卡片）。

### §3 安全卡片按钮间距（条目 9）

`SecurityCard.vue`：`.unlock-methods { display: flex; flex-direction: column; gap: 12px; }`。

### §4 验证码字体（条目 10，落点收敛为 1 处）

条目 3 重构后揭示容器（RevealDialog / mini 揭示卡片 / popup onReveal）全部删除，
验证码唯一展示点为三端共用的 `OtpListItem.vue` `.code`。修改：

- `font-family: system-ui, sans-serif`（无衬线黑体）；
- `font-weight: 700`；
- `font-variant-numeric: tabular-nums`（无衬线下保持数字等宽，倒计时不抖动）；
- 打码形态 `••• •••` 同样式展示（见 §6）。

### §5 弹窗滚动与可访问性审计（条目 12）

1. `MdDialog.vue`：`.md-dialog { max-height: 85vh; overflow-y: auto; }`（一期整体滚动，
   不做 header/footer sticky 布局）。
2. 全仓弹层审计（用户要求，一并修）：枚举所有 `position: fixed` 弹层——
   `EntryFormDialog`、`OtpQrDialog`、MCP 审批弹窗、导入相关弹窗及各处自定义 scrim——
   统一验收标准：**小视口（约 500px 高）下内容可滚动、底部操作按钮可达**。
   走 MdDialog 的自动继承修复；自定义弹层逐个补同款约束。
3. 顺带核对 `focus trap` 与 `Esc` 关闭在滚动容器下不回归（现有行为为基线）。

### §6 Entry 交互重构（条目 3，核心改动全在共享组件）

**`OtpListItem.vue`（packages/ui，三端自动生效：桌面主窗口 / mini 小窗 / 扩展 popup）**：

1. 移除 🔑 reveal 按钮与 `reveal` emit。
2. 新增「复制」图标按钮（content-copy 图标，`@click.stop`），复用现有 `emit('copy')` 链路
   （宿主写剪贴板 + 定时清除 + HOTP 复制后 counter 递增语义不变）。
3. 6 位码默认打码为 `••• •••`（显示层打码；`code` prop 仍传真值，复制语义不变）。
4. 单击条目 = 复制（现状保留）；**双击条目 = 显示真实码 8 秒后自动打回**（`@dblclick`，
   组件内部 revealed 状态 + setTimeout）。双击会先触发一次单击复制——无害且符合直觉，不做延迟判定。
5. QR 按钮、右键菜单、倒计时环均不动。

**三宿主死代码清理**（🔑 入口移除后成为不可达代码）：

- `CodesPage.vue`：删 `onReveal` 与 `<RevealDialog>` 接线；`RevealDialog.vue` 若无其他使用方则删组件文件与测试。
- `MiniApp.vue`：删揭示卡片内联块、`revealing` ref 与 `@reveal` 接线。
- `extension popup/App.vue`：删 `onReveal` 处理。

**seed 出口收敛**：编辑表单的 secret 字段与 QR 弹窗（三端一致的现有功能），列表层不再提供。

**i18n**：复制按钮的 aria-label/tooltip 双语文案；打码/显示无文案需求。

## 验收

- 组件测试：OtpListItem 单击 emit copy；双击后显示真值、8s 后恢复打码；打码态渲染断言（不含真值）。
- 现有 `store.lockRace` / reveal 相关测试同步修剪。
- 矮视口（500px 高）下逐弹窗手动过一遍 + visual judge 渲染检查。
- 三端冒烟：desktop 主窗、mini 小窗（alt+shift+t）、extension popup 各点一遍。

## 非目标

- 弹窗 sticky header/footer 布局重构。
- MiniApp 功能扩展（仅随 §6 删揭示卡片）。
- 双击显示时长的用户可配置化（固定 8s）。
