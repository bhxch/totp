//! ABE 提权 Tauri 命令层（plan p6 §T4）：abe_status / abe_bind / abe_wrap / abe_remove /
//! abe_unwrap。I1 终审：bind/wrap/remove/unwrap 四个动状态或动 DEK 的命令均按主窗口
//! 门控（ensure_main_window_label，先例 db33486 abe_unwrap）；abe_status 只读无门控。
//!
//! 本模块全平台编译：`generate_handler!` 宏不支持条目级 cfg，注册须无条件（审查裁定
//! 拆 cfg 包装层的样板远贵于 3 个桩）；Windows 真实现经 [`crate::elevation_client`] /
//! [`crate::elevation_install`]（均 cfg(windows) 门控，Linux CI 不编译提权机制），
//! 非 Windows 走 supported:false 桩——TS 侧 supported=false 不渲染不调用，桩仅兜底防御。
//!
//! abe_status 映射语义（Task 2 审查裁定）：失配者收到的是连接级错误 Resp 而非 Status JSON，
//! 故 matchesCaller 恒由「Status ok 与否」推导——boundPath/version 仅匹配者可见，失配态
//! 前端展示「需要重新绑定」即可，无需路径细节（预期行为）。

use serde::Serialize;
use zeroize::Zeroize;

/// abe_status 返回（前端契约 §T4；serde camelCase 对齐 TS AbeStatus：
/// { installed, matchesCaller, boundPath?, version? }——supported 由 AbeOps.supported 表达，
/// 不在状态体重复，TS 侧显隐判定亦只认 AbeOps.supported）
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbeStatusResult {
    /// 平台支持（非 Windows 桩 false；UI 据此不渲染区块）
    pub supported: bool,
    /// 服务已安装（管道可达即 true——含失配/未绑定态）
    pub installed: bool,
    /// 当前调用者通过验证（Status ok 才可知 true；失配/未绑定/未知均 false）
    pub matches_caller: bool,
    /// 绑定路径（仅匹配者从 Status JSON 可得）
    pub bound_path: Option<String>,
    /// 服务版本（仅匹配者可得）
    pub version: Option<String>,
}

/// abe_status（管道 3s 超时上界的阻塞 IO）。形态（T4 审查 ⚠️ 收敛裁定）：async fn +
/// spawn_blocking——原 `#[tauri::command(async)]` 标同步体只会把阻塞挪到 tokio worker
/// 上原地阻塞；现收敛到 blocking 池。join 失败仅可能是纯映射实现 panic（无此路径），expect 兜底
#[tauri::command]
pub async fn abe_status() -> AbeStatusResult {
    tauri::async_runtime::spawn_blocking(abe_status_impl)
        .await
        .expect("abe_status 后台任务失败（实现 panic）")
}

/// abe_bind（§T4）：trigger_install 一次 UAC → 1.5s 间隔轮询 Status 至服务可达，最多 10s。
/// UAC 交互与轮询循环均为分钟级无上界阻塞段（T4 审查 ⚠️）：整体收敛 spawn_blocking，
/// worker 线程不被占。UAC 取消/提权进程失败/join 失败经 Err(String) 传播（TS 侧捕获为 false）。
/// 主窗口门控（I1 终审）：UAC 提权安装属动系统状态的高权命令，mini webview 内脚本 invoke
/// 恒 Err「仅主窗口可调用此命令」（同 abe_unwrap 先例 db33486）；label 先取再 move
#[tauri::command]
pub async fn abe_bind(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || abe_bind_impl(&label))
        .await
        .map_err(|e| format!("abe_bind 后台任务异常: {e}"))?
}

