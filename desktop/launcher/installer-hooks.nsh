; NSIS 安装钩子。
;
; 【为什么需要】用户报过：部分机器安装时报「抽取:无法写入文件 …\bundle\runtime\git\usr\bin\
; msys-svn_diff-1-0.dll」。最常见的成因是**升级/重装时应用还开着**：网关会拉起 bundle 里的
; bash/git 去跑技能脚本，那些 DLL 正被进程占用，NSIS 覆盖不了就中止解压。
;
; 处理方式：装之前，把【安装目录下】正在跑的进程全部结束掉。
; 只按 ExecutablePath 前缀匹配，绝不按镜像名杀 —— `taskkill /IM node.exe` 会把用户自己
; 别处跑的 node 一起干掉，那是不能接受的。
; 覆盖三类：sciagent-desktop.exe（壳）、runtime\node\node.exe（网关）、
; runtime\opencode\opencode.exe，以及 git 拉起的一切子进程。
;
; ★★ 比对前必须先剥掉 \\?\ 前缀，否则 opencode.exe 永远杀不掉 ★★
; 真机实测（2026-08-09）：同一次运行里三个进程的 Win32_Process.ExecutablePath 是
;   壳       C:\...\Niuma Science\sciagent-desktop.exe
;   网关     C:\...\Niuma Science\bundle\runtime\node\node.exe
;   opencode \\?\C:\...\Niuma Science\bundle\runtime\opencode\opencode.exe   ← 带前缀
; opencode 是 bun 编译的单文件二进制，起来后报的是 Win32 长路径形式。裸 StartsWith("$INSTDIR")
; 对它必然不成立 —— 于是壳和网关都杀掉了，唯独它活着攥住自己的 exe，NSIS 覆盖不了，
; 报「无法打开要写入的文件 …\runtime\opencode\opencode.exe」。现场看着像是"随机某些机器装不上"，
; 实则只取决于装之前有没有留下 opencode 孤儿进程（它是 detached 起的，关窗口的
; taskkill /T 带不走它，只有壳正常退出时的按端口兜底才清得掉）。
; TrimStart 用 [char]92 / [char]63（\ 与 ?）而不是字面量：这串要穿过 NSIS 单引号 + cmd + PowerShell
; 三层转义，少一个反斜杠就整条静默失效，而失效了没人看得出来（nsExec 的返回码这里从来没人查）。

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "检查是否有正在运行的实例…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.TrimStart([char]92,[char]63).StartsWith(\"$INSTDIR\", [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $0
  ; 给句柄释放留点时间：进程退出到文件锁真正解除之间有延迟，紧接着解压仍可能撞上
  Sleep 1500

  ; 升级时清掉【上一版留下的在线更新状态】。
  ;
  ; 【为什么】skill-packs\ 与 web-packs\ 里存的是"当前装的是哪个在线版本 + 各版归档"，
  ; 而覆盖安装会把技能与前端换成本安装包自带的那套 —— 状态文件却还写着"我在用
  ; 2026.7.30 那版"，于是客户端认为自己已是最新、不再提示更新，回退列表里的"出厂版"
  ; 指的也是上一个安装包的内容。清掉它们，装完就是干净的出厂状态。
  ; 【不动 outputs / uploads / cloud-state.json / chat-bridge\】用户的产出、上传、登录态
  ; 与聊天接入的绑定状态（企微凭证 + 绑定的会话）要跨升级留着。
  DetailPrint "清理上一版的在线更新状态…"
  RMDir /r "$INSTDIR\bundle\app\skill-packs"
  RMDir /r "$INSTDIR\bundle\app\web-packs"
  Delete "$INSTDIR\bundle\app\gateway.log"
  Delete "$INSTDIR\bundle\app\serve.out"
  Delete "$INSTDIR\bundle\app\serve.err"
!macroend

