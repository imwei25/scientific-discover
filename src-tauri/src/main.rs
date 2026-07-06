// 科研助手桌面外壳。
// 启动时拉起本地 Python sidecar(打包为 binaries/sidecar-*.exe), 退出时关闭它。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;
use std::net::TcpListener;
use std::sync::Mutex;

// 保存 sidecar 子进程句柄, 以便退出时结束它。
struct SidecarHandle(Mutex<Option<CommandChild>>);

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

// 把字节写到用户在保存对话框选定的路径(前端下载走此命令, 因 WebView2 不响应
// <a download> 的 blob 下载)。用自定义命令直接写盘, 避开 fs 插件的作用域限制。
#[tauri::command]
fn save_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &contents).map_err(|e| e.to_string())
}

// 启动后静默检查 GitHub Releases 上的新版本; 有则弹窗询问, 同意后下载安装并重启。
// 检查/下载失败一律静默(不打扰用户, 下次启动再试)。
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
                    if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                        h.restart();
                    }
                });
            });
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_file, get_backend_port])
        .manage(SidecarHandle(Mutex::new(None)))
        .setup(|app| {
            // 为后端分配一个空闲端口, 记入状态供前端读取。
            let port = pick_backend_port();
            app.manage(BackendPort(port));
            // 以 sidecar 形式启动后端(externalBin: binaries/sidecar)。
            // 通过 SIDECAR_PORT 注入端口(专用变量名, 不会被后端 .env 里的 PORT 覆盖),
            // 后端据此监听并强制仅对本机回环开放; 前端再 invoke get_backend_port 读回同一端口。
            let sidecar = app
                .shell()
                .sidecar("sidecar")?
                .env("SIDECAR_PORT", port.to_string());
            let (mut _rx, child) = sidecar.spawn()?;
            app.state::<SidecarHandle>().0.lock().unwrap().replace(child);
            check_update(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 窗口关闭时结束 sidecar。
                if let Some(child) = window
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
