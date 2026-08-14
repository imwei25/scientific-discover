' 定时任务的隐藏启动器。
'
' 【为什么需要它】任务计划到点直接执行 node.exe（控制台子系统程序）时，Windows 会给它
' 配一个控制台窗口 —— 用户正用着电脑，突然弹出一个黑框，像中了毒。InteractiveToken
' （跟随登录用户、不用存密码）没法避开这一点，只能换启动方式。
' wscript.exe 是 GUI 子系统程序，本身没有任何窗口；由它把 node 以窗口样式 0（隐藏）
' 拉起来、等待退出并透传退出码 —— 任务计划里看到的运行状态/结果码与直接跑 node 一致。
'
' 用法（由 web/schtasks.mjs 生成的任务 XML 调用，不要手工执行）：
'   wscript.exe //B //Nologo headless-launch.vbs <exe> <arg1> <arg2> ...
' 每个参数都会被加引号后拼接 —— 安装目录（Niuma Science）带空格，不加引号会被拆开。
Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & """" & WScript.Arguments(i) & """ "
Next
If cmd = "" Then WScript.Quit 2
WScript.Quit sh.Run(Trim(cmd), 0, True)
