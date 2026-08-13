// Niuma Science 桌面版启动器
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 27821; // 网关端口（避开常见 3000/8080，降低撞车概率；server.mjs 启动时会清掉本端口残留进程）
const OC_PORT: u16 = 27822; // opencode 端口
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// 点 X 只把窗口缩到托盘、不退出；只有托盘右键「完全关闭」把它置 true 再退出。
// 用全局 AtomicBool 而不是 app state：CloseRequested 处理器里要读它，全局最省事。
static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);

struct Backend(Mutex<Option<u32>>); // node 网关的 pid

/// 把主窗口从托盘唤回前台（app 窗口还没建出来时退回 splash）。
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app
        .get_webview_window("app")
        .or_else(|| app.get_webview_window("splash"))
    {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 取日志末尾若干行，供启动失败时直接显示在启动页上。
/// 现场诊断最缺的就是"到底为什么起不来"，把它摆到用户眼前比让他去翻文件强得多。
fn tail_of(path: &std::path::Path, lines: usize) -> String {
    match std::fs::read_to_string(path) {
        Ok(s) => {
            let v: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
            if v.is_empty() {
                "（gateway.log 是空的：说明服务连一行输出都没来得及打，多半是 node 本身没起来——\
                 常见于缺 Microsoft Visual C++ 运行库、或被杀软拦截）".into()
            } else {
                v[v.len().saturating_sub(lines)..].join("\n")
            }
        }
        Err(_) => "（找不到 gateway.log：服务可能根本没被拉起来）".into(),
    }
}

/// 往启动页写一句话。用 serde_json 序列化成 JS 字面量，避免日志里的引号/换行把脚本搞坏。
fn splash_msg(handle: &tauri::AppHandle, msg: &str) {
    if let Some(w) = handle.get_webview_window("splash") {
        let js = format!(
            "document.getElementById('msg').style.whiteSpace='pre-wrap';\
             document.getElementById('msg').style.textAlign='left';\
             document.getElementById('msg').textContent = {};",
            serde_json::to_string(msg).unwrap_or_else(|_| "\"启动失败\"".into())
        );
        let _ = w.eval(&js);
    }
}

fn health_ok() -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", PORT)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(8)));
    // 【必须带 quick=1】不带的话网关会先去问 opencode 活没活（那头有 2.5s 超时）才应答。
    // 而 opencode 起得慢正是现场最常见的故障，于是"壳判断网关就绪"反过来卡在"opencode 就绪"上——
    // 真机上表现为：网关明明已经 listen，启动页还是转满 120 秒。
    // 壳这一关只该判网关本身；opencode 的状态由页面自己的横幅去报。
    if s.write_all(
        format!("GET /api/health?quick=1 HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .is_err()
    {
        return false;
    }
    // 【不能用 read_to_string】它在出错时会把 buf 截回调用前的长度——读超时属于出错，
    // 于是"已经收到了完整应答、只是连接迟迟不 close"会被判成【什么都没读到】。
    // 这里手工累加，超时也保留已读到的字节。
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while buf.len() < 8192 {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).contains("\"gateway\":true")
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

/// 建主窗口。抽成函数是为了能【建两次】：后台轮询线程里建失败时回主线程再试一次
/// （见调用处注释）。两次走的是完全同一套配置，所以重试不会丢下载钩子或拖放设置。
fn open_app_window(handle: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let url: tauri::Url = format!("http://127.0.0.1:{PORT}/").parse().unwrap();
    WebviewWindowBuilder::new(handle, "app", WebviewUrl::External(url))
        .title("Niuma Science")
        .inner_size(1280.0, 860.0)
        // 【必须关掉】默认为 true 时，Tauri 会在 webview 层截走全部拖放事件去做
        // 原生文件拖入，于是页面自己的 HTML5 拖放【整个失效】：
        //   · 侧栏「拖会话进项目 / 拖到已持久化」拖不动；
        //   · 上传区「拖拽文件到此」也收不到 drop。
        // 而本应用的这两处用的都是标准 web 事件（dragstart/dragover/drop），
        // 关掉后交回 webview 自己处理，两者都正常。代价是拿不到 Tauri 的原生
        // 拖放事件——我们本来就没用它。
        // （Tauri 自己的文档原话：This is required to use HTML5 drag and drop
        //   APIs on the frontend on Windows.）
        .disable_drag_drop_handler()
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
            true // 放行下载；返回 false 就是那个"点了没反应"
        })
        // 不接这个钩子，WebView2 对 <a target="_blank"> / window.open 也是【静默丢弃】：
        // wry 的 NewWindowRequested 处理里，宿主没给 handler 就走 `args.SetHandled(true)` 直接吃掉。
        // 现场表现同样是"点了没反应"——文献卡的 DOI、AI 回答里的每条链接、公告里的「下载新版」全中。
        // 壳里开第二个 WebView 窗口没意义（用户要的是在自己的浏览器里看、能收藏能登录），
        // 所以一律交给系统默认浏览器，然后 Deny 掉壳内的新窗口。
        .on_new_window(|url, _features| {
            open_in_browser(url.as_str());
            NewWindowResponse::Deny
        })
        .build()
}

/// 用系统默认浏览器打开一个 http(s) 地址。
/// ★ 协议必须白名单：新窗口请求的 URL 来自页面内容（AI 回答里的链接也算），
///   不设限就等于把任意协议处理器（file: / ms-… / 自定义 scheme）交给页面去触发。
/// ★ 用 rundll32 而不是 `cmd /c start`：后者要经 shell 解析，URL 里的 & ^ 会被当成命令语法。
fn open_in_browser(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let _ = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
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
        // 点 X = 缩到托盘，不退出（除非托盘「完全关闭」已把 ALLOW_EXIT 置 true）。
        // 只拦 app 主窗口；splash 启动期点 X 仍按退出处理（那时用户就是想放弃启动）。
        .on_window_event(|window, event| {
            if window.label() == "app" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !ALLOW_EXIT.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
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
            // ---- 系统托盘：点 X 缩到这里，右键「完全关闭」才真正退出 ----
            let open_i = MenuItem::with_id(app, "tray_open", "打开主界面", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "tray_quit", "完全关闭", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_i, &quit_i])?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Niuma Science（点开图标唤回窗口，右键可完全关闭）")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)   // 左键=唤回窗口，右键才弹菜单
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_open" => show_main(app),
                    "tray_quit" => {
                        ALLOW_EXIT.store(true, Ordering::SeqCst); // 放行真正退出，随后 RunEvent::Exit 收后台
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

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
                // 【别让网关再去 PATH 里找 opencode】位置我们完全知道，直接给绝对路径。
                // 真机上出过：PATH 前插在（见上），serve.err 里却是
                // 「'opencode' 不是内部或外部命令」，于是 opencode 起不来、启动页干转。
                // 裸名字要同时指望 PATH 前插生效、cmd.exe 解析成功、文件真在盘上；
                // 给了 OC_BIN 就只剩最后一件，而那件网关会明确报出来（见 resolveOcBin）。
                .env("OC_BIN", rt.join("opencode").join("opencode.exe"))
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
                // pip 默认走 pypi.org，国内实测冷装 icecream（4 个包、1.4MB）要 25.6s，清华源 7.3s。
                // 25s 这个量级正好卡在 bash 工具超时（默认 60s）与"输出分段太多"的射程里，用户看到的
                // 就是"让 agent 装个包，每次都失败"。索性在这儿把镜像钉死：网关 spawn opencode 时不传
                // env、直接继承本进程，所以一处注入就覆盖 agent 跑的所有 pip。
                // EXTRA 留官方源兜底：pip 在主 index 不可达时会自动回退到 extra index（已实测），
                // 于是校园网屏蔽清华源、或用户在境外时不至于整个装不了包。
                .env("PIP_INDEX_URL", "https://pypi.tuna.tsinghua.edu.cn/simple")
                .env("PIP_EXTRA_INDEX_URL", "https://pypi.org/simple")
                .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
                .env("MPLBACKEND", "Agg")
                // 中文字体兜底 rc。matplotlib 的查找顺序是 $MATPLOTLIBRC → cwd/matplotlibrc →
                // configdir（env 优先级最高）；技能都在会话产物目录里跑
                // （那儿没有 rc 文件、configdir 也没铺过），故这条 env 是包内 matplotlibrc 唯一的生效通道；
                // node 把整份 env 传给 opencode 再传给技能 python，一处注入全链路生效。
                .env("MATPLOTLIBRC", appdir.join("matplotlibrc"))
                // 客户端版本。网关把它作为 X-Client-Version 发给云端，后台的「客户端版本」
                // 列与公告的「最低版本」校验都靠它。
                // 【此前全仓没有一处给 APP_VERSION 赋值】于是 cloud-account.mjs 里那个
                // `process.env.APP_VERSION || "dev"` 恒取 "dev" —— 后台看到的是一片 dev，
                // 想催升级也无从下手。用 Cargo 包版本（= tauri.conf.json 里那个）钉住，
                // 发版时改一处即可。
                .env("APP_VERSION", env!("CARGO_PKG_VERSION"))
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

            // ★ 无头运行器的环境快照：定时任务在【软件关着】时要自己起一套网关，而上面这一大堆
            //   env（PATH 前插 runtime、OC_BIN、SCI_PYTHON、MATPLOTLIBRC、PIP 镜像…）只有这里算得出来。
            //   让 node 那边自己重算一遍必然漂移，症状是"定时跑出来的图没有中文字体""agent 找不到
            //   python"——而这些只在无人值守时发生，最难查。所以每次启动都把这份 env 原样存下来，
            //   web/headless-run.mjs 直接加载（见该文件 loadEnvSnapshot）。
            //   写失败不该挡启动：定时任务退化成"用当前环境跑"，主功能不受影响。
            {
                let mut env_map = serde_json::Map::new();
                for (k, v) in cmd.get_envs() {
                    if let (Some(k), Some(v)) = (k.to_str(), v.and_then(|x| x.to_str())) {
                        env_map.insert(k.to_string(), serde_json::Value::String(v.to_string()));
                    }
                }
                let at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let snap = serde_json::json!({
                    "writtenAt": at,
                    "appVersion": env!("CARGO_PKG_VERSION"),
                    // 计划任务的 <Command> 就用这个 node：打包版的 node 在 bundle\runtime 下，
                    // 与开发机的 process.execPath 完全不是一回事。
                    "nodeExe": rt.join("node").join("node.exe").to_string_lossy(),
                    "appDir": appdir.to_string_lossy(),
                    "env": env_map,
                });
                let _ = std::fs::write(
                    appdir.join("web").join("headless-env.json"),
                    serde_json::to_string_pretty(&snap).unwrap_or_default(),
                );
            }

            let mut child = cmd.spawn()?;
            *app.state::<Backend>().0.lock().unwrap() = Some(child.id());

            // 后台轮询：就绪 → 开主窗口、关 splash；超时 → splash 上报错
            let handle = app.handle().clone();
            let logpath = appdir.join("gateway.log");
            std::thread::spawn(move || {
                for i in 0..240u32 {
                    // 最多 120s
                    // 【后端已经死了就别再空等】原实现只轮询端口：node 若因缺 VC++ 运行时、
                    // 被杀软拦下、端口被占等原因起不来，用户要对着转圈整整 120 秒，
                    // 最后才拿到一句笼统的失败提示。这里一发现子进程退出就立刻报，
                    // 并把 gateway.log 的尾巴直接贴到启动页上 —— 现场诊断全靠它。
                    if let Ok(Some(status)) = child.try_wait() {
                        let tail = tail_of(&logpath, 12);
                        splash_msg(&handle, &format!(
                            "启动失败：本地服务已退出（{status}）。\n\n{tail}\n\n\
                             日志完整内容在安装目录 bundle\\app\\gateway.log"));
                        return;
                    }
                    // 每 5 秒刷一次进度：不动的转圈无法区分"在装"和"卡死了"
                    if i > 0 && i % 10 == 0 {
                        splash_msg(&handle, &format!(
                            "首次启动需要初始化本地引擎，约需 10–60 秒…（已用 {} 秒）", i / 2));
                    }
                    if health_ok() {
                        // 【建窗失败不能静默】原来是 `if win.is_ok() { 关 splash }` 然后无条件 return：
                        // 窗口没建出来就直接退出轮询线程，splash 永远转下去、一个字提示都没有。
                        // 真机上正好撞到这一格：日志里 opencode 就绪、网关 listen、浏览器打开 27821
                        // 一切正常，于是 health_ok 必然通过 —— 真正卡住的是【这之后】建窗口这一步。
                        // 症状与"后端没起来"一模一样，却把人往后端排查上引，方向全错。
                        let ok = match open_app_window(&handle) {
                            Ok(_) => true,
                            Err(e1) => {
                                // 【回主线程再建一次】splash 自己就是个 WebView2 窗口且渲染正常，
                                // 说明这台机器的 WebView2 是好的 —— 那更可能是"在后台线程里建窗"这条
                                // 路本身脆（Windows 上窗口创建对线程敏感）。换主线程重试一次，
                                // 而不是退化成"让用户自己开浏览器"：这样下载钩子与拖放设置全都保住。
                                let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
                                let h2 = handle.clone();
                                let posted = handle.run_on_main_thread(move || {
                                    let _ = tx.send(
                                        open_app_window(&h2).map(|_| ()).map_err(|e| e.to_string()),
                                    );
                                });
                                // 主线程若已卡死，recv 会一直挂着；给个上限，别把这里也变成无声等待
                                let second = match (posted, rx.recv_timeout(Duration::from_secs(20))) {
                                    (Ok(()), Ok(r)) => r,
                                    (Ok(()), Err(_)) => Err("主线程 20 秒内没有响应".into()),
                                    (Err(e), _) => Err(e.to_string()),
                                };
                                match second {
                                    Ok(()) => true,
                                    Err(e2) => {
                                        splash_msg(&handle, &format!(
                                            "本地服务已就绪，但主窗口没能创建。\n\
                                             后台线程：{e1}\n主线程重试：{e2}\n\n\
                                             后端是好的（网关已在 http://127.0.0.1:{PORT} 上），\
                                             卡住的只是本程序的窗口这一层。\n\n\
                                             现在就能用的办法：用浏览器打开 http://127.0.0.1:{PORT}\n\
                                             功能与本窗口完全一致（本机免登录），只要本程序开着就一直可用。\n\n\
                                             请把这段文字和安装目录 bundle\\app 下的 gateway.log 发给技术支持。"));
                                        false
                                    }
                                }
                            }
                        };
                        if ok {
                            if let Some(w) = handle.get_webview_window("splash") {
                                let _ = w.close();
                            }
                        }
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                let tail = tail_of(&logpath, 12);
                splash_msg(&handle, &format!(
                    "启动失败：本地服务 120 秒内未就绪。请重启应用；若反复出现，把安装目录 \
                     bundle\\app 下的 gateway.log 与 serve.err 发给技术支持。\n\n{tail}"));
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
