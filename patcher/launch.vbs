Option Explicit
Dim fso, sh, base, logPath, running, code, cmd, appRoot, exe, configPath, configText, re

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = base & "\patch.log"
configPath = base & "\config.json"

If Not fso.FileExists(configPath) Then
  sh.Popup "缺少 config.json。请复制 config.example.json 为 config.json，并填写 ZCode 安装目录 appRoot。", 10, "ZCode Token Speed", 48
  WScript.Quit 1
End If

configText = fso.OpenTextFile(configPath, 1).ReadAll
Set re = New RegExp
re.IgnoreCase = True
re.Pattern = """appRoot""\s*:\s*""([^""]+)"""
If Not re.Test(configText) Then
  sh.Popup "config.json 缺少 appRoot 字段。", 10, "ZCode Token Speed", 48
  WScript.Quit 1
End If
appRoot = re.Execute(configText)(0).SubMatches(0)
exe = appRoot & "\ZCode.exe"
If Not fso.FileExists(exe) Then
  sh.Popup "在 " & appRoot & " 找不到 ZCode.exe，请检查 config.json 的 appRoot。", 10, "ZCode Token Speed", 48
  WScript.Quit 1
End If

If fso.FileExists(base & "\disabled") Then fso.DeleteFile base & "\disabled"

running = sh.Run("cmd /c tasklist /FI ""IMAGENAME eq ZCode.exe"" | find /I ""ZCode.exe"" >nul", 0, True)
If running = 0 Then
  sh.Popup "ZCode 正在运行。请先完全退出 ZCode（包括托盘图标），再通过本快捷方式启动。", 8, "ZCode Token Speed", 48
  WScript.Quit 1
End If

cmd = "cmd /c node """ & base & "\patch.mjs"" >> """ & base & "\patch-console.log"" 2>&1"
code = sh.Run(cmd, 0, True)
If code <> 0 Then
  sh.Popup "Token Speed 补丁未应用（可能是不支持的 ZCode 版本）。ZCode 仍会启动，详情见：" & vbCrLf & logPath, 9, "ZCode Token Speed", 48
End If

sh.Run """" & exe & """", 1, False
