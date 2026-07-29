// 科研医学 Agent 桌面版启动器
//
// 职责（与 deploy/entrypoint.sh + 容器 env 对齐）：
//   1. 把 bundle 里的便携运行时（node / opencode / PortableGit / pandoc / 嵌入式 Python）前插进 PATH；
//   2. 设好技能约定的环境变量（REPO_ROOT / SKILL_DIR 用正斜杠——bash 里 ${VAR} 会展开进命令，反斜杠会被吃掉）；
//   3. 拉起 node web/server.mjs（网关自己会再拉起并接管 opencode serve），其 stdout/stderr 落 gateway.log；
//   4. 轮询 /api/health 直到 gateway:true，再开主窗口指向 http://127.0.0.1:<PORT>/；
//   5. 退出时 taskkill /T 杀掉 node 进程树（含 cmd→opencode），并按端口兜底清扫。
//
// 单实例：装 tauri-plugin-single-instance。WebView 壳没有它就会各起各的后台，第二个 server.mjs
// 按设计清端口把前一个的 node/opencode 顶掉，留下一个连不上后台、还拒绝优雅退出的僵尸窗口。
//
// 下载：WebView2 默认不处理 <a download>，不配 on_download 就是点了完全没反应（不是慢，是静默丢弃）。
//
// 云端接入：app/cloud.json（gatewayUrl/apiKey/model）→ OC_GATEWAY_URL/OC_GATEWAY_KEY/OC_MODEL，
// server.mjs 启动时读到这些 env 会自动把 opencode 的 provider 写成云端网关（token 管控在云端 one-api）。
// 没有 cloud.json 也能起：用户在界面「模型设置」里填网关地址+key，效果相同。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::DownloadEvent;
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

// 下载落点：优先系统「下载」已知文件夹（用户可能把它挪到别的盘，硬拼 %USERPROFILE%\Downloads 会写错地方），
// 取不到再退回 <家目录>\Downloads。
fn downloads_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(|| PathBuf::from("."))
}

