# P3 条目布局重构 + toast 体系 真机冒烟清单

对应计划：docs/superpowers/plans/2026-10-07-p3-item-layout-toast.md（spec docs/superpowers/specs/2026-10-06-seven-features-design.md §3）

前置：桌面 `pnpm -F @totp/desktop dev`、扩展 `pnpm -F @totp/extension dev`（浏览器加载 dist）；准备含 HOTP 条目、超长名称条目（issuer+label 拼接 > 行宽）、零标签条目、置顶/非置顶混合的测试库。

## 桌面 CodesPage 新布局
- [ ] 行顶进度条：2px 高、每秒离散步进（无平滑补间动画）；progress≤1/3（非 HOTP、非占位）转红色 urgent；HOTP 条目无进度衰减
- [ ] 两行结构：上行「服务商/名称」（空 label 只显 issuer、空 issuer 只显 label），下行大号验证码 + ▣ 二维码按钮；环形倒计时与剩余秒数不再出现
- [ ] 长名跑马灯：名称超行宽时横向滚动（约 8s/循环）；名称变短后动画消失
- [ ] 打码/揭示：默认 `••• •••`；双击或 Shift+Enter 揭示 8s 后自动打回
- [ ] 右键菜单 6 项（顺序）：复制验证码 / 编辑 / 显示二维码 / 复制 otpauth URI / 删除 / 置顶切换
- [ ] 右键复制 HOTP：粘贴值与单击复制一致且 counter 递增（与 dd2dab8 同口径）
- [ ] 右键删除：进入行内两击确认，3s 无操作自动退出
- [ ] 复制 toast：单击行 / Enter / 右键复制验证码均在底部居中出现深色圆角「已复制」，约 3s 消失；同文案连点刷新计时不叠加；点击可手动关
- [ ] 批量导入：batchToast 横幅不再出现，改为 toast 显示「已导入 N 条」
- [ ] 冻结滚动：条目多时滚动列表，SearchBar + 标签 chips 行 sticky 钉在顶部不随内容滚走

## Mini 走查
- [ ] 条目为新两行布局（行顶进度条 + 上名下码），无操作按钮（无二维码钮、无复制钮）
- [ ] 单击复制后条目 500ms 自动隐藏即反馈；不出现 toast（MiniApp 不挂 ToastHost）

## 扩展 popup
- [ ] 条目为 popup 形态新布局（showQr=false）：两行 + 行顶进度条，无操作按钮
- [ ] 复制成功 → 底部 toast「已复制」；复制失败 → 红色 error toast；旧「已复制/复制失败」横幅不再出现
- [ ] 关窗时序：复制后按 popupCloseDelayMs 延迟关窗，toast 在关窗前可见不被截断

## 扩展 options CodesPage
- [ ] 同桌面 CodesPage 走查项：新布局 / 右键 6 项 / 复制 toast / 冻结滚动（挂载 ToastHost）

## 重点观察项
- [ ] 跑马灯 160px 假设：keyframes 以 `calc(-100% + 160px)` 估算可视宽；在实际条目宽度（窄窗/宽窗、有/无 QR 钮）下目测滚动终点不露白、不过冲
- [ ] 零标签态宽窄窗：无任何标签时 chips 行收窄后冻结区不遮挡首条目、无空白塌陷；宽窗下冻结区背景与页面同色不突兀
