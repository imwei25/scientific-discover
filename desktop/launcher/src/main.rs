// 科研医学 Agent 桌面版启动器
//
// 职责（与 deploy/entrypoint.sh + 容器 env 对齐）：
//   1. 把 bundle 里的便携运行时（node / opencode / PortableGit / pandoc / 嵌入式 Python）前插进 PATH；
//   2. 设好技能约定的环境变量（REPO_ROOT 用正斜杠——bash 里 ${REPO_ROOT} 会展开进命令，反斜杠会被吃掉）；
//   3. 拉起 node web/server.mjs（网关自己会再拉起并接管 opencode serve）；
//   4. 轮询 /api/health 直到 gateway:true，再开主窗口指向 http://127.0.0.1:<PORT>/；
//   5. 退出时 taskkill /T 杀掉 node 进程树（含 cmd→opencode），并按端口兜底清扫。
//
// 云端接入：app/cloud.json（gatewayUrl/apiKey/model）→ OC_GATEWAY_URL/OC_GATEWAY_KEY/OC_MODEL，
// server.mjs 启动时读到这些 env 会自动把 opencode 的 provider 写成云端网关（token 管控在云端 one-api）。
// 没有 cloud.json 也能起：用户在界面「模型设置」里填网关地址+key，效果相同。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 27821; // 网关端口（避开常见 3000/8080，降低撞车概率；server.mjs 启动时会清掉本端口残留进程）
const OC_PORT: u16 = 27822; // opencode 端口
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Backend(Mutex<Option<u32>>); // node 网关的 pid

fn health_ok() -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", PORT)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    if s.write_all(
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .is_err()
    {
        return false;
    }
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf.contains("\"gateway\":true")
}

// bash 的 ${REPO_ROOT} 展开会把反斜杠当转义吃掉，Git Bash 认 D:/xxx 正斜杠写法
fn fwd(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn kill_port(port: u16) {
    let ps = format!(
        "Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | \
         Select-Object -ExpandProperty OwningProcess -Unique | \
         ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

fn main() {
    tauri::Builder::default()
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            let bundle = app.path().resource_dir()?.join("bundle");
            let appdir = bundle.join("app");
            let rt = bundle.join("runtime");

            // PATH 前插：node/opencode/git(bash)/pandoc/python 都要能被裸名字找到
            // （server.mjs spawn("opencode")、技能里裸 python3、render_docx.sh 找 pandoc 全靠这个）
            let prepend: Vec<PathBuf> = vec![
                rt.join("node"),
                rt.join("opencode"),
                rt.join("git").join("cmd"),
                rt.join("git").join("bin"),
                rt.join("git").join("usr").join("bin"),
                rt.join("git").join("mingw64").join("bin"),
                rt.join("pandoc"),
                appdir.join(".venv").join("Scripts"),
            ];
            let path = format!(
                "{};{}",
                prepend
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(";"),
                std::env::var("PATH").unwrap_or_default()
            );

            let mut cmd = Command::new(rt.join("node").join("node.exe"));
            cmd.arg(appdir.join("web").join("server.mjs"))
                .current_dir(&appdir)
                .env("PATH", &path)
                .env("PORT", PORT.to_string())
                .env("OC_URL", format!("http://127.0.0.1:{OC_PORT}"))
                .env("MANAGE_OC", "1")
                .env("REPO_ROOT", fwd(&appdir))
                .env("SCI_PYTHON", appdir.join(".venv").join("Scripts").join("python.exe"))
                .env("MPLBACKEND", "Agg")
                .env("MATPLOTLIBRC", appdir.join("matplotlibrc"))
                .creation_flags(CREATE_NO_WINDOW);

            // 云端接入配置（可缺省；界面「模型设置」是等价入口）
            if let Ok(txt) = std::fs::read_to_string(appdir.join("cloud.json")) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    if let Some(u) = v["gatewayUrl"].as_str() {
                        cmd.env("OC_GATEWAY_URL", u);
                    }
                    if let Some(k) = v["apiKey"].as_str() {
                        cmd.env("OC_GATEWAY_KEY", k);
                    }
                    if let Some(m) = v["model"].as_str() {
                        cmd.env("OC_MODEL", format!("custom/{m}"));
                    }
                }
            }

            let child = cmd.spawn()?;
            *app.state::<Backend>().0.lock().unwrap() = Some(child.id());

            // 后台轮询：就绪 → 开主窗口、关 splash；超时 → splash 上报错
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..240u32 {
                    // 最多 120s
                    if health_ok() {
                        let url: tauri::Url = format!("http://127.0.0.1:{PORT}/").parse().unwrap();
                        let win = WebviewWindowBuilder::new(&handle, "app", WebviewUrl::External(url))
                            .title("科研医学 Agent")
                            .inner_size(1280.0, 860.0)
                            .build();
                        if win.is_ok() {
                            if let Some(w) = handle.get_webview_window("splash") {
                                let _ = w.close();
                            }
                        }
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                if let Some(w) = handle.get_webview_window("splash") {
                    let _ = w.eval(
                        "document.getElementById('msg').textContent = \
                         '启动失败：本地服务 120 秒内未就绪。请重启应用；若反复出现，把安装目录 bundle/app 下的 serve.err 发给技术支持。'",
                    );
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("launcher 初始化失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // taskkill /T 沿父子树把 node → cmd → opencode 一锅端；再按端口兜底
                if let Some(pid) = *app.state::<Backend>().0.lock().unwrap() {
                    let _ = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
                kill_port(OC_PORT);
                kill_port(PORT);
            }
        });
}
