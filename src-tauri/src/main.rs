// 科研助手桌面外壳。
// 启动时拉起本地 Python sidecar(onedir 打包在 resources/sidecar/), 退出时关闭它。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;
use std::net::TcpListener;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

// 保存 sidecar 子进程句柄, 以便退出时结束它。
struct SidecarHandle(Mutex<Option<Child>>);

// sidecar 后端实际监听的端口, 供前端(webview)读取以拼 API 基地址。
struct BackendPort(u16);

// 让操作系统分配一个空闲端口(bind 到 :0 再取回端口号)后立即释放,
// sidecar 随即绑定它。每次启动都用新端口, 这样上次异常退出残留、
// 仍占着旧端口的 sidecar 不会导致本次后端起不来。分配失败则退回 8756。
fn pick_backend_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
        .unwrap_or(8756)
}

// 前端启动时 invoke 此命令拿到 sidecar 真实端口, 而不是写死 8756。
#[tauri::command]
fn get_backend_port(port: tauri::State<BackendPort>) -> u16 {
    port.0
}

// sidecar 可执行文件名。用带前缀的唯一名字(而非通用的 sidecar.exe):
// NSIS 升级钩子按镜像名 taskkill, 通用名会误杀其他程序的同名进程。
const SIDECAR_EXE: &str = "kyzs-sidecar.exe";

// 不弹出黑色控制台窗口(spawn sidecar / 打开浏览器时共用)。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// 在资源目录里定位 onedir 打包的 sidecar exe。Tauri 把 resources/sidecar/ 整个目录随安装铺到资源目录,
// 不同布局下路径可能带或不带 resources 前缀, 故先试首选路径, 再递归兜底(限深, 避免误扫大目录)。
fn find_sidecar(resource_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    for cand in [
        resource_dir.join("resources").join("sidecar").join(SIDECAR_EXE),
        resource_dir.join("sidecar").join(SIDECAR_EXE),
    ] {
        if cand.is_file() {
            return Some(cand);
        }
    }
    fn walk(dir: &std::path::Path, depth: u8) -> Option<std::path::PathBuf> {
        if depth > 4 {
            return None;
        }
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(found) = walk(&p, depth + 1) {
                    return Some(found);
                }
            } else if p.file_name().is_some_and(|n| n == SIDECAR_EXE) {
                return Some(p);
            }
        }
        None
    }
    walk(resource_dir, 0)
}

// 把 sidecar 绑进一个 KILL_ON_JOB_CLOSE 的 Job Object: 外壳进程无论以何种方式退出
// (正常关闭/崩溃/被 taskkill), 系统回收本进程句柄时会连带结束 sidecar 及其全部子进程
// (含数据分析 runner), 彻底杜绝孤儿后端驻留内存。失败则静默退回原有 kill-on-close 逻辑。
// job 句柄故意不关闭: 它必须与本进程同生命周期, 进程退出时由 OS 关闭并触发 KILL。
fn bind_to_job_object(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            return;
        }
        let _ = AssignProcessToJobObject(job, child.as_raw_handle());
    }
}

// sidecar 日志路径: %APPDATA%\科研助手\sidecar.log(与后端 .env 同目录, 方便用户取用)。
fn sidecar_log_path() -> std::path::PathBuf {
    std::env::var("APPDATA")
        .ok()
        .map(|p| std::path::PathBuf::from(p).join("科研助手").join("sidecar.log"))
        .unwrap_or_else(|| std::env::temp_dir().join("kyzs-sidecar.log"))
}

// 「保存对话框 + 写盘」一体化命令(前端下载走此命令, 因 WebView2 不响应
// <a download> 的 blob 下载)。对话框与写入都在 Rust 侧完成, 前端拿不到"写任意
// 路径"的能力——此前的 save_file(path, contents) 接受前端传入的任意路径, 一旦
// 渲染层(LLM 输出的 markdown/mermaid)出 XSS 就是任意文件写入。
// 返回 true=已保存, false=用户取消。
#[tauri::command]
async fn save_file_dialog(
    app: tauri::AppHandle,
    filename: String,
    contents: Vec<u8>,
) -> Result<bool, String> {
    // 路径由原生对话框产生, 不信任前端; 文件名仅作为默认建议。
    let picked = app
        .dialog()
        .file()
        .set_file_name(&filename)
        .blocking_save_file();
    let Some(path) = picked else {
        return Ok(false); // 用户取消
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, &contents).map_err(|e| e.to_string())?;
    Ok(true)
}

