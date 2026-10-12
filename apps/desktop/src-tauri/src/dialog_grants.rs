//! 对话框授权与备份/导入文件命令（R8 自 lib.rs 分节纯移动）：对话框由 Rust 侧打开，
//! 选中目录 normalize_for_containment（canonicalize 优先，RamDisk 等卷不支持时词法归一）
//! 后登记进 DialogGrants 并返回不透明 token，文件命令以 dirToken
//! 反查登记目录做遏制；接线（manage 登记/run() 装载持久化授权）留在 lib.rs。

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::settings_io::write_text_atomic;

// ---------- 备份/导入文件命令 ----------
// 信任边界（F4 根修）：read/write_text_file_os 等命令的遏制基准不再接受前端 IPC 自证的
// allowed_dir（前端以 parentDirOf(同一路径) 自证派生，遏制比较按构造恒真）。现在对话框由
// Rust 侧打开（pick_dir_os / pick_open_file_os / pick_save_file_os），选中目录归一后登记进
// DialogGrants 并返回不透明 token，文件命令以 dirToken 反查登记目录做遏制；
// 扩展名白名单（备份 .totpbackup / 导入扩展名组）保持不变，防被前端脚本当任意读写原语。
// remove_backup_file 仅允许 AppData/backups 下的合法备份名（白名单防路径穿越）。

/// 会话授权登记容量上限（简易 LRU：超出逐出最旧；持久化文件同受此约束）
const GRANT_CAP: usize = 16;
/// 跨会话授权文件（AppData 下：目录对话框登记时后端写入，启动时装载）
const GRANTS_FILE: &str = "dialog_grants.json";

/// 登记来源（B1 持久化边界）：Dir=目录对话框（备份源目录，跨会话落盘）；
/// File=文件对话框父目录（导出/恢复/导入，仅会话内、不落盘）
#[derive(Clone, Copy, PartialEq, Eq)]
enum GrantSource {
    Dir,
    File,
}

/** 对话框授权登记：token（OS CSPRNG 随机，不可预测）→ canonical 目录 + 来源。
 *  跨会话说明：备份源目录的自动/手动备份在重启后仍需静默写盘，无法要求每次重弹对话框，
 *  故 pick_dir_os 登记时把目录持久化到 GRANTS_FILE、启动时装载。诚实边界：该文件位于
 *  webview 可写的 AppData（fs:allow-appdata-write-recursive），被持久化 XSS 污染的下一个
 *  会话可借篡改该文件登记任意目录——跨会话授权弱于本会话对话框登记；本设计消除的是
 *  运行中会话「自证参数直通任意路径」的读/写/删原语。持久化范围（B1）：仅 Dir 来源
 *  （目录对话框登记项）落盘——persist/load 均按来源过滤，磁盘格式保持纯字符串数组
 *  （装载项一律按 Dir 来源登记，旧文件天然兼容）；File 来源（文件对话框登记的父目录）
 *  只在会话内可用，不落盘。 */
#[derive(Default)]
pub struct DialogGrants {
    // 简易 LRU：front=最旧（登记/命中序），容量 GRANT_CAP
    entries: Mutex<Vec<(String, std::path::PathBuf, GrantSource)>>,
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("OS CSPRNG 不可用");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

impl DialogGrants {
    /** 登记目录（须已经 normalize_for_containment 归一）：同目录复用既有 token（刷新为最近使用），超限逐出最旧。
     *  来源只升不降：同目录先经目录对话框授权（Dir，已落盘）后再被文件对话框复登记（File）
     *  不降级，已持久化授权保持重启可装载 */
    fn register(&self, canonical: std::path::PathBuf, source: GrantSource) -> String {
        let mut g = self.entries.lock().unwrap();
        if let Some(i) = g.iter().position(|(_, d, _)| *d == canonical) {
            let (token, dir, prev) = g.remove(i);
            let merged = if prev == GrantSource::Dir {
                GrantSource::Dir
            } else {
                source
            };
            g.push((token.clone(), dir, merged));
            return token;
        }
        if g.len() >= GRANT_CAP {
            g.remove(0);
        }
        let token = random_token();
        g.push((token.clone(), canonical, source));
        token
    }

    /** token 反查登记目录（命中刷新为最近使用）；未知 token 拒绝 */
    fn resolve(&self, token: &str) -> Result<std::path::PathBuf, String> {
        let mut g = self.entries.lock().unwrap();
        let Some(i) = g.iter().position(|(t, _, _)| t == token) else {
            return Err("unknown dir token".into());
        };
        let (t, d, s) = g.remove(i);
        g.push((t, d.clone(), s));
        Ok(d)
    }

    /** 按已归一目录反查 token：备份源仅持久化路径字符串，重启后经此重取句柄 */
    fn token_for(&self, canonical: &std::path::Path) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(_, d, _)| d == canonical)
            .map(|(t, _, _)| t.clone())
    }

    /// 仅 Dir 来源目录（persist_grants 序列化的唯一来源：File 来源项仅会话内，不落盘）
    fn persistable_dirs(&self) -> Vec<std::path::PathBuf> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, _, s)| *s == GrantSource::Dir)
            .map(|(_, d, _)| d.clone())
            .collect()
    }
}

fn grants_store_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(GRANTS_FILE))
}

/// 持久化装载核心（B3 抽纯函数，不依赖 AppHandle，便于单测）：JSON 字符串数组 → 逐项
/// 归一化（回调注入，canonicalize 优先/词法退路） → 过滤失败项（目录已删/不可达）。仅接受
/// 字符串数组——磁盘格式
/// 自始即 Vec<String>，旧文件天然兼容，装载项一律按 Dir 来源登记；非数组/元素类型不符/
/// 解析失败返回空（与既有 load_grants 静默忽略口径一致）
fn parse_persisted_dirs(
    text: &str,
    canonicalize: impl Fn(&str) -> std::io::Result<std::path::PathBuf>,
) -> Vec<std::path::PathBuf> {
    let Ok(dirs) = serde_json::from_str::<Vec<String>>(text) else {
        return Vec::new();
    };
    dirs.into_iter()
        .filter_map(|d| canonicalize(&d).ok())
        .collect()
}

/// 启动装载：持久化授权 → 会话登记（目录已不存在则丢弃；装载项一律 Dir 来源）
pub fn load_grants(app: &tauri::AppHandle) {
    let Some(p) = grants_store_path(app) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(p) else {
        return;
    };
    let state = app.state::<DialogGrants>();
    for c in parse_persisted_dirs(&text, |d| {
        normalize_for_containment(std::path::Path::new(d)).map_err(std::io::Error::other)
    }) {
        state.register(c, GrantSource::Dir);
    }
}

/// 目录登记后的持久化（best-effort：写失败不影响本会话授权，仅影响重启后的自动备份）。
/// 只序列化 Dir 来源项（B1）：文件对话框登记项仅会话内，不随任一 grant_dir 触发的持久化落盘
fn persist_grants(app: &tauri::AppHandle) {
    let Some(p) = grants_store_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string_pretty(&app.state::<DialogGrants>().persistable_dirs())
    {
        // 原子写（同审查 I-5 口径）：grants 文件与 settings.json 同级，写一半崩溃不再留半截 JSON
        let _ = write_text_atomic(&p, &json);
    }
}

