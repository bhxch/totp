# 遗留清理批次 E 真机验证记录(2026-09-27)

| | |
|---|---|
| 性质 | plan22(`docs/plans/2026-09-27-plan22-leftover-batch-e.md`)可自动化部分,由操作者代跑 |
| 基线 | 055c44e9(批次 A-D 清理完成后;含 F7 aria-live 补丁 447f8cd) |
| 环境 | debug 构建(`tauri build --debug`)+ GUI 直启 + driver-session 9223(`connected:true`,com.totp.desktop);main+mini 双窗 |
| 金库 | DPAPI 自动解锁直达 Codes 页 |

## 结果总览

| 场景 | 结果 |
|---|---|
| 场景1 D2 剪贴板重跑 | ✅ 通过 |
| 场景2(R1 验证)本地 WebDAV 替身 keep 源 | ✅ 通过(readPath+滚动删除,日志级证据) |
| 场景5 E1-E6 扩展用例 | ⏸ 平台受限,维持人工(限制见下) |
| 场景6 主题重启保留+外来键探针+销毁档+D6 | ✅ 通过 |
| 人工配合项(D3 锁屏 / OAuth+S9 / 双 desktop / E4 系统对话框) | 待用户,见文末清单 |

## 场景1:D2 剪贴板重跑 ✅

上次(2026-09-26)受阻原因为宿主机剪贴板被提权第三方进程独占;本次环境正常:

1. 复制:Codes 页点击首条目复制按钮(trusted click)→ PowerShell `Get-Clipboard -Raw` 读回 **LEN=6**(`975***`,6 位码本体)——stage 写入成功;
2. 30s+ 后复读:**CLIPBOARD_EMPTY**——自动清空承诺兑现;
3. 附带观察:F7 补丁的 `aria-live` 在本构建已生效(码文本节点属性在 DOM 可查)。

D2 主链路(复制→读回→30s 清空)通过;fail-safe 清空分支由 `should_clear_clipboard` 单测覆盖,未真机触发(无第三方占用干扰)。

## 场景2:本地 WebDAV 替身——R1 keep 源 readPath ✅

- 替身:`.temp/e2e-batch-e/webdav-standin.mjs`(127.0.0.1:49218,Basic totp:e2e-pass,请求全量落 `access.log`——readPath 的观测通道;初版漏 CORS 预检被客户端拦截,补 `Access-Control-Allow-*` 后通)。
- app 侧:Sync 页启用会话口令(Test-Backup!234)→ Add source 选 WebDAV → 填 URL/凭据 → 角色.Primary + Keep latest(默认 n=3)→ Save credentials → 三轮手动同步+一次 curl 直写。

**日志级证据**(`access.log`,OPTIONS 预检略):

| 轮 | 动作 | 关键日志 | 结论 |
|---|---|---|---|
| 1 | 首次同步(远端空) | PROPFIND → GET(同 名 exists)→ PUT `vault-20260927-235935`(T1) | 上传正常 |
| 2 | curl 直写 T3=`vault-20260927-235999`(内容复制 T1,名字比 T1/T2 新——模拟另一写入者的最新份)→ 手动同步 | PROPFIND → **GET /vault-20260927-235999 ×4** | **R1 readPath 直接证据:手动通道对自己从未写过的远端最新份发起读取**(修复前永不 GET);内容同本地 → 判 in-sync 无 PUT,符合预期 |
| 3 | 改库内容 → 手动同步 | **GET T3(readPath)** → PUT T4 | 读最新+上传 |
| 4 | 再改内容 → 手动同步 | GET T4 → PUT T5 → PROPFIND → **DELETE /vault-20260927-235935** | **keep n=3 滚动删除生效**:第 4 份落盘后删最旧,远端剩 3 份 |

结论:R1(手动通道补 readPath)与 keep 滚动删除的真机行为证据完整。**确认流回归**(下载差异化内容→两步确认→取消后基线不变)需远端存在比本地新的差异化信封,替身无法伪造有效加密信封,留待真实云账号会话(见人工项)。

## 场景5:E1-E6 扩展用例 ⏸(平台受限,维持人工)

经评估,Playwright 自动化在以下点触及平台边界,本轮不强行替代手测:

- **E1/E2**:依赖浏览器**原生右键菜单**(contextMenus.create 的菜单项点击无法经 CDP 触发);
- **E3**:需扩展端金库数据+popup 复制+系统剪贴板三方联动,headless 下剪贴板不可达,headed 需真实解锁流程;
- **E5/E4(Firefox)**:Playwright Firefox 官方不支持加载扩展;E4 的 `ext+otpauth` 系统级协议回调还会弹 OS「选择应用」对话框。

各用例维持 `docs/e2e-test.md` §3 手测登记,建议与下述人工配合项同一次会话完成。

## 场景6:重启持久化与销毁档 ✅

1. **settings 外来键探针(R9 `write_section` 真机验证)**:`settings.json` 手工注入 `"__probe__": 1` → app 内切换 blurHideEnabled → 读回:probe 保留 ✓、blurHideEnabled 翻转落盘 ✓、Rust 三组(devtools/releasePolicy/mcp,mcp.enabled=true)完整 ✓——「合并写不丢外来键」不变式在真机成立;
2. **主题重启保留**:Settings 页主题分段按钮切 Dark(themeMode=dark 落盘)→ kill+重启 → themeMode 仍 dark ✓、UI 直达 Codes 页(DPAPI 免口令,D6 核心)✓;09-24 遗留复测①(Rust 四组配置跨重启保留)在 R9 单点化后复验通过;
3. **销毁档**:`release_policy_set {pauseMinutes:0, destroyMinutes:1, lockOnDestroy:false}` → JS 隐藏 main+mini 双窗 → 95s 后 `manage-window` **totalCount:0**(webview 全销毁)且进程存活(48756)✓;托盘重建回注为人工项;
4. **销毁后恢复**:kill+重启 → 免口令直达解锁态(lockOnDestroy:false 语义)✓;release_policy 已恢复默认 {5,30,lockOnDestroy:true}。

## 人工配合项清单(待用户,建议同一次会话完成)

1. **D3 锁屏**:Win+L(人工解锁)→ system-lock 锁库;关开关复测不锁;
2. **场景3 OAuth/S9**:GDrive/OneDrive 真实云账号授权全流程(401 自愈/轮转回存)+ MS refresh_token 轮转撤销实测(S9 结论回写 backlog);
3. **场景4 双 desktop**:一端编辑→另一端 15min auto 轮拉取;冲突裁决全链(同机被 single-instance 拦截,需第二台设备);
4. **R1/R2 真实云账号复验**:keep 源差异化内容下载→**两步确认流回归**(取消→基线不变→重新提示)——替身无法伪造有效加密信封,此项是 R1 最终确认;legacy 迁移旧→新数据 diff(如有旧盘数据);
5. **E1-E6 手测**(场景5 上述平台限制原因);
6. **D1 托盘重建回注**(销毁档托盘点击→DEK 回注免解锁)。
