# 六 spec 全量代码审查与验证报告(2026-09-22)

对象:9 月 21 日固化的六份 spec(验收条目 1-13)对应全部代码,审查范围 `410238c..91f3f9d`(36 个实现提交)。方法:六领域并行子代理审查(对照 spec/plan 逐条核验+全上下文精读)→ 全量修复 → 单测/typecheck/clippy → 浏览器 e2e → tauri 真机验收。

**总结论:2 Critical / 8 Important 全部修复,浏览器 e2e 16/16 通过,桌面真机 9/9 通过,全量单测绿(core 655/ui 706/desktop 110/extension 95,cargo 62,clippy -D warnings 干净)。未修项归档 `docs/plans/2026-09-22-review-backlog.md`。**

## 一、审查发现与修复映射

| 领域 | 发现 | 修复(commit) |
|---|---|---|
| 跨端同步(条目2) | **C1 跟随拉取方向失效**:本地内容 hash 门短路云端下载,options>3min 永拉不到桌面更新;popup 每开必走全量推拉,编排层无条件重推致写放大+无意义冲突副本 | `7f43c90` 跟随改 pull-only:下载后按远端字节 hash 基线去重,内容相同仅刷基线;编排层 conflict 内容相同返回 in-sync 不存副本不回推。另修 I1 凭据失效恢复闭环(onManualSynced→resume)、I2 认证失败结构化 status(CloudHttpError)、M4 开关变更即时重建轮询 |
| UI entry 交互(3/7/8/9/10/12) | I-1 双击取消与 copy await 武装竞态(timer 赋值晚于 dblclick 时取消落空,揭示仍被截断);I-2 mini 侧零测试;M-3 双击内嵌按钮穿透触发根级揭示 | `eb11a11` 揭示代次快照守卫(copy 开始快照、武装前比对,覆盖两种到达顺序);mini 抽 miniAutoHide 纯模块+竞态时序测试(旧代码验证红);按钮 `@dblclick.stop`+穿透测试 |
| foxauth 导入(11) | I-1 非 ASCII 口令(U+0080-U+00FF)atob latin1 视图致正确口令恒报错;M-2 缺口令报错文案误导 | `cba7bfa` TextDecoder 按 UTF-8 语义还原明文,KDF 保持 latin1 与官方 btoa 语义一致;文案改提示性;补 pässwörd 正反用例(修复前红) |
| 桌面开发者能力(1/4/13) | I-1 CLI stderr 报错在 attach console 之前,Windows GUI 子系统下静默 exit 2;I-2 随机端口无测试;M3 devtools_set_config 非对象 settings panic;M5 随机按钮不随 busy 禁用;M6 devtools/MCP 端口冲突静默 | `e9039ce` 带参启动前置 attach console;randomDynamicPort 纯函数+端点/值域测试;as_object 口径防护+测试;busy 禁用;devtools 与已启用 MCP 同端口拒绝+设置页错误回显(原 catch 静默回滚) |
| CI 与发布(6) | **C1 deb 非法包名**(CJK productName 违反 Debian Policy,CI 绿但 dpkg 拒装);I1 nightly tag 不删致 release 永挂首日;I3 第三方 action 未 pin SHA;M1-M8 门禁/产物/加固小项 | `ed7c7e8` productName→TOTP Tools(窗口标题显式中文不变;Windows/macOS 安装显示名变英文为已知取舍);`85c9ebe` deleteRef 重建 tag、全部 action pin 到经 GitHub API 核实的 SHA(含 dtolnay stable HEAD)、timeout-minutes、persist-credentials:false、zip 名带版本、nightly body 带日期 sha、bump 第 5 落点 Cargo.lock+无参 --check+ci 门禁接入 |
| icon 扩充(5) | I-1 生成脚本别名校验用候选清单非实际产物,上游下架会静默生成悬空别名;M-1 playstation 死别名;I-2 验收口径 300+→218 未回写 | `2d70ee1` 校验改 `!(id in icons)`+运行时悬空别名断言;删死别名(59→58);pin simple-icons 16.31.0;`97100f8` 218 裁定回写(候选清单算术上限,质量优先) |

