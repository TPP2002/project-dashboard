Option Explicit
Dim fso, sh, root, home, logs, day, logfile, command, arg
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
home = sh.ExpandEnvironmentStrings("%DASHBOARD_HOME%")
If home = "%DASHBOARD_HOME%" Or home = "" Then home = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude\dashboard"
If Not fso.FolderExists(home) Then fso.CreateFolder(home)
logs = home & "\logs"
If Not fso.FolderExists(logs) Then fso.CreateFolder(logs)
day = Year(Date) & Right("0" & Month(Date), 2) & Right("0" & Day(Date), 2)
logfile = logs & "\launcher-" & day & ".log"
command = "cmd /c ""cd /d """ & root & """ && node cli\launcher.cjs"
For Each arg In WScript.Arguments
  command = command & " """ & Replace(arg, """", """""") & """"
Next
command = command & " >>""" & logfile & """ 2>&1"""
sh.Run command, 0, False