fn valid_backup_name(name: &str) -> bool {
    // 白名单：vault- 前缀、.totpbackup 后缀、不含路径分隔符与 ..，防路径穿越
    name.starts_with("vault-")
        && name.ends_with(BACKUP_EXTENSION)
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/** C9/F4：校验 path.parent() 必须落在后端登记目录内。双侧 normalize_for_containment 归一：
 *  canonicalize 解析 symlink/junction/8.3/大小写防链接逃逸（原行为）；卷不支持时词法归一 +
 *  逐级 reparse 拒绝（见该函数文档），比较走大小写不敏感折叠（Windows 语义） */
fn ensure_within(path: &std::path::Path, allowed_dir: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid path: no parent".to_string())?;
    ensure_within_with(parent, allowed_dir, |p: &std::path::Path| {
        std::fs::canonicalize(p)
    })
}

/// 可注入 canonicalize 的遏制核心（单测模拟 RamDisk 类卷：canonicalize 恒报 os error 1）
fn ensure_within_with(
    parent: &std::path::Path,
    allowed_dir: &std::path::Path,
    canonicalize: impl Fn(&std::path::Path) -> std::io::Result<std::path::PathBuf>,
) -> Result<(), String> {
    let abs_parent = normalize_with(parent, |p: &std::path::Path| canonicalize(p))?;
    let abs_allowed = normalize_with(allowed_dir, |p: &std::path::Path| canonicalize(p))?;
    #[cfg(windows)]
    {
        if !folded_starts_with(&abs_parent, &abs_allowed) {
            return Err("path outside allowed dir".into());
        }
    }
    #[cfg(not(windows))]
    {
        if !abs_parent.starts_with(&abs_allowed) {
            return Err("path outside allowed dir".into());
        }
    }
    Ok(())
}

/// 卷不支持 GetFinalPathNameByHandle 的识别（Windows 语义：os error 1 Incorrect function
/// ——实测 RamDisk 卷即此错、50 Not supported、120 Call not implemented）。仅按 raw code
/// 判定且仅 Windows 启用：Unix 的 raw 1 是 EPERM，语义无关，保持既有 fail-closed
#[cfg(windows)]
fn canonicalize_unsupported(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(1 | 50 | 120))
}

/// 登记与遏制比较共用的路径归一化：canonicalize 优先（解析链接/大小写/8.3）；卷不支持时
/// 退回词法归一（RamDisk 等虚拟盘驱动不实现 GetFinalPathNameByHandle，实测 Z: 报
/// 「Incorrect function (os error 1)」而纯读取正常——导入/导出/备份在这些盘上全军覆没的根因）。
/// 登记/校验双侧恒走同一函数，归一形态可比较；其余错误（不存在/拒绝访问等）照常 fail-closed
fn normalize_for_containment(p: &std::path::Path) -> Result<std::path::PathBuf, String> {
    normalize_with(p, |q: &std::path::Path| std::fs::canonicalize(q))
}

/// 可注入 canonicalize 的归一化核心（单测注入恒失败模拟 RamDisk 类卷）
fn normalize_with(
    p: &std::path::Path,
    canonicalize: impl Fn(&std::path::Path) -> std::io::Result<std::path::PathBuf>,
) -> Result<std::path::PathBuf, String> {
    match canonicalize(p) {
        Ok(c) => Ok(c),
        Err(e) => {
            #[cfg(windows)]
            if canonicalize_unsupported(&e) {
                return lexical_normalize(p);
            }
            Err(e.to_string())
        }
    }
}

/// 词法归一（canonicalize 不可用的卷上的退路，仅 Windows）：绝对路径校验（对话框路径恒
/// 绝对，相对即异常 fail-closed）；逐组件消解 . 与 ..（出根即拒绝，防穿越）；逐级祖先双重
/// 检查——symlink_metadata 存在性（死目录在持久化装载过滤时须失败）+ leaf_redirects_path
/// 路径重定向判定（无链接解析能力时对 symlink/junction fail-closed，云占位等无路径目标
/// reparse 与普通路径放行）。末位组件也一并查（目录登记时它即目标本身；文件路径的叶子
/// 另有读取/直写通道的同名判定把守）
#[cfg(windows)]
fn lexical_normalize(p: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use std::path::Component;
    if !p.is_absolute() {
        return Err("path not absolute".into());
    }
    let mut out = std::path::PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    return Err("path outside allowed dir".into());
                }
            }
            Component::CurDir => {}
            // RootDir 不能走 PathBuf::push（带根路径的替换语义：verbatim/UNC 前缀 + "\"
            // 会被整段吞成 "\"，实测 \\?\E: + "\\\\" → "\\"），改 OsString 裸拼接
            Component::RootDir => {
                let mut os: std::ffi::OsString = out.into_os_string();
                os.push(std::path::MAIN_SEPARATOR_STR);
                out = os.into();
            }
            _ => out.push(c.as_os_str()),
        }
    }
    let mut anc = out.as_path();
    loop {
        std::fs::symlink_metadata(anc).map_err(|e| e.to_string())?;
        if leaf_redirects_path(anc) {
            return Err("path outside allowed dir".into());
        }
        match anc.parent() {
            Some(up) if up != anc => anc = up,
            _ => break,
        }
    }
    Ok(out)
}

/// Windows 遏制比较的形态折叠：\\?\verbatim 剥离、\\?\UNC\server\share → \\server\share
/// 对齐、小写化（Windows 路径大小写不敏感）。canonical（\\?\E:\a）与词法（E:\a）混合形态
/// 也能对齐；非尾随 \ 的目录前缀须以「目录+\」为界（Path::starts_with 组件语义的字符串版）
#[cfg(windows)]
fn folded_starts_with(parent: &std::path::Path, dir: &std::path::Path) -> bool {
    let fold = |p: &std::path::Path| {
        let mut s = p.to_string_lossy().to_string();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            s = format!(r"\\{rest}");
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            s = rest.to_string();
        }
        s.to_lowercase()
    };
    let (p, d) = (fold(parent), fold(dir));
    let d = d.trim_end_matches('\\');
    !d.is_empty() && (p == d || p.starts_with(&format!("{d}\\")))
}

/// 路径重定向链接叶子判定（B2 叶子穿透防护，2026-10-12 修订：细分 reparse 标签）。
/// 判定以 std::fs::read_link 能否解析出目标为准——Windows 上 std 仅解析
/// IO_REPARSE_TAG_SYMLINK 与 IO_REPARSE_TAG_MOUNT_POINT 两类标签（std/src/sys/fs/
/// windows.rs readlink），其余 reparse 标签（云占位 CLOUD_1..9/CLOUD_SYNC_ROOT、ProjFS、
/// DEDUP 等系统托管标签，内容经驱动原位补全、不重定向路径，如 OneDrive 占位文件）一律
/// 报错，恰好构成「是否路径重定向」的分界：解析得出目标（symlink/junction）→ true，
/// 调用方按「路径越界」拒绝；解析不出（含普通文件）→ false 放行，云占位文件得以读取/写入。
/// TOCTOU 诚实边界：与既有检查相同，判定与后续读写之间窗口仍在
fn leaf_redirects_path(path: &std::path::Path) -> bool {
    std::fs::read_link(path).is_ok()
}

// ---------- 扩展名白名单（R11 单点：5 个文件命令共用 ensure_extension，白名单按命令用途分组） ----------

/// 备份文件扩展名（valid_backup_name 与读备份白名单共用）
const BACKUP_EXTENSION: &str = ".totpbackup";

/// 导出写白名单（批① §2.3）：备份 .totpbackup + otpauth 文本 .txt + Aegis JSON .json
const EXPORT_EXTENSIONS: [&str; 3] = [".totpbackup", ".json", ".txt"];

/// 二进制导出白名单（批① §2.5 多选二维码拼版 PNG）：不复用文本侧、也不并入文本命令
/// ——文本写 PNG 必然损坏，各命令用途与白名单一一对应
const IMAGE_EXTENSIONS: [&str; 1] = [".png"];

/// 导入文本组（R11 单点）：Aegis(.json/.aegis)、WinAuth(.wauth/.xml)、纯文本 URI 批量(.txt)、
/// generic JSON/JSONL(.jsonl——core import/generic.ts 支持 JSONL 行解析)。与 extension 端
/// options App.vue 的 accept 派生常量经下方镜像断言互验，防三端漂移
const IMPORT_TEXT_EXTENSIONS: [&str; 6] = [".json", ".jsonl", ".wauth", ".xml", ".txt", ".aegis"];

/// 导入二进制组（字节通道专用）：SQLite(.db/.sqlitedb/.sqlite) 与 AP 加密 zip(.zip)
const IMPORT_BINARY_EXTENSIONS: [&str; 4] = [".db", ".sqlitedb", ".sqlite", ".zip"];

/// 字节组白名单 = 文本组 + 二进制组拼接派生（R11：原为 9 项手工罗列的超集，与文本组
/// 各自维护已发生漂移——.jsonl 只在 extension 侧有；派生后文本组增删自动跟随）
fn import_byte_extensions() -> Vec<&'static str> {
    IMPORT_TEXT_EXTENSIONS
        .into_iter()
        .chain(IMPORT_BINARY_EXTENSIONS)
        .collect()
}

