# 推送前评审:未推送 117 提交(24ad8a1..685dae8)

- 日期:2026-09-28
- 范围:`origin/main`(24ad8a1)→ HEAD(685dae8),117 提交,175 文件,+12361/-6478
- 方法:六路子代理分区评审(desktop Rust / desktop TS / packages/core / packages/ui / apps/extension / docs+scripts),逐文件 diff 比对旧版验证「行为不变/单点化」声明
- 机械验证(主会话实跑):typecheck 四包全绿;vitest core 1039 通过/2 跳过、ui 1068、extension 283、desktop 337 全过;cargo test 112 通过、clippy 零告警、fmt 干净;check:i18n 通过(zh=733 en=733 引用=705)

## 总评

**Ready to push: With fixes —— 0 Critical / 7 Important / 约 27 Minor。**

全部「行为不变/单点化收敛」声明经逐文件比对与全量测试验证成立(两处有意行为修正 yandex digits 6→8、`.jsonl` 白名单补齐均有留痕与测试背书)。7 项 Important 中 4 项属本批应闭环项,3 项为 24ad8a1 即存在的存量问题(建议挂 backlog 跟进,不阻塞推送)。

## 分块结论

| 分块 | 结论 | Critical/Important/Minor |
|---|---|---|
| desktop Rust(lib.rs 拆分四模块等价性、白名单镜像、serde 兼容) | Yes | 0 / 3 / 3 |
| desktop TS(DisposableBag、BackupDirSink、storeAccess 等) | Yes | 0 / 0 / 6 |
| packages/core(注册表、密码学原语、迁移下沉、retention 断环) | With fixes | 0 / 1 / 3 |
| packages/ui(store 拆分、host 层、卡片基建、MdSwitch) | With fixes | 0 / 1 / 5 |
| apps/extension(R2/R4/R16⑪、B10/B11/C3/C4) | With fixes | 0 / 1 / 6 |
| docs + scripts(计划落地一致性、e2e 记录、check-i18n) | With fixes | 0 / 4 / 4 |

## Important

### A. 本批应闭环(4 项)

**A1.[core] D1 后粘贴通道对加密 FoxAuth 的可诊断性回归,正确性依赖弱判据**
- 位置:`packages/core/src/import/registry.ts:242-248` + `src/import/paste.ts:28-34`
- foxauth 不设 needsPassword 谓词后,粘贴加密备份直接进 `importFoxauthPlaintext`(无解密能力):整串密文形态抛「缺少 accountInfos 数组」(误导);数组形态则散落 base32 failures 且 issuer/label 明文照读。不静默导入乱码条目依赖「密文恰好整串落 base32 字母表」的碰运气判据,方向是静默数据污染。`test/importPaste.test.ts:30-34` 把该回归锁定为预期,属测试固化回归。
- 修法:(a) paste.ts 分派前单判 `sniffFoxauthEncrypted`,给「加密 FoxAuth 备份请走导入页(将自动解密)」文案,不动注册表;或 (b) 登记谓词并让 ImportCard 对 foxauth 命中直接走 `parse`。PASTE_PASSWORD_GUIDE 兜底文案(paste.ts:32)「需输入口令」对 D1 后语义已过时,一并校正;放开 importPaste.test 的错误锁定。

**A2.[ui] R16⑤ onPersistError 两端宿主均未接线,生产零效果**
- 位置:`packages/ui/src/store.ts:45,263`(能力已实现且有测试 store.test.ts:67);`apps/extension/src/store.ts:39-61`、`apps/desktop/src/desktopShell.ts:72` 装配均未传
- 后果:生产环境 commit 落盘失败仍只 console.error,与改造前完全相同,「宿主可提示数据未保存」目标未实现。
- 修法:两端装配补接线(extension 桥 badge/横幅通道或至少结构化留痕;desktop 经宿主通知通道),或明确把 R16⑤ 重新裁定为「仅 ui 侧能力」并挂账 backlog。与 B1 同源。

