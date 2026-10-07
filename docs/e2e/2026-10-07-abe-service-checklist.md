# ABE 提权服务（P6）真机验证清单

对应计划：docs/superpowers/plans/2026-10-07-p6-abe-service.md（§0 ABE 设计正本）。
历次审查挂账的真机验证项已全部并入本清单：T2 慢客户端阻塞 Stop 观察、T3 目录抢占 OWNER_RIGHTS / HKLM WOW64 / StopPending 竞态、T4 命令阻塞段真机体感、T7 unwrap 端到端。

前置：Windows 10/11 真机（管理员账户，可弹 UAC）；`pnpm -F @totp/desktop tauri build` 产 NSIS setup 或 `pnpm -F @totp/desktop dev` 跑桌面；vault 已启用库加密；另开一个管理员终端备用（`sc` / `reg` / `icacls` 复核）。审计命令速查：

```bat
sc query TotpToolsElevationService & sc qc TotpToolsElevationService
reg query HKLM\SOFTWARE\TotpTools\Elevation
icacls "%ProgramData%\TotpTools\service"
```

## 0. SecurityCard 三态走查（dev 即可，Task 9 冒烟）

- [ ] 非 Windows / extension 宿主：ABE 区块不渲染（supported=false 不显示）
- [ ] 未安装态：「安装服务」按钮；点击后「安装中…」busy 态（独立于卡片全局 busy）
- [ ] 已绑定态：状态行「版本 {version} · 绑定 {path}」（路径只显示尾段）+「移除」两击确认（「确认移除」3s 超时复位）
- [ ] 失配态：提示「应用已更新或路径已变，需要重新绑定」+「重新绑定」按钮
- [ ] UAC 取消 / 服务 10s 未就绪：toast「安装未完成（已取消或服务未就绪），可重试」，busy 复位不卡死

## 1. 安装与启用（UAC）

- [ ] 安全页点「安装服务」→ 弹一次 UAC → 同意 → 区块变已绑定态，toast「应用绑定解锁已启用」
- [ ] `sc qc`：ImagePath 指向 `%ProgramData%\TotpTools\service\TotpTools.exe` 且带 `--elevation-service` 参数；启动类型「按需 (DEMAND_START)」；账户 LocalSystem
- [ ] `reg query`：`HKLM\SOFTWARE\TotpTools\Elevation` 下 `BoundPath`（提权发起方 exe 绝对路径）、`BoundSha256`（64 位 hex）、`ServiceVersion` 三值齐全
- [ ] 副本目录存在 `TotpTools.exe`；服务处于 RUNNING
- [ ] 全程仅一次 UAC（安装+绑定+启动在提权进程内一次完成）；**体感**：UAC 期间 UI 不冻结（T4 收敛后 abe_bind 走 blocking 池，其他页面操作不卡）

## 2. 锁屏自动解（abe 优先）+ unwrap 真机端到端（T7 挂账）

- [ ] 启用 abe 后锁定（锁屏页出现）→ 数秒内静默自动解锁，无需输入口令（Wrap→HKLM WrappedDek→服务 Unwrap→会话注入全链路真机走通）
- [ ] 自动解锁后验证码页数据正常可读（DEK 注入会话有效）；无 console 错误
- [ ] 重复锁定/解锁多次稳定；服务日志无异常（事件查看器或 debug 日志）

## 3. abe 失败回退 dpapi

- [ ] `sc stop TotpToolsElevationService` 后锁定 → 静默解锁仍成功（走 DPAPI 回退路径，无声降级、无报错弹窗）
- [ ] `reg delete`WrappedDek 后锁定 → 回退同样成立；口令解锁兜底路径不受影响

## 4. 哈希失配重绑 / 便携目录迁移失配

- [ ] 用新版 exe 覆盖安装目录（模拟应用更新）→ 锁屏 abe 静默失败回退；安全页呈失配态（提示需重新绑定）
- [ ] 点「重新绑定」→ 一次 UAC → 恢复已绑定态，`BoundPath`/`BoundSha256` 更新为新 exe → 锁屏自动解恢复
- [ ] 便携版场景：把 exe 整目录迁移到另一路径再运行 → 同样失配提示（路径+哈希双失配）→ 重绑收敛
- [ ] 失配期间第三方旧 exe（原路径塞回旧版）无法通过服务验证（PathMismatch/HashMismatch 分支）

