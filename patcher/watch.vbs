Option Explicit
Dim fso, sh, base, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)

Do
  If fso.FileExists(base & "\disabled") Then WScript.Quit 0
  sh.Environment("PROCESS")("ZCODE_PATCH_WATCH") = "1"
  cmd = "cmd /c node """ & base & "\patch.mjs"" >> """ & base & "\patch-console.log"" 2>&1"
  sh.Run cmd, 0, True
  WScript.Sleep 300000
Loop
