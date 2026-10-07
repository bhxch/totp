# P2 导入增强批次 真机验证清单

对应审查：docs/review/2026-10-07-dual-batch-code-review-findings.md R4 批次（R4-C1 配套，兼覆盖 R4-I1/I2/I3 真机面）。

前置：
- 扩展端：`pnpm exec wxt build -b firefox` 与 Chrome 构建各一份。
- 桌面端：`cd apps/desktop && pnpm tauri build --debug`；准备一份**升级前版本**（per-icon 键改造前，含 `urlcache:<id>.json` 原名缓存与旧单键 `icons.json`）的用户数据目录备份，用于升级路径验证。
- 材料：aegis-icons releases 全量 zip（2000+ 图标）；WinAuth 官方导出器导出的无口令 .txt（含 Steam 条目）。

## 图标包导入（大 zip / 上限边界）
- [ ] 导入 aegis-icons 全量 zip（2000+ 图标）：进度正常走完，统计文案数量正确，选择器可搜到包内图标
- [ ] 导入后重启扩展/应用：包归属与图标保持（per-icon 键 + 索引持久化）
- [ ] zip 内文件名含特殊字符（如 `a:b.png`、`a/b.png`——可手工构造）：导入成功且桌面端不产生子目录/0 字节基文件（`%LOCALAPPDATA%/<app>/` 下检查）
- [ ] 单文件恰好 200KB 图标导入成功（含限侧边界）；200KB+1 计入跳过

## 旧数据升级（桌面端重点，R4-C1）
- [ ] 用升级前版本数据目录启动新版本：首次 init 完成旧单键 `icons.json` → `icon:<id>` + `iconindex` 迁移，`icons.json` 删除，图标全部可见
- [ ] 升级前已有 URL 缓存（`urlcache:<id>.json` 原名文件）：升级后首次读取自动迁移为 `urlcache%3A<id>.json` 映射名，条目图标正常显示，无「缓存丢失」误报
- [ ] 数据目录检查：无 `icon`、`urlcache` 等 0 字节基文件（NTFS ADS 流残留），无含冒号文件名
- [ ] 断电/强杀模拟迁移中断（icons.json 与 iconindex 并存的混合状态）：再次启动迁移收敛，图标不丢

## ADS / 特殊字符 id 场景（桌面端）
- [ ] 手工在数据目录放置 `urlcache:test.json` 原名文件 → 启动 → 图标显示且文件被重命名为 `urlcache%3Atest.json`
- [ ] 删除引用特殊字符 id 图标的条目/整包：数据目录无残留、无报错
- [ ] 人为注入单键写失败（如目录只读）后启动：不出整屏「加载失败」白屏，console 有 per-key 迁移失败告警，其余图标可用；恢复权限后重启自动收敛

## WinAuth txt 导入（R4-I1）
- [ ] WinAuth 官方导出 .txt 含 Steam 条目（`otpauth://totp/Steam:...?...&deviceid=...&data=...`）：导入后条目类型为 Steam（5 位、Steam 字母表验证码），非普通 TOTP
- [ ] 同文件普通 TOTP 条目不受影响；`data` 参数损坏的 Steam 行进失败清单（行级错误提示），不产出错误条目
- [ ] 粘贴通道与文件通道（URI 文本入口）行为一致

## 批量写与失败路径（R4-I2/I3）
- [ ] 2000+ 图标导入耗时明显低于串行逐键基线（IPC 并行化生效），UI 无卡死
- [ ] 删除整包后重启：无孤儿图标复活；包管理列表同步清空
- [ ] （可选）人为注入落盘失败（mock/只读目录）：导入对话框报错且重开应用后图标集合与导入前一致（内存回滚生效）
