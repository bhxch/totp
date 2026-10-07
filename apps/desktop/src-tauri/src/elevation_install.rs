//! ABE 提权安装/卸载（plan p6 §0.2）：`--elevation-install`/`--elevation-uninstall` 由
//! runas 提权拉起（UAC 一次完成安装+绑定），执行完即退出、无 UI。安装流程：算自身路径+
//! SHA256 → 建/收紧副本目录 ACL（SDDL 含 OWNER_RIGHTS ACE 抑制所有者隐式 WRITE_DAC，
//! 见 DIR_SDDL 注释的抢占威胁）→ 复制自身 →
//! decide_service_action（纯函数）→ CreateService/ChangeServiceConfig → 写 HKLM 绑定三值
//! （BoundPath/BoundSha256/ServiceVersion）→ 启动服务。
//!
//! 结构：纯逻辑（decide_service_action）与 IO 薄壳（SCM/HKLM/ACL/文件复制）分层——
//! 系统调用不可单测（brief 裁定），单测只覆盖纯函数与 fs 真复制。
//! HKLM 读写统一收口 [`crate::elevation_service`]（windows 原生 API 单点；Task 3 审查
//! 裁定不引 windows-registry——原生写/删键增量仅约 20 行，避免同链路两套注册表习惯）。

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR,
};
use windows_service::service::{
    Service, ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState,
    ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::Error as ScmError;

use crate::elevation_service::{self, SERVICE_NAME};

/// 服务显示名（plan p6 §0.1）
pub const SERVICE_DISPLAY_NAME: &str = "TOTP Tools Elevation Service";

/// 副本目录（%PROGRAMDATA% 下的相对段，§0.2）
const SERVICE_DIR_SEGMENTS: &str = r"TotpTools\service";

/// 副本文件名恒定（升级换二进制不改 ImagePath 语义；便携源 exe 名可能不同）
const COPY_EXE_NAME: &str = "TotpTools.exe";

/// 副本目录 DACL（§0.2 + 审查 C-1）：拒绝继承（P）；SYSTEM/Administrators 完全——
/// 移除 Users 写，防 SYSTEM 服务运行用户可写路径的二进制（本地提权面）。
/// OWNER_RIGHTS ACE（OW）必须有：其**存在本身**即抑制 NTFS「对象所有者恒隐式持有
/// WRITE_DAC」规则（只留 RC 供所有者查询）。威胁动机（目录抢占）：%ProgramData% 默认
/// 允许 Users 建目录，攻击者可在安装前预建 `TotpTools\service`（或 junction）抢得所有者
/// 身份，create_dir_all 静默成功；若无 OW ACE，tighten_dir_acl 只换 DACL 不换所有者，
/// 抢占者仍可重开 DACL 自授 Full → 替换副本 exe → SYSTEM 执行任意代码。勿当冗余删除
/// （守护测试 dir_sddl_suppresses_owner_implicit_write_dac 锁形）。
const DIR_SDDL: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;RC;;;OW)";

/// 服务 ImagePath 的启动参数（服务分支入口，与 lib.rs 分派字面量一致）
const SERVICE_LAUNCH_ARG: &str = "--elevation-service";

/// 停服等待上限与轮询间隔（变更 ImagePath 重启前置；卸载侧等停为尽力）
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_POLL: Duration = Duration::from_millis(200);

// SCM 错误码（io::Error raw_os_error 形态；具名常量为 WIN32_ERROR 类型不便于匹配）
/// ERROR_SERVICE_DOES_NOT_EXISTS
const SCM_E_NOT_EXISTS: i32 = 1060;
/// ERROR_SERVICE_NOT_ACTIVE
const SCM_E_NOT_ACTIVE: i32 = 1062;
/// ERROR_SERVICE_MARKED_FOR_DELETE（brief 指定容忍，对齐 Chrome uninstall.cc）
const SCM_E_MARKED_FOR_DELETE: i32 = 1072;

/// 安装/卸载错误（CLI 分派层 stderr 输出；不携带敏感内容）
#[derive(Debug)]
pub struct InstallError(String);

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InstallError {}

/// SCM 调用错误转 InstallError（what 描述动作语境）
fn scm_err(e: ScmError, what: &str) -> InstallError {
    InstallError(format!("{what}: {e}"))
}

