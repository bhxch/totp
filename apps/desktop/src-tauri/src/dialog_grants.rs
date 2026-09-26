//! 对话框授权与备份/导入文件命令（R8 自 lib.rs 分节纯移动）：对话框由 Rust 侧打开，
//! 选中目录 canonicalize 后登记进 DialogGrants 并返回不透明 token，文件命令以 dirToken
//! 反查登记目录做遏制；接线（manage 登记/run() 装载持久化授权）留在 lib.rs。

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::settings_io::write_text_atomic;

// ---------- 备份/导入文件命令 ----------
// 信任边界（F4 根修）：read/write_text_file_os 等命令的遏制基准不再接受前端 IPC 自证的
// allowed_dir（前端以 parentDirOf(同一路径) 自证派生，遏制比较按构造恒真）。现在对话框由
// Rust 侧打开（pick_dir_os / pick_open_file_os / pick_save_file_os），选中目录 canonicalize
// 后登记进 DialogGrants 并返回不透明 token，文件命令以 dirToken 反查登记目录做遏制；
// 扩展名白名单（备份 .totpbackup / 导入扩展名组）保持不变，防被前端脚本当任意读写原语。
// remove_backup_file 仅允许 AppData/backups 下的合法备份名（白名单防路径穿越）。

/// 会话授权登记容量上限（简易 LRU：超出逐出最旧；持久化文件同受此约束）
const GRANT_CAP: usize = 16;
/// 跨会话授权文件（AppData 下：目录对话框登记时后端写入，启动时装载）
const GRANTS_FILE: &str = "dialog_grants.json";

/** 对话框授权登记：token（OS CSPRNG 随机，不可预测）→ canonical 目录。
 *  跨会话说明：备份源目录的自动/手动备份在重启后仍需静默写盘，无法要求每次重弹对话框，
 *  故 pick_dir_os 登记时把目录持久化到 GRANTS_FILE、启动时装载。诚实边界：该文件位于
 *  webview 可写的 AppData（fs:allow-appdata-write-recursive），被持久化 XSS 污染的下一个
 *  会话可借篡改该文件登记任意目录——跨会话授权弱于本会话对话框登记；本设计消除的是
 *  运行中会话「自证参数直通任意路径」的读/写/删原语。文件对话框（导出/恢复/导入）只在
 *  会话内登记，不落盘。 */
#[derive(Default)]
pub struct DialogGrants {
    // 简易 LRU：front=最旧（登记/命中序），容量 GRANT_CAP
    entries: Mutex<Vec<(String, std::path::PathBuf)>>,
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("OS CSPRNG 不可用");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

impl DialogGrants {
    /** 登记目录（须已 canonicalize）：同目录复用既有 token（刷新为最近使用），超限逐出最旧 */
    fn register(&self, canonical: std::path::PathBuf) -> String {
        let mut g = self.entries.lock().unwrap();
        if let Some(i) = g.iter().position(|(_, d)| *d == canonical) {
            let (token, dir) = g.remove(i);
            g.push((token.clone(), dir));
            return token;
        }
        if g.len() >= GRANT_CAP {
            g.remove(0);
        }
        let token = random_token();
        g.push((token.clone(), canonical));
        token
    }

    /** token 反查登记目录（命中刷新为最近使用）；未知 token 拒绝 */
    fn resolve(&self, token: &str) -> Result<std::path::PathBuf, String> {
        let mut g = self.entries.lock().unwrap();
        let Some(i) = g.iter().position(|(t, _)| t == token) else {
            return Err("unknown dir token".into());
        };
        let (t, d) = g.remove(i);
        g.push((t, d.clone()));
        Ok(d)
    }

    /** 按已 canonicalize 的目录反查 token：备份源仅持久化路径字符串，重启后经此重取句柄 */
    fn token_for(&self, canonical: &std::path::Path) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(_, d)| d == canonical)
            .map(|(t, _)| t.clone())
    }

    fn canonical_dirs(&self) -> Vec<std::path::PathBuf> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, d)| d.clone())
            .collect()
    }
}

fn grants_store_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(GRANTS_FILE))
}

/// 启动装载：持久化授权 → 会话登记（目录已不存在则丢弃）
pub fn load_grants(app: &tauri::AppHandle) {
    let Some(p) = grants_store_path(app) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(p) else {
        return;
    };
    let Ok(dirs) = serde_json::from_str::<Vec<String>>(&text) else {
        return;
    };
    let state = app.state::<DialogGrants>();
    for d in dirs {
        if let Ok(c) = std::fs::canonicalize(&d) {
            state.register(c);
        }
    }
}

/// 目录登记后的持久化（best-effort：写失败不影响本会话授权，仅影响重启后的自动备份）
fn persist_grants(app: &tauri::AppHandle) {
    let Some(p) = grants_store_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string_pretty(&app.state::<DialogGrants>().canonical_dirs()) {
        // 原子写（同审查 I-5 口径）：grants 文件与 settings.json 同级，写一半崩溃不再留半截 JSON
        let _ = write_text_atomic(&p, &json);
    }
}

