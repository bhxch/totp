# 全量基线审查修复与裁定记录（2026-09-24）

来源：2026-09-24 对全部特性基线（docs/plans 17 份 + docs/superpowers/specs 10 份，共 27 份设计文档）的代码对照审查。本文为**裁定与勘误的集中记录**：docs 下以日期开头的历史文档均为归档、反映演变过程，不再回改；后续 spec 层面的演进勘误统一追加到本文。

## 一、产品裁定（用户确认）

| # | 裁定 | 说明 |
| --- | --- | --- |
| D1 | **WinAuth XML 导出取消** | 总体设计（2026-09-13）§9 曾定案「导出明文/加密 WinAuth XML（回导 WinAuth）」，从未实现且无勘误。经确认**该项需求取消**：导出面维持 Aegis（明/密）+ otpauth URI 文本 + envelope 三类；WinAuth 仅保留**导入**侧（明文/口令加密/DPAPI 仅桌面）。 |
| D2 | **扩展 API 通道定案为 extApi 自建通道** | 批⑧ plan 曾留痕修正（2026-09-23-batch8-improvements.md §对 spec 1.3 的实现级修正）：不采用 `import { browser } from 'wxt/browser'`（vitest 无宿主环境下 wxt polyfill 行为不可控），统一走 `apps/extension/src/extApi.ts` 的 `globalThis.browser ?? globalThis.chrome` 通道；spec 1.3 所定 `packages/ui/src/extensionCapabilities.ts` **不建**，能力探测以 `extApi.ts` 的 `canOffscreen/canIdle/canOpenPopup/canSetBadge` 收拢（packages/ui 无 wxt 依赖的约束不变）。 |
| D3 | **扩展端 backupMode/backupKeepN 只读化石保留** | options 页两键无设置入口、扩展端全仓无写入方，但历史残留值仍生效于备份下载文件名偏好，删除属行为变更；保留读取并注释为「只读兼容化石」。 |
| D4 | **renameTag 维持不查重** | tag-upgrade spec §1「同名唯一」不变式以实现为准：查重收敛仅在创建路径（addTag/ensureTag），重命名只改名不做重名合并（packages/core/src/vault.ts 注释为有意决策）。 |

## 二、spec 演进勘误（代码已演进、原 spec 未回写，以本文为准）

1. **envelope v1 示例已废**：总体设计 §6 示例停在 v1；代码为 v2（`kdf.profile`/`aead`）+ v3 云同步信封，v1 读兼容已放弃（应用未发布）。
2. **IconRef 为三 kind**：总体设计 §8 的四 kind（builtin/extra/stored/url）以 plan7 定案的三 kind（builtin/stored/url）为准；URL 缓存键实际为 `urlcache:` 前缀命名空间（I58 加固，非 stored 混存）。
3. **plan9 三处被替代方案吸收**：a) `sync:meta.sha256` 完整性字段从未实现——由 base64 严格解码 + fatal UTF-8 + `validateVaultObject` 承担；b) LWW「相等比 updatedAt」平局规则由 appliedRev 设备本地记账 + 推送前重拉收敛替代；c) 同步区超限检测由「写前 getBytesInUse」改为「写后占用 >90%」。
4. **Steam URI 仅按 host 判定**：总体设计 §5「`otpauth://steam/` 及 issuer=Steam 兼容识别」中的后者已移除（I32），仅保留 host 判定；解码统一 RFC4648 base32。
5. **扩展权限实际清单**：总体设计 §10 勘误清单之外，实际已追加 `idle`、`clipboardRead`（批⑧），chrome 端另含 `offscreen`。
6. **释放策略实现级事实**：TrySuspend 经 `ICoreWebView2_3`（webview2-com 0.38 绑定中 TrySuspend 声明在 _3，spec 所写 _6 仅有 OpenTaskManagerWindow）；TrySuspend 为异步、失败不回退销毁计时（从 Pause 时刻起算，注释在案的有意取舍）；窗口由代码内 builder 创建（`tauri.conf.json` 的 `windows: []`，`enable_clipboard_access` 仅 builder 可配，批⑧真机修复）。
7. **MCP 保存刷新走 get_config**：`mcp_set_config` 返回 `Result<(), String>` 不回传 cfg，前端保存后经 `mcp_get_config` 对账刷新（与 spec「以 set 返回 cfg 刷新」功能等效）。
8. **云同步内容门（auto）已实现**：旧「无变化跳过不可达/互踢」结论作废——auto 模式持久内容基线命中且内容未变时降级 pull-only 零上传；manual 轮仍不设门（README 已同步改写）。

## 三、本轮修复清单（2026-09-24）