/// windows_service::Error 中 Winapi 变体的 Win32 错误码（其余变体无码）
fn raw_code(e: &ScmError) -> Option<i32> {
    match e {
        ScmError::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

/// 服务配置动作（decide_service_action 判定结果；IO 由调用方执行）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceAction {
    /// 服务不存在 → CreateService
    Create,
    /// 服务存在但 ImagePath 非本副本 → ChangeServiceConfig（并重启生效）
    Change,
    /// 服务已指向本副本 → 无操作（仍会写绑定与确保启动）
    None,
}

/// 服务动作判定纯函数：不存在=Create；ImagePath 相同=None；ImagePath 位于副本目录内
/// （SCM 原样回传 lpBinaryPathName，本安装器历史产物可能带引号/参数形态）视为一致=None；
/// 其余（指向旧位置/用户区等）=Change
pub fn decide_service_action(
    exists: bool,
    image_path: &str,
    want_image_path: &str,
) -> ServiceAction {
    if !exists {
        return ServiceAction::Create;
    }
    let img = normalize_image_path(image_path);
    let want = normalize_image_path(want_image_path);
    if img == want {
        return ServiceAction::None;
    }
    if let Some((dir, _)) = want.rsplit_once('\\') {
        if img.starts_with(&format!("{dir}\\")) {
            return ServiceAction::None;
        }
    }
    ServiceAction::Change
}

/// ImagePath 形态归一化（比对用）：去首尾引号/空白 + 小写（与服务侧归一化同源语义）。
/// 已知脆弱（Minor，Fix round 1 留档）：对 `"path" args` 尾参形态只能剥首引号（尾引号
/// 不在串端）；此类形态不落入精确相等分支，靠 decide_service_action 的副本目录前缀
/// 容差兜底，判定仍正确
fn normalize_image_path(path: &str) -> String {
    path.trim().trim_matches('"').trim().to_lowercase()
}

/// %PROGRAMDATA%\TotpTools\service（§0.2 副本目录）
fn service_dir() -> Result<PathBuf, InstallError> {
    let root = std::env::var_os("PROGRAMDATA")
        .ok_or_else(|| InstallError("环境变量 PROGRAMDATA 未设置".into()))?;
    Ok(PathBuf::from(root).join(SERVICE_DIR_SEGMENTS))
}

/// 复制自身 exe 到 dir（恒定文件名 [`COPY_EXE_NAME`]），返回目标路径（§0.2 副本正本）
pub fn copy_self_to(dir: &Path) -> std::io::Result<PathBuf> {
    let src = std::env::current_exe()?;
    let dest = dir.join(COPY_EXE_NAME);
    std::fs::copy(&src, &dest)?;
    Ok(dest)
}

/// 收紧副本目录 DACL（§0.2 SDDL + PROTECTED_DACL 阻断继承）。目录为本安装器自建、
/// 无既有 ACE 需保留，直接整体替换 DACL（无需先 GetNamedSecurityInfoW）
fn tighten_dir_acl(dir: &Path) -> Result<(), InstallError> {
    let sddl = elevation_service::to_wide(DIR_SDDL);
    let mut psd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut psd,
            None,
        )
    }
    .map_err(|e| InstallError(format!("SDDL 转安全描述符失败: {e}")))?;
    let mut present = BOOL::default();
    let mut defaulted = BOOL::default();
    let mut dacl: *mut windows::Win32::Security::ACL = std::ptr::null_mut();
    unsafe { GetSecurityDescriptorDacl(psd, &mut present, &mut dacl, &mut defaulted) }
        .map_err(|e| InstallError(format!("取 DACL 失败: {e}")))?;
    // SetNamedSecurityInfoW 以 WIN32_ERROR 报告结果（ERROR_SUCCESS=0）
    let applied = if present.as_bool() && !dacl.is_null() {
        unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(elevation_service::to_wide(&dir.to_string_lossy()).as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(dacl),
                None,
            )
        }
    } else {
        windows::Win32::Foundation::ERROR_INVALID_PARAMETER
    };
    // 描述符已拷贝进内核对象，立即释放
    unsafe {
        let _ = LocalFree(Some(HLOCAL(psd.0)));
    }
    if applied != windows::Win32::Foundation::ERROR_SUCCESS {
        return Err(InstallError(format!(
            "收紧副本目录 ACL 失败: WIN32_ERROR({:?})",
            applied
        )));
    }
    Ok(())
}