; ---------------------------------------------------------------------------
; 装完之后：把 0.1.8 及更早的【SciAgent】旧版数据接管过来，再把它静默卸掉。
;
; 【为什么必须有】0.1.9 起 productName 从 SciAgent 改成 Niuma Science，而 NSIS 是按
; productName 认安装目录与卸载登记项的：装到 %LOCALAPPDATA%\Niuma Science，注册表写的是
; Uninstall\Niuma Science。也就是说新包【不会覆盖升级】旧版 —— 不做任何事的话，老用户机器上
; 会并存两套应用（旧的还占着 380MB 且还能被点开、连着同一个云端账号），且新装的这套是空的：
; 要重新登录、看不到以前的产出。所以这里把该带走的带走，然后调旧版自己的卸载器把它清掉。
;
; 【为什么放 POSTINSTALL 而不是 PREINSTALL】要等新目录的文件都解压成功了再动旧的。
; 万一解压中途失败，用户至少还留着一套能用的旧应用，而不是新的没装上、旧的已经被卸了。
;
; 【会话记录不在这里】opencode 的会话数据存在用户配置目录、不在安装目录下，改名不影响，
; 所以只搬安装目录内的这几样：登录态、会话标题/归类、自设模型路由、产出与上传。
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $R8
  Push $R9

  ; ---- 先清掉「上一版有、这一版没有」的残留 ----
  ;
  ; 【为什么必须有】NSIS 把新文件**覆盖**到旧树上，只删自己登记过的东西。凡是上一版随包、
  ; 这一版不再随包的文件，既不被覆盖也不被删除，永远留着。实测 0.1.29 → 0.1.30：
  ; ppt-master 的 AI 配图对照图库从包里移除后，用户机器上那 55 个文件 / 43.2 MB 原样躺着 ——
  ; 安装器瘦了 33.5 MB，老用户一个字节没省回来。
  ; 下面那串 POSTUNINSTALL 的 Delete/RMDir 已经证明「逐个点名」会漏（0.1.4 漏 web-packs、
  ; 0.1.5/0.1.6 漏 workspace.html），所以这里反着做：打包时生成 bundle\manifest.txt 记下
  ; 随包有什么，装完按清单把「包拥有的目录里、不在清单上的」删掉。以后增删随包内容不用改这里。
  ;
  ; 【为什么放 POSTINSTALL 而不是 PREINSTALL】和下面接管旧版数据同一个道理：要等新文件都解压
  ; 成功了再动手。装前就清，万一解压中途失败，用户手上就是一套被掏空的应用。
  ;
  ; 【安全性由脚本自己兜】清单缺失 / 读不出 / 条目数低于 2000 时它什么都不做并打印原因；
  ; 打包时刻意排除的用户状态文件（登录态、会话标题、模型路由）在它的白名单里。
  ; 旧安装包不带 manifest.txt 与该脚本，IfFileExists 直接跳过，属正常。
  IfFileExists "$INSTDIR\bundle\cleanup-stale.ps1" 0 nm_no_cleanup
    DetailPrint "清理上一版残留文件…"
    nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\bundle\cleanup-stale.ps1" -BundleDir "$INSTDIR\bundle"'
    Pop $0
  nm_no_cleanup:

  StrCpy $R8 ""   ; 迁移出错标记：非空 = 别删旧目录

  ; 旧版装在哪：先读它自己写的键（用户可能装到了别处），读不到再退回默认的 per-user 目录
  ReadRegStr $R9 HKCU "Software\sciagent\SciAgent" ""
  StrCmp $R9 "" 0 +2
    StrCpy $R9 "$LOCALAPPDATA\SciAgent"
  StrCmp $R9 $INSTDIR nm_migrate_done   ; 同一个目录：不可能，但绝不能自己卸自己
  ; 判据放宽到"旧目录还在"：用户可能已经手工卸载过旧版，但卸载器按设计留下了
  ; outputs/uploads —— 那些同样该接管过来，不然就成了谁也不认领的孤儿目录。
  IfFileExists "$R9\*.*" 0 nm_migrate_done

  DetailPrint "发现旧版 SciAgent（$R9），正在接管数据…"
  ; 旧版可能正开着（用户边装边用），先结束【旧安装目录下】的进程。同上：只按路径前缀，
  ; 绝不按镜像名杀，否则会连累用户自己别处跑的 node。
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.TrimStart([char]92,[char]63).StartsWith(\"$R9\", [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $0
  Sleep 1500

  ; 1) 小文件：这三样旧卸载器会【显式删掉】，必须赶在卸载之前拷走。
  ;    cloud-state.json = 登录态（不搬就得重新登录）；sessions-meta.json = 会话标题与项目归类；
  ;    model-config.json = 用户自设的 API 路由（没设过就没有这个文件，拷不到属正常）。
  CreateDirectory "$INSTDIR\bundle\app\web"
  CopyFiles /SILENT "$R9\bundle\app\web\cloud-state.json"   "$INSTDIR\bundle\app\web"
  CopyFiles /SILENT "$R9\bundle\app\web\sessions-meta.json" "$INSTDIR\bundle\app\web"
  CopyFiles /SILENT "$R9\bundle\app\web\model-config.json"  "$INSTDIR\bundle\app\web"

  ; 2) 用户的产出与上传。这两样旧卸载器会保留，但会连同旧目录一起留在磁盘上 ——
  ;    不搬过来，用户在新应用里就看不到自己以前的东西。
  ;    拷贝一旦出错就【保留旧目录】：宁可让用户看到一个多余的文件夹，也不能把数据删没了。
  CreateDirectory "$INSTDIR\bundle\app\outputs"
  CreateDirectory "$INSTDIR\bundle\app\uploads"
  ClearErrors
  IfFileExists "$R9\bundle\app\outputs\*.*" 0 +2
    CopyFiles /SILENT "$R9\bundle\app\outputs\*.*" "$INSTDIR\bundle\app\outputs"
  IfFileExists "$R9\bundle\app\uploads\*.*" 0 +2
    CopyFiles /SILENT "$R9\bundle\app\uploads\*.*" "$INSTDIR\bundle\app\uploads"
  IfErrors 0 +3
    StrCpy $R8 "keep"
    DetailPrint "迁移产出/上传时出错，旧目录将原样保留：$R9"

  ; 3) 卸载旧版。/S 静默，_?= 让它就地同步执行（不自我复制到临时目录、也不自删），
  ;    这样 ExecWait 才真的能等到它跑完，收尾动作不会和它抢。
  IfFileExists "$R9\uninstall.exe" 0 nm_old_manual
    DetailPrint "正在卸载旧版 SciAgent…"
    ExecWait '"$R9\uninstall.exe" /S _?=$R9'
  nm_old_manual:
  ; 收尾。两种情况都要兜住：卸载器正常跑完（只剩自己和被保留的数据目录），
  ; 以及卸载器根本不在/跑失败（那就手工把目录、登记项、快捷方式清干净，
  ; 否则控制面板里会留一条点了没反应的「SciAgent」）。
  Delete "$R9\uninstall.exe"
  StrCmp $R8 "keep" +2 0
    RMDir /r "$R9"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SciAgent"
  DeleteRegKey HKCU "Software\sciagent\SciAgent"
  DeleteRegKey /ifempty HKCU "Software\sciagent"
  Delete "$SMPROGRAMS\SciAgent.lnk"
  Delete "$SMPROGRAMS\SciAgent\SciAgent.lnk"
  RMDir "$SMPROGRAMS\SciAgent"
  Delete "$DESKTOP\SciAgent.lnk"
  DetailPrint "旧版 SciAgent 已卸载，登录态与产出已接管"