// 用系统默认浏览器打开发布页(自动更新失败时的手动下载入口)。
// 不引入 shell/opener 插件, 直接经 cmd start 打开; CREATE_NO_WINDOW 避免黑窗一闪。
fn open_release_page() {
    const URL: &str = "https://github.com/imwei25/scientific-discover/releases/latest";
    let _ = Command::new("cmd")
        .args(["/C", "start", "", URL])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

// 启动后静默检查 GitHub Releases 上的新版本; 有则弹窗询问, 同意后下载安装并重启。
// 检查失败静默(不打扰用户, 下次启动再试); 用户同意更新后的安装失败会弹窗引导手动下载。
fn check_update(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match handle.updater() {
            Ok(u) => u,
            Err(_) => return,
        };
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            _ => return,
        };
        let version = update.version.clone();
        let h = handle.clone();
        handle
            .dialog()
            .message(format!(
                "发现新版本 v{version}。\n现在更新吗？会自动下载安装并重启应用。"
            ))
            .title("科研助手 · 有可用更新")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "立即更新".into(),
                "以后再说".into(),
            ))
            .show(move |yes| {
                if !yes {
                    return;
                }
                tauri::async_runtime::spawn(async move {
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(()) => h.restart(),
                        Err(_) => {
                            // 下载/签名校验失败(典型: 2026-07 签名密钥更换前安装的老版本,
                            // 内置旧公钥, 自动更新永远校验不过)。此前静默吞掉 → 老用户
                            // 永远滞留旧版且毫无感知; 现在明确告知并引导手动下载。
                            h.dialog()
                                .message(
                                    "自动更新失败（可能是网络问题，或本版本过旧、更新签名已更换）。\n\
                                     请前往发布页手动下载最新安装包，安装后即可恢复自动更新。",
                                )
                                .title("科研助手 · 自动更新失败")
                                .buttons(MessageDialogButtons::OkCancelCustom(
                                    "打开下载页".into(),
                                    "取消".into(),
                                ))
                                .show(|open| {
                                    if open {
                                        open_release_page();
                                    }
                                });
                        }
                    }
                });
            });
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_file_dialog, get_backend_port])
        .manage(SidecarHandle(Mutex::new(None)))
        .setup(|app| {
            // 为后端分配一个空闲端口, 记入状态供前端读取。
            let port = pick_backend_port();
            app.manage(BackendPort(port));

            // 定位 onedir 打包的后端 exe(resources/sidecar/kyzs-sidecar.exe)。
            let resource_dir = app.path().resource_dir()?;
            let exe = find_sidecar(&resource_dir).ok_or("在资源目录中找不到 kyzs-sidecar.exe")?;

            // sidecar 的 stdout/stderr 直接重定向到 %APPDATA%\科研助手\sidecar.log(每次启动覆盖)。
            // 否则打包版丢弃后端输出, 一旦启动崩溃(如缺 DLL)就毫无线索、表现为界面永远"连接中"。
            let log_path = sidecar_log_path();
            if let Some(dir) = log_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }

            // 通过 SIDECAR_PORT 注入端口(专用变量名, 不会被后端 .env 里的 PORT 覆盖),
            // 后端据此监听并强制仅对本机回环开放; 前端再 invoke get_backend_port 读回同一端口。
            let mut cmd = Command::new(&exe);
            cmd.env("SIDECAR_PORT", port.to_string())
                .creation_flags(CREATE_NO_WINDOW);
            if let Some(dir) = exe.parent() {
                cmd.current_dir(dir);
            }
            if let Ok(f) = std::fs::File::create(&log_path) {
                if let Ok(f2) = f.try_clone() {
                    cmd.stdout(Stdio::from(f)).stderr(Stdio::from(f2));
                }
            }
            let child = cmd.spawn()?;
            bind_to_job_object(&child);
            app.state::<SidecarHandle>().0.lock().unwrap().replace(child);

            check_update(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 窗口关闭时结束 sidecar。
                if let Some(mut child) = window
                    .app_handle()
                    .state::<SidecarHandle>()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