/// abe_wrap（C1 终审：绑定链补 Wrap 一步）：当前进程 DEK → 服务侧 Wrap → HKLM WrappedDek。
/// 与 abe_bind/addSource 编排为 bind→wrap→addSource（SecurityCard.onAbeBind），缺 wrap 步
/// 则 HKLM 永无密文、锁屏 abe.unwrap 恒 NoWrappedDek。DEK 入口命令与 abe_unwrap（DEK 出口）
/// 同标准：主窗口门控 + spawn_blocking（DEK 管道 IO 阻塞段，T4 审查 ⚠️）。入参形态与
/// abe_unwrap 返回对称：JSON number 数组（Vec<u8> serde 通道），32B 校验在实现层先行
/// （非 32B 直接拒，不发起管道往返）；DEK 缓冲处理完 zeroize（成功失败路径同清——含门控
/// 拒绝路径，R7-M3：&mut 入参 + 出口统一清零，不再有提前 return 跳过清零的分支）
#[tauri::command]
pub async fn abe_wrap(window: tauri::WebviewWindow, mut dek: Vec<u8>) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || abe_wrap_impl(&label, &mut dek))
        .await
        .map_err(|e| format!("abe_wrap 后台任务异常: {e}"))?
}

/// abe_remove（§T4）：管道 Remove 删 HKLM WrappedDek。恒回 {ok, message?} 不抛 invoke 错
/// ——服务不可达仅意味密文已随卸载消失，前端移除流程（清 security.json abe 源）不应被阻断；
/// 管道 IO 阻塞段收敛 spawn_blocking，join 失败折入 ok:false（与错误通道同形态）。
/// 主窗口门控（I1 终审）：动 HKLM 密文的写命令，mini 内 invoke 恒拒（门控失败折入
/// {ok:false,message}，与该命令恒不抛 invoke 错的通道契约一致）
#[tauri::command]
pub async fn abe_remove(window: tauri::WebviewWindow) -> serde_json::Value {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || abe_remove_impl(&label))
        .await
        .unwrap_or_else(|e| {
            serde_json::json!({ "ok": false, "message": format!("abe_remove 后台任务异常: {e}") })
        })
}

/// abe_unwrap（plan p6 §0.3/T7 锁屏静默解锁）：服务侧 Unwrap 代理返回明文 DEK（32B）。
/// 返回选型：Vec<u8> 经 serde 序列化为 JSON number 数组（Tauri invoke 默认 JSON 通道），
/// 32B 规模开销可忽略且 JS 侧 `new Uint8Array(arr)` 直构，不用 base64 省一次编解码往返；
/// DEK 在 JS 侧 unlockWithDek 注入会话后无密文残留（core 侧 zeroize 责任）。
/// 错误以 Err(String) 折叠外传——锁屏回退语义下 TS 侧仅 console.warn 留痕并回退 dpapi。
/// 主窗口门控（T7 fix 1/5）：DEK 出口命令与 dek_unprotect/os_auto_unprotect 同标准——
/// 命令体内按窗口 label 收窄（Tauri v2 对应用自有 command 无按窗口 ACL 细分），mini
/// webview 内脚本 invoke 恒 Err「仅主窗口可调用此命令」。DEK 管道 IO 阻塞段收敛
/// spawn_blocking（T4 审查 ⚠️）；label 先取再 move，窗口句柄不进 blocking 池
#[tauri::command]
pub async fn abe_unwrap(window: tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || abe_unwrap_impl(&label))
        .await
        .map_err(|e| format!("abe_unwrap 后台任务异常: {e}"))?
}

// ---------- 实现分派（cfg 内联，保持命令签名单点） ----------

#[cfg(windows)]
fn abe_status_impl() -> AbeStatusResult {
    status_outcome(crate::elevation_client::status())
}

#[cfg(not(windows))]
fn abe_status_impl() -> AbeStatusResult {
    unsupported()
}

#[cfg(windows)]
fn abe_bind_impl(window_label: &str) -> Result<serde_json::Value, String> {
    crate::platform_security::ensure_main_window_label(window_label)?;
    bind_and_wait()
}

#[cfg(not(windows))]
fn abe_bind_impl(_window_label: &str) -> Result<serde_json::Value, String> {
    Err("当前平台不支持 ABE 服务".into())
}

