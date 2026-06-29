; Tauri NSIS custom hooks.
; The app launches a background Python backend "sidecar.exe". On upgrade/reinstall,
; if it is still running it locks the file and the installer fails with
; "cannot write ...\sidecar.exe". Kill it before install AND before uninstall.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM sidecar.exe'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM sidecar.exe'
!macroend
