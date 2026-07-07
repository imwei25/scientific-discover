; Tauri NSIS custom hooks.
; The app launches a background Python backend "kyzs-sidecar.exe". On upgrade/reinstall,
; if it is still running it locks the file and the installer fails with
; "cannot write ...\kyzs-sidecar.exe". Kill it before install AND before uninstall.
; Also kill the legacy image name "sidecar.exe": upgrades FROM versions <= 5.0.2
; still have the old-named process running and its file must be replaceable.
; (The legacy name is generic enough to collide with other apps -- that is exactly
; why the exe was renamed; keep the legacy kill only as long as old installs exist.)

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM kyzs-sidecar.exe'
  nsExec::Exec 'taskkill /F /IM sidecar.exe'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM kyzs-sidecar.exe'
  nsExec::Exec 'taskkill /F /IM sidecar.exe'
!macroend
