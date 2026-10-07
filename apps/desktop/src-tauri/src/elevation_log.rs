//! ABE 安装/服务子进程诊断日志（Task 10）：[`elog`] = eprintln 全量同步 + 追加写
//! `%ProgramData%\TotpTools\service\{kind}.log`（kind = `install` | `service`）。
//! GUI 子系统（windows_subsystem=windows）与服务 SCM 上下文下 stderr 不可见，
//! 落盘日志是提权链路唯一可诊断面。写入失败静默——诊断不得反噬主流程。
//!
//! 仅提权链路消费（elevation_install / elevation_service / lib.rs 分支，均
//! cfg(windows)）：模块整体 cfg(windows) 门控，非 Windows 无消费方，私有模块
//! 未用即 dead_code（Linux clippy CI 门禁）。

/// 追加一行诊断日志：stderr 同步输出 + `{kind}.log` 追加写（时间戳为 UNIX_EPOCH
/// 起算的秒值，诊断用途无需日历时间，不引 chrono）。目录未建/权限不足等文件
/// 打开失败静默返回
pub fn elog(kind: &str, msg: &str) {
    eprintln!("[elevation-{kind}] {msg}");
    if let Ok(dir) = crate::elevation_install::service_dir() {
        let path = dir.join(format!("{kind}.log"));
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            use std::io::Write;
            let _ = writeln!(f, "[{}] {}", unix_epoch_seconds(), msg);
        }
    }
}

/// 秒级时间戳（SystemTime UNIX_EPOCH 起算；时钟回拨等异常时回落 0）
fn unix_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
