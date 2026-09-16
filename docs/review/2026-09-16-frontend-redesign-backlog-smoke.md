# 前端重设计 backlog(计划14)扩展侧复验记录

- 日期:2026-09-16
- 范围:计划14(73d9271..10ad254,md 接线/tokens 按需/a11y)在真实 Chromium 的定向复验;plan13 全量矩阵(12 项)已于同日先行通过,本记录只覆盖计划14 变更面
- 产物:10ad254 之后重建的 chrome-mv3 + inject-test-shim;agent-browser CDP
- 截图:`.temp/smoke14/*.png`

## 结果(全部通过)

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | 懒载换色端到端:设置页点击「青绿」圆点 | ✅ | data-color=teal、primary=#55dbc6(青绿·深)、`<link tokens-palettes>` 注入、镜像更新 |
| 2 | FOUC 回放(设置=镜像,teal) | ✅ | seedKeys teal 两次加载均稳定 teal 首帧,无 blue 兜底残留 |
| 3 | MdDialog 焦点陷阱 | ✅ | 管理分组对话框末焦点元素 Tab → 回首元素(cycle 生效) |
| 4 | 「设置为准」语义保持 | ✅ | 重载无 seed 时 shim 设置重置为 auto/blue,teal 镜像被校正回 blue/镜像重写(spec §4.5) |
| 5 | 接线控件真实渲染 | ✅ | rg 门 + 截图:全业务组件 md 控件渲染,浮动 label/danger/图标钮正常 |
| 6 | popup 首载体积 | ✅ | 393,413B→344,671B(-48.7KB/-12.4%),tokens-palettes 50,073B 独立懒载 chunk 不进首载(worktree 基线法,29fabc0) |

## 备注

- 桌面 Tauri 主窗/mini 仍待用户真机走查(与 plan13 相同豁免)。
- 击键写频(keep-n/delay-ms 每次 update:model-value 触发异步写,终值收敛)已在任务审查裁定缓办,真机如有卡顿感再议防抖。
