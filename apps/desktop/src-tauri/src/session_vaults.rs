//! 会话暂存槽（R8 自 lib.rs 分节纯移动）：剪贴板暂存（F16）与 DEK 暂存槽（销毁档
//! 「不锁库」路径，spec 批⑧）。两者均为仅进程内存的 static 槽，命令/纯判定在此，
//! 接线副作用（托盘退出兜底/锁库清槽调用点）留在 lib.rs。

use std::sync::Mutex;
use tauri::{AppHandle, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;

// F16 剪贴板暂存（托盘退出兜底清除的唯一事实源）：JS 复制路径经 stage_clipboard_write 写入并登记，
// clipboard_clear_if_staged / 托盘退出时读回比对——内容仍为本应用最近一次复制的值才清空（不误清外部内容）。
// 剪贴板读取只在 Rust 侧进行：不向 webview JS 授予剪贴板读取能力（CSP null 下 read 权限=持续监听原语）。
pub static CLIPBOARD_STAGE: Mutex<Option<String>> = Mutex::new(None);

/// 释放销毁档「不锁库」路径的 DEK 暂存槽（仅进程内存，不落盘）：destroy 前前端 stash，重建后前端 take 回注；锁库/退出时清除。
///
/// ⚠ 成对约定（C1 审查修复 2026-10-01）：**锁库路径必须同步清空全部 DEK 槽**（统一走
/// `dek_slots_clear_on_lock`，勿散落单槽 clear）——漏清任何一格都会击穿「主窗已锁、mini 仍明文」
/// 不变量：残留槽让对应窗口聚焦重建时 peek/take 到 DEK 自动解锁，而主窗经 take_stashed_dek 得
/// None 保持锁定。新增 DEK 槽时：本注释链补登记 + `dek_slots_clear_on_lock` 补一行清空。
pub static STASHED_DEK: Mutex<Option<String>> = Mutex::new(None);

/// CLIPBOARD_STAGE 清除判定（纯函数，四分支直测）：无暂存→false（不动剪贴板）；
/// 读回==暂存→true（清空）；读回≠暂存（用户已复制外部内容）→false（不误清）；
/// 读取失败→true（fail-safe，宁误清不残留种子）
fn should_clear_clipboard(staged: Option<&str>, read: Result<&str, ()>) -> bool {
    let Some(value) = staged else { return false };
    match read {
        Ok(current) => current == value,
        Err(()) => true,
    }
}

/// 托盘退出兜底与 clipboard_clear_if_staged 命令共用：仅当剪贴板内容仍为本应用最近一次复制的值时清空。
/// 判定委托 should_clear_clipboard（读取失败按 fail-safe 处理，宁误清不残留种子）；
/// 无暂存/内容已换则不动剪贴板。返回是否实际清空。
pub fn clear_clipboard_if_staged<R: Runtime>(app: &AppHandle<R>) -> bool {
    let staged = CLIPBOARD_STAGE.lock().ok().and_then(|mut s| s.take());
    let Some(value) = staged else { return false };
    let clear = match app.clipboard().read_text() {
        Ok(current) => should_clear_clipboard(Some(&value), Ok(current.as_str())),
        Err(_) => should_clear_clipboard(Some(&value), Err(())),
    };
    if clear {
        let _ = app.clipboard().write_text(String::new());
    }
    clear
}

#[tauri::command]
pub fn stage_clipboard_write(value: String, app: AppHandle) -> Result<(), String> {
    app.clipboard()
        .write_text(value.clone())
        .map_err(|e| e.to_string())?;
    if let Ok(mut s) = CLIPBOARD_STAGE.lock() {
        *s = Some(value);
    }
    Ok(())
}

#[tauri::command]
pub fn clipboard_clear_if_staged(app: AppHandle) -> bool {
    clear_clipboard_if_staged(&app)
}

// ---- DEK 暂存槽操作（静态槽语义参数化：测试以局部 Mutex 实例直测，不触碰全局态）----

/// 只进槽（stash-dek-request 事件后前端上报当前会话 DEK；仅进程内存）
fn dek_slot_stash(slot: &Mutex<Option<String>>, dek: String) {
    if let Ok(mut s) = slot.lock() {
        *s = Some(dek);
    }
}

/// 取即清（重建后前端启动期取回）；None=无暂存
fn dek_slot_take(slot: &Mutex<Option<String>>) -> Option<String> {
    slot.lock().ok().and_then(|mut s| s.take())
}

/// 恒清空（锁库即清口径：release_tick/destroy/托盘退出/前端 onLocked 共用）
pub fn dek_slot_clear(slot: &Mutex<Option<String>>) {
    if let Ok(mut s) = slot.lock() {
        *s = None;
    }
}

/// 前端在 stash-dek-request 事件后上报当前会话 DEK（base64）；只进内存槽
#[tauri::command]
pub fn stash_dek(dek: String) {
    dek_slot_stash(&STASHED_DEK, dek);
}

/// 重建后前端启动期取回暂存 DEK（取即清）；无暂存返回 null
#[tauri::command]
pub fn take_stashed_dek() -> Option<String> {
    dek_slot_take(&STASHED_DEK)
}

/// 锁库即清 DEK 暂存槽（Task 14 补口）：前端手动锁/空闲锁/系统锁走纯前端 store.lock()
/// 不通知 Rust，若此前销毁档「不锁库」路径已 stash 而 destroy 失败回滚，暂存 DEK 仍在槽内，
/// 下次销毁重建会被回注、绕过刚发生的锁定。store.lock() 末尾经 onLocked 回调 invoke 本命令，
/// 与 Rust force-lock（release_tick/destroy_releasable_windows）及托盘退出的清槽口径对齐
#[tauri::command]
pub fn clear_stashed_dek() {
    dek_slot_clear(&STASHED_DEK);
}

/// mini 迷你窗跟随主窗解锁的 DEK 槽（仅进程内存，不落盘；2026-09-30 设计）：主窗解锁 set、
/// 锁定 clear、mini 启动/聚焦重建 peek——peek 保留槽值（mini 每次重建 store 都要能再取）。
/// 所有权约定（M2 审查修复 2026-10-01）：槽写/清权在主窗（publishMiniUnlock/publishMiniLock），
/// mini 只读（peek）；command 体内按 window.label 强制（见下方各 *_inner）。成对约定见 STASHED_DEK。
pub static MINI_DEK: Mutex<Option<String>> = Mutex::new(None);

/// 锁库路径的 DEK 槽同步清空（C1 审查修复 2026-10-01）：release_tick 锁库档与销毁档 lock_on_destroy
/// 分支调用——锁库即清 STASHED_DEK + MINI_DEK **成对**清空，不再依赖「force-lock 事件 → 主窗 JS →
/// invoke('clear_mini_dek')」两跳异步链（emit 后随即 TrySuspend/销毁窗口，事件大概率来不及落地）。
/// 销毁档「不锁库」分支（stash 回注路径）**不得**调用本函数：重建后主窗回注会重新 publish 覆盖。
/// 新增 DEK 槽时在此补一行（成对约定见 STASHED_DEK/MINI_DEK 注释）。
pub fn dek_slots_clear_on_lock() {
    dek_slot_clear(&STASHED_DEK);
    dek_slot_clear(&MINI_DEK);
}

/// DEK 入参校验（M1 审查修复 2026-10-01）：对齐 ui 层 unlockWithDek 的 C1 口径——base64 解码
/// 必须成功且恰为 32 字节（AES-256 DEK 本体，前端 bytesToBase64 标准字母表+padding）。槽只收
/// 合法 DEK，防垃圾/超长数据借槽存续（peek 后 GCM 证明才解锁，此处前置拒绝缩小攻击面）
fn validate_dek_b64(dek: &str) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(dek)
        .map_err(|_| "dek 不是合法 base64".to_string())?;
    if bytes.len() != 32 {
        return Err(format!(
            "dek 须为 32 字节 DEK（base64），实际解码 {} 字节",
            bytes.len()
        ));
    }
    Ok(())
}

