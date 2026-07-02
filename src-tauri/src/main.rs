// 科研助手桌面外壳。
// 启动时拉起本地 Python sidecar(打包为 binaries/sidecar-*.exe), 退出时关闭它。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;
use std::sync::Mutex;

// 保存 sidecar 子进程句柄, 以便退出时结束它。
struct SidecarHandle(Mutex<Option<CommandChild>>);

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
        .manage(SidecarHandle(Mutex::new(None)))
        .setup(|app| {
            // 以 sidecar 形式启动后端(externalBin: binaries/sidecar)。
            let sidecar = app.shell().sidecar("sidecar")?;
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
