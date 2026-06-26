// 科研助手桌面外壳。
// 启动时拉起本地 Python sidecar(打包为 binaries/sidecar-*.exe), 退出时关闭它。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use std::sync::Mutex;

// 保存 sidecar 子进程句柄, 以便退出时结束它。
struct SidecarHandle(Mutex<Option<CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarHandle(Mutex::new(None)))
        .setup(|app| {
            // 以 sidecar 形式启动后端(externalBin: binaries/sidecar)。
            let sidecar = app.shell().sidecar("sidecar")?;
            let (mut _rx, child) = sidecar.spawn()?;
            app.state::<SidecarHandle>().0.lock().unwrap().replace(child);
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