**P0**
- settings.json 跨层互踩：前端 `createTauriFs` 对 `settings` 键改读改写合并（`mergeSettingsPreservingForeign` 纯函数），保留 Rust 侧 `shortcutToggleMini/devtools/releasePolicy/mcp` 外来键；此前前端任意一次保存设置会整文件覆盖抹掉四组 Rust 配置。
- 用户自选备份目录与 dialog_grants 落盘改 `write_text_atomic`（原 `std::fs::write` 直写，overwrite 模式半写即损毁唯一份备份）。

**Important**
- DEK 暂存槽锁库即清：Rust 新增 `clear_stashed_dek` 命令，store opts 新增 `onLocked` 桥（主窗/mini 均注入）——修复「stash 后 destroy 失败回滚 → 手动锁库 → 销毁重建回注旧 DEK 绕过锁定」链路。
- 批量入库成功提示条数（CodesPage 轻量提示条，粘贴/剪贴板批量共用）。
- 导入预览前 3 条落地（ImportCard confirm 区，总体设计 §9 静默缩水项）。
- `FieldMap.transform` 僵尸契约兑现（none=仅去空白不大写 / uppercaseSecret 默认）。
- popup 四条回退提示 i18n 化（原硬编码中文）。
- CI：typecheck 前补 `wxt prepare`（干净环境缺 `.wxt` 类型致 `defineBackground` 报错）；`cargo fmt` 全量归位；actions/checkout、actions/setup-node、pnpm/action-setup 升至 v6（Node 24 运行时，消除 Node 20 弃用告警）。

**死代码清理（逐项调查定性）**

| 项 | 定性 | 处置 |
| --- | --- | --- |
| `set_global_shortcut` 命令 | 快捷键自定义 UI 从未立项（git -S 仅 f108524 引入，docs 无计划，前端零调用） | 删命令与注册；保留启动读 `shortcutToggleMini` 覆写的活特性 |
| `dpapi_protect/unprotect` 命令 + 前端 `dpapiProtectOs/dpapiUnprotectOs`/`hasDpapiSource` | os_auto_* 与 dpapi_* 同一实现，三平台统一通道后无消费方 | 删；`dpapiSource` 本体保留（SecurityCard 在用）；`dek_*_inner`/base64 工具保留（os_auto 与 decrypt_dpapi 共用） |
| `otp/uri.ts` Steam 字母表死三元 + `void STEAM_ALPHABET` | 忘清理（Steam 解码统一 RFC4648 后残留） | 删；STEAM_ALPHABET 常量保留（steam.ts 在用） |
| `WinauthEntryInput` 死类型 | 忘清理（plan5 契约接口，实现改走 XML 解析后零引用） | 删 |
| `importEnte` 孤儿导出 | Ente 并入 uriBatch 后无生产消费；加密报错等价迁入 uriBatch | 删函数，3 项专测迁 uriBatch |
| extension `store.ts` `commit`/`storeCommit`/`storeCommitSettings` 再导出 | 忘清理（ui 重构后零引用） | 删 |
| extension `removeConflictCopy` | 生产死代码（5 份滚动删由 `addConflictCopy` 内部 slice 实现） | 删，测试保留坏数据回落断言 |
| `chromeStorage.ts` 命名 | MV2 双命名空间时代命名名不副实 | 更名 `storage.ts` |
| firefox 产物 `offscreen.html` 死文件 | entrypoint 未按目标排除 | WXT 原生 `<meta name="manifest.include" content='["chrome"]'>`（官方 isEntrypointSkipped 机制） |
| `CLOUD_BACKUP_PATH` deprecated 死导出 | 兼容理由已不成立（零引用） | 删 |
| OtpListItem `aria-haspopup` 死声明（mini）+ QR 死入口 | 宿主未接菜单/面板却恒渲染 | 组件加 `contextMenu`/`showQr` prop（默认 true 不影响已接宿主），mini 传 false；mini 排序补 pinned 优先 |
| FOUC 镜像缺 contrast | AMOLED 演进后未同步 | writeMirror 补 contrast + 四入口内联脚本还原 |

**注释/文档同步**
- README 双语：Firefox 构建命令、yaotp、🔑 揭示→双击揭示、分组→标签、`urlcache:`、测试数去数字化、cargo test、内容门已知限制改写、License 节。
- 过时注释：`ensure_window`（conf 同参→builder 硬编码）、headless gate 打印 `{:?}`→线格式小写、sniff/miscApps 的 M1 XML 表述、「旧单页」措辞、EntryForm `url:` 前缀、MiniApp locked 初值描述。
- backlog（2026-09-22-review-backlog.md）：B1 gecko id 已于批⑧定稿，标记解决。

## 四、License

仓库采用 **MIT**（LICENSE 文件 + 各 package.json `license` 字段 + README License 节）。依据：全部运行时依赖为宽松许可（vue/vue-i18n/wxt/fflate/hash-wasm/sql.js/@tauri-apps = MIT；tauri 及 Rust 生态 = MIT OR Apache-2.0；simple-icons = CC0-1.0），无 copyleft 传染项，MIT 可用。
