# shortcutToggleMini 跨重启保留真机补验记录(2026-09-28)

| | |
|---|---|
| 性质 | 补齐 2026-09-27 遗留清理批次 E 场景 6 缺口:四组配置中 shortcutToggleMini 一组当时无观测记录(勘误见 docs/review/2026-09-28-pre-push-review.md A4) |
| 基线 | d6a96a8(评审修复批后)+ lib.rs 错误留痕临时日志(验证后收敛为失败留痕,commit 见当日) |
| 环境 | debug 构建(`cargo build`)+ GUI 直启;WebView2 CDP 经 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`(9223/9222 与 app 内部服务冲突,不可用) |
| 数据安全 | 验证前整目录备份 `%APPDATA%/com.totp.desktop`,验证后还原 |

## 验证设计

shortcutToggleMini 无 UI 开关(纯 Rust 读的配置组,前端写 settings 走合并写仅保留该键),故采用「注入自定义值 → 重启 → Rust 行为级证据」:

1. settings.json 注入 `"shortcutToggleMini": "ctrl+shift+k"`(非默认值,证明非默认路径);
2. 启动 → kill → 重启(同配置);
3. Rust 日志级证据:注入 `apply_shortcut_override`/`toggle_mini` 临时 eprintln 观测读取/注册/触发/show 四环节;
4. 触发通道:PowerShell `SendKeys '^+k'`(合成输入);观测:日志(窗口枚举不可靠,见下)。

## 证据链(run11/run12 日志)

```
[shortcut] configured = 'ctrl+shift+k'                          ← Rust 从 settings.json 读到自定义值
[shortcut] override fired state=Pressed                          ← 热键触发(unregister_all+on_shortcut 动态注册路径生效)
[shortcut] toggle_mini: show ok=true visible_after=Ok(true)      ← show 成功且 show 后窗口可见
[shortcut] override fired state=Released                         ← 松键;第二次按键 is_visible=true 走 hide 分支(无日志),toggle 语义正确
```

- **配置跨重启保留**:kill 后与重启后 settings.json 值均为 `'ctrl+shift+k'`(Rust 各写路径不覆写该键,读路径重启后生效)✓
- **OS 层注册旁证**:独立进程对同组合 RegisterHotKey 返回 `ERROR_HOTKEY_ALREADY_REGISTERED(0xCB)`,证明 app 持有系统热键 ✓
- **对照实验**:默认配置(删键)下 alt+shift+t(builder 静态注册)同通道可触发,排除合成输入通道问题 ✓
- **自包含对照**:独立进程注册 ctrl+shift+j 后,SendKeys 合成输入可触发其 WM_HOTKEY,证明合成输入对 RegisterHotKey 可达 ✓

## 结论

09-27 遗留的「Rust 四组配置跨重启保留」第四组(shortcutToggleMini)复验**通过**:配置跨重启保留、读取生效、热键 toggle 语义(显示↔隐藏)正确。至此四组(devtools/releasePolicy/mcp/shortcutToggleMini)全部有真机观测。

## 附带发现(已随当日提交落地)

1. **观测方法教训**:mini 有「失焦即自动隐藏」产品行为(`on_window_event Focused(false)` 无条件 hide),且后台进程 `set_focus` 受 Windows 前台锁限制——**瞬时窗口枚举数不到 mini 是常态,真机验证必须以日志级证据为准**(run6/7/9 三轮「未触发」实为观测假象,run10 日志证明链路自始畅通)。
2. **错误留痕改进**:原 `apply_shortcut_override` 对 `unregister_all`/`on_shortcut` 的失败静默吞掉(`is_ok()`+`let _`),注册失败无从诊断(本次排查初期因此绕路)。已改为 `eprintln` 留痕(失败不阻断启动);`toggle_mini` 的 `mini.show()` Err 同样补留痕。成功路径无日志。

## 遗留

无(本项闭环)。数据目录已还原验证前状态(settings.json 无 shortcutToggleMini 键)。
