# P4 miniapp/popup 快速取码面板统一 + 右键直达主界面 真机冒烟清单

对应计划：docs/superpowers/plans/2026-10-07-p4-quick-panel.md（spec docs/superpowers/specs/2026-10-06-seven-features-design.md §4）

前置：桌面 `pnpm -F @totp/desktop dev`、扩展 `pnpm -F @totp/extension dev`（浏览器加载 dist）；准备含多标签、零标签、置顶/非置顶、HOTP 条目的测试库；Firefox 需配置 `ext+otpauth:` 协议回调（`?uri=` 路径用）。Chrome 与 Firefox 各完整走一轮。

## 扩展 popup（快速取码面板）
- [ ] header「打开主界面」按钮（codes 图标）点击 → 新标签页打开 `options.html#/codes`；设置齿轮仍直达 `#/settings`
- [ ] background 右键菜单：action 图标右键与普通页面右键均出现「打开主界面」，点击同样建 `options.html#/codes` 标签页；原两项（选中文字添加 otpauth / 图片二维码识别）不受影响
- [ ] URL 过滤：开启 urlFilterEnabled 后仅显示当前站点匹配条目，行内出现「匹配 N 条」hint；关闭开关恢复全量
- [ ] 四级回退提示：无标签页 URL（新标签页打开 popup）时放宽提示仍可达（hint 不被门控吞掉）
- [ ] 标签筛选 tab 行：chips 点击选中/取消，∧/∨ 切换任一/全部模式；选中集合随 popup 关闭重置（会话级，不持久化）
- [ ] 冻结滚动：条目多时滚动列表，SearchBar + 标签 chips 行 sticky 钉在顶部（背景 surface 不透字）
- [ ] 快捷新增（pendingOtpauth 模拟）：DevTools 向 `storage.local` 写 `pendingOtpauth: 'otpauth://totp/Smoke:smoke?secret=JBSWY3DPEHPK3PXP'` 后打开 popup → 直接渲染 EntryForm 确认态（无 Tab、纯手动路径）→ 保存落库后回列表且新条目可见
- [ ] 快捷新增（?uri= 协议回调，Firefox）：`ext+otpauth:` 链接触发 → 同样进入确认态 → 保存落库；取消则不落库
- [ ] 空态两态文案：空库显示「暂无条目，点击右上角「打开主界面」录入。」；有条目但搜索/筛选无结果显示「无匹配结果」
- [ ] 复制反馈：单击条目 → 底部 toast「已复制」→ 按 popupCloseDelayMs 延迟关窗且 toast 在关窗前可见不被截断；双击揭示同时取消自动关窗（I-1 代次守卫）
- [ ] 精简确认：popup 内无「添加」常驻钮、无粘贴导入 details、无双 tab、无条目右键菜单、无行内 ops、无二维码 dialog（管理面全部只在主界面态）
- [ ] PersistErrorBanner / LockScreen：锁库时 popup 显示锁定屏，解锁后恢复面板

## Mini 走查（桌面 QuickCodesPanel 装配）
- [ ] 标签筛选 tab 行出现：chips 选择 + ∧/∨ 任一/全部切换生效；筛选会话级（重开 mini 重置），tagMode 跟随全局设置并写回
- [ ] 冻结滚动：SearchBar + chips 行 sticky，列表独立滚动
- [ ] pin 置顶：钉住后失焦不再自动隐藏；取消钉住恢复
- [ ] 复制自动隐藏：单击复制后条目 500ms 自动隐藏即反馈（不出现 toast）；pinned 状态下复制仍自动隐藏（让位口径不变）
- [ ] 锁定态搜索行：主窗锁定 → mini 跟随锁库（面板不可用，搜索行随锁定态门控变化）；解锁后恢复且数据重载（知悉即可，非缺陷判定项）
- [ ] 悬空标签：在主界面删除某标签后，mini 的 chips 行不再出现该标签、选中集合被清理

## 双浏览器差异（Chrome 与 Firefox 各一轮）
- [ ] popup 布局/冻结/筛选行为一致；toast 表现一致
- [ ] Firefox：`ext+otpauth:` 协议回调确认态；Chrome：右键菜单 pendingOtpauth 路径（或 DevTools 模拟）
- [ ] background 右键菜单三项目在两浏览器均正常注册（SW 重启后不缺失）

## 重点观察项
- [ ] URL 过滤滤空的语义微差（记录用，非缺陷）：URL 过滤把全部条目滤空且无搜索词、无标签选中时，面板显示的是 empty 文案（「暂无条目…录入」）而非 noMatch——与「库里真没有条目」共用一文案，语义有微差；spec 裁定维持现状，走查时确认表现与该结论一致
- [ ] popup 空 tags（零标签库）：chips 行整体隐藏（tagRow && tags.length>0 门控），冻结区不出现空白塌陷
- [ ] 快捷新增确认态样式：EntryForm 无 Tab 包裹后单列布局在窄 popup 宽度下不溢出