/// MINI_DEK 槽所有权校验（M2 审查修复 2026-10-01）：Tauri v2 对应用自有 command 无按窗口 ACL
/// 细分，mini webview 内的脚本理论上可调 set/clear 把槽「复活」绕过主窗锁定。故在命令体内按
/// window.label 收窄（platform_security::ensure_main_window_label 同款手法）：set/clear 仅
/// "main"（槽写/清权在主窗，desktopShell 的 publishMiniUnlock/publishMiniLock），peek 仅
/// "mini"（唯一读方是 MiniApp 的 dekPersist.get 与复查）
fn ensure_mini_dek_owner(label: &str, action: &str, allowed: &str) -> Result<(), String> {
    if label == allowed {
        Ok(())
    } else {
        Err(format!(
            "mini 槽 {action} 仅 {allowed} 窗口可调用（槽所有权约定，M2）"
        ))
    }
}

/// set_mini_dek 命令体（label 以 &str 传入，不依赖 Tauri 运行时，单测直测门控/校验）
fn set_mini_dek_inner(label: &str, dek: &str) -> Result<(), String> {
    ensure_mini_dek_owner(label, "set", "main")?;
    validate_dek_b64(dek)?;
    dek_slot_stash(&MINI_DEK, dek.to_string());
    Ok(())
}

