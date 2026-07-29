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
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "正在结束运行中的实例…"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(\"$INSTDIR\", [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Pop $0
  Sleep 1500
!macroend