/// HKLM 绑定三值（§0.2）：BoundPath=提权调用方 exe 绝对路径、BoundSha256=hex 64 字符、
/// ServiceVersion=构建版本。注册表读写统一走 elevation_service 收口（见模块注释裁定）
fn write_hklm_binding(exe: &Path, sha256: &str) -> Result<(), InstallError> {
    if !elevation_service::reg_ensure_key() {
        return Err(InstallError("创建 HKLM 绑定键失败（需管理员权限）".into()));
    }
    let values = [
        (
            elevation_service::REG_BOUND_PATH,
            exe.to_string_lossy().into_owned(),
        ),
        (elevation_service::REG_BOUND_SHA, sha256.to_string()),
        (
            elevation_service::REG_SERVICE_VERSION,
            env!("CARGO_PKG_VERSION").to_string(),
        ),
    ];
    for (name, value) in &values {
        if !elevation_service::reg_write_sz(name, value) {
            return Err(InstallError(format!("写 HKLM 绑定值 {name} 失败")));
        }
    }
    Ok(())
}

/// 服务启动参数（LocalSystem、OnDemand、OWN_PROCESS、ImagePath 带服务分支参数，§0.1/§0.2）
fn service_info(copy_exe: &Path) -> ServiceInfo {
    ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::OnDemand,
        error_control: ServiceErrorControl::Normal,
        executable_path: copy_exe.to_path_buf(),
        launch_arguments: vec![OsString::from(SERVICE_LAUNCH_ARG)],
        dependencies: vec![],
        // None = LocalSystem（§0.1）
        account_name: None,
        account_password: None,
    }
}

/// 停服务并等至 Stopped（变更 ImagePath 后重启的前置）；超时报错（不静默——后续
/// start 会命中旧进程仍占用旧 ImagePath，语义已坏）
fn stop_service(svc: &Service) -> Result<(), InstallError> {
    let status = svc
        .query_status()
        .map_err(|e| scm_err(e, "查询服务状态失败"))?;
    if !matches!(
        status.current_state,
        ServiceState::Running | ServiceState::StartPending
    ) {
        return Ok(());
    }
    svc.stop().map_err(|e| scm_err(e, "停止服务失败"))?;
    let deadline = Instant::now() + STOP_TIMEOUT;
    loop {
        let status = svc
            .query_status()
            .map_err(|e| scm_err(e, "查询服务状态失败"))?;
        if status.current_state == ServiceState::Stopped {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(InstallError("等待服务停止超时".into()));
        }
        std::thread::sleep(STOP_POLL);
    }
}

/// 尽力等待至 Stopped（卸载侧；状态不可得/超时均直接返回，不阻断后续清理）
fn wait_stopped_best_effort(svc: &Service) {
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        match svc.query_status() {
            Ok(status) if status.current_state == ServiceState::Stopped => return,
            Ok(_) => {}
            Err(_) => return,
        }
        std::thread::sleep(STOP_POLL);
    }
}

/// 启动服务（幂等：仅 Stopped 时拉起，运行中跳过）
fn start_if_stopped(svc: &Service) -> Result<(), InstallError> {
    let status = svc
        .query_status()
        .map_err(|e| scm_err(e, "查询服务状态失败"))?;
    if status.current_state != ServiceState::Stopped {
        return Ok(());
    }
    svc.start(&[] as &[&str])
        .map_err(|e| scm_err(e, "启动服务失败"))
}