/// 扩展名白名单守护（R11 抽取，5 个文件命令共用）：exts 任一后缀命中即放行，否则报 msg。
/// 仅守护骨架（白名单步骤）——写盘通道各命令保持有意不同（text=write_text_atomic 原子写、
/// bytes=std::fs::write 直写，不得统一）。大小写语义内聚为两个包装（Minor-1）：exact 原样
/// 比较（读备份既有大小写敏感语义），ci 内部归一小写后比较（导出/导入组既有大小写不敏感
/// 语义），调用点按命令用途二选一，不再依赖调用方自行传入 lowercase 形态
fn ensure_extension_exact(path: &str, exts: &[&str], msg: &str) -> Result<(), String> {
    if !exts.iter().any(|ext| path.ends_with(ext)) {
        return Err(msg.into());
    }
    Ok(())
}

/// 大小写不敏感包装：路径 to_ascii_lowercase 后按 exact 比较（扩展名白名单均为 ASCII，
/// 后缀命中只发生在 ASCII 段，非 ASCII 文件名字符不受归一影响）
fn ensure_extension_ci(path: &str, exts: &[&str], msg: &str) -> Result<(), String> {
    ensure_extension_exact(&path.to_ascii_lowercase(), exts, msg)
}

// ---------- 对话框命令（F4：授权源头收归后端）----------
// 对话框只在用户交互时出现：前端即便被 XSS 调 pick_* 也只能弹出用户可见的系统对话框，
// 无法静默取得授权；文件命令全部要 dirToken，前端自证 allowed_dir 参数已删除。

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedPath {
    dir_token: String,
    path: String,
}

#[derive(serde::Deserialize)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// 登记选中「目录」本身（备份源目录，Dir 来源），并持久化跨会话授权
fn grant_dir(app: &tauri::AppHandle, dir: std::path::PathBuf) -> Result<PickedPath, String> {
    let normalized = normalize_for_containment(&dir)?;
    let token = app
        .state::<DialogGrants>()
        .register(normalized, GrantSource::Dir);
    persist_grants(app);
    Ok(PickedPath {
        dir_token: token,
        path: dir.to_string_lossy().to_string(),
    })
}

/// 登记选中「文件所在父目录」（导出保存/打开读取为单次会话流，File 来源不落盘）。
/// save 选中的新文件尚不存在，须对父目录归一登记（对话框保证父目录已存在）
fn grant_file_parent(
    app: &tauri::AppHandle,
    file: std::path::PathBuf,
) -> Result<PickedPath, String> {
    let dir = file
        .parent()
        .ok_or_else(|| "invalid path: no parent".to_string())?
        .to_path_buf();
    let normalized = normalize_for_containment(&dir)?;
    let token = app
        .state::<DialogGrants>()
        .register(normalized, GrantSource::File);
    Ok(PickedPath {
        dir_token: token,
        path: file.to_string_lossy().to_string(),
    })
}

/// 目录选择（备份源目录）：Rust 打开系统对话框 → canonical 登记 + 持久化 → {token, path}
#[tauri::command]
pub async fn pick_dir_os(app: tauri::AppHandle) -> Result<Option<PickedPath>, String> {
    let Some(fp) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    grant_dir(&app, fp.into_path().map_err(|e| e.to_string())?).map(Some)
}

/// 文件打开（备份恢复/导入）：同上，登记父目录，过滤器与旧前端对话框一致
#[tauri::command]
pub async fn pick_open_file_os(
    app: tauri::AppHandle,
    filters: Vec<DialogFilter>,
) -> Result<Option<PickedPath>, String> {
    let mut b = app.dialog().file();
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        b = b.add_filter(f.name.clone(), &exts);
    }
    let Some(fp) = b.blocking_pick_file() else {
        return Ok(None);
    };
    grant_file_parent(&app, fp.into_path().map_err(|e| e.to_string())?).map(Some)
}

/// 文件保存（备份导出）：default_name 为缺省文件名，登记保存位置父目录
#[tauri::command]
pub async fn pick_save_file_os(
    app: tauri::AppHandle,
    default_name: String,
    filters: Vec<DialogFilter>,
) -> Result<Option<PickedPath>, String> {
    let mut b = app.dialog().file().set_file_name(default_name);
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        b = b.add_filter(f.name.clone(), &exts);
    }
    let Some(fp) = b.blocking_save_file() else {
        return Ok(None);
    };
    grant_file_parent(&app, fp.into_path().map_err(|e| e.to_string())?).map(Some)
}

/// 备份源目录重取会话 token：仅对已登记（对话框授权过/启动装载）的归一目录发放
#[tauri::command]
pub fn dir_token_os(app: tauri::AppHandle, dir: String) -> Result<String, String> {
    let normalized = normalize_for_containment(std::path::Path::new(&dir))?;
    app.state::<DialogGrants>()
        .token_for(&normalized)
        .ok_or_else(|| "dir not granted via dialog".into())
}