/// 主窗解锁成功后下发 mini 窗解锁用 DEK（base64；前端 bytesToBase64）。
/// 入参校验 + 槽所有权见 validate_dek_b64 / ensure_mini_dek_owner
#[tauri::command]
pub fn set_mini_dek(window: tauri::WebviewWindow, dek: String) -> Result<(), String> {
    set_mini_dek_inner(window.label(), &dek)
}

/// peek_mini_dek 命令体：仅 mini 可读（所有权约定），非法 label 拒绝（前端 catch 后得 null
/// ——fail-safe 方向为锁定态）
fn peek_mini_dek_inner(label: &str) -> Result<Option<String>, String> {
    ensure_mini_dek_owner(label, "peek", "mini")?;
    Ok(MINI_DEK.lock().ok().and_then(|s| s.clone()))
}

/// mini 窗读取槽中 DEK（保留语义，非 take；无则 null=主窗未解锁）
#[tauri::command]
pub fn peek_mini_dek(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    peek_mini_dek_inner(window.label())
}

/// clear_mini_dek 命令体：仅 main 可清（主窗锁定汇聚点 publishMiniLock）
fn clear_mini_dek_inner(label: &str) -> Result<(), String> {
    ensure_mini_dek_owner(label, "clear", "main")?;
    dek_slot_clear(&MINI_DEK);
    Ok(())
}