#[cfg(windows)]
fn abe_wrap_impl(window_label: &str, dek: &mut Vec<u8>) -> Result<(), String> {
    // 门控先行（mini + 非 32B 也报门控错，次序同历史行为）；&mut 入参 + 出口统一清零：
    // 成功/长度拒绝/门控拒绝任何路径返回前堆缓冲均已清（R7-M3——原实现在门控 ? 提前
    // return 时跳过 zeroize，与「成功失败路径同清」注释不符）
    let result = crate::platform_security::ensure_main_window_label(window_label).and_then(|()| {
        match <[u8; 32]>::try_from(dek.as_slice()) {
            // wrap_dek 双层 Result（外层=管道/传输错，内层=服务侧裁定）：外层映射 String，
            // 内层原样透出——语义与原 `map_err(?` 早退版一致，但不再提前 return 跳过清零
            Ok(arr) => crate::elevation_client::wrap_dek(&arr)
                .map_err(|e| e.to_string())
                .and_then(|inner| inner),
            Err(_) => Err(format!("DEK 长度非 32B: {}B", dek.len())),
        }
    });
    // 明文 DEK 处理完即清（Global Constraints；成功失败路径同清）
    dek.zeroize();
    result
}

/// 非 Windows：平台不支持即无 DEK 可入，不门控直接桩（与 abe_unwrap 非 Windows 形态一致）
#[cfg(not(windows))]
fn abe_wrap_impl(_window_label: &str, dek: &mut Vec<u8>) -> Result<(), String> {
    // 平台不支持同样不得滞留明文 DEK（与 Windows 出口同清——Global Constraints 跨平台一致，
    // 亦令 use zeroize::Zeroize 在两平台均有消费方，Linux clippy -D warnings 不报 unused）
    dek.zeroize();
    Err("当前平台不支持 ABE 服务".into())
}

#[cfg(windows)]
fn abe_remove_impl(window_label: &str) -> serde_json::Value {
    if let Err(e) = crate::platform_security::ensure_main_window_label(window_label) {
        return serde_json::json!({ "ok": false, "message": e });
    }
    remove_result_to_json(crate::elevation_client::remove_binding())
}

#[cfg(not(windows))]
fn abe_remove_impl(_window_label: &str) -> serde_json::Value {
    // 经同一折叠通道产出桩（{ok:false,message}），保持 Linux CI 下该纯函数有非测试消费方
    remove_result_to_json(Err("当前平台不支持 ABE 服务".to_string()))
}

#[cfg(windows)]
fn abe_unwrap_impl(window_label: &str) -> Result<Vec<u8>, String> {
    crate::platform_security::ensure_main_window_label(window_label)?;
    unwrap_outcome(crate::elevation_client::unwrap_dek())
}

/// 非 Windows：平台不支持即无 DEK 可泄，不门控直接桩（与 decrypt_dpapi 非 Windows 形态一致）
#[cfg(not(windows))]
fn abe_unwrap_impl(_window_label: &str) -> Result<Vec<u8>, String> {
    Err("当前平台不支持 ABE 服务".into())
}

/// unwrap 结果 → 前端载荷（§0.3/T7；Windows-only 纯函数化，单测覆盖成功与错误分型折叠）：
/// Ok(DEK) → 字节向量；四分型错误（Unavailable/CallerRejected/NoWrappedDek/Other）经
/// Display 折叠为 String——锁屏回退语义不区分失败原因，仅留痕。
/// dek.to_vec() 注记（fix 1/5 Minor）：[u8;32] 为 Copy，栈副本无法 zeroize——既定
/// Vec<u8> serde 接口形态下接受该残余（明文本体的堆缓冲在 unwrap_dek/transact 内已
/// 用后即清，残余面仅 32B 栈内存，随函数返回失效）
#[cfg(windows)]
fn unwrap_outcome(
    result: Result<[u8; 32], crate::elevation_client::UnwrapError>,
) -> Result<Vec<u8>, String> {
    result.map(|dek| dek.to_vec()).map_err(|e| e.to_string())
}

/// 非 Windows 统一桩形态
#[cfg(not(windows))]
fn unsupported() -> AbeStatusResult {
    AbeStatusResult {
        supported: false,
        installed: false,
        matches_caller: false,
        bound_path: None,
        version: None,
    }
}

// ---------- Windows 实现 ----------

#[cfg(windows)]
mod win {
    use std::time::{Duration, Instant};

    use crate::elevation_client::{self, ClientError, StatusReply};
    use crate::elevation_install;

    use super::AbeStatusResult;

