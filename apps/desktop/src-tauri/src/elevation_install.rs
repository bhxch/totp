//! ABE 提权安装/卸载（plan p6 §0.2）：`--elevation-install`/`--elevation-uninstall` 由
//! runas 提权拉起（UAC 一次完成安装+绑定），执行完即退出、无 UI。安装流程（C2 终审重排，
//! 步骤序由 [`install_plan`] 纯函数单点给出）：算自身路径+SHA256 → 探查服务（存在性/
//! ImagePath/运行态）→ 停服（存在且运行中；先于一切写动作——运行中映像被内核锁定，
//! 覆盖必失败）→ 建/收紧副本目录 ACL → 复制自身 → decide_service_action（纯函数，
//! Create/Change/None，Change 仅落 ImagePath）→ 写 HKLM 绑定三值 → 启动服务。
//!
//! 结构：纯逻辑（decide_service_action / install_plan）与 IO 薄壳（SCM/HKLM/ACL/文件复制）
//! 分层——系统调用不可单测（brief 裁定），单测只覆盖纯函数与 fs 真复制。
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

/// 安装编排步骤（C2 终审：序由 [`install_plan`] 纯函数单点给出，[`run_install`] 逐项执行
/// ——序的可断言性与执行保真绑定在同一出处，测试锁定不变量）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallStep {
    /// 停服务并等待 Stopped（存在且运行中才入列；映像解锁前置，先于一切写动作）
    StopService,
    /// 建/收紧副本目录 ACL（先锁 ACL 再放入副本，不留可写窗口）
    PrepareDir,
    /// 复制自身到副本（恒定文件名；前置：服务已停/本就不存在，映像无锁定）
    CopySelf,
    /// 服务动作落位（decide_service_action：Create/Change/None——Change 此处仅落
    /// ImagePath，服务已被前置停服步停止，重启统一收口 StartService）
    ApplyService,
    /// HKLM 绑定三值（服务动作后写：绑定即「该副本已就位」的宣告）
    WriteBinding,
    /// 幂等启动（编排末步）
    StartService,
}

/// 编排纯函数（I4 终审可断言核心）：停服是探查后的条件步（服务存在且运行中才入列），
/// 恒先于副本目录/覆盖写动作；其后固定 dir→copy→service→binding→start。
/// 「stop 先于 copy」不变量由 install_plan_stops_running_service_before_copy 锁定——
/// 违反即回退 C2 缺陷（运行中重绑：ImagePath 相同判 None 根本不停服，映像锁定覆盖必失败）
fn install_plan(exists: bool, running: bool) -> Vec<InstallStep> {
    let mut plan = Vec::with_capacity(6);
    if exists && running {
        plan.push(InstallStep::StopService);
    }
    plan.extend_from_slice(&[
        InstallStep::PrepareDir,
        InstallStep::CopySelf,
        InstallStep::ApplyService,
        InstallStep::WriteBinding,
        InstallStep::StartService,
    ]);
    plan
}

/// 服务探查结果（run_install 前置步骤；存在性/ImagePath/运行态先于一切写动作得知）
struct ProbedService {
    exists: bool,
    /// 现有 ImagePath（不存在时空串；decide_service_action 输入）
    image_path: String,
    /// 运行中（Running/StartPending；停服步入列依据）
    running: bool,
    /// 已打开的服务句柄（探查访问集全集；不存在时 None——停服/变更/启动共用）
    handle: Option<Service>,
}

/// 探查服务（open_service 一次取全量访问集：停服/变更/启动与探查同一句柄，避免
/// 多次 open 的权限窗口；不存在=1060 视为未安装）
fn probe_service(
    manager: &ServiceManager,
    access: ServiceAccess,
) -> Result<ProbedService, InstallError> {
    match manager.open_service(SERVICE_NAME, access) {
        Ok(svc) => {
            let image_path = svc
                .query_config()
                .map(|c| c.executable_path.to_string_lossy().into_owned())
                .unwrap_or_default();
            let running = svc
                .query_status()
                .map(|s| {
                    matches!(
                        s.current_state,
                        ServiceState::Running | ServiceState::StartPending
                    )
                })
                .unwrap_or(false);
            Ok(ProbedService {
                exists: true,
                image_path,
                running,
                handle: Some(svc),
            })
        }
        Err(e) if raw_code(&e) == Some(SCM_E_NOT_EXISTS) => Ok(ProbedService {
            exists: false,
            image_path: String::new(),
            running: false,
            handle: None,
        }),
        Err(e) => Err(scm_err(e, "查询服务失败")),
    }
}