/// 主窗锁定时清空 mini 槽（mini 收事件同步锁窗）
#[tauri::command]
pub fn clear_mini_dek(window: tauri::WebviewWindow) -> Result<(), String> {
    clear_mini_dek_inner(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- F16 剪贴板暂存清除判定（should_clear_clipboard 四分支；盘点 B5）----

    #[test]
    fn clipboard_clear_decision_four_branches() {
        // 无暂存：不动剪贴板
        assert!(!should_clear_clipboard(None, Ok("whatever")));
        // 读回==暂存：清空
        assert!(should_clear_clipboard(Some("seed"), Ok("seed")));
        // 读回≠暂存（用户已复制外部内容）：保留不误清
        assert!(!should_clear_clipboard(Some("seed"), Ok("external")));
        // 读取失败：fail-safe 清空（宁误清不残留种子）
        assert!(should_clear_clipboard(Some("seed"), Err(())));
    }

    // ---- DEK 暂存槽三命令语义（盘点 B7：stash 只进槽 / take 取即清 / clear 恒清）----
    // 以局部 Mutex 实例直测，不触碰全局 static（并行安全）

    // 命令本体直测（无 State 参数可直接调用）：覆盖命令层真实入口与槽操作的一致性。
    // 入口/出口经 clear_stashed_dek 自净化（Minor-2）：消除与未来其他触全局槽用例的并行互扰
    #[test]
    fn stashed_dek_commands_roundtrip_on_global_slot() {
        clear_stashed_dek();
        assert_eq!(take_stashed_dek(), None, "无暂存返回 None（前端收 null）");
        stash_dek("dek".into());
        assert_eq!(take_stashed_dek(), Some("dek".to_string()), "取即清");
        assert_eq!(take_stashed_dek(), None, "二次取为空");
        stash_dek("again".into());
        clear_stashed_dek();
        assert_eq!(take_stashed_dek(), None, "clear 后无残留");
        clear_stashed_dek(); // 出口净化：不把残值泄漏给其他全局槽用例
    }

    #[test]
    fn dek_slot_semantics_stash_take_clear() {
        let slot: Mutex<Option<String>> = Mutex::new(None);
        // 无暂存 take 返回 None（前端收到 null）
        assert_eq!(dek_slot_take(&slot), None);
        // stash 只进槽，不产生任何其他副作用
        dek_slot_stash(&slot, "dek-base64".into());
        assert_eq!(slot.lock().unwrap().as_deref(), Some("dek-base64"));
        // take 取即清：第二次 take 回 None，槽不留残值（销毁重建回注通道的单次性）
        assert_eq!(dek_slot_take(&slot), Some("dek-base64".to_string()));
        assert_eq!(dek_slot_take(&slot), None);
        // stash 后 clear 恒清空（锁库口径），重复 clear 幂等
        dek_slot_stash(&slot, "again".into());
        dek_slot_clear(&slot);
        dek_slot_clear(&slot);
        assert!(slot.lock().unwrap().is_none());
    }
}

#[cfg(test)]
mod mini_dek_tests {
    use super::*;

    /// 合法 32 字节全零 DEK 的 base64（43 A + 1 pad，前端 bytesToBase64 标准字母表输出形态）
    const DEK32_B64: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    fn peek_inner() -> Option<String> {
        MINI_DEK.lock().ok().and_then(|s| s.clone())
    }

    #[test]
    fn mini_dek_set_peek_clear_cycle() {
        dek_slots_clear_on_lock(); // 前置净化：含 MINI_DEK（顺带覆盖成对清空入口）
        assert_eq!(peek_inner(), None);
        dek_slot_stash(&MINI_DEK, "ZGVr".into());
        assert_eq!(peek_inner(), Some("ZGVr".into()));
        assert_eq!(peek_inner(), Some("ZGVr".into())); // peek 保留语义：mini 聚焦重建 store 依赖此
        dek_slot_clear(&MINI_DEK);
        assert_eq!(peek_inner(), None);
    }

    // M1 审查修复：set_mini_dek 入参校验——base64 合法且恰 32 字节，非法拒绝且不入槽
    #[test]
    fn set_mini_dek_validates_base64_and_32_byte_length() {
        dek_slots_clear_on_lock();
        // 合法：入槽
        set_mini_dek_inner("main", DEK32_B64).unwrap();
        assert_eq!(peek_inner().as_deref(), Some(DEK32_B64));
        // 非 base64：拒绝，槽值保持不变
        assert!(set_mini_dek_inner("main", "not-base64!!").is_err());
        // base64 合法但非 32 字节（31 字节全零 = 42 A + 2 pad）：拒绝
        assert!(
            set_mini_dek_inner("main", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==").is_err()
        );
        assert_eq!(
            peek_inner().as_deref(),
            Some(DEK32_B64),
            "非法入参不得污染槽"
        );
        dek_slots_clear_on_lock(); // 出口净化
    }

    // M2 审查修复：槽所有权按窗口 label 收敛——set/clear 仅 main，peek 仅 mini
    #[test]
    fn mini_dek_commands_enforce_window_label_ownership() {
        dek_slots_clear_on_lock();
        // mini（或任意非 main label）不得写/清槽
        assert!(set_mini_dek_inner("mini", DEK32_B64).is_err());
        assert!(clear_mini_dek_inner("mini").is_err());
        // main 不得 peek（读方仅 mini）
        assert!(peek_mini_dek_inner("main").is_err());
        assert!(peek_mini_dek_inner("spoofed-label").is_err());
        assert_eq!(peek_inner(), None, "被拒 peek 不得返回槽值");
        // 允许路径：main set/clear、mini peek
        set_mini_dek_inner("main", DEK32_B64).unwrap();
        assert_eq!(
            peek_mini_dek_inner("mini").unwrap(),
            Some(DEK32_B64.to_string())
        );
        clear_mini_dek_inner("main").unwrap();
        assert_eq!(peek_mini_dek_inner("mini").unwrap(), None);
    }

    // C1 审查修复：锁库路径成对清空——STASHED_DEK 与 MINI_DEK 同步清，杜绝「主窗已锁、
    // mini 聚焦重建 peek 残留 DEK 自动解锁」的不变量击穿
    #[test]
    fn dek_slots_clear_on_lock_clears_both_paired_slots() {
        dek_slots_clear_on_lock(); // 前置净化
        assert_eq!(take_stashed_dek(), None);
        assert_eq!(peek_mini_dek_inner("mini").unwrap(), None);
        stash_dek("stale".into());
        set_mini_dek_inner("main", DEK32_B64).unwrap();
        dek_slots_clear_on_lock();
        assert_eq!(
            take_stashed_dek(),
            None,
            "锁库路径 STASHED_DEK 必清（Task 14）"
        );
        assert_eq!(
            peek_mini_dek_inner("mini").unwrap(),
            None,
            "锁库路径 MINI_DEK 必清（C1：残留槽让 mini 聚焦重建绕过主窗锁定）"
        );
    }
}