    /// bind 轮询间隔（§T4：UAC 成功后 1.5s 间隔）
    pub(super) const BIND_POLL_INTERVAL: Duration = Duration::from_millis(1500);
    /// bind 轮询预算（§T4：最多 10s——CreateService→Start 与首连接落位的竞态余量）
    pub(super) const BIND_POLL_BUDGET: Duration = Duration::from_secs(10);

    /// abe_status 数据 → 前端形态映射（§T4 审查裁定的纯函数化，单测覆盖四分支）：
    /// ok → installed+matches；非 ok（失配/未绑定，管道可达）→ installed+失配；
    /// Unavailable（管道不存在）→ 未安装；其余（打开/传输/协议失败）→ 管道可达按失配兜底
    pub(super) fn status_outcome(reply: Result<StatusReply, ClientError>) -> AbeStatusResult {
        match reply {
            Ok(StatusReply::Ok(info)) => {
                let non_empty = |s: String| if s.is_empty() { None } else { Some(s) };
                AbeStatusResult {
                    supported: true,
                    installed: true,
                    matches_caller: true,
                    bound_path: non_empty(info.bound_path),
                    version: non_empty(info.version),
                }
            }
            Ok(StatusReply::Rejected(_)) => reachable_but_rejected(),
            // ERROR_FILE_NOT_FOUND 等：服务未安装/未运行
            Err(ClientError::Unavailable(_)) => AbeStatusResult {
                supported: true,
                installed: false,
                matches_caller: false,
                bound_path: None,
                version: None,
            },
            // 管道曾打开成功后的读写/协议失败：installed 恒真，验证态未知按失配兜底
            Err(_) => reachable_but_rejected(),
        }
    }

    /// 管道可达但调用者验证态为否（失配/未绑定/未知）
    fn reachable_but_rejected() -> AbeStatusResult {
        AbeStatusResult {
            supported: true,
            installed: true,
            matches_caller: false,
            bound_path: None,
            version: None,
        }
    }

    /// bind 主体：UAC 安装 → 轮询服务可达。UAC 结果以提权进程退出码为准（错误 stderr
    /// 不可见于 GUI 子系统，安装结果以 Status 复核为准——见 trigger_install 注释）
    pub(super) fn bind_and_wait() -> Result<serde_json::Value, String> {
        elevation_install::trigger_install().map_err(|e| e.to_string())?;
        // UAC 成功 ≠ 服务立即可达（CreateService→StartService 异步落位）：轮询至
        // status() 不再 Unavailable（含 Rejected——装好即失配也属「服务可达」，
        // 失配态由 abe_status 呈现并走重绑，bind 本身不失败）
        let deadline = Instant::now() + BIND_POLL_BUDGET;
        loop {
            match elevation_client::status() {
                Ok(_) => return Ok(serde_json::json!({ "ok": true })),
                Err(err) => {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "安装命令已完成，但服务未在 {:?} 内可达: {err}",
                            BIND_POLL_BUDGET
                        ));
                    }
                    std::thread::sleep(BIND_POLL_INTERVAL);
                }
            }
        }
    }
}

#[cfg(windows)]
use win::{bind_and_wait, status_outcome};

