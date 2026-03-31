Option Explicit

Dim shell, fso, scriptDir, psScript, logPath, cmd, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = scriptDir & "\publish_github.ps1"
logPath = scriptDir & "\publish_github_last.log"

If Not fso.FileExists(psScript) Then
  MsgBox "publish_github.ps1 not found in: " & scriptDir, 16, "Publish Failed"
  WScript.Quit 1
End If

cmd = "cmd /c ""%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & psScript & """ > """ & logPath & """ 2>&1"""
rc = shell.Run(cmd, 1, True)

If rc = 0 Then
  MsgBox "Push completed successfully." & vbCrLf & "Log: " & logPath, 64, "Publish Done"
Else
  MsgBox "Push failed. Exit code: " & rc & vbCrLf & "Log: " & logPath, 16, "Publish Failed"
  shell.Run "notepad.exe """ & logPath & """", 1, False
End If