// 文件名消毒：只留最后一段，把路径分隔符/盘符/Windows 非法字符挡在外面。
// 网关的 name 参数来自会话产物目录，正常不会带路径；但它是 URL 里可改的东西，
// 放任 ..\..\ 就能把文件写出下载目录，故一律按不可信输入处理。
fn safe_name(raw: &str) -> Option<String> {
    let last = raw.rsplit(|c| c == '/' || c == '\\').next()?.trim();
    if last.is_empty() || last == "." || last == ".." {
        return None;
    }
    let cleaned: String = last
        .chars()
        .map(|c| if "<>:\"|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c })
        .collect();
    // 结尾的点和空格 Windows 建不出文件，去掉；全被去光就当没拿到名字
    let cleaned = cleaned.trim_end_matches(|c| c == '.' || c == ' ').to_string();
    if cleaned.is_empty() { None } else { Some(cleaned) }
}

// 重名不覆盖：a.png → a (1).png → a (2).png，跟资源管理器一个观感。
// 只探到 999，再多说明用户真在刷同名文件，退回带 pid 的名字免得死循环。
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..1000u32 {
        let c = dir.join(format!("{stem} ({n}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    dir.join(format!("{stem} ({}){ext}", std::process::id()))
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
        // 必须是第一个注册的插件（官方要求）：它在插件初始化阶段就让第二实例退出，
        // 从而赶在下面 setup 里 spawn node 之前——第二实例根本不会碰后台和端口。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 回调跑在【已存在的第一实例】里：把窗口拉回前台就是全部工作。
            // 首启轮询期间 app 窗口还没建出来，此时退回 splash。
            if let Some(w) = app
                .get_webview_window("app")
                .or_else(|| app.get_webview_window("splash"))
            {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
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
                // ppt-master 是 vendored 上游技能，它的 60 余处命令全用 ${SKILL_DIR} 拼路径，
                // 全仓没有别处给它赋值（容器版靠 Dockerfile 的 ENV 补）。桌面版漏了它就展开成空串，
                // 用户说"做个 PPT"第一步就 ENOENT。正斜杠，理由同 REPO_ROOT。
                .env(
                    "SKILL_DIR",
                    fwd(&appdir.join(".opencode").join("skills").join("ppt-master")),
                )
                .env("SCI_PYTHON", appdir.join(".venv").join("Scripts").join("python.exe"))
                .env("MPLBACKEND", "Agg")
                // 中文字体兜底 rc。matplotlib 的查找顺序是 $MATPLOTLIBRC → cwd/matplotlibrc →
                // configdir（与 deploy/Dockerfile 注释一致，env 优先级最高）；技能都在会话产物目录里跑
                // （那儿没有 rc 文件、configdir 也没铺过），故这条 env 是包内 matplotlibrc 唯一的生效通道；
                // node 把整份 env 传给 opencode 再传给技能 python，一处注入全链路生效。
                .env("MATPLOTLIBRC", appdir.join("matplotlibrc"))
                .creation_flags(CREATE_NO_WINDOW);

            // 网关日志：node 的 stdout/stderr 原先直接丢弃，客户现场出问题什么都拿不到
            // （bundle/app 下的 serve.out/err 是 server.mjs 另开给 opencode 的，与网关无关，恒空）。
            // 每次启动截断重写，不追加——长跑几个月不至于长成 GB；要留历史自行拷走。
            // 开日志失败不该挡启动，静默退回"丢弃"的老行为。
            if let Ok(f) = File::create(appdir.join("gateway.log")) {
                if let (Ok(o), Ok(e)) = (f.try_clone(), f.try_clone()) {
                    cmd.stdout(Stdio::from(o)).stderr(Stdio::from(e));
                }
            }

            // 云端接入配置（可缺省；界面「模型设置」是等价入口）
            if let Ok(txt) = std::fs::read_to_string(appdir.join("cloud.json")) {
                // 去 BOM：PowerShell 的 Out-File -Encoding utf8 与记事本另存都会写 BOM，
                // serde_json 见了 BOM 直接报错 —— 表现是"配置在、内容对，程序却当没配"。
                let txt = txt.trim_start_matches('\u{feff}');
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(txt) {
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
                            // 不接这个钩子，WebView2 对 <a download href="api/download?..."> 就是静默丢弃：
                            // 没有保存框、没有落盘、控制台也没报错，用户只看到"点了没反应"。
                            .on_download(|_wv, event| {
                                match event {
                                    DownloadEvent::Requested { url, destination } => {
                                        // 壳里没有"另存为"对话框可用，直接定死到系统「下载」文件夹，
                                        // 完成后再用资源管理器指给用户看（见 Finished 分支）。
                                        let dir = downloads_dir();
                                        let _ = std::fs::create_dir_all(&dir);
                                        // 文件名来源：网关下载接口的 name 参数（query_pairs 已做 percent 解码）
                                        // → WebView2 依 Content-Disposition 预填在 destination 上的缺省名 → 兜底常量。
                                        let name = url
                                            .query_pairs()
                                            .find(|(k, _)| k == "name")
                                            .and_then(|(_, v)| safe_name(&v))
                                            .or_else(|| {
                                                destination
                                                    .file_name()
                                                    .and_then(|s| s.to_str())
                                                    .and_then(safe_name)
                                            })
                                            .unwrap_or_else(|| "download".to_string());
                                        *destination = unique_path(&dir, &name);
                                    }
                                    DownloadEvent::Finished { path, success, .. } => {
                                        // 壳内没有可靠的前端提示通道（页面是网关发的，注入 JS 得挑时机），
                                        // 用资源管理器选中该文件是最省事又不会误报的"告诉用户存哪了"。
                                        if success {
                                            if let Some(p) = path {
                                                // explorer 的 /select 参数必须整段带引号，交给 Rust 自动加引号会解析失败
                                                let _ = Command::new("explorer")
                                                    .raw_arg(format!("/select,\"{}\"", p.display()))
                                                    .spawn();
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                                true // 放行下载；返回 false 就是眼下要修的那个"静默无反应"
                            })
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
                         '启动失败：本地服务 120 秒内未就绪。请重启应用；若反复出现，把安装目录 bundle/app 下的 gateway.log 与 serve.err 发给技术支持。'",
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