/// `--elevation-install` 入口（已提权进程内执行，§0.2 全流程）
pub fn run_install() -> Result<(), InstallError> {
    // ① 自身路径 + SHA256（绑定正本：BoundPath/BoundSha256 指向提权发起方 exe）
    let exe =
        std::env::current_exe().map_err(|e| InstallError(format!("获取自身路径失败: {e}")))?;
    let sha256 = elevation_service::sha256_file_hex(&exe.to_string_lossy())
        .ok_or_else(|| InstallError("计算自身 SHA256 失败".into()))?;
    // ② 建/收紧副本目录 → 复制自身（先锁 ACL 再放入副本，不留可写窗口）
    let copy_dir = service_dir()?;
    std::fs::create_dir_all(&copy_dir)
        .map_err(|e| InstallError(format!("创建副本目录失败: {e}")))?;
    tighten_dir_acl(&copy_dir)?;
    let copy_exe =
        copy_self_to(&copy_dir).map_err(|e| InstallError(format!("复制自身失败: {e}")))?;
    let want_image = copy_exe.to_string_lossy().into_owned();
    // ③ SCM 接线（创建 + 后续操作同一权限集）
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| InstallError(format!("连接服务控制器失败: {e}")))?;
    // 服务存在性与现有 ImagePath（不存在=1060 视为未安装）
    let (exists, current_image) = match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG,
    ) {
        Ok(svc) => {
            let image = svc
                .query_config()
                .map(|c| c.executable_path.to_string_lossy().into_owned())
                .unwrap_or_default();
            (true, image)
        }
        Err(e) if raw_code(&e) == Some(SCM_E_NOT_EXISTS) => (false, String::new()),
        Err(e) => return Err(scm_err(e, "查询服务失败")),
    };
    let op_access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::CHANGE_CONFIG;
    let info = service_info(&copy_exe);
    // ④ CreateService / ChangeServiceConfig（重启前置：变更 ImagePath 须先停旧进程）
    let service = match decide_service_action(exists, &current_image, &want_image) {
        ServiceAction::Create => manager
            .create_service(&info, op_access)
            .map_err(|e| scm_err(e, "创建服务失败"))?,
        ServiceAction::Change => {
            let svc = manager
                .open_service(SERVICE_NAME, op_access)
                .map_err(|e| scm_err(e, "打开服务失败"))?;
            svc.change_config(&info)
                .map_err(|e| scm_err(e, "更新服务 ImagePath 失败"))?;
            stop_service(&svc)?;
            svc
        }
        ServiceAction::None => manager
            .open_service(SERVICE_NAME, op_access)
            .map_err(|e| scm_err(e, "打开服务失败"))?,
    };
    // ⑤ HKLM 绑定三值（最后写：绑定即"该副本已就位"的宣告）
    write_hklm_binding(&exe, &sha256)?;
    // ⑥ 启动服务（幂等）
    start_if_stopped(&service)?;
    Ok(())
}

/// `--elevation-uninstall` 入口（已提权进程内执行）：停服务→DeleteService→删副本目录
/// →删 HKLM 键。容忍 ERROR_SERVICE_MARKED_FOR_DELETE（1072）与未安装（1060）——
/// 卸载须幂等可重入（对齐 Chrome uninstall.cc 的容忍语义）；目录/HKLM 清理尽力而为
/// （服务未完全退出时文件可被占用；NSIS 卸载钩子兜底再清）
pub fn run_uninstall() -> Result<(), InstallError> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| InstallError(format!("连接服务控制器失败: {e}")))?;
    let service = match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(svc) => Some(svc),
        Err(e) if raw_code(&e) == Some(SCM_E_NOT_EXISTS) => None, // 本就未安装：幂等
        Err(e) => return Err(scm_err(e, "打开服务失败")),
    };
    if let Some(svc) = &service {
        // 停（尽力）：未运行(1062)/已标记待删(1072)不阻断
        match svc.stop() {
            Ok(_) => wait_stopped_best_effort(svc),
            Err(e)
                if raw_code(&e) != Some(SCM_E_NOT_ACTIVE)
                    && raw_code(&e) != Some(SCM_E_MARKED_FOR_DELETE) =>
            {
                eprintln!("[elevation-install] 停止服务失败（继续清理）: {e}");
            }
            Err(_) => {}
        }
        // DeleteService：1072 容忍（brief 指定）、1060 幂等容忍
        if let Err(e) = svc.delete() {
            let code = raw_code(&e);
            if code != Some(SCM_E_MARKED_FOR_DELETE) && code != Some(SCM_E_NOT_EXISTS) {
                return Err(scm_err(e, "删除服务失败"));
            }
            eprintln!("[elevation-install] 服务已标记待删除，重启后完全移除");
        }
    }
    // 删副本目录（尽力）
    if let Ok(dir) = service_dir() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[elevation-install] 删除副本目录失败（继续清理）: {e}");
            }
        }
    }
    // 删 HKLM 绑定键（尽力；键不存在已幂等）
    if !elevation_service::reg_delete_key() {
        eprintln!("[elevation-install] 删除 HKLM 绑定键失败（继续）");
    }
    Ok(())
}

