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

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "检查是否有正在运行的实例…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(\"$INSTDIR\", [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $0
  ; 给句柄释放留点时间：进程退出到文件锁真正解除之间有延迟，紧接着解压仍可能撞上
  Sleep 1500

  ; 升级时清掉【上一版留下的在线更新状态】。
  ;
  ; 【为什么】skill-packs\ 与 web-packs\ 里存的是"当前装的是哪个在线版本 + 各版归档"，
  ; 而覆盖安装会把技能与前端换成本安装包自带的那套 —— 状态文件却还写着"我在用
  ; 2026.7.30 那版"，于是客户端认为自己已是最新、不再提示更新，回退列表里的"出厂版"
  ; 指的也是上一个安装包的内容。清掉它们，装完就是干净的出厂状态。
  ; 【不动 outputs / uploads / cloud-state.json】用户的产出、上传与登录态要跨升级留着。
  DetailPrint "清理上一版的在线更新状态…"
  RMDir /r "$INSTDIR\bundle\app\skill-packs"
  RMDir /r "$INSTDIR\bundle\app\web-packs"
  Delete "$INSTDIR\bundle\app\gateway.log"
  Delete "$INSTDIR\bundle\app\serve.out"
  Delete "$INSTDIR\bundle\app\serve.err"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "正在结束运行中的实例…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(\"$INSTDIR\", [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
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
  RMDir /r "$INSTDIR\bundle\app\.opencode"
  RMDir /r "$INSTDIR\bundle\app\skill-packs"
  RMDir /r "$INSTDIR\bundle\app\web-packs"
  RMDir /r "$INSTDIR\bundle\app\.venv"
  RMDir /r "$INSTDIR\bundle\runtime"
  Delete "$INSTDIR\bundle\app\gateway.log"
  Delete "$INSTDIR\bundle\app\serve.out"
  Delete "$INSTDIR\bundle\app\serve.err"
  Delete "$INSTDIR\bundle\app\*.txt"
  ; RMDir（不带 /r）只删空目录：outputs/uploads 里有东西就会原样留下，正是我们要的
  RMDir "$INSTDIR\bundle\app\outputs"
  RMDir "$INSTDIR\bundle\app\uploads"
  ; web 必须 /r：界面包在线更新会往 web\ 里【新增】NSIS 没登记过的文件（如后来加的
  ; workspace.html），只删空目录必然失败，进而连锁到 app/bundle/$INSTDIR 全都删不掉。
  ; web\ 下没有用户数据（凭证上面已显式删，产出在 app\outputs）——整树删除是安全的。
  RMDir /r "$INSTDIR\bundle\app\web"
  RMDir "$INSTDIR\bundle\app"
  RMDir "$INSTDIR\bundle"
  RMDir "$INSTDIR"
  IfFileExists "$INSTDIR\bundle\app\outputs\*.*" 0 +2
    DetailPrint "你的产出与上传保留在 $INSTDIR\bundle\app（outputs / uploads），可自行备份后删除"
!macroend