**A3.[extension] R4 装配改写丢失「四 platform 经 props 接入 NavigationShell」回归探针**
- 位置:`apps/extension/test/optionsApp.test.ts`(对照基线 24ad8a1 版 NavStub)
- 基线 NavStub 带 props 声明并经 `shellOf()` 从 props 取平台直测(基线注释明言此为「.vue 漏接无编译期信号」的回归探针);新版 NavStub 是无 props 的 `<div/>`,31 用例无一断言 App.vue 模板把装配好的平台传给壳。NavigationShell 的 platform props 为可选,漏传 `:sync-platform` 之类 vue-tsc 不报错、测试全绿 → options 页 SyncCard/CloudCard 静默消失。终审(20b579f)回补的 8 项编排冒烟恰好漏了这一项。
- 修法:恢复 NavStub props 声明 + 一条 `shellOf(w).syncPlatform.canSync === true` 式断言,成本几行。

**A4.[docs] 四处轻量修订**
- R16⑤ 未进遗留 triage:`docs/plans/2026-09-27-leftover-cleanup-design.md` 自称「遗留项全面 triage」却漏掉 onPersistError 宿主未接线这条最大 deviations。按惯例在本日文档挂账即可(与 A2 同源)。
- check:i18n 未接 CI:`.github/workflows/` 四条流水线均无调用,C9 防死键初衷在无人手动运行时不生效。当前运行绿,接入安全,建议 ci.yml 增一步 `pnpm check:i18n`。
- 批次 E 记录基线矛盾:`docs/e2e/2026-09-27-refactor-leftover-e2e-record.md:6`(e2e-test.md §4 索引行同句)称基线 055c44e「含 F7 补丁 447f8cd」,但 055c44e(21:24)是 447f8cd(23:23)的祖先,单一基线不可能含后者;观测到 aria-live 生效说明实际树 ≥447f8cd。按「历史文档不回改」约定在此勘误:实际基线为 447f8cd(=055c44e+F7 补丁)。
- 批次 E 场景 6 证据与结论不匹配(同文件 :59 vs :58):结论称「四组配置跨重启保留复验通过」,探针证据只列三组(devtools/releasePolicy/mcp),shortcutToggleMini 无观测记录。在此勘误:如实按「三组(+外来键探针)」口径理解,第四组待真机补验。

### B. 存量问题(24ad8a1 即存在,非本批回归,建议挂 backlog)(3 项)

**B1.[rust] 文件对话框授权实际会被持久化,与模块头诚实边界声明不符**
- 位置:`apps/desktop/src-tauri/src/dialog_grants.rs:29-30`(声明)vs `persist_grants` :115-123 / `load_grants` :96-112(实现)
- persist 序列化的是 `canonical_dirs()` 全部会话登记项:导出目录经 `grant_file_parent` 登记后,任一后续 `grant_dir` 触发落盘,重启后静默重登记,下一会话被污染 webview 可直接 `dir_token_os` 取句柄。影响有限(下一会话 XSS 本可直接篡改该 JSON,边界注释已承认),但注释与实现不符。修法:仅持久化经 `grant_dir` 登记的目录(登记项加来源标记或 persist 只快照 dir-grant 子集)。

**B2.[rust] `ensure_within` 不校验叶子组件 symlink,注释 overstated**
- 位置:`dialog_grants.rs:134-145` 只 canonicalize parent 与 allowed_dir;授权目录内被植入的 symlink 叶子可穿透:`read_import_file_bytes_os`/`read_text_file_os` 读穿目录外;`write_bytes_file_os` 直写通道(std::fs::write,:455)跟随 symlink 覆写目录外文件(text 通道走 rename 替换 symlink 本身,无此问题)。前置条件苛刻(需先向授权目录植入 symlink),24ad8a1 逐字相同。修法:读/bytes 写通道改 `symlink_metadata` 拒绝叶子为 reparse point/symlink,补 symlink 用例进矩阵测试。

**B3.[rust] `load_grants`/`persist_grants` 无测试覆盖**
- 位置:`dialog_grants.rs:96-123`,AppHandle 接线代码,GRANTS_FILE 的 `Vec<String>` 格式无版本字段。修法:抽「JSON 数组 → canonicalize 过滤 → 登记」纯函数补测;做 B1 时必须补。

## Minor(归并,均不阻塞)