/// 非提权应用侧入口：runas 拉起自身 `--elevation-install`（UAC），阻塞至提权进程退出，
/// 以其退出码为结果（提权进程错误经 stderr 输出，GUI 子系统下通常不可见——安装结果
/// 由调用方（abe_bind）经管道 Status 复核）
pub fn trigger_install() -> Result<(), InstallError> {
    let exe =
        std::env::current_exe().map_err(|e| InstallError(format!("获取自身路径失败: {e}")))?;
    let status = runas::Command::new(&exe)
        .arg("--elevation-install")
        .status()
        .map_err(|e| InstallError(format!("UAC 提权启动失败: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(InstallError(format!("提权安装进程退出码非零: {status}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 副本目录形态（测试用字面量，不依赖真实 %PROGRAMDATA%）
    const WANT: &str = r"C:\ProgramData\TotpTools\service\TotpTools.exe";

    // ---- DIR_SDDL 形状守护（审查 C-1）----

    #[test]
    fn dir_sddl_suppresses_owner_implicit_write_dac() {
        // P 标志阻断继承：防 %ProgramData%（Users 可写）的 ACE 经继承渗入
        assert!(DIR_SDDL.starts_with("D:P("), "拒绝继承标记不可丢");
        // OWNER_RIGHTS(OW) READ_CONTROL ACE 是 C-1 修复的核心：其存在本身抑制 NTFS
        // 「所有者恒隐式持有 WRITE_DAC」——目录抢占（squat）场景下换 DACL 不换所有者
        // 也不再能重开 DACL。威胁模型见 DIR_SDDL 注释；缺此 ACE 即回退到可提权形态
        assert!(
            DIR_SDDL.contains("(A;;RC;;;OW)"),
            "OWNER_RIGHTS ACE 不可删（目录抢占威胁，见 DIR_SDDL 注释）"
        );
        assert!(DIR_SDDL.contains("(A;;FA;;;SY)"), "SYSTEM 完全控制不可丢");
        assert!(
            DIR_SDDL.contains("(A;;FA;;;BA)"),
            "Administrators 完全控制不可丢（重装/重绑仍需经提权管理员写 DACL 与放副本）"
        );
    }

    // ---- decide_service_action 四例（brief 清单）----

    #[test]
    fn missing_service_creates() {
        assert_eq!(
            decide_service_action(false, "", WANT),
            ServiceAction::Create
        );
    }

    #[test]
    fn same_image_path_is_noop() {
        assert_eq!(decide_service_action(true, WANT, WANT), ServiceAction::None);
    }

    #[test]
    fn foreign_image_path_changes() {
        assert_eq!(
            decide_service_action(
                true,
                r"C:\Users\me\AppData\Local\TotpTools\TotpTools.exe",
                WANT
            ),
            ServiceAction::Change
        );
    }

    #[test]
    fn legacy_form_inside_copy_dir_is_noop() {
        // 历史安装产物：带引号 + 参数 + 大小写漂移，仍指向副本目录 → 视为一致（无需变更）
        let legacy = format!(r#""{}" {}"#, WANT.to_uppercase(), SERVICE_LAUNCH_ARG);
        assert_eq!(
            decide_service_action(true, &legacy, WANT),
            ServiceAction::None
        );
    }

    // ---- copy_self_to（fs 真复制，tempdir 断言字节一致）----

    #[test]
    fn copy_self_copies_bytes_to_constant_name() {
        let dir = std::env::temp_dir().join(format!(
            "totp-install-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = copy_self_to(&dir).unwrap();
        assert_eq!(dest, dir.join(COPY_EXE_NAME));
        let src = std::env::current_exe().unwrap();
        assert_eq!(
            std::fs::read(&src).unwrap(),
            std::fs::read(&dest).unwrap(),
            "副本字节须与自身一致"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
