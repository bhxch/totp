# 桌面 Miniapp 跟随主窗解锁 设计（2026-09-30）

## 背景与目标

Miniapp（桌面迷你窗，`apps/desktop` 独立 WebView 窗口，`mini.html` + `MiniApp.vue`）在 vault 启用加密后恒显示「加密启用后迷你窗不可用」。根因：解锁态（DEK）在 `encryptionSession` 中按 windowId 隔离（`packages/ui/src/store/encryptionSession.ts:57`），mini 以 `windowId: 'mini'` boot（`MiniApp.vue:34`），既无解锁 UI、也无从主窗获取 DEK 的通道（`desktopShell.ts` 的 `bootDesktopStore` 未传 `dekPersist`，`initStore` 自动恢复分支 `packages/ui/src/store.ts:199` 恒空），密文库下必然落入 `setWindowLocked(true)`。

**裁定（用户 2026-09-30）**：跟随主窗——主窗解锁 → mini 自动解锁；主窗锁定 → mini 同步锁定。mini 永不独立持有会话。

## 安全模型

- DEK 全程仅存于进程内存：Rust 槽与各 WebView JS 内存；不落盘、不跨进程、不序列化到 storage。
- 窗口事件只传**状态布尔**（locked/unlocked），密钥本体只经 Rust command 点对点（mini 主动 peek），不过事件 payload。
- 应用退出进程终止，槽随之消失；无任何持久化路径。
- mini 的锁定与主窗严格联动，不存在「主窗已锁、mini 仍明文」的状态。

## 机制设计

### Rust 侧（apps/desktop/src-tauri/src/session_vaults.rs）

新增独立槽与三个 command（模式参照现有 `STASHED_DEK`，语义为 set/clear/peek 而非 take——mini 聚焦时会重建 store 从盘重载，每次都要能再取）：

- `set_mini_dek(dek: Vec<u8>)`：写入 `MINI_DEK` 槽（`Mutex<Option<Vec<u8>>>`，进程内存）。
- `clear_mini_dek()`：清空槽。
- `peek_mini_dek() -> Option<Vec<u8>>`：读取（槽保留，不清除）。

三者在 `lib.rs` 的 `generate_handler` 注册；单测覆盖 set→peek→clear→peek None 循环。

### 主窗挂钩（apps/desktop/src/desktopShell.ts）

新增两个 helper 单点收口（禁止各处散落 invoke）：

- `publishMiniUnlock(dek)`：`set_mini_dek(dek)` + 向 mini 窗 emit 事件 `mini-session`（payload `{ locked: false }`）。
- `publishMiniLock()`：`clear_mini_dek()` + emit `mini-session`（payload `{ locked: true }`）。

挂钩点两处：

1. **解锁成功**：主窗三条解锁路径（口令 / PRF / DPAPI）最终汇聚的 `unlockWithDek` 成功处（与现有 `take_stashed_dek` 回注同层，`desktopShell.ts:326-341` 附近）调 `publishMiniUnlock`。PRF「销毁不锁库」路径的 DEK 经 stash 回注后同样走到此点，天然覆盖。
2. **锁定**：主窗锁定动作的回调（`bootDesktopStore` 的 `onLocked` 通道 / LockScreen 锁定 op，实现时以「所有锁定路径必须收敛」为准选取唯一挂钩点）调 `publishMiniLock`。

emit 用 Tauri v2 `emitTo('mini', ...)` 定向（`lib.rs:359` 确认 mini 窗 label 为 `"mini"`）。

### mini 侧（apps/desktop/src/MiniApp.vue + desktopShell.ts）

- `bootDesktopStore` 增加可选 `dekPersist` 透传（现有参数，`store.ts:199` 原生消费，core 零改动）：mini 传 `{ get: () => invoke('peek_mini_dek') }`。mini 启动与聚焦重建 store（`MiniApp.vue:71-73`）时 `initStore` 自动恢复分支直接用槽中 DEK 解锁。
- 监听 `mini-session` 事件：
  - `{ locked: true }` → `encryption.setWindowLocked(true)`：丢弃本窗内存 DEK、vault 清空（复用现有锁定语义，`store.ts:243` 锁定态 commit 拒写）。
  - `{ locked: false }` 且本窗当前锁定 → 重新执行 boot/initStore 从槽取 DEK 装载明文。
- 锁定提示文案 `mini.lockedNote`（`packages/ui/src/i18n/locales/zh/common.json:755` 及 en）改为「主窗口解锁后此窗口可用」语义。不加跳转按钮（mini 保持只读极简）。

## 行为序列

| 场景 | 行为 |
|---|---|
| 加密未启用 | 一切如旧（明文库分支不涉及 DEK） |
| 加密启用，主窗未解锁，打开 mini | mini 提示「主窗口解锁后可用」 |
| 主窗解锁 | 槽写入 + 事件 → mini 自动装载明文 |
| mini 已开，主窗锁定 | 槽清空 + 事件 → mini 回到锁定提示，内存明文清空 |
| mini 运行中用户聚焦 mini | 重建 store → peek 槽（主窗解锁态下依旧可用） |
| 应用退出 | 进程终止，槽消失，无残留 |
| mini 打开于主窗解锁前，主窗后解锁 | mini 收 `{locked:false}` 事件重载解锁 |

## 测试

- Rust：MINI_DEK 三 command 单测（set/peek 保留性/clear）。
- desktopShell：`publishMiniUnlock/Lock` 单测（mock invoke/emit，断言调用序）。
- MiniApp：dekPersist 注入后 `initStore` 自动恢复（mock peek 返回/不返回 DEK 两分支）；`mini-session` 事件两分支处理。
- 真机验证清单（并入批次 E 人工验证会话）：口令/PRF/DPAPI 三路径解锁后 mini 跟随；主窗锁定 mini 联动；mini 聚焦重建不丢解锁态；应用重启后 mini 恢复锁定提示。

## 非目标

- mini 独立解锁 UI（口令/PRF 直接在 mini 输入）——裁定弃用。
- 扩展端任何改动（popup/options 已有 `chrome.storage.session` 会话共享，不受影响）。
- mini 增加编辑/管理能力（保持只读）。
