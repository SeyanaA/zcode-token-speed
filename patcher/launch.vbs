Option Explicit
Dim fso, sh, base, logPath, running, code, cmd, appRoot, exe, configPath, configText, re

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = base & "\patch.log"
configPath = base & "\config.json"

If Not fso.FileExists(configPath) Then
  sh.Popup "Missing config.json. Copy config.example.json to config.json and set appRoot to your ZCode install directory.", 10, "ZCode Token Speed", 48
  WScript.Quit 1
End If

configText = fso.OpenTextFile(configPath, 1).ReadAll
Set re = New RegExp
re.IgnoreCase = True
re.Pattern = """appRoot""\s*:\s*""([^""]+)"""
If Not re.Test(configText) Then
  sh.Popup "config.json is missing the appRoot field.", 10, "ZCode Token Speed", 48
  WScript.Quit 1
End If
appRoot = re.Execute(configText)(0).SubMatches(0)
exe = appRoot & "\ZCode.exe"
If Not fso.FileExists(exe) Then
  sh.Popup "ZCode.exe was not found under " & appRoot & ". Check appRoot in config.json.", 10, "ZCode Token Speed", 48
  WScript.Quit 1
End If

If fso.FileExists(base & "\disabled") Then fso.DeleteFile base & "\disabled"

running = sh.Run("cmd /c tasklist /FI ""IMAGENAME eq ZCode.exe"" | find /I ""ZCode.exe"" >nul", 0, True)
If running = 0 Then
  sh.Popup "ZCode is running. Fully quit ZCode (including the tray icon), then launch via this shortcut.", 8, "ZCode Token Speed", 48
  WScript.Quit 1
End If

cmd = "cmd /c node """ & base & "\patch.mjs"" >> """ & base & "\patch-console.log"" 2>&1"
code = sh.Run(cmd, 0, True)
If code <> 0 Then
  sh.Popup "Token Speed patch was not applied (possibly an unsupported ZCode version). ZCode will still start. See:" & vbCrLf & logPath, 9, "ZCode Token Speed", 48
End If

sh.Run """" & exe & """", 1, False