## 5. 移除与卸载清理

- [ ] 「移除」（两击确认）→ security.json abe 源消失、`reg query` 无 `WrappedDek`（BoundPath/BoundSha256/ServiceVersion 保留）；锁屏回退 dpapi；服务本体保留（仍 RUNNING）
- [ ] NSIS setup 卸载（系统「应用和功能」）→ 卸载完成后：服务不存在（`sc query` 报 1060）、`%ProgramData%\TotpTools` 副本目录已删、HKLM `SOFTWARE\TotpTools\Elevation` 键已删
- [ ] **观察项（currentUser 模式）**：常规卸载器非提权（RequestExecutionLevel user），若上述特权清理未生效（权限不足被 nsExec 静默吞掉），以管理员身份运行卸载器复验钩子本身语法/逻辑正确，并记录实际行为（残留时手动 `sc delete` + 删目录收尾）；主清理通道为提权 `--elevation-uninstall`（`"安装目录\TOTP Tools.exe" --elevation-uninstall` + UAC）→ 逐项复验同上三点
- [ ] 卸载/清理后重装流程可完整重走（安装→启用→自动解）

## 6. 目录抢占用例（T3 C-1 修复验证：OWNER_RIGHTS 抑制）

- [ ] 安装前以普通用户预建 `%ProgramData%\TotpTools\service` 目录（可塞入诱饵 TotpTools.exe）→ 走安装 → 安装成功不报错（create_dir_all 静默成功属预期）
- [ ] `icacls` 对照 SDDL `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;RC;;;OW)`：DACL 受保护（无继承 ACE）、仅 SYSTEM/Administrators 完全、所有者（普通用户）只有 READ_CONTROL——**无 W/WRITE_DAC 权**
- [ ] 以预建目录的所有者（普通用户）身份尝试 `icacls <dir> /grant 当前用户:F` → 应被拒绝（OWNER_RIGHTS 抑制所有者隐式 WRITE_DAC）
- [ ] 副本 exe 字节与安装源一致（未被预置诱饵顶替）；服务运行的是安装器写入的副本

## 7. junction / 重解析点攻击面观察（T3 审查留档，观察不作门禁）

- [ ] 安装前把 `%ProgramData%\TotpTools\service` 做成指向用户可控目录的 junction → 安装 → 记录行为：ACL 收紧落点（跟随重解析）、副本最终落盘位置、服务是否可用
- [ ] 结论记录：若收紧 ACL 作用于 junction 目标（攻击者控制域）且副本可被顶替，则该攻击面成立，转后续 round（CreateService 前副本校验/拒绝重解析点）候选项

## 8. CreateService 前副本 DACL 复核（icacls 对照，T3 留档）

- [ ] 常规安装后 `icacls` 输出与 §6 形态一致（本项为常规路径基线；当前实现写入副本后未程序化复核 DACL，属观察挂账非缺陷）

## 9. SC 真机（服务启停 / 无挂起连接，T2 挂账观察）

- [ ] `sc stop` / `sc start` 服务启停正常，状态机经 StopPending 到 STOPPED，无卡 pending
- [ ] 服务停止期间桌面端 `abe_status` 快速返回（3s 超时上界内），锁屏/安全页不 hang（T4 收敛后命令不阻塞 UI）
- [ ] **观察**：起一个客户端连接发半帧后停住，再 `sc stop` → 记录服务是否被阻塞至 SCM 30s 强杀（挂账：阻塞读无超时；如需彻底解决转全重叠 IO 候选）

## 10. 32 位安装包注册表 WOW64 观察（T3 挂账）

- [ ] 当前仅产 x64 包：确认安装器/服务/应用均 64 位，HKLM 键落在原生视图（`reg query` 非 WOW6432Node）
- [ ] 若未来出 32 位产物：32 位进程写 HKLM 落 WOW6432Node、与 64 位服务读原生视图错位（现未加 KEY_WOW64_64KEY）——记录观察结论，转后续候选

## 11. StopPending 竞态再装收敛（T3 挂账）

- [ ] 制造变更安装（改 exe 使哈希变化→重新绑定走 Change 路径），在服务恰处 StopPending 时观察：本轮安装「跳过启动、旧进程跑到自然停止」属预期
- [ ] 稍后再点一次「重新绑定」→ 收敛为新 ImagePath 且服务 RUNNING（`sc qc` 核对）
