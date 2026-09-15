# 前端重设计(计划13)真机冒烟验收报告

- 日期:2026-09-16
- 方式:agent-browser(Chromium 真实渲染,CDP)+ 仓库 E2E 基建(`scripts/inject-test-shim.mjs` 注入 chrome shim,`?seedVault`/`?seedKeys` 驱动测试态),`npx serve` 本地静态服务扩展 chrome-mv3 构建产物
- 产物:修复波次 9e8694c 之后重建的 `apps/extension/.output/chrome-mv3`(options + popup)
- 截图:`.temp/smoke/01~09-*.png`(git 忽略目录)

## 结论

**扩展双页面(options/popup)全部通过**;桌面 Tauri 主窗/mini 属系统级宿主,留给用户真机验收(见「未覆盖」)。过程中发现并排除一个测试环境问题(非产品缺陷):初版产物早于修复波次构建,导致镜像回写行为缺席——重建后全部通过。

## 验证矩阵与结果

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | options 五页导航(Rail/Tabs、hash 深链 `#/codes` 等、active 指示) | ✅ | `#/import` `#/sync` `#/security` 逐页渲染(本地备份/云同步、启用加密等区块齐),默认 `/`→`#/codes` 重定向 |
| 2 | auto 模式真实解析 | ✅ | headless Chromium prefers-dark 下 auto→深色,主色 #b2c5ff(蓝·深 primary) |
| 3 | 深→浅切换(blue) | ✅ | data-mode=light,primary=#0856cf,「当前生效:浅色」文案正确,镜像 `{"mode":"light","color":"blue"}` |
| 4 | 主题色切换(blue→slate,浅色) | ✅ | primary=#006496,surface 近白;跨页(`/codes` 懒加载页)变量保持 |
| 5 | 深色 × slate 组合 | ✅ | primary=#91cdff;seedKeys 预置 settings 后 attrs=dark/slate |
| 6 | 镜像校正(spec §4.5 后半步,修复波次 F2) | ✅ | 陈旧镜像 light/slate + settings dark/slate → 加载后镜像被回写 dark/slate |
| 7 | FOUC 首帧回放(镜像与设置一致) | ✅ | 二次加载首帧即 dark/slate,无错主题闪烁 |
| 8 | 垃圾镜像自愈 | ✅ | 镜像写 garbage → 加载后 attrs/镜像均回到设置值(auto/blue) |
| 9 | 列表行为(真实浏览器) | ✅ | 种子 2 条:置顶 GitLab 排首、验证码渲染、分组 chips(全部/工作/管理分组)、搜 secret 开关在位 |
| 10 | popup | ✅ | 种子条目渲染(GitHub a@b)、深色 token 生效、搜 secret/添加入口在位 |
| 11 | 平台门控 | ✅ | options 无「失焦自动隐藏」(showDesktop=false 生效);弹窗延迟/URL 过滤(扩展专属)在位 |
| 12 | 设置页控件 | ✅ | 三选分段(自动选中)、10 色板圆点(带 label)、spinbutton 2000ms |

## 测试环境问题记录(非产品缺陷)

1. **产物过期假象**:初验镜像回写缺席——`.output` 为 Task 13 构建(cf17429),早于修复波次(9e8694c 的 F2)。重建后行为正确。教训:验收前必须确认产物 commit ≥ 被验代码。
2. **`serve` clean-URL 重定向丢查询串**:`/popup.html?seedVault=…` 301 到 `/popup` 丢失参数,种子静默失败;改用干净路径直开规避。
3. **base64 种子含 `+` 被 URLSearchParams 解为空格** → `atob` 静默失败;需 `encodeURIComponent`(既有已知坑,本次再确认)。

## 未覆盖(移交用户真机验收)

- 桌面 Tauri 主窗(五页 Rail、隐藏到托盘 railActions、失焦隐藏)与 mini 窗(双窗 localStorage 同源、100dvh):需 `pnpm tauri build` 后真机走查;桌面 web 层与扩展共享同一套组件/主题代码,本次扩展侧全绿意味着风险集中在宿主集成而非页面本身。
- 真实 passkey(PRF)/DPAPI/云同步:未触及(本次改动不涉数据层,既往 E2E 已覆盖)。
