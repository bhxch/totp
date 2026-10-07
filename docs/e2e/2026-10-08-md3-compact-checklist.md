# MD3 紧凑批 + ABE 失败分类文案 真机清单

对应计划：docs/superpowers/plans/2026-10-08-md3-compact-service-fixes.md（spec §2/§3；Task 1 token 体系、Task 2/3/4/5/6/7/8/9 布局紧凑档、Task 11 失败文案分类）。
前置：桌面 `pnpm -F @totp/desktop dev`（主窗 + mini 双窗）、扩展 `pnpm -F @totp/extension dev`（浏览器加载 dist）；准备宽/窄两种窗口尺寸、深色/浅色/AMOLED 三种主题、含 HOTP 条目与置顶混合的测试库；Windows 真机另备 ESET（或等效第三方杀软）与日志目录 `%ProgramData%\TotpTools\service\`。

## 三端布局冻结与卡片描边

- [ ] 桌面主窗宽窗：CodesPage 条目区滚动时 SearchBar + 标签 chips 行 sticky 钉在顶部不随内容滚走；窄窗（拖到最小宽）同样成立且无横向溢出
- [ ] 桌面主窗 + 扩展 options：MdCard outlined 单层描边（M3 双描边裁定——卡片边界仅由外层 MdCard 提供，内层组件无重复边框线）
- [ ] 三端（主窗/mini/扩展 popup）窗缘贴边时卡片描边不裁切、圆角完整

## mini/popup 紧凑档观感

- [ ] mini 紧凑档：头部区域总高约 104px（titlebar + 搜索行收拢），目测无大段留白；条目行高 48px 档，两行内容（上名下码）不挤不叠
- [ ] 扩展 popup 紧凑档：头部约 104px、行 48px 同 mini 口径；popup 宽度下长名称/长验证码不折行错位
- [ ] CodesPage（主窗/options）行 56px 档：默认档行高目测 56px 上下（progress 2px + 两行内容），与 mini/popup 48px 档形成可辨识的密度差
- [ ] 单页条目数：窄窗主窗下一屏可见条目数明显多于改版前（56px 档收拢后目测对比，记录大致条数）
- [ ] 进度条逐行等长：列表内每行顶部进度条长度一致（随行宽拉伸，无长条/短条混杂）；HOTP 行无进度衰减、进度条不闪动
- [ ] 悬浮框（tooltip/复制气泡等悬浮提示）为单行气泡形态：不换行、不出三角箭头残影、深浅色下可读

## 主题跟随与首帧（Task 1 断链验证）

- [ ] 深色主题：mini 窗底色与主窗一致（mini.html 首帧底色随主题，无白底闪烁→深色跳变）
- [ ] 浅色主题：mini 底色同为主窗浅色背景，无深色残留
- [ ] AMOLED（纯黑 palette）：mini 底色跟随纯黑（#000 系），与主窗背景一致；popup 同样核对首帧防闪底色
- [ ] 桌面 index.html 防闪内联生效：冷启动首帧背景与最终主题色一致（无 blue 种子闪帧）

## 弹窗与表单交互

- [ ] 弹窗 headline 观感：headline-small 24px 档，与内容区层级清晰；scrim 半透明遮罩下背景可辨识且弹窗对比充分，深浅色均成立
- [ ] EntryForm 回车提交探针（dialog 形态）：焦点在任一输入框时按 Enter 触发提交（display:none 默认提交钮的隐式提交链路），不出现误清空/双提交
- [ ] EntryForm 回车提交探针（popup 形态）：popup 内快速新增表单 Enter 提交同样成立（两形态共用 display:none 提交钮方案，真机各验一次）
- [ ] dense 搜索框浮动 label 40px 槽视觉核对：mini/popup 搜索框 --dense 档下浮动 label 收进 40px 槽不与输入值重叠、不裁切下沿；聚焦/有值两态各看一次

## 触控命中抽查

- [ ] mini titlebar 收起/置顶按钮：视觉 32px、命中区约 40px（::after 扩展），触控/点击无 miss
- [ ] popup 条目行右缘操作按钮与 OtpListItem compact 档按钮：命中区不小于视觉区，相邻按钮不误触（命中带重叠时 topmost 胜出为预期）
- [ ] EntryForm 标签勾选列（纵排 checkbox）快速连点两行间隙，确认不误触发相邻行
- [ ] 触屏设备（或有触屏的机器）抽查：codes 卡片 FAB、标签 chips、TagFilterRow mode-toggle 命中正常

## ABE 安装服务全链路（Windows 真机）

- [ ] ESET（或等效杀软）排除 `C:\ProgramData\TotpTools\service\` 目录（信任区加目录排除，非仅进程信任）
- [ ] 安全页「安装服务」→ 一次 UAC 同意 → 区块变已绑定态，toast「应用绑定解锁已启用」；全程仅一次 UAC，UI 不冻结
- [ ] `install.log`（%ProgramData%\TotpTools\service\）核对：安装步骤逐条落盘无 ERROR；`service.log` 服务侧启动无异常
- [ ] `sc query TotpToolsElevationService` RUNNING；`reg query HKLM\SOFTWARE\TotpTools\Elevation` 四值齐全
- [ ] 锁定 → 数秒内静默自动解锁（abe 通道端到端）；验证码可读
- [ ] 换主口令（服务在线）→ ABE 区块保持已启用态（在线恢复路径），锁屏自动解仍成立
- [ ] NSIS 卸载（或提权 `--elevation-uninstall`）→ 服务/副本目录/HKLM 键清理干净（细项见 2026-10-07-abe-service-checklist §5）

## 三类失败文案各触发一次（Task 11 分类验证）

- [ ] 取消 UAC：「安装服务」弹出 UAC 后点「否」→ 内联提示「已取消 UAC 授权或未完成授权，安装中止」，busy 复位不卡死，保持未安装态
- [ ] 安装失败：制造失败场景（如临时以拒绝权限方式干扰服务目录，或停用 Windows Installer 类策略）→ 文案「安装失败：{Rust detail}；详情可查看日志 %ProgramData%\TotpTools\service\install.log」，detail 与 install.log 记录一致
- [ ] 未就绪：安装放行但阻断服务可达（如安装后立即以杀软拦截服务启动/占住管道）→ 文案「服务未就绪：若安装了第三方安全软件（如 ESET），请将 C:\ProgramData\TotpTools\service\ 加入信任后重试」
- [ ] 三类失败后均可直接重试收敛为成功态（重试不再残留上一次提示）；en 语言下三类文案同步切换且无插值残漏（{detail} 正确替换）