- [rust] `ensure_extension` 大小写语义由调用方传参决定,建议内聚两个包装(dialog_grants.rs:180-185);stashed_dek 测试触全局槽无自净化(session_vaults.rs:126-134);`default_true()` 单行函数做作但属 C6 产物保持即可(release_policy.rs:26-28)。
- [desktop TS] desktopShell.ts:278 注释「随主 try 进 loadError」不实(`listen('system-lock')` 在 try 外,失败随 init 整体失败,行为与旧一致仅注释误导);storeAccess.ts:66-68 dispose 先 splice 后遍历,中途抛错余项不执行(可 try/finally);desktopShell.ts:54-62 useDesktopI18n 在 app 为 undefined 时仍建 i18n 实例(与「逐字保持」注释有出入,无可观察影响);backupService.ts:104-107 os sink 滚动删除多 N-1 次 IPC(等价且更鲁棒,可不修);backupService.ts:205 `dirOverride` 死参数;MiniApp.vue:58 失效行号引用。
- [core] vault.ts:22「幂等」注释不准确(toOtpDigits(5)→6 正是非幂等点,建议对齐 typeProfiles.ts:151 口径);gdrive.ts:195/s3.ts:208/onedrive.ts:82 `listBackups()` 薄包装依赖 `this.listBackupsEx!()`,接口未约定 this 绑定;typeProfiles.ts:134-138 `as` 断言仅收形可接受。
- [ui] MdSwitch 受控化残留 DOM checked 漂移(md/MdSwitch.vue:7-13,消费方无拒绝路径,可 onChange 末尾强制回写);两套 saveConflictBackup 参数序相反(host/cloudPlatform.ts:75-77 vs host/cloudRunner.ts:111,建议统一或改对象参数);手动同步排队期无「排队中」反馈(CloudCard.vue:374-376,留观);host/** 为三包覆盖率统计盲区(vitest.config.ts:17-24 已声明,收紧 CI 覆盖率时记得);卡片常量 setup 期取词不随 locale 切换(与旧一致,记录)。
- [extension] syncEngine.ts:130 远端为合法 JSON 非对象('null'/'123')时 spread 得残串整键替换本端 settings(旧代码同款既有洞,修法 parse 后加形状守卫);background.ts:21-28 notify() 无 `.catch`(顺手补齐口径);offscreen ack rejection 吸收路径无直接用例;optionsPlatforms.ts:171 F5 clipboardNote 注入值无断言;cloudRunnerFactory.ts:27 `revSeal` 再导出仅测试引用可删;popup 包体增量待 `pnpm build` 前后对比(预计极小,不阻塞)。
- [docs] M2 源码改动混入 docs 类型提交(241a503 含 mcpCard.ts `as const`,正文有披露,危害小);cleanup-design §5 F10/F1 两处落点漂移未回标(实施更优,建议补半句);09-26 e2e 记录「R16-uiext 受阻」无下文括注;check-i18n 扫描面硬编码 .vue/.ts,脚本头建议注明。

## 值得记录的亮点(抽样)

- Rust 四模块拆分为逐行验证的等价搬迁;R11 白名单编译期 `include_str!` 内嵌 optionsPlatforms.ts 互验三端一致,13×5 允许/拒绝矩阵测试锁定(dialog_grants.rs:833-941、990-1010)。
- core HMAC/truncateU31 收敛有 RFC 2202/4231 向量锚定;sniffFormat 全序 35 探针双锁定;R2 迁移「以 extension 版为准」声明属实且三项差异守卫用例真实。
- ui store 拆分逐函数对照等价,5 平行 Map 收敛 WindowSession 把「成对更新靠纪律」变结构保证;host overrides 纪律(同型 vs 注入清单)无一超线;B10 修复还顺带收窄了旧缺陷(远端 syncEnabled 不再被坏数据裹挟,含竞态注入测试 syncEngine.test.ts:588-660)。
- extension readSyncStatus 单点化修复了旧实现丢 pct 的隐性缺陷(SyncCard 占用百分比行此前在 options 页永不显示)。
- 文档:14 项交付物抽查全部真实落地,backlog 划线六项零虚报,e2e 记录诚实(D2 受阻不编造、批次 E 用 WebDAV 替身取得 GET T3×4 直接证据、真实云确认流不冒充)。

## 处置建议

1. A1/A2/A3 建议推送前或紧随其后的一个小修复批闭环(A1 与 A2 也可裁定为「有意后置」挂账,但需明确记录);A4 前两点(check:i18n 接 CI、R16⑤ 挂账)建议随手做,后两点勘误已由本文件按约定记录。
2. B1-B3 挂 backlog(2026-09-22-review-backlog.md),与安全边界相关建议排前。
3. Minor 随后续批次顺手处理,不设专门批次。