审查同时确认的达标面:六域逐条验收全部对齐(含三端弹层 85vh 审计独立复核、foxauth 加密参数与官方 master 源码逐项核实、bump 幂等/最小 diff 实测、icon 数据零注入零悬空零流失、82a6338 修复路径全覆盖)。

## 二、浏览器 e2e(agent-browser 驱动 chrome-mv3 + 测试 shim)

**16/16 通过,0 功能失败。** 临时夹具与截图 `E:\tmp\cc\review-fix\e2e\`。

- A 组 entry 交互(5):默认打码 DOM 零真值泄漏、单击复制真值一致、双击揭示 8s 真实等待打回、双击 QR 按钮不穿透、GitHub 品牌 icon 渲染。
- B 组 跨端同步(7):autoFollow 默认开、**零写云回归**(症状 B:解锁跟随 GET-only/PUT=0)、手动同步闭环(404→PUT→回读)、**跟随首拉零写零副本**(症状 A 对偶)、云端变化采纳(云端胜出+冲突副本+基线推进,全程 0 PUT)、401 暂停警示+手动同步成功复位恢复、默认源名 i18n 英文回落零汉字。
- C 组 foxauth(2):明文粘贴导入(TOTP/HOTP 字段核对)、**真密文**(node crypto.subtle 按 HKDF/AES-GCM 官方参数构造)口令页→解密导入逐字一致、错误口令明确报错不崩。
- D 组 弹层(1):500px 矮视口 MdDialog 内滚无溢出。
- 平台边界声明:window.close/file chooser/chrome.idle shim/无 fake timers 等 6 项,详见 e2e 报告输出。冲突副本双下载事件经单测调用计数钉死为插桩副作用(非缺陷)。

## 三、桌面真机验收(tauri-mcp 驱动 dev 构建)

**9/9 通过,本轮修复重点全部实证。** 证据 `E:\tmp\cc\review-fix\realtest\`。

- 环境/标题:新代码 dev 实例+driver session 连通;窗口标题仍中文(productName 改动无影响)。
- entry 交互(桌面):打码/单击复制(链路触达)/双击揭示 8.5s 打回(码值与 RFC 6238 独立计算一致)/QR 不穿透。
- 视觉规格:外观行距 16px、分段按钮贴合胶囊圆角、解锁按钮间距 12px、验证码 system-ui+tabular-nums(getComputedStyle 断言)。
- devtools 卡片:默认关+红色警示+落盘;**端口冲突校验生效**(48215 被拒,role=alert 错误回显+输入回滚)。
- MCP 卡片:随机端口 3 次均落 49152-65535、提交落盘重启 Running、改回恢复。
- MCP e2e 脚本:11 断言全 PASS(EXIT=0)。
- headless(验收13):debug exe 直跑——`--bad-flag`/低端口/缺值/短 token 均 stderr 明确+exit 2(**I-1 修复实证**);`--headless-mcp --mcp-port 48333` 无窗口+stdout 连接行+e2e 全 PASS;token 显式覆盖生效旧 token 401;**覆盖值不落盘**(port/token 均未持久化)。
- 真机新发现并已修:三端复制失败静默(剪贴板被第三方独占时)→ `01b8be7` 三端显式错误提示+失败路径不武装自动隐藏/关窗+HOTP 不推进 counter+popup 行为测试。
- 上轮(plan17)通过项中托盘/token 轮换/审批全链/mcporter 真连/加密锁定重启未重跑(代码路径本轮无改动,headless 顺带复验锁定→解锁恢复链路)。

## 四、遗留

见 `docs/plans/2026-09-22-review-backlog.md`:产品决策 2 项(gecko id 定稿为发布阻断;foxauth 口令 UX)、增强 7 项(键盘揭示/TOCTOU 合并/envPreset 提示等)、观察记录 7 条。