/// `--elevation-install` 入口（已提权进程内执行，§0.2 全流程；步骤序=install_plan 纯函数
/// 产物，C2 终审重排后停服先于副本覆盖）
pub fn run_install() -> Result<(), InstallError> {
    // ① 自身路径 + SHA256（绑定正本：BoundPath/BoundSha256 指向提权发起方 exe）
    let exe =
        std::env::current_exe().map_err(|e| InstallError(format!("获取自身路径失败: {e}")))?;
    let sha256 = elevation_service::sha256_file_hex(&exe.to_string_lossy())
        .ok_or_else(|| InstallError("计算自身 SHA256 失败".into()))?;
    // ② 探查服务（C2：一切写动作之前——停服决策依赖存在性与运行态；同一句柄贯穿停服/
    //    变更/启动，QUERY_CONFIG 仅探查期需要）
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| InstallError(format!("连接服务控制器失败: {e}")))?;
    let op_access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::CHANGE_CONFIG;
    let probed = probe_service(&manager, op_access | ServiceAccess::QUERY_CONFIG)?;
    let mut probed_svc = probed.handle;
    // ③ 编排执行（序由 install_plan 单点给出；copy_exe/service 为跨步产出物，
    //    expect 兜底断言计划不变量——步骤入列即保证其前置已就位）
    let mut copy_exe: Option<PathBuf> = None;
    let mut service: Option<Service> = None;
    for step in install_plan(probed.exists, probed.running) {
        match step {
            InstallStep::StopService => {
                stop_service(probed_svc.as_ref().expect("Stop 前置：服务已探查存在"))?;
            }
            InstallStep::PrepareDir => {
                let copy_dir = service_dir()?;
                std::fs::create_dir_all(&copy_dir)
                    .map_err(|e| InstallError(format!("创建副本目录失败: {e}")))?;
                tighten_dir_acl(&copy_dir)?;
            }
            InstallStep::CopySelf => {
                copy_exe = Some(
                    copy_self_to(&service_dir()?)
                        .map_err(|e| InstallError(format!("复制自身失败: {e}")))?,
                );
            }
            InstallStep::ApplyService => {
                let copy_exe = copy_exe.as_deref().expect("ApplyService 前置：副本已就位");
                let info = service_info(copy_exe);
                let want_image = copy_exe.to_string_lossy().into_owned();
                match decide_service_action(probed.exists, &probed.image_path, &want_image) {
                    ServiceAction::Create => {
                        service = Some(
                            manager
                                .create_service(&info, op_access)
                                .map_err(|e| scm_err(e, "创建服务失败"))?,
                        );
                    }
                    // 变更/无操作：前置停服已由编排保证（变更仅落 ImagePath，启动在末步）
                    action @ (ServiceAction::Change | ServiceAction::None) => {
                        let svc = probed_svc.take().expect("Change/None 前置：服务已探查存在");
                        if action == ServiceAction::Change {
                            svc.change_config(&info)
                                .map_err(|e| scm_err(e, "更新服务 ImagePath 失败"))?;
                        }
                        service = Some(svc);
                    }
                }
            }
            InstallStep::WriteBinding => write_hklm_binding(&exe, &sha256)?,
            InstallStep::StartService => {
                start_if_stopped(service.as_ref().expect("Start 前置：服务已就位"))?;
            }
        }
    }
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

    // ---- install_plan 编排不变量（I4 终审：跨项目集成必须有一条穿层测试；编排层
    //      断言在此以纯函数步序形式落地，run_install 逐项执行同一序列）----

    #[test]
    fn install_plan_stops_running_service_before_copy() {
        // 运行中服务（重绑场景）：停服是第一步且先于副本覆盖——运行中映像被内核锁定，
        // 覆盖必失败（C2 缺陷根源）；完整序 stop→dir→copy→service→binding→start 一并锁定
        assert_eq!(
            install_plan(true, true),
            vec![
                InstallStep::StopService,
                InstallStep::PrepareDir,
                InstallStep::CopySelf,
                InstallStep::ApplyService,
                InstallStep::WriteBinding,
                InstallStep::StartService,
            ]
        );
    }

    #[test]
    fn install_plan_fresh_or_stopped_service_has_no_stop_step() {
        // 未安装：无停服步，其余序不变
        assert_eq!(
            install_plan(false, false),
            vec![
                InstallStep::PrepareDir,
                InstallStep::CopySelf,
                InstallStep::ApplyService,
                InstallStep::WriteBinding,
                InstallStep::StartService,
            ]
        );
        // 已安装但已停止：同样无需停服步（stop_service 本身幂等，计划层不入列）
        assert!(!install_plan(true, false).contains(&InstallStep::StopService));
    }

    #[test]
    fn install_plan_always_binds_before_start() {
        // 三态全组合：绑定恒先于启动（「绑定最后写、启动收尾」既有不变量随 C2 重排保持）
        for (exists, running) in [(false, false), (true, false), (true, true)] {
            let plan = install_plan(exists, running);
            let bind = plan
                .iter()
                .position(|s| *s == InstallStep::WriteBinding)
                .unwrap();
            let start = plan
                .iter()
                .position(|s| *s == InstallStep::StartService)
                .unwrap();
            assert!(bind < start, "exists={exists} running={running}");
        }
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
