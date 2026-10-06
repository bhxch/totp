# P5 右键快捷新增全格式文本 + data:URL 图片 + Firefox 通知回退 真机冒烟清单

对应计划：docs/superpowers/plans/2026-10-07-p5-quick-add.md（Task 1/2：background 信封双菜单升级 + popup 消费端 kind 分派）

前置：扩展 `pnpm -F @totp/extension dev`（Chrome / Firefox 各加载 dist）；测试库可空。夹具：

- SteamGuard 单条 JSON（shared_secret 须 20 字节，生成：`python -c "import base64;print(base64.b64encode(b'\xff'*20).decode())"`）：
  `{"shared_secret":"<上一步输出>","serial_number":"12345678901","steamid":"76561190000000000"}`
- data: URL 图片页：任一含 otpauth 二维码的 PNG 转 base64，存为本地 HTML `<img src="data:image/png;base64,...">` 后打开

## Chrome 选中文本右键（快捷新增，pending 信封 kind=pasted）
- [ ] 选中单条 otpauth URI → 右键「将选中的 otpauth 链接添加为条目」→ popup 自动打开 + EntryForm 预填确认态（issuer/label 与 URI 一致）→ 保存落库后回列表
- [ ] 选中 SteamGuard 明文 JSON（单条）→ 右键同菜单 → popup 预填 issuer=Steam、type=steam、digits=5、note 含 serial_number → 保存落库
- [ ] 消费即清：保存/取消后重开 popup 不再出现旧预填（DevTools 查 `storage.local` 无 `pendingOtpauth` 残留）
- [ ] 选中多行 otpauth URI（多条）→ 不写 pending、不弹 popup → 通知「识别到 N 条，请打开主界面导入页完成批量添加」
- [ ] 选中不可识别文本 → 通知透传嗅探文案（如「无法识别粘贴内容格式」），不弹 popup
- [ ] 抽查 P2 粘贴白名单其余单条格式（如 2FAS 单条分享 JSON、totpAuthenticator 明文数组）→ 预填对应 issuer
- [ ] 旧格式兼容：DevTools 写 `pendingOtpauth` = 裸 `'otpauth://totp/Smoke:smoke?secret=JBSWY3DPEHPK3PXP'` → 打开 popup 预填（升级用户旧盘残留值，decodePending null 回退路径）

## Chrome 图片右键（QR 识别，pending 信封 kind=uri）
- [ ] data: URL 图片（base64 内嵌页 `<img>`）右键「识别图中的验证码二维码」→ fetch data: 成功解码 → 通知「已识别验证码二维码…」+ popup 打开预填 URI
- [ ] http(s) 图片二维码照常识别（回归：activeTab fetch 路径未被 data: 分支影响）
- [ ] 非二维码图片右键 → 通知「图中未识别到有效的 otpauth 二维码」，不写 pending

## Firefox 通知回退（无 openPopup 能力）
- [ ] 选中文本右键（单条）→ 出现「TOTP 验证码工具 / 已识别待添加内容，点击完成添加」通知（id= totp-pending-add）
- [ ] 点击该通知 → 新标签页打开 popup.html → 自动进入预填确认态（同 Chrome 消费路径）→ 保存落库
- [ ] QR 图片识别失败/无 pending 时的一般通知点击不误开 popup.html（onClicked 只认 totp-pending-add）

## 双浏览器回归
- [ ] `?uri=` 协议回调（Firefox `ext+otpauth:`）不受信封改造影响：仍走 URI 预填确认态
- [ ] SW 冷启动（开发者工具重启 service worker）后右键菜单三项仍在、`notifications.onClicked` 监听仍生效
- [ ] 非法预填值（如手工写入 `pendingOtpauth: 'junk'`）→ popup 报错横幅常显、不渲染表单、值被清除不重弹

## 重点观察项
- [ ] selection 菜单标题仍为「将选中的 otpauth 链接添加为条目」，但实际已支持全格式文本（P5 Task 1 未改文案）——文案与能力的脱节是否调整，走查后裁定
- [ ] data: URL 页面右键时 activeTab 授权是否覆盖 data: scheme（Chrome 对 data: 页面权限口径）——若 fetch 被拒走统一失败通知，记录实际表现
- [ ] SteamGuard 预填的 note（serial/revocation）在表单内可编辑且随保存落库
