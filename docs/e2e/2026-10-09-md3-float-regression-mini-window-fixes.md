# 2026-10-09 MD3 浮动 label 回归 + mini 窗口修复批 真机走查

四项用户报告问题，四笔原子提交（ffd9dad / baea844 / 403b06e / 273f0fb），
debug 构建（tauri dev + mcp-bridge 127.0.0.1:9223）真机实证。

## 走查结论：4/4 实测达标

### 1. 主界面输入框/下拉框浮动 label 与内容行重叠（ffd9dad）

根因：`ba6e6a1`（56dp 收敛）把 input 原 `padding: 22px 16px 6px` 归零迁入
flex 居中容器，丢掉了浮动 label 的顶部预留——浮动 label 顶带 y8..24 与居中
内容行 y16..40 重叠 8px。MdSelect 同构，且 box 注释声称的 `padding: 0 16px`
从未落地（值文本贴左缘 0）。

真机实测（主窗 codes 页搜索框，有占位符恒浮动态）：

| 指标 | 修复后实测 | 预期 |
| --- | --- | --- |
| field 高 | 56px | 56 |
| label 带 | [76, 92] | y8..24（16px 行高） |
| input 行 | [95.5, 119.5] | y27.5..51.5 |
| 重叠 | **0px** | 0（间隙 3.5px） |
| 有值态（输入 "git"） | floated=true, 重叠 **0px** | 同上 |

安全页 MdSelect：box 高 56，label [364.5,380.5] / 值行 [384,408] 重叠 **0px**；
值文本 left=128 vs box left=112 → **16px 水平 padding 生效**（修复前贴 0）。

### 2. 验证码页「搜 secret」复选框未对齐（baea844）

根因：`62b6679` 给 `.md-checkbox__label` 加 `min-height: 48px` 后 span 成
48px 高块、文字顶在块首，与 18px 勾选盒垂直错位约 13px。

真机实测（codes 页搜索行）：勾选盒中心 **96** == 文字中心 **96**，完全对齐。

### 3. mini 收起按钮无效（403b06e）

根因：R1-M2 起收起钮走 `window.close()` 复用 Rust CloseRequested 拦截链，
但 capabilities 从未授予 `core:window:allow-close`（core:default 仅 getter），
调用被 ACL 拒绝、CloseRequested 不触发。

真机实测：webview-interact 点击 `[data-test="hide-btn"]`（命中 (182,21)）→
窗口 visible: true→**false**（拦截链 记位→隐藏 生效），console 无 denied/rejected。

### 4. mini 无法调整窗口大小（273f0fb）

用户裁定放开 spec §1.4/§1.5 固定尺寸（历史文档不回改，以本节留档 deviation）。
无边框窗 tauri 无原生 resize 边缘：`resizable(true)`（系统层放行）+ 前端 8 向
fixed 热区 startResizeDragging + `LAST_MINI_SIZE` 尺寸记忆（与位置同源三隐藏
路径共用，恢复时先尺寸后定位）+ min_inner_size 240×320 逻辑。

真机实测（SendInput 被环境吞，改用页面派发 pointerdown + SetCursorPos 驱动
系统 resize 循环）：

- 派发 `.rz--East` pointerdown → 窗宽 666 → **1386 物理**（跟随光标）✓
- 夹取：异常态回落至 **480 物理 = 240 逻辑 × DPR2**，恰为 min_inner_size ✓
- 附带发现：resizable(true) 后 Windows 给无边框窗 ~6.5 逻辑 px 不可见原生
  resize 边框（outer 666 vs 视口 640 物理），热区在边框内侧 5px，两段互补
- 测试伪影备注：合成派发不像真实用户先激活窗口，resize 期间失焦触发未
  pin 态自动隐藏（focused(false)→hide 为既有设计）；真实拖拽窗口持焦不受影响

## 环境坑（后续走查复用）

- 已装 release 版（E:\app\totp-desktop.exe）驻留时 dev 实例被 single-instance
  让位直接退出（exit 0 假象）；先 taskkill 再 dev
- **SendInput 输入注入被吞**（ESET/完整性级别）：SetCursorPos 可用、
  SendInput/mouse_event 静默失效（光标不动、返回值成功）——真机拖拽类走查
  改用「页面派发 pointerdown + SetCursorPos 驱动循环」套路
- manage-window info 坐标为窗口 outer 物理值；页面级精确映射用
  `outerPosition()` + `window.screenX/Y` 换算（本例客户区原点物理 (552,542)）
- SendInput 绝对坐标按虚拟屏（SM_XVIRTUALSCREEN 等 76..79）映射而非主屏

## 自动化验证

pnpm -r test 全绿（core 72 文件 / ui 120 文件 / extension 24 文件 / desktop
32 文件 393 用例）；pnpm -r typecheck 4 包全绿；cargo test 228 passed；
cargo clippy / fmt --check 干净。新增用例：MdTextField/MdSelect 浮动态类
钩子行为+源码断言、MdCheckbox 居中源码断言、MiniApp 8 向热区方向断言
（mock 补 startResizeDragging 成员）。

## 遗留

- 36 笔未推送 origin（累积至此批）
- LAST_MINI_SIZE 重建路径（释放策略销毁→快捷键重建）未真机驱动，逻辑简单
  （remember 三路径共用 + toggle 恢复分支先尺寸后定位），靠单测与下一次走查
- 用户若偏好 mini 默认尺寸/记住尺寸策略调整，属产品决策另议
