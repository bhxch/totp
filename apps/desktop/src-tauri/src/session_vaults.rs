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

/// 释放销毁档「不锁库」路径的 DEK 暂存槽（仅进程内存，不落盘）：destroy 前前端 stash，重建后前端 take 回注；锁库/退出时清除
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
/// 锁定 clear、mini 启动/聚焦重建 peek——peek 保留槽值（mini 每次重建 store 都要能再取）
pub static MINI_DEK: Mutex<Option<String>> = Mutex::new(None);

/// 主窗解锁成功后下发 mini 窗解锁用 DEK（base64；前端 bytesToBase64）
#[tauri::command]
pub fn set_mini_dek(dek: String) {
    dek_slot_stash(&MINI_DEK, dek);
}

/// mini 窗读取槽中 DEK（保留语义，非 take；无则 null=主窗未解锁）
#[tauri::command]
pub fn peek_mini_dek() -> Option<String> {
    MINI_DEK.lock().ok().and_then(|s| s.clone())
}

/// 主窗锁定时清空 mini 槽（mini 收事件同步锁窗）
#[tauri::command]
pub fn clear_mini_dek() {
    dek_slot_clear(&MINI_DEK);
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

    fn peek_inner() -> Option<String> {
        MINI_DEK.lock().ok().and_then(|s| s.clone())
    }

    #[test]
    fn mini_dek_set_peek_clear_cycle() {
        dek_slot_clear(&MINI_DEK);
        assert_eq!(peek_inner(), None);
        dek_slot_stash(&MINI_DEK, "ZGVr".into());
        assert_eq!(peek_inner(), Some("ZGVr".into()));
        assert_eq!(peek_inner(), Some("ZGVr".into())); // peek 保留语义：mini 聚焦重建 store 依赖此
        dek_slot_clear(&MINI_DEK);
        assert_eq!(peek_inner(), None);
    }
}