fn valid_backup_name(name: &str) -> bool {
    // 白名单：vault- 前缀、.totpbackup 后缀、不含路径分隔符与 ..，防路径穿越
    name.starts_with("vault-")
        && name.ends_with(".totpbackup")
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/** C9/F4：校验 path.parent() 必须落在后端登记目录内，canonicalize 双侧防 symlink/相对路径逃逸 */
fn ensure_within(path: &std::path::Path, allowed_dir: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid path: no parent".to_string())?;
    let abs_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let abs_allowed = std::fs::canonicalize(allowed_dir).map_err(|e| e.to_string())?;
    if !abs_parent.starts_with(&abs_allowed) {
        return Err("path outside allowed dir".into());
    }
    Ok(())
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

/// 登记选中「目录」本身（备份源目录），并持久化跨会话授权
fn grant_dir(app: &tauri::AppHandle, dir: std::path::PathBuf) -> Result<PickedPath, String> {
    let canonical = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    let token = app.state::<DialogGrants>().register(canonical);
    persist_grants(app);
    Ok(PickedPath {
        dir_token: token,
        path: dir.to_string_lossy().to_string(),
    })
}

/// 登记选中「文件所在父目录」（导出保存/打开读取为单次会话流，不落盘）。
/// save 选中的新文件尚不存在，须对父目录 canonicalize（对话框保证父目录已存在）
fn grant_file_parent(
    app: &tauri::AppHandle,
    file: std::path::PathBuf,
) -> Result<PickedPath, String> {
    let dir = file
        .parent()
        .ok_or_else(|| "invalid path: no parent".to_string())?
        .to_path_buf();
    let canonical = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    let token = app.state::<DialogGrants>().register(canonical);
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

/// 备份源目录重取会话 token：仅对已登记（对话框授权过/启动装载）的 canonical 目录发放
#[tauri::command]
pub fn dir_token_os(app: tauri::AppHandle, dir: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    app.state::<DialogGrants>()
        .token_for(&canonical)
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

/// 读取守护链公共段（is_file + dirToken 反查登记目录遏制，canonicalize 双侧防逃逸），
/// 白名单由各命令按用途前置（read_text 大小写敏感、import 组大小写不敏感，语义各自保留），
/// 返回经校验的路径供读取
fn read_granted_file_core(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    if !p.is_file() {
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
    if !path.ends_with(".totpbackup") {
        return Err("invalid backup file extension".into());
    }
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
    const EXPORT_EXTENSIONS: [&str; 3] = [".totpbackup", ".json", ".txt"];
    let lower = path.to_lowercase();
    if !EXPORT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err("invalid export file extension".into());
    }
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err("path is a directory".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
    // 原子写（同审查 I-5 口径）：备份/文本导出写一半崩溃不再留半截文件
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
    const IMAGE_EXTENSIONS: [&str; 1] = [".png"];
    let lower = path.to_lowercase();
    if !IMAGE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err("invalid image file extension".into());
    }
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err("path is a directory".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
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

/// 命令本体抽 *_granted inner：导入文本读取。WinAuth(.wauth/.xml)、Aegis(.json/.aegis)、
/// 纯文本 URI 批量(.txt)——白名单大小写不敏感（与写侧 EXPORT_EXTENSIONS 同口径）
fn read_import_file_granted(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<String, String> {
    const IMPORT_EXTENSIONS: [&str; 5] = [".json", ".wauth", ".xml", ".txt", ".aegis"];
    let lower = path.to_lowercase();
    if !IMPORT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err("invalid import file extension".into());
    }
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
/// 白名单在文本导入组基础上加 .db/.sqlitedb/.sqlite 与 AP 加密 zip 的 .zip；
/// 返回原始字节（invoke JSON 数组），不经 UTF-8 文本管道
fn read_import_file_bytes_granted(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<Vec<u8>, String> {
    const IMPORT_BYTE_EXTENSIONS: [&str; 9] = [
        ".json",
        ".wauth",
        ".xml",
        ".txt",
        ".aegis",
        ".db",
        ".sqlitedb",
        ".sqlite",
        ".zip",
    ];
    let lower = path.to_lowercase();
    if !IMPORT_BYTE_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return Err("invalid import file extension".into());
    }
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

    // ---------- F4 对话框授权登记（DialogGrants）单测 ----------

    #[test]
    fn grants_register_resolve_roundtrip_and_token_for() {
        let g = DialogGrants::default();
        let dir = std::env::temp_dir().join("totp_grants_roundtrip");
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();
        let token = g.register(canonical.clone());
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
        g.register(std::fs::canonicalize(&dir).unwrap());
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
        let t1 = g.register(canonical.clone());
        let t2 = g.register(canonical.clone());
        assert_eq!(t1, t2);
        assert_eq!(g.canonical_dirs().len(), 1);
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
            tokens.push(g.register(std::fs::canonicalize(&d).unwrap()));
        }
        assert!(g.resolve(&tokens[0]).is_err(), "最旧授权必须被 LRU 逐出");
        assert!(
            g.resolve(&tokens[GRANT_CAP]).is_ok(),
            "最新授权必须仍在登记"
        );
        assert_eq!(g.canonical_dirs().len(), GRANT_CAP);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn remove_backup_file_os_deletes_within_granted_dir_only() {
        let base = std::env::temp_dir().join("totp_rm_os_test");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap());
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
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap());
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
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap());
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
        let t_lower = grants.register(lower);
        let t_canonical = grants.register(canonical.clone());
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
        let token = grants.register(std::fs::canonicalize(&base).unwrap());
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
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap());
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