#[tauri::command]
pub fn remove_backup_file(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !valid_backup_name(&name) {
        return Err("invalid backup name".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    std::fs::remove_file(dir.join(name)).map_err(|e| e.to_string())
}

/// 命令本体抽为 *_granted inner（tauri::State 单测无法构造，测试直打 inner，单一代码路径）
fn remove_backup_file_granted(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<(), String> {
    let p = std::path::Path::new(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if !valid_backup_name(&name) {
        return Err("invalid backup name".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// 用户自选备份目录的删除命令（D4/F4）：与 remove_backup_file 同守护（白名单名 + ensure_within），
/// 只是授权目录从「AppData/backups 固定值」改为「dirToken 反查的后端登记目录（对话框授权）」
#[tauri::command]
pub fn remove_backup_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    dir_token: String,
) -> Result<(), String> {
    remove_backup_file_granted(&grants, &path, &dir_token)
}

fn list_backup_files_granted(
    grants: &DialogGrants,
    dir_token: &str,
) -> Result<Vec<String>, String> {
    let dir = grants.resolve(dir_token)?;
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| {
            valid_backup_name(n) || (n.starts_with("conflict-") && n.ends_with(".totpbackup"))
        })
        .collect();
    names.sort();
    Ok(names)
}

/// 用户自选备份目录的列举命令（D4/F4）：不做 ensure_within——dir 本身即对话框授权目标
/// （dirToken 反查登记目录），列举仅返回白名单名
/// （vault-*.totpbackup 与 conflict-*.totpbackup），不泄露目录内其他文件
#[tauri::command]
pub fn list_backup_files_os(
    grants: tauri::State<DialogGrants>,
    dir_token: String,
) -> Result<Vec<String>, String> {
    list_backup_files_granted(&grants, &dir_token)
}

/// 读取守护链公共段（is_file + dirToken 反查登记目录遏制，双侧归一防逃逸——canonicalize
/// 优先，卷不支持时词法归一 + 逐级路径重定向拒绝），
/// 白名单由各命令按用途前置（read_text 大小写敏感、import 组大小写不敏感，语义各自保留），
/// 返回经校验的路径供读取。
/// B2 叶子穿透防护（2026-10-12 修订）：is_file 以 symlink_metadata 判定（不跟随末尾组件）；
/// 叶子为路径重定向链接（symlink/junction，read_link 可解析出目标）按「路径越界」同类错误
/// 拒绝（不读穿目录外目标、不泄漏目标信息）；云占位等无路径目标的系统 reparse 标签放行
/// （原 0x400 一刀切误杀 OneDrive 类占位文件——带属性即使已落地仍保留）。TOCTOU 诚实边界：
/// canonicalize(parent) 与最终 read 之间窗口仍在，本检查收窄窗口而非完全关闭 TOCTOU
/// （不引入 openat 复杂度）
fn read_granted_file_core(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    let meta = std::fs::symlink_metadata(p).map_err(|_| "not a file".to_string())?;
    if leaf_redirects_path(p) {
        return Err("path outside allowed dir".into());
    }
    if !meta.is_file() {
        return Err("not a file".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
    Ok(p.to_path_buf())
}

/// 命令本体抽 *_granted inner（tauri::State 单测无法构造，测试直打 inner，单一代码路径）：
/// 本命令唯一用途是读取备份文件，限定 .totpbackup 防止被前端 XSS 当作任意文件读取原语
fn read_text_file_granted(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<String, String> {
    ensure_extension_exact(path, &[BACKUP_EXTENSION], "invalid backup file extension")?;
    let p = read_granted_file_core(grants, path, dir_token)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    dir_token: String,
) -> Result<String, String> {
    read_text_file_granted(&grants, &path, &dir_token)
}

fn write_text_file_granted(
    grants: &DialogGrants,
    path: String,
    contents: String,
    dir_token: &str,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    // 扩展名白名单：本命令用途是备份导出（.totpbackup）与文本导出（批① §2.3：otpauth 文本
    // .txt / Aegis JSON .json，均经 pick_save_file_os 对话框授权）；CSP 为 null 的现状下，
    // 任意路径+任意内容写入等于 XSS 任意文件覆写原语，故仍限定扩展名集合
    ensure_extension_ci(&path, &EXPORT_EXTENSIONS, "invalid export file extension")?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err("path is a directory".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
    // 原子写（同审查 I-5 口径）：备份/文本导出写一半崩溃不再留半截文件。
    // 写盘通道有意与 bytes 通道不同（原子写 vs 直写），不得随守护链收敛统一（R11）
    write_text_atomic(std::path::Path::new(&path), &contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    contents: String,
    dir_token: String,
) -> Result<(), String> {
    write_text_file_granted(&grants, path, contents, &dir_token)
}

/// 二进制写盘（批① §2.5 多选二维码拼版 PNG 保存）：与 write_text_file_granted 同守护
/// （固定扩展名白名单 + dirToken 登记目录遏制），但 contents 为原始字节（Vec<u8>，
/// invoke JSON 数组通道），PNG 等二进制不经 UTF-8 文本管道防编码损坏。
/// 扩展名集合按本命令用途固定为 .png（不复用文本侧 .totpbackup/.json/.txt，也不把 .png
/// 加进文本命令——文本写 PNG 必然损坏，各命令用途与白名单一一对应）
fn write_bytes_file_granted(
    grants: &DialogGrants,
    path: String,
    contents: Vec<u8>,
    dir_token: &str,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    ensure_extension_ci(&path, &IMAGE_EXTENSIONS, "invalid image file extension")?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err("path is a directory".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
    // B2 叶子穿透防护（2026-10-12 修订）：直写通道跟随 symlink 会覆写目录外目标，叶子为
    // 路径重定向链接（symlink/junction，read_link 可解析出目标）按「路径越界」同类错误拒绝
    // （text 通道 rename 落盘替换链接本身、无此穿透，保持不动）；云占位等无路径目标的
    // reparse 标签放行。TOCTOU 诚实边界：与 ensure_within 的归一化之间窗口仍在，本检查
    // 收窄窗口而非完全关闭；路径不存在（新建文件）时 read_link 失败照常放行
    if leaf_redirects_path(std::path::Path::new(&path)) {
        return Err("path outside allowed dir".into());
    }
    // 直写通道（与 text 侧原子写有意不同）：PNG 等二进制不经 UTF-8 管道，rename 亦无增益
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_bytes_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    contents: Vec<u8>,
    dir_token: String,
) -> Result<(), String> {
    write_bytes_file_granted(&grants, path, contents, &dir_token)
}

// ---------- 导入文件命令 ----------
// 与 read_text_file_os 同构：信任边界一致（路径经 pick_open_file_os 的登记授权，dirToken 反查登记目录遏制），
// 扩展名白名单限定导入用途，防止被前端 XSS 当作任意文件读取原语。

/// 命令本体抽 *_granted inner：导入文本读取。白名单=IMPORT_TEXT_EXTENSIONS（R11 单点），
/// 大小写不敏感（与写侧 EXPORT_EXTENSIONS 同口径）
fn read_import_file_granted(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<String, String> {
    ensure_extension_ci(
        path,
        &IMPORT_TEXT_EXTENSIONS,
        "invalid import file extension",
    )?;
    let p = read_granted_file_core(grants, path, dir_token)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_import_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    dir_token: String,
) -> Result<String, String> {
    read_import_file_granted(&grants, &path, &dir_token)
}

/// 命令本体抽 *_granted inner：导入文件字节读取（SQLite 等二进制格式，ImportCard 字节入口），
/// 白名单=文本导入组+二进制组拼接派生（import_byte_extensions，R11）；
/// 返回原始字节（invoke JSON 数组），不经 UTF-8 文本管道
fn read_import_file_bytes_granted(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<Vec<u8>, String> {
    ensure_extension_ci(
        path,
        &import_byte_extensions(),
        "invalid import file extension",
    )?;
    let p = read_granted_file_core(grants, path, dir_token)?;
    std::fs::read(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_import_file_bytes_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    dir_token: String,
) -> Result<Vec<u8>, String> {
    read_import_file_bytes_granted(&grants, &path, &dir_token)
}

// repo 首批 Rust 单测：覆盖备份 os 命令的纯守护逻辑（白名单/登记目录遏制）与
// F4 对话框授权登记（token 发放反查/未知拒绝/LRU 上限），
// 文件系统用 std::env::temp_dir 隔离，不依赖 Tauri runtime
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_backup_name_accepts_vault_prefixed() {
        assert!(valid_backup_name("vault-20260916-120000.totpbackup"));
    }

    #[test]
    fn valid_backup_name_rejects_traversal_and_conflict() {
        // 白名单仅 vault- 前缀：路径穿越与 conflict- 副本均不可经删除命令触达
        assert!(!valid_backup_name("../x.totpbackup"));
        assert!(!valid_backup_name("conflict-1.totpbackup"));
    }

    #[test]
    fn ensure_within_rejects_path_outside_allowed_dir() {
        let base = std::env::temp_dir().join("totp_ensure_within_test");
        let allowed = base.join("allowed");
        let other = base.join("other");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let outside = other.join("vault-20260916-120000.totpbackup");
        std::fs::write(&outside, "x").unwrap();
        assert!(ensure_within(&outside, &allowed).is_err());
        let inside = allowed.join("vault-20260916-120000.totpbackup");
        std::fs::write(&inside, "x").unwrap();
        assert!(ensure_within(&inside, &allowed).is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    // ---- 真机缺陷 2026-10-12：RamDisk 等卷不支持 canonicalize（os error 1）时的词法归一退路 ----

    /// 注入恒失败的 canonicalize（os error 1 = ERROR_INVALID_FUNCTION）：模拟 Z: RamDisk 类
    /// 虚拟盘驱动不实现 GetFinalPathNameByHandle（实测纯读取正常、canonicalize 必挂）
    #[cfg(windows)]
    fn ramdisk_like_canon(_p: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
        Err(std::io::Error::from_raw_os_error(1))
    }

    #[test]
    fn normalize_with_supported_volume_matches_canonicalize() {
        let dir = std::env::temp_dir().join("totp_normalize_canon");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            normalize_with(&dir, |p: &std::path::Path| std::fs::canonicalize(p)).unwrap(),
            std::fs::canonicalize(&dir).unwrap()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn ensure_within_lexical_fallback_allows_plain_paths_and_rejects_traversal() {
        let base = std::env::temp_dir().join("totp_lexical_fallback_ok");
        let allowed = base.join("Allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let inside = allowed.join("import.json");
        std::fs::write(&inside, "{}").unwrap();
        // 登记小写形态、读取原始形态：词法分支大小写不敏感须命中同一目录
        //（temp 路径含大写段，metadata 查询走 NTFS 大小写不敏感语义不受影响）
        let lower = std::path::PathBuf::from(allowed.to_string_lossy().to_lowercase());
        assert!(ensure_within_with(inside.parent().unwrap(), &lower, ramdisk_like_canon).is_ok());
        // RootDir OsString 拼接回归：verbatim 前缀形态不被 push 的带根替换语义吞掉
        let verbatim = std::path::PathBuf::from(format!(r"\\?\{}", allowed.display()));
        assert_eq!(lexical_normalize(&verbatim).unwrap(), verbatim);
        // .. 穿越在词法分支同样拒绝（词法消解后越出登记目录）
        std::fs::create_dir_all(base.join("Other")).unwrap();
        let tricky = allowed.join("..").join("Other").join("x.json");
        assert!(
            ensure_within_with(tricky.parent().unwrap(), &allowed, ramdisk_like_canon).is_err()
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(windows)]
    #[test]
    fn ensure_within_lexical_fallback_rejects_reparse_component() {
        // 词法分支无链接解析能力：路径任一祖先是 junction（reparse 点）即 fail-closed，
        // 即便其解析目标就落在登记目录内（保守拒绝，与「放行普通路径」不冲突）。
        // junction 走 mklink /J（无特权可用；std 未提供 junction 创建 API）
        let base = std::env::temp_dir().join("totp_lexical_fallback_reparse");
        let real = base.join("real");
        let link = base.join("link");
        std::fs::create_dir_all(&real).unwrap();
        let mklink = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output();
        if !mklink.map(|o| o.status.success()).unwrap_or(false) {
            eprintln!("skip junction 用例：mklink 不可用");
            std::fs::remove_dir_all(&base).ok();
            return;
        }
        let sub = link.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let f = sub.join("x.json");
        std::fs::write(&f, "{}").unwrap();
        assert!(ensure_within_with(f.parent().unwrap(), &link, ramdisk_like_canon).is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(windows)]
    #[test]
    fn parse_persisted_dirs_fallback_keeps_unsupported_volume_dir() {
        // 持久化装载走同一归一退路：重启后 RamDisk 类卷上的备份源目录不再被静默丢弃
        //（目录真实存在，仅 canonicalize 不被支持）
        let dir = std::env::temp_dir().join("totp_persist_fallback");
        std::fs::create_dir_all(&dir).unwrap();
        let text = serde_json::to_string(&vec![dir.to_string_lossy().to_string()]).unwrap();
        let got = parse_persisted_dirs(&text, |d| {
            normalize_with(std::path::Path::new(d), ramdisk_like_canon)
                .map_err(std::io::Error::other)
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0], dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- F4 对话框授权登记（DialogGrants）单测 ----------

    #[test]
    fn grants_register_resolve_roundtrip_and_token_for() {
        let g = DialogGrants::default();
        let dir = std::env::temp_dir().join("totp_grants_roundtrip");
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();
        let token = g.register(canonical.clone(), GrantSource::Dir);
        assert_eq!(g.resolve(&token).unwrap(), canonical);
        assert_eq!(g.token_for(&canonical).as_deref(), Some(token.as_str()));
        // 未登记目录无 token 可反查
        assert_eq!(g.token_for(canonical.parent().unwrap()), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grants_unknown_token_rejected() {
        let g = DialogGrants::default();
        let dir = std::env::temp_dir().join("totp_grants_unknown");
        std::fs::create_dir_all(&dir).unwrap();
        g.register(std::fs::canonicalize(&dir).unwrap(), GrantSource::Dir);
        assert!(g.resolve("forged-token").is_err());
        assert!(g.resolve("").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grants_same_dir_reuses_token_and_stays_single_entry() {
        let g = DialogGrants::default();
        let dir = std::env::temp_dir().join("totp_grants_dedupe");
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();
        let t1 = g.register(canonical.clone(), GrantSource::Dir);
        let t2 = g.register(canonical.clone(), GrantSource::Dir);
        assert_eq!(t1, t2);
        assert_eq!(g.persistable_dirs().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grants_lru_cap_evicts_oldest() {
        let g = DialogGrants::default();
        let base = std::env::temp_dir().join("totp_grants_lru");
        std::fs::create_dir_all(&base).unwrap();
        let mut tokens = Vec::new();
        // 登记 GRANT_CAP+1 个目录：首个被逐出，登记总量稳定在 GRANT_CAP
        for i in 0..=GRANT_CAP {
            let d = base.join(format!("d{i}"));
            std::fs::create_dir_all(&d).unwrap();
            tokens.push(g.register(std::fs::canonicalize(&d).unwrap(), GrantSource::Dir));
        }
        assert!(g.resolve(&tokens[0]).is_err(), "最旧授权必须被 LRU 逐出");
        assert!(
            g.resolve(&tokens[GRANT_CAP]).is_ok(),
            "最新授权必须仍在登记"
        );
        assert_eq!(g.persistable_dirs().len(), GRANT_CAP);
        std::fs::remove_dir_all(&base).ok();
    }

    // ---- B3：load_grants 持久化装载核心（parse_persisted_dirs 纯函数）单测 ----

    #[test]
    fn parse_persisted_dirs_keeps_existing_and_filters_missing() {
        let base = std::env::temp_dir().join("totp_parse_grants");
        let d = base.join("ok");
        std::fs::create_dir_all(&d).unwrap();
        let canon = std::fs::canonicalize(&d).unwrap();
        // 正常数组：逐项 canonicalize 归一保留
        let ok = serde_json::to_string(&vec![d.to_string_lossy().to_string()]).unwrap();
        assert_eq!(
            parse_persisted_dirs(&ok, |p| std::fs::canonicalize(p)),
            vec![canon.clone()]
        );
        // 含非法项（目录已删/不可达）：失败项被过滤，成功项保留
        let mixed = serde_json::to_string(&vec![
            base.join("gone").to_string_lossy().to_string(),
            d.to_string_lossy().to_string(),
        ])
        .unwrap();
        assert_eq!(
            parse_persisted_dirs(&mixed, |p| std::fs::canonicalize(p)),
            vec![canon]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn parse_persisted_dirs_rejects_non_string_array_and_empty() {
        // 非数组/元素类型不符/解析失败：整体拒绝（静默返回空，与 load_grants 忽略口径一致）
        for bad in [r#"{"dir":"C:/x"}"#, r#""C:/x""#, "[1,2]", "null"] {
            assert!(
                parse_persisted_dirs(bad, |p| std::fs::canonicalize(p)).is_empty(),
                "非字符串数组必须拒绝: {bad}"
            );
        }
        // 空串/空数组幂等：装载结果为空，不报错
        assert!(parse_persisted_dirs("", |p| std::fs::canonicalize(p)).is_empty());
        assert!(parse_persisted_dirs("[]", |p| std::fs::canonicalize(p)).is_empty());
    }

    // ---- B1/B3 协同：持久化 roundtrip——Dir 来源落盘并可装载，File 来源仅会话内 ----

    #[test]
    fn persist_roundtrip_keeps_dir_source_drops_file_source() {
        let base = std::env::temp_dir().join("totp_grants_roundtrip_src");
        let d1 = base.join("d1");
        let d2 = base.join("d2");
        std::fs::create_dir_all(&d1).unwrap();
        std::fs::create_dir_all(&d2).unwrap();
        let c1 = std::fs::canonicalize(&d1).unwrap();
        let c2 = std::fs::canonicalize(&d2).unwrap();
        let g = DialogGrants::default();
        g.register(c1.clone(), GrantSource::Dir);
        g.register(c2.clone(), GrantSource::File);
        // persist：仅序列化 Dir 来源项（模拟 persist_grants 的序列化段），写盘后读回
        let p = base.join(GRANTS_FILE);
        std::fs::write(
            &p,
            serde_json::to_string_pretty(&g.persistable_dirs()).unwrap(),
        )
        .unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        // Windows canonical 路径带 \\?\ 前缀与反斜杠，JSON 转义后子串匹配不成立，按解析值比较
        let persisted: Vec<String> = serde_json::from_str(&text).unwrap();
        assert!(
            persisted.iter().any(|s| std::path::Path::new(s) == c1),
            "Dir 来源项必须落盘: {persisted:?}"
        );
        assert!(
            !persisted.iter().any(|s| std::path::Path::new(s) == c2),
            "File 来源项不得落盘"
        );
        // load：装载项一律 Dir 来源（磁盘格式=纯字符串数组，旧文件天然兼容）
        let g2 = DialogGrants::default();
        for c in parse_persisted_dirs(&text, |s| std::fs::canonicalize(s)) {
            g2.register(c, GrantSource::Dir);
        }
        assert_eq!(g2.persistable_dirs(), vec![c1.clone()]);
        assert!(g2.token_for(&c1).is_some(), "Dir 来源项重启后可重取句柄");
        assert!(
            g2.token_for(&c2).is_none(),
            "File 来源项不得经持久化装载复活"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // B1 来源标记协同：同目录复登记来源只升不降——File→Dir 升级（目录对话框明确授权后落盘），
    // Dir→File 不降级（已落盘授权保持重启可装载）
    #[test]
    fn grants_source_upgrade_only_never_downgrades() {
        let base = std::env::temp_dir().join("totp_grants_source_merge");
        let d = base.join("d");
        std::fs::create_dir_all(&d).unwrap();
        let c = std::fs::canonicalize(&d).unwrap();
        let g = DialogGrants::default();
        g.register(c.clone(), GrantSource::File);
        assert!(g.persistable_dirs().is_empty(), "File 来源不落盘");
        g.register(c.clone(), GrantSource::Dir);
        assert_eq!(g.persistable_dirs(), vec![c.clone()], "File→Dir 升级后落盘");
        g.register(c.clone(), GrantSource::File);
        assert_eq!(g.persistable_dirs(), vec![c], "Dir→File 不降级");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn remove_backup_file_os_deletes_within_granted_dir_only() {
        let base = std::env::temp_dir().join("totp_rm_os_test");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap(), GrantSource::Dir);
        let name = "vault-20260916-120000.totpbackup";
        let target = allowed.join(name);
        std::fs::write(&target, "x").unwrap();
        remove_backup_file_granted(&grants, target.to_str().unwrap(), &token).unwrap();
        assert!(!target.exists());
        // 登记目录之外的同名文件：白名单名也必须拒绝删除（遏制基准=后端登记目录，非前端自证）
        let outside = base.join(name);
        std::fs::write(&outside, "x").unwrap();
        assert!(remove_backup_file_granted(&grants, outside.to_str().unwrap(), &token).is_err());
        assert!(outside.exists());
        // 未知 token（未授权句柄）拒绝删除
        std::fs::write(&target, "x").unwrap();
        assert!(
            remove_backup_file_granted(&grants, target.to_str().unwrap(), "forged-token").is_err()
        );
        assert!(target.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_text_file_granted_enforces_extension_and_containment() {
        let base = std::env::temp_dir().join("totp_write_os_test");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap(), GrantSource::Dir);
        // 登记目录内合法备份名：写入成功
        let target = allowed.join("vault-20260916-120000.totpbackup");
        write_text_file_granted(
            &grants,
            target.to_str().unwrap().into(),
            "{}".into(),
            &token,
        )
        .unwrap();
        assert!(target.exists());
        // 文本导出（批① §2.3）：白名单内 .txt/.json（大小写不敏感）写入成功
        let txt = allowed.join("totp-export.txt");
        write_text_file_granted(
            &grants,
            txt.to_str().unwrap().into(),
            "otpauth://".into(),
            &token,
        )
        .unwrap();
        assert!(txt.exists());
        let json = allowed.join("aegis-export.JSON");
        write_text_file_granted(&grants, json.to_str().unwrap().into(), "{}".into(), &token)
            .unwrap();
        assert!(json.exists());
        // 非白名单扩展名拒绝
        let exe = allowed.join("evil.exe");
        assert!(write_text_file_granted(
            &grants,
            exe.to_str().unwrap().into(),
            "{}".into(),
            &token
        )
        .is_err());
        assert!(!exe.exists());
        // 登记目录之外（.totpbackup 合法名）遏制拒绝且不落盘
        let outside = base.join("vault-20260916-120000.totpbackup");
        assert!(write_text_file_granted(
            &grants,
            outside.to_str().unwrap().into(),
            "{}".into(),
            &token
        )
        .is_err());
        assert!(!outside.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_bytes_file_granted_enforces_extension_and_containment() {
        let base = std::env::temp_dir().join("totp_write_bytes_os_test");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap(), GrantSource::Dir);
        // 登记目录内 .png（大小写不敏感）：字节写入成功且内容保真
        let png = allowed.join("totp-qr-sheet.PNG");
        let bytes: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF];
        write_bytes_file_granted(&grants, png.to_str().unwrap().into(), bytes.clone(), &token)
            .unwrap();
        assert_eq!(std::fs::read(&png).unwrap(), bytes);
        // 非白名单扩展名拒绝（含文本侧合法的 .txt/.totpbackup——各命令白名单独立，不互通）
        for name in ["evil.exe", "note.txt", "vault-20260916-120000.totpbackup"] {
            let p = allowed.join(name);
            assert!(write_bytes_file_granted(
                &grants,
                p.to_str().unwrap().into(),
                bytes.clone(),
                &token
            )
            .is_err());
            assert!(!p.exists());
        }
        // 登记目录之外（.png 合法扩展名）遏制拒绝且不落盘
        let outside = base.join("totp-qr-sheet.png");
        assert!(
            write_bytes_file_granted(&grants, outside.to_str().unwrap().into(), bytes, &token)
                .is_err()
        );
        assert!(!outside.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    /// 创建指向 target 的文件 symlink；无特权环境（Windows 非开发者模式）创建失败返回
    /// false，调用方跳过用例（Unix 恒可建）
    fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    // B2 叶子穿透防护：授权目录内被植入的 symlink 叶子不得穿透——读通道
    // （read_granted_file_core，覆盖 read_text/import/bytes 三读命令）与 bytes 直写通道对
    // 路径重定向链接叶子按「路径越界」同类错误拒绝，目录外目标不被读取/覆写
    // （2026-10-12 修订：云占位等无路径目标 reparse 已放行，见 leaf_redirects_path）。
    // Windows 无特权（非开发者模式）创建 symlink 常失败，创建失败即跳过
    #[test]
    fn symlink_leaf_inside_granted_dir_rejected_for_read_and_direct_write() {
        let base = std::env::temp_dir().join("totp_symlink_leaf_test");
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap(), GrantSource::Dir);

        // 读通道：allowed 内 symlink 叶子（白名单内 .totpbackup 名）指向目录外 secret → 拒绝
        let secret = outside.join("vault-20260916-120000.totpbackup");
        std::fs::write(&secret, "secret").unwrap();
        let read_link = allowed.join("vault-20260916-120000.totpbackup");
        if !create_file_symlink(&secret, &read_link) {
            eprintln!("skip symlink_leaf 用例：symlink 创建无特权");
            std::fs::remove_dir_all(&base).ok();
            return;
        }
        assert_eq!(
            read_text_file_granted(&grants, read_link.to_str().unwrap(), &token).unwrap_err(),
            "path outside allowed dir",
            "symlink 叶子必须按路径越界拒绝，不得读穿"
        );
        // bytes 直写通道：allowed 内 .png symlink 指向目录外 payload → 拒绝且目标不被覆写
        let payload = outside.join("payload.png");
        std::fs::write(&payload, b"orig").unwrap();
        let png_link = allowed.join("qr.png");
        assert!(
            create_file_symlink(&payload, &png_link),
            "同环境第二个 symlink 应同样可建"
        );
        assert_eq!(
            write_bytes_file_granted(
                &grants,
                png_link.to_str().unwrap().into(),
                vec![1, 2, 3],
                &token,
            )
            .unwrap_err(),
            "path outside allowed dir"
        );
        assert_eq!(
            std::fs::read(&payload).unwrap(),
            b"orig",
            "目录外目标不得被穿透覆写"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // B2 修订（2026-10-12）：leaf_redirects_path 以 read_link 可解析为准（std 仅解析
    // SYMLINK/MOUNT_POINT 两类标签，云占位 CLOUD*/ProjFS/DEDUP 等一律报错）——
    // 钉死该分界语义，防 std 行为漂移或误改判定
    #[cfg(windows)]
    #[test]
    fn leaf_redirects_path_pins_read_link_discriminator() {
        let base = std::env::temp_dir().join("totp_redirect_discriminator");
        std::fs::create_dir_all(&base).unwrap();
        let plain = base.join("plain.json");
        std::fs::write(&plain, "{}").unwrap();
        // 普通文件与不存在路径：非重定向（云占位文件同属此分支 → 读取/写入放行）
        assert!(!leaf_redirects_path(&plain));
        assert!(!leaf_redirects_path(&base.join("nonexistent.json")));
        // symlink 文件：可解析出目标 → 重定向
        let secret = base.join("secret.json");
        std::fs::write(&secret, "x").unwrap();
        let link = base.join("link.json");
        if create_file_symlink(&secret, &link) {
            assert!(leaf_redirects_path(&link));
            std::fs::remove_file(&link).ok();
        }
        std::fs::remove_dir_all(&base).ok();
    }

    // B2 修订配套：junction（MOUNT_POINT 标签）叶子同样可被 read_link 解析 → 读通道
    // 仍按越界拒绝（junction 无特权可建，比 symlink 用例少一个环境跳过条件）
    #[cfg(windows)]
    #[test]
    fn junction_leaf_inside_granted_dir_rejected_for_read() {
        let base = std::env::temp_dir().join("totp_junction_leaf_test");
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap(), GrantSource::Dir);
        let link = allowed.join("vault-20260916-120000.totpbackup");
        let mklink = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output();
        if !mklink.map(|o| o.status.success()).unwrap_or(false) {
            eprintln!("skip junction_leaf 用例：mklink 不可用");
            std::fs::remove_dir_all(&base).ok();
            return;
        }
        assert_eq!(
            read_text_file_granted(&grants, link.to_str().unwrap(), &token).unwrap_err(),
            "path outside allowed dir",
            "junction 叶子必须按路径越界拒绝，不得读穿目录"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // 审查 I12（F4 重写）：授权基准不再有 allowed_dir IPC 入参；等价保障为「非规范形态的
    // 目录路径（大小写差异/\\?\ verbatim 前缀，对话框或持久化值可能携带）canonicalize 后
    // 与登记目录归一，文件路径同样归一命中」。仅 Windows 可跑（依赖 NTFS 大小写不敏感与 \\?\ 语义）
    #[cfg(windows)]
    #[test]
    fn dir_grants_normalize_case_variant_and_verbatim_forms() {
        let base = std::env::temp_dir().join("totp_grants_case_test");
        let allowed = base.join("Allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let canonical = std::fs::canonicalize(&allowed).unwrap();
        assert!(canonical.to_str().unwrap().starts_with(r"\\?\"));
        // 形态一：小写形态登记（canonicalize 归一为磁盘实际大小写）与真实形态为同一登记
        let lower = std::fs::canonicalize(allowed.to_str().unwrap().to_lowercase()).unwrap();
        let t_lower = grants.register(lower, GrantSource::Dir);
        let t_canonical = grants.register(canonical.clone(), GrantSource::Dir);
        assert_eq!(t_lower, t_canonical, "同目录不同大小写形态归一为同一登记");
        // 形态二：verbatim 形态文件路径删除命中同一登记（ensure_within canonicalize(父) 归一）；
        // canonical 本身即 \\?\ 前缀形态，直接拼子路径构造 verbatim 文件路径
        let name = "vault-20260916-120000.totpbackup";
        let target = canonical.join(name);
        std::fs::write(&target, "x").unwrap();
        let verbatim_path = format!("{}{}{name}", canonical.display(), std::path::MAIN_SEPARATOR);
        remove_backup_file_granted(&grants, &verbatim_path, &t_canonical).unwrap();
        assert!(!target.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_backup_files_os_returns_sorted_vault_and_conflict_only() {
        let base = std::env::temp_dir().join("totp_list_os_test");
        std::fs::create_dir_all(&base).unwrap();
        for n in [
            "vault-20260916-120001.totpbackup",
            "vault-20260916-120000.totpbackup",
            "conflict-20260916-120000.totpbackup",
            "conflict-foo.txt",
            "secret.txt",
        ] {
            std::fs::write(base.join(n), "x").unwrap();
        }
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&base).unwrap(), GrantSource::Dir);
        let names = list_backup_files_granted(&grants, &token).unwrap();
        assert_eq!(
            names,
            vec![
                "conflict-20260916-120000.totpbackup".to_string(),
                "vault-20260916-120000.totpbackup".to_string(),
                "vault-20260916-120001.totpbackup".to_string(),
            ]
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // ---- 读取命令白名单与遏制（盘点 B23/B25：read_text/import/bytes 全零测试补齐）----
    // 照 remove_backup_file_granted 模式直测 inner：白名单 → is_file → dirToken 遏制 → 读取

    /// 建临时登记目录并写入测试文件，返回 (grants, 文件路径, dir_token)
    fn granted_dir_with_file(
        dir: &str,
        name: &str,
        contents: &[u8],
    ) -> (DialogGrants, String, String) {
        let allowed = std::env::temp_dir().join(dir).join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let p = allowed.join(name);
        std::fs::write(&p, contents).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap(), GrantSource::Dir);
        (grants, p.to_str().unwrap().to_string(), token)
    }

    #[test]
    fn read_text_file_granted_whitelists_totpbackup_only() {
        // 白名单内：读取成功
        let (grants, p, token) = granted_dir_with_file(
            "totp_read_text_test",
            "vault-20260916-120000.totpbackup",
            b"cipher",
        );
        assert_eq!(
            read_text_file_granted(&grants, &p, &token).unwrap(),
            "cipher"
        );
        // 白名单外（导入侧合法扩展名亦拒）：本命令仅用于备份读取
        let (g2, txt, t2) = granted_dir_with_file("totp_read_text_test", "batch.txt", b"x");
        assert!(read_text_file_granted(&g2, &txt, &t2).is_err());
        // 未知 token（未授权句柄）拒绝
        assert!(read_text_file_granted(&grants, &p, "forged").is_err());
        std::fs::remove_dir_all(std::env::temp_dir().join("totp_read_text_test")).ok();
    }

    // ---- R11 守卫：5 个文件命令 × 扩展名 允许/拒绝矩阵 ----
    // 各命令白名单互不互通（写 text/bytes、读备份/导入文本/导入字节），矩阵以字面量
    // 锁定成员与大小写语义（读备份大小写敏感、导出/导入组大小写不敏感），收敛
    // ensure_extension 时矩阵必须保持不变（除显式记录的白名单成员变更）。
    // 显式契约变更（R11 镜像对齐）：导入文本组/字节组补 .jsonl——extension accept 与
    // core generic.ts 均已支持 JSONL，此前仅 Rust 白名单缺失（三端漂移），补齐而非裁剪。
    #[test]
    fn file_command_extension_allow_deny_matrix_locks_current_contract() {
        // 矩阵覆盖三类成员：导入组现有成员、白名单外交互样本、他命令专属成员
        const EXTS: [&str; 13] = [
            ".json",
            ".jsonl",
            ".wauth",
            ".xml",
            ".txt",
            ".aegis",
            ".db",
            ".sqlitedb",
            ".sqlite",
            ".zip",
            ".totpbackup",
            ".png",
            ".exe",
        ];
        // 允许集合（字面量快照）
        const READ_TEXT_OK: [&str; 1] = [".totpbackup"];
        const READ_IMPORT_TEXT_OK: [&str; 6] =
            [".json", ".jsonl", ".wauth", ".xml", ".txt", ".aegis"];
        const READ_IMPORT_BYTES_OK: [&str; 10] = [
            ".json",
            ".jsonl",
            ".wauth",
            ".xml",
            ".txt",
            ".aegis",
            ".db",
            ".sqlitedb",
            ".sqlite",
            ".zip",
        ];
        const WRITE_TEXT_OK: [&str; 3] = [".totpbackup", ".json", ".txt"];
        const WRITE_BYTES_OK: [&str; 1] = [".png"];
        for e in EXTS {
            // 读命令：对每个扩展名建真实文件（is_file 前置），逐命令断言允许/拒绝
            let (g, p, t) = granted_dir_with_file("totp_matrix_read_text", &format!("f{e}"), b"x");
            assert_eq!(
                read_text_file_granted(&g, &p, &t).is_ok(),
                READ_TEXT_OK.contains(&e),
                "read_text_file 对 {e} 的允许/拒绝与矩阵不符"
            );
            let (g, p, t) =
                granted_dir_with_file("totp_matrix_read_import", &format!("f{e}"), b"x");
            assert_eq!(
                read_import_file_granted(&g, &p, &t).is_ok(),
                READ_IMPORT_TEXT_OK.contains(&e),
                "read_import_file 对 {e} 的允许/拒绝与矩阵不符"
            );
            let (g, p, t) =
                granted_dir_with_file("totp_matrix_read_import_bytes", &format!("f{e}"), b"x");
            assert_eq!(
                read_import_file_bytes_granted(&g, &p, &t).is_ok(),
                READ_IMPORT_BYTES_OK.contains(&e),
                "read_import_file_bytes 对 {e} 的允许/拒绝与矩阵不符"
            );
        }
        // 写命令：两通道各自守护（写盘通道有意不同：text=原子写、bytes=直写，此处只锁白名单）
        let base = std::env::temp_dir().join("totp_matrix_write");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap(), GrantSource::Dir);
        for e in EXTS {
            let text_path = allowed.join(format!("text-f{e}"));
            assert_eq!(
                write_text_file_granted(
                    &grants,
                    text_path.to_str().unwrap().into(),
                    "{}".into(),
                    &token
                )
                .is_ok(),
                WRITE_TEXT_OK.contains(&e),
                "write_text_file 对 {e} 的允许/拒绝与矩阵不符"
            );
            let bytes_path = allowed.join(format!("bytes-f{e}"));
            assert_eq!(
                write_bytes_file_granted(
                    &grants,
                    bytes_path.to_str().unwrap().into(),
                    vec![1, 2],
                    &token
                )
                .is_ok(),
                WRITE_BYTES_OK.contains(&e),
                "write_bytes_file 对 {e} 的允许/拒绝与矩阵不符"
            );
        }
        std::fs::remove_dir_all(&base).ok();
    }

    // 大小写语义锁定（read_granted_file_core 注释「read_text 大小写敏感、import 组大小写
    // 不敏感，语义各自保留」）：大写形态的备份名在读备份命令被拒，大写导入扩展名在导入命令放行
    #[test]
    fn file_command_case_sensitivity_semantics_locked() {
        let (g, p, t) = granted_dir_with_file("totp_matrix_case_text", "f.TOTPBACKUP", b"x");
        assert!(
            read_text_file_granted(&g, &p, &t).is_err(),
            "读备份白名单必须保持大小写敏感"
        );
        let (g2, p2, t2) = granted_dir_with_file("totp_matrix_case_import", "f.AEGIS", b"x");
        assert!(
            read_import_file_granted(&g2, &p2, &t2).is_ok(),
            "导入组白名单必须保持大小写不敏感"
        );
    }

    // Minor-1：ensure_extension 两包装的大小写语义内聚锁定——exact 原样比较（读备份既有
    // 大小写敏感语义），ci 内部归一小写（导出/导入组既有大小写不敏感语义）；大写扩展名
    // 在 ci 放行、在 exact 拒绝，非白名单后缀两包装同拒
    #[test]
    fn ensure_extension_wrappers_lock_case_semantics() {
        const EXTS: [&str; 1] = [".txt"];
        assert!(ensure_extension_exact("a.txt", &EXTS, "no").is_ok());
        assert!(
            ensure_extension_exact("a.TXT", &EXTS, "no").is_err(),
            "exact 包装保持大小写敏感"
        );
        assert!(
            ensure_extension_ci("a.TXT", &EXTS, "no").is_ok(),
            "ci 包装对大写扩展名放行"
        );
        assert!(ensure_extension_ci("a.exe", &EXTS, "no").is_err());
    }

    // 字节组 = 文本组 + 二进制组拼接派生（R11）：以字面量锁定派生源与顺序，防手工罗列回潮
    #[test]
    fn import_byte_group_derives_from_text_plus_binary() {
        assert_eq!(
            import_byte_extensions(),
            vec![
                ".json",
                ".jsonl",
                ".wauth",
                ".xml",
                ".txt",
                ".aegis",
                ".db",
                ".sqlitedb",
                ".sqlite",
                ".zip",
            ]
        );
    }

    // ---- R11 镜像断言：Rust 导入白名单与 extension 端 accept 派生常量集合一致（防三端漂移）----

    /// 从 TS 源码提取 `const NAME = ['..', ..] as const` 数组的字符串字面量项
    /// （optionsPlatforms.ts 的导入扩展名两段派生常量与 Rust 白名单互验）
    fn ts_const_string_array(source: &str, name: &str) -> Vec<String> {
        let marker = format!("const {name}");
        let start = source.find(&marker).unwrap_or_else(|| {
            panic!("extension App.vue 缺 {name} 常量（R11 镜像断言要求单一派生常量）")
        });
        let open = start
            + source[start..]
                .find('[')
                .unwrap_or_else(|| panic!("{name} 定义缺数组开括号"));
        let close = open
            + source[open..]
                .find(']')
                .unwrap_or_else(|| panic!("{name} 定义缺数组闭括号"));
        source[open + 1..close]
            .split(',')
            .map(|s| s.trim().trim_matches('\'').trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    // include_str! 编译期内嵌 optionsPlatforms.ts（R4 起导入 accept 派生常量自 App.vue 迁驻于此）：
    // 文件缺失/常量改名/扩展名增删任一侧不同步即测试失败。
    // 集合比较（排序后全等）不依赖两侧书写顺序
    #[test]
    fn import_whitelist_mirrors_extension_accept_constants() {
        const OPTIONS_PLATFORMS_TS: &str =
            include_str!("../../../extension/src/optionsPlatforms.ts");
        let mut ts: Vec<String> =
            ts_const_string_array(OPTIONS_PLATFORMS_TS, "IMPORT_TEXT_EXTENSIONS");
        ts.extend(ts_const_string_array(
            OPTIONS_PLATFORMS_TS,
            "IMPORT_BINARY_EXTENSIONS",
        ));
        ts.sort();
        let mut rs: Vec<String> = import_byte_extensions()
            .into_iter()
            .map(String::from)
            .collect();
        rs.sort();
        assert_eq!(
            ts, rs,
            "extension accept 与 Rust 导入白名单漂移（两侧须集合一致）"
        );
    }

    #[test]
    fn read_import_file_granted_whitelist_and_bytes_superset() {
        // 文本导入组白名单（大小写不敏感）
        let (grants, aegis, token) =
            granted_dir_with_file("totp_read_import_test", "backup.AEGIS", b"{\"db\":{}}");
        assert_eq!(
            read_import_file_granted(&grants, &aegis, &token).unwrap(),
            "{\"db\":{}}"
        );
        // .totpbackup 不在导入白名单（备份读取走 read_text_file_os，各命令白名单独立）
        let (_, bak, _) = granted_dir_with_file("totp_read_import_test", "v.totpbackup", b"x");
        assert!(read_import_file_granted(&grants, &bak, &token).is_err());
        // 字节组是文本导入组的超集：.zip/.db 可读且字节保真
        let (_, zip, _) =
            granted_dir_with_file("totp_read_import_test", "ap.zip", &[0x50, 0x4B, 3, 4]);
        assert_eq!(
            read_import_file_bytes_granted(&grants, &zip, &token).unwrap(),
            vec![0x50, 0x4B, 3, 4]
        );
        let (_, db, _) = granted_dir_with_file("totp_read_import_test", "s.db", &[1, 2]);
        assert!(read_import_file_bytes_granted(&grants, &db, &token).is_ok());
        // 非白名单扩展名两组同拒
        let (_, exe, _) = granted_dir_with_file("totp_read_import_test", "evil.exe", b"x");
        assert!(read_import_file_granted(&grants, &exe, &token).is_err());
        assert!(read_import_file_bytes_granted(&grants, &exe, &token).is_err());
        // 目标不存在 → not a file
        assert!(
            read_import_file_granted(&grants, "no/such/file.json", &token)
                .unwrap_err()
                .contains("not a file")
        );
        // 登记目录之外（合法扩展名）：遏制拒绝且不读取
        let base = std::env::temp_dir().join("totp_read_import_test");
        let outside_file = base.join("leak.json");
        std::fs::write(&outside_file, "x").unwrap();
        assert!(read_import_file_granted(&grants, outside_file.to_str().unwrap(), &token).is_err());
        std::fs::remove_dir_all(&base).ok();
    }
}