/// remove 结果 → {ok, message?}（全平台可测：错误类型泛型化，客户端层折叠完成后
/// 内层恒为 String）
fn remove_result_to_json<E: std::fmt::Display>(
    result: Result<Result<(), String>, E>,
) -> serde_json::Value {
    match result {
        Ok(Ok(())) => serde_json::json!({ "ok": true }),
        Ok(Err(msg)) => serde_json::json!({ "ok": false, "message": msg }),
        Err(e) => serde_json::json!({ "ok": false, "message": e.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- abe_status 映射四分支（§T4 审查裁定语义）----

    #[cfg(windows)]
    #[test]
    fn status_outcome_mapping() {
        use crate::elevation_client::{ClientError, StatusInfo, StatusReply};
        use crate::elevation_proto::ErrCode;

        // ok：全量信息（匹配者视角）
        let ok = status_outcome(Ok(StatusReply::Ok(StatusInfo {
            bound_path: r"C:\App\TotpTools.exe".into(),
            sha256_prefix: "abcd1234".into(),
            version: "1.2.3".into(),
        })));
        assert_eq!(
            ok,
            AbeStatusResult {
                supported: true,
                installed: true,
                matches_caller: true,
                bound_path: Some(r"C:\App\TotpTools.exe".into()),
                version: Some("1.2.3".into()),
            }
        );

        // 失配（连接级 PathMismatch/HashMismatch）：管道可达但拿不到 Status JSON
        for code in [ErrCode::PathMismatch, ErrCode::HashMismatch] {
            let r = status_outcome(Ok(StatusReply::Rejected(code)));
            assert!(r.installed && !r.matches_caller, "{code:?}");
            assert_eq!(r.bound_path, None);
            assert_eq!(r.version, None);
        }
        // 未绑定（VerifyError）：同样 installed+失配
        let r = status_outcome(Ok(StatusReply::Rejected(ErrCode::VerifyError)));
        assert!(r.installed && !r.matches_caller);

        // 管道不存在：未安装
        let r = status_outcome(Err(ClientError::Unavailable("not found".into())));
        assert!(!r.installed && !r.matches_caller);

        // 打开/传输失败（管道可达语义）：installed+失配兜底
        let r = status_outcome(Err(ClientError::OpenFailed("busy".into())));
        assert!(r.installed && !r.matches_caller);
        let r = status_outcome(Err(ClientError::Io("timeout".into())));
        assert!(r.installed && !r.matches_caller);
    }

    // ---- abe_remove 折叠（全平台可测）----

    #[test]
    fn remove_result_folding() {
        assert_eq!(
            remove_result_to_json::<std::io::Error>(Ok(Ok(()))),
            serde_json::json!({ "ok": true })
        );
        assert_eq!(
            remove_result_to_json::<std::io::Error>(Ok(Err("删除被拒".into()))),
            serde_json::json!({ "ok": false, "message": "删除被拒" })
        );
        let e = std::io::Error::other("pipe gone");
        assert_eq!(
            remove_result_to_json(Err(e)),
            serde_json::json!({ "ok": false, "message": "pipe gone" })
        );
    }

    // ---- abe_unwrap 折叠（§0.3/T7，全分型）----

    #[cfg(windows)]
    #[test]
    fn unwrap_outcome_folding() {
        use crate::elevation_client::UnwrapError;

        // 成功：32B DEK → 字节向量（invoke JSON number 数组载荷）
        let dek = [7u8; 32];
        assert_eq!(unwrap_outcome(Ok(dek)), Ok(dek.to_vec()));

        // 回退主路径分型（预期失败，文案仅 warn 留痕）
        assert_eq!(
            unwrap_outcome(Err(UnwrapError::Unavailable)),
            Err("ABE 服务不可达（未安装或未运行）".into())
        );
        assert_eq!(
            unwrap_outcome(Err(UnwrapError::CallerRejected)),
            Err("ABE 服务拒绝当前调用者".into())
        );
        assert_eq!(
            unwrap_outcome(Err(UnwrapError::NoWrappedDek)),
            Err("ABE 服务无已绑定密文".into())
        );
        assert_eq!(
            unwrap_outcome(Err(UnwrapError::Other("x".into()))),
            Err("x".into())
        );
    }

    // ---- abe_unwrap 主窗口门控（T7 fix 1/5；DEK 出口命令同标准）----

    #[cfg(windows)]
    #[test]
    fn abe_unwrap_impl_gates_mini_window() {
        // mini webview 内脚本 invoke：门控先行，不触达管道即拒（错误消息与 platform_security 同源）
        assert_eq!(abe_unwrap_impl("mini").unwrap_err(), "仅主窗口可调用此命令");
        // 主窗口 label 放行（至 unwrap 阶段因测试环境无服务管道而失败——非门控错误即达门控后方）
        let err = abe_unwrap_impl("main").unwrap_err();
        assert_ne!(err, "仅主窗口可调用此命令");
    }

    // ---- abe_bind/abe_remove 主窗口门控（I1 终审）----
    // 仅测 mini 拒绝：main 路径 bind 会拉 UAC、remove 会动 HKLM WrappedDek，测试禁触

    #[cfg(windows)]
    #[test]
    fn abe_bind_impl_gates_mini_window() {
        assert_eq!(abe_bind_impl("mini").unwrap_err(), "仅主窗口可调用此命令");
    }

    #[cfg(windows)]
    #[test]
    fn abe_remove_impl_gates_mini_window() {
        // 门控失败折入 {ok:false,message}（本命令恒不抛 invoke 错的通道契约）
        assert_eq!(
            abe_remove_impl("mini"),
            serde_json::json!({ "ok": false, "message": "仅主窗口可调用此命令" })
        );
    }

    // ---- abe_wrap 门控与 32B 校验（C1 终审；DEK 入口命令同 unwrap 门控标准）----

    #[cfg(windows)]
    #[test]
    fn abe_wrap_impl_gates_mini_window() {
        assert_eq!(
            abe_wrap_impl("mini", &mut vec![0u8; 32]).unwrap_err(),
            "仅主窗口可调用此命令"
        );
    }

    #[cfg(windows)]
    #[test]
    fn abe_wrap_impl_rejects_non_32b_after_gate() {
        // 主窗口放行至长度校验（非 32B 在实现层先拒，不发起管道往返——错误非门控文案）
        let err = abe_wrap_impl("main", &mut vec![0u8; 31]).unwrap_err();
        assert!(err.contains("32B"), "实际: {err}");
        assert_ne!(err, "仅主窗口可调用此命令");
    }

    // ---- abe_wrap 清零（R7-M3）：门控拒绝/长度拒绝路径与成功路径同清（&mut 入参令清零可断言）----

    #[cfg(windows)]
    #[test]
    fn abe_wrap_impl_zeroizes_dek_on_rejected_paths() {
        // 门控拒绝（原缺陷路径：? 提前 return 跳过 zeroize）
        let mut dek = vec![7u8; 32];
        let _ = abe_wrap_impl("mini", &mut dek);
        assert!(dek.iter().all(|&b| b == 0), "门控拒绝路径未清零");
        // 长度拒绝（主窗口放行后非 32B 被拒）
        let mut short = vec![7u8; 31];
        let _ = abe_wrap_impl("main", &mut short);
        assert!(short.iter().all(|&b| b == 0), "长度拒绝路径未清零");
    }

    // ---- 命令层 async 通道守护（T4 审查 ⚠️ 收敛）：命令经 spawn_blocking 返回与同步
    // 实现一致。只探只读 status——bind/remove/wrap 带 WebviewWindow 参数（测试环境无法
    // 构造窗口）且会动 UAC/HKLM，禁触，门控与折叠已由各 impl 层测试覆盖；
    // Windows 下 installed 随真机环境可真可假，仅断言平台位 supported（四分支映射已由
    // status_outcome_mapping 纯函数覆盖）；非 Windows 桩路径全量断言见 unsupported_platform_stub ----

    #[test]
    fn async_commands_delegate_via_blocking_pool() {
        tauri::async_runtime::block_on(async {
            let s = abe_status().await;
            assert_eq!(s.supported, cfg!(windows));
        });
    }

    #[test]
    fn abe_status_result_serializes_camel_case() {
        let v = serde_json::to_value(AbeStatusResult {
            supported: true,
            installed: true,
            matches_caller: true,
            bound_path: Some(r"C:\x.exe".into()),
            version: Some("9.9.9".into()),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "supported": true,
                "installed": true,
                "matchesCaller": true,
                "boundPath": r"C:\x.exe",
                "version": "9.9.9",
            })
        );
    }

    // 非 Windows 桩形态（Linux CI 亦验证）
    #[cfg(not(windows))]
    #[test]
    fn unsupported_platform_stub() {
        let s = abe_status_impl();
        assert!(!s.supported && !s.installed && !s.matches_caller);
        assert_eq!(
            abe_bind_impl("main").unwrap_err(),
            "当前平台不支持 ABE 服务"
        );
        assert_eq!(
            abe_remove_impl("main"),
            serde_json::json!({ "ok": false, "message": "当前平台不支持 ABE 服务" })
        );
        assert_eq!(
            abe_wrap_impl("main", &mut vec![0u8; 32]).unwrap_err(),
            "当前平台不支持 ABE 服务"
        );
        assert_eq!(
            abe_unwrap_impl("main").unwrap_err(),
            "当前平台不支持 ABE 服务"
        );
    }
}