nm_migrate_done:
  Pop $R9
  Pop $R8
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; ★ 先撤定时任务，再动文件。
  ;   Windows 任务计划里的条目是【安装器没登记过】的东西（由应用自己注册，见 web/schtasks.mjs），
  ;   NSIS 不会碰它。留着的话：卸载之后到了设定的时刻，任务计划照样去启动
  ;   $INSTDIR\bundle\runtime\node\node.exe —— 一个已经不存在的程序。用户看到的是
  ;   "软件都卸了还天天弹一下错"，而且在任务计划程序里永远躺着一串找不到来源的条目。
  ;   两条路都走：ScheduledTasks 模块（Win8+，能连同文件夹一起清掉），失败再退回 schtasks 通配删除。
  DetailPrint "撤销定时任务…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-ScheduledTask -TaskPath \"\NiumaScience\\\" | Unregister-ScheduledTask -Confirm:$$false; schtasks.exe /Delete /TN \"\NiumaScience\*\" /F"'
  Pop $0

  ; ★★★ 排除 uninstall.exe 自己，否则【卸载器会把自己杀掉】★★★
  ;
  ; 这条按 ExecutablePath 前缀匹配 $INSTDIR，而 uninstall.exe 就住在 $INSTDIR 里。要命的是
  ; 两条卸载路径的运行位置不同：
  ;   · 控制面板卸载 → NSIS 先把 uninstall.exe 【复制到 %TEMP%】再运行，路径不在 $INSTDIR 下，
  ;     匹配不到自己 → 一直正常，所以这个 bug 藏了很久；
  ;   · 安装新版时选「先卸载再安装」→ 安装器用 `_?=<目录>` 调它，该参数的语义正是
  ;     【就地运行、不复制到临时目录】→ 路径就在 $INSTDIR 下 → 自杀。
  ; 自杀发生在 Section Uninstall 的第一行（本钩子），而删主程序的
  ; Delete "$INSTDIR\${MAINBINARYNAME}.exe" 排在它【后面】，于是一个文件都没删就结束了。
  ; 安装器随后检查 `$0 <> 0 或 主程序仍存在`，两个条件同时成立 → 弹「无法卸载」并 Abort。
  ; 2026-08-17 本机实测：按安装器原样的命令行跑 uninstall.exe /S _?=<目录>，
  ; 退出码 -1、59739 项残留、sciagent-desktop.exe 原封不动；加上本排除后退出码 0、清理正常。
  DetailPrint "正在结束运行中的实例…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.TrimStart([char]92,[char]63).StartsWith(\"$INSTDIR\", [StringComparison]::OrdinalIgnoreCase) -and -not $$_.ExecutablePath.EndsWith(\"uninstall.exe\", [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $0
  Sleep 1500
