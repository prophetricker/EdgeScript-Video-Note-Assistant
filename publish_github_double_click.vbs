Option Explicit

Dim shell, fso, scriptDir, psScript, cmd, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = scriptDir & "\publish_github.ps1"

If Not fso.FileExists(psScript) Then
  MsgBox "publish_github.ps1 not found in: " & scriptDir, 16, "Publish Failed"
  WScript.Quit 1
End If

cmd = "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & psScript & """"
rc = shell.Run(cmd, 1, True)

If rc = 0 Then
  MsgBox "Push completed successfully.", 64, "Publish Done"
Else
  MsgBox "Push failed. Exit code: " & rc & vbCrLf & "Please check the PowerShell output window for details.", 16, "Publish Failed"
End If

