//! 系统锁屏事件监听（plan16 T15 / 设计 §1 锁定策略「系统锁屏」触发器，仅桌面端）。
//!
//! Windows 实现：专用线程创建隐藏顶层窗口，`WTSRegisterSessionNotification(hwnd,
//! NOTIFY_FOR_THIS_SESSION)` 订阅本会话的会话变更；窗口过程收到 `WM_WTSSESSION_CHANGE`
//! 且 `wParam == WTS_SESSION_LOCK`（系统锁屏/进入屏保）时向前端广播 `system-lock` 事件，
//! 前端按 settings.lockOnSystemLock 实时决定是否执行锁定。注销时机：窗口 WM_DESTROY 与
//! 应用退出（RunEvent::Exit → shutdown）；进程终止时由 OS 自动清理兜底。
//!
//! 计划裁定偏差第三条：Windows 先行，macOS/Linux 记挂账——本模块对非 Windows 提供
//! no-op 空实现，`system-lock` 事件恒不触发，前端 lockOnSystemLock 开关自然降级为
//! 无操作，不影响其余触发器（空闲/重启/手动锁）。

#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    imp::start(app);
}

/// 应用退出时注销会话通知并结束监听线程（lib.rs RunEvent::Exit 调用）
#[cfg(windows)]
pub fn shutdown() {
    imp::shutdown();
}

/// 非 Windows 空实现（挂账：macOS/Linux 系统锁屏触发器待平台适配）
#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}

/// 非 Windows 空实现
#[cfg(not(windows))]
pub fn shutdown() {}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter};
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW,
        PostQuitMessage, RegisterClassW, TranslateMessage, WTS_SESSION_LOCK, WM_CLOSE, WM_DESTROY,
        WM_WTSSESSION_CHANGE, WNDCLASSW, WS_OVERLAPPED,
    };

    /// 事件回调持有的 AppHandle：窗口过程是 extern "system" fn 无法捕获环境，经静态
    /// 注册表传递（Tauri 2 AppHandle 为 Send+Sync，跨线程 emit 安全）
    static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

    /// 已注册 WTS 通知的窗口句柄（isize 形态）：shutdown 跨线程投递 WM_CLOSE 用
    static REGISTERED_HWND: AtomicIsize = AtomicIsize::new(0);

    /// 启动监听（lib.rs setup 钩子调用；应用生命周期内幂等，重复调用不叠线程）
    pub fn start(app: AppHandle) {
        {
            let Ok(mut g) = APP.lock() else { return };
            if g.is_some() {
                return;
            }
            *g = Some(app);
        }
        // 隐藏窗口 + 消息泵必须独占线程：Tauri 主线程跑自身事件循环，不可被 GetMessage 阻塞
        let spawned = std::thread::Builder::new().name("lock-events".into()).spawn(|| {
            if let Err(e) = unsafe { run_message_window() } {
                eprintln!("[lock_events] 锁屏监听线程退出：{e}");
            }
        });
        if let Err(e) = spawned {
            eprintln!("[lock_events] 监听线程创建失败（系统锁屏触发器不可用）：{e}");
        }
    }

    /// 应用退出：向监听线程投递 WM_CLOSE → WM_DESTROY → 注销 + 退出消息泵
    pub fn shutdown() {
        let hwnd = REGISTERED_HWND.swap(0, Ordering::SeqCst);
        if hwnd != 0 {
            // DestroyWindow 仅允许窗口创建线程调用，跨线程只能经消息间接触发
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(hwnd as *mut core::ffi::c_void)),
                    WM_CLOSE,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
        }
        if let Ok(mut g) = APP.lock() {
            *g = None;
        }
    }

    /// 创建隐藏顶层窗口、订阅会话通知并运行消息泵（阻塞至 WM_QUIT）。
    /// 用隐藏顶层窗口而非 message-only 窗口：后者非顶层窗口，不保证收到 WM_WTSSESSION_CHANGE。
    unsafe fn run_message_window() -> windows::core::Result<()> {
        let hinstance: windows::Win32::Foundation::HINSTANCE = GetModuleHandleW(None)?.into();
        let class_name = w!("totp_lock_events_wndclass");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(lock_event_wnd_proc),
            hInstance: hinstance,
            lpszClassName: class_name,
            ..Default::default()
        };
        // 同进程重复注册同名 class 返回 0（start 幂等已防重入）；失败由 CreateWindowExW 报错兜底
        unsafe { RegisterClassW(&wc) };
        let hwnd = unsafe {
            CreateWindowExW(
                Default::default(), // WINDOW_EX_STYLE(0)
                class_name,
                w!("totp lock events"),
                WS_OVERLAPPED, // 隐藏顶层窗口（无 WS_VISIBLE，永不 ShowWindow）
                0,
                0,
                0,
                0,
                None, // 无父窗口 → 顶层
                None, // 无菜单
                Some(hinstance),
                None,
            )?
        };
        unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)? };
        REGISTERED_HWND.store(hwnd.0 as isize, Ordering::SeqCst);

        // 消息泵：GetMessage 返回 0（WM_QUIT）即结束线程；-1（错误）同样终止泵
        let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
            let _ = unsafe { TranslateMessage(&msg) };
            let _ = unsafe { DispatchMessageW(&msg) };
        }
        Ok(())
    }

    unsafe extern "system" fn lock_event_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_WTSSESSION_CHANGE => {
                if wparam.0 == WTS_SESSION_LOCK as usize {
                    let Ok(g) = APP.lock() else { return LRESULT(0) };
                    if let Some(app) = g.as_ref() {
                        // 广播到全部窗口（main/mini 均可监听）；无监听者时事件自然丢弃
                        if let Err(e) = app.emit("system-lock", ()) {
                            eprintln!("[lock_events] system-lock 事件发送失败：{e}");
                        }
                    }
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                // 窗口销毁即注销；异常退出/进程终止路径由 OS 自动清理兜底
                let _ = unsafe { WTSUnRegisterSessionNotification(hwnd) };
                REGISTERED_HWND.store(0, Ordering::SeqCst);
                unsafe { PostQuitMessage(0) };
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }
}