!macroend

; 卸载收尾：把【安装器没登记过】的东西也清掉。
;
; 【为什么必须有】NSIS 只删自己装过的文件，而这个应用运行起来会产生一大堆它没装过的：
;   · 在线更新过技能包 / 界面包后，.opencode\skills 与 web 下的文件已经被换成新的（NSIS 不认），
;     外加 skill-packs\ 、web-packs\ 两个版本归档目录；
;   · .venv 里的 __pycache__、gateway.log / serve.out / serve.err、技能脚本的临时输出。
; 真机实测（2026-08-03）：卸载 0.1.3 后目录里还剩 621 个文件、整个 bundle\app 留着 ——
; 用户看到的就是"卸载不掉、文件夹还在"，而里面还躺着 web\cloud-state.json（refresh token，
; 等价于口令）。
;
; 【outputs 与 uploads 是用户的东西，不删】它们是用户的产出与上传的原始数据，卸载不该顺手
; 抹掉。所以：先删程序自己产生的一切，再尝试删空目录 —— 用户没数据时目录自然就消失了；
; 有数据时只留下这两个目录，并明确告诉用户它们在哪。
!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "清理运行期间产生的文件…"
  ; 凭证优先：哪怕后面几条都失败，这个也必须没了
  Delete "$INSTDIR\bundle\app\web\cloud-state.json"
  Delete "$INSTDIR\bundle\app\web\model-config.json"
  Delete "$INSTDIR\bundle\app\web\sessions-meta.json"
  ; 聊天接入的运行期状态也是凭证：state.json 存企微 bot_id/bot_secret，config.toml 是
  ; 由它生成的 cc-connect 配置（同样含 secret），bridge.log/wrap.log 是日志。整目录都是
  ; 运行期产物（安装器没登记过），走"有用户数据时只留 outputs/uploads"的分支必然被留下，
  ; 所以和 cloud-state.json 同待遇，在这里显式删。
  RMDir /r "$INSTDIR\bundle\app\chat-bridge"
  RMDir /r "$INSTDIR\bundle\app\.opencode"
  RMDir /r "$INSTDIR\bundle\app\skill-packs"
  RMDir /r "$INSTDIR\bundle\app\web-packs"
  RMDir /r "$INSTDIR\bundle\app\.venv"
  RMDir /r "$INSTDIR\bundle\runtime"
  ; 定时任务的定义与运行记录：程序自己产生的配置（计划任务已在 PREUNINSTALL 撤掉），
  ; 留着既没用又会挡住目录删除。用户的产出仍在 app\outputs，不受影响。
  RMDir /r "$INSTDIR\bundle\app\tasks"
  Delete "$INSTDIR\bundle\app\headless-gateway.log"
  Delete "$INSTDIR\bundle\app\gateway.log"
  Delete "$INSTDIR\bundle\app\serve.out"
  Delete "$INSTDIR\bundle\app\serve.err"
  Delete "$INSTDIR\bundle\app\*.txt"
  ; web 必须 /r：界面包在线更新会往 web\ 里【新增】NSIS 没登记过的文件（如后来加的
  ; workspace.html），只删空目录必然失败，进而连锁到 app/bundle/$INSTDIR 全都删不掉。
  ; web\ 下没有用户数据（凭证上面已显式删，产出在 app\outputs）——整树删除是安全的。
  RMDir /r "$INSTDIR\bundle\app\web"

  ; 收尾：空的就删掉
  RMDir "$INSTDIR\bundle\app\outputs"
  RMDir "$INSTDIR\bundle\app\uploads"

  ; 【最后一道：白名单式清扫，别再逐个点名】上面那串 Delete/RMDir 是"把已知会产生的东西一个个
  ; 列出来"，这类清单天生会漏：0.1.4 漏了整个 web-packs，0.1.5/0.1.6 漏了热更新增的
  ; workspace.html，2026-08-17 实测又漏了 .ocglobal（opencode 的全局配置：技能 + node 依赖 +
  ; .venv，约 5800 个文件）—— 它随包发布、NSIS 本该删掉，但在线更新技能包与 __pycache__ 往里
  ; 新增了没登记过的文件，于是整个目录删不掉。技能脚本还会随手往 app\ 根写临时文件
  ; （xlsx_tail_*.txt 之类），清单永远追不上。每漏一个，用户看到的就是"卸载不掉、文件夹还在"。
  ;
  ; 所以反过来做：**只保 outputs / uploads，bundle 下其余一律删**，不再依赖清单的完整性；
  ; 以后新增任何运行期目录都不用再改这里。
  ; 【为什么只对 $INSTDIR\bundle 下手】bundle 是我们自己造的目录，边界明确；绝不对 $INSTDIR
  ; 整体做递归删除（用户可能把安装目录指到了别处，万一 $INSTDIR 异常，代价是删掉他自己的东西）。
  ; $INSTDIR 本身只用 RMDir 尝试删空目录 —— 删不掉就说明还有东西，那是安全的失败方向。
  ; uninstall.exe 在 $INSTDIR 根、不在 bundle 下，不受影响（`_?=` 就地运行时它还锁着自己）。
  DetailPrint "清扫安装目录（保留 outputs / uploads）…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; $$r=\"$INSTDIR\bundle\"; if (Test-Path $$r) { Get-ChildItem $$r -Force | Where-Object { $$_.Name -ne \"app\" } | Remove-Item -Recurse -Force; $$a=Join-Path $$r \"app\"; if (Test-Path $$a) { Get-ChildItem $$a -Force | Where-Object { $$_.Name -ne \"outputs\" -and $$_.Name -ne \"uploads\" } | Remove-Item -Recurse -Force } }"'
  Pop $0

  IfFileExists "$INSTDIR\bundle\app\outputs\*.*" keepdata 0
  IfFileExists "$INSTDIR\bundle\app\uploads\*.*" keepdata 0
    RMDir /r "$INSTDIR"
    Goto donecleanup
  keepdata:
    RMDir "$INSTDIR\bundle\app"
    RMDir "$INSTDIR\bundle"
    RMDir "$INSTDIR"
    DetailPrint "你的产出与上传保留在 $INSTDIR\bundle\app（outputs / uploads），可自行备份后删除"
  donecleanup:
!macroend
