Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")
sh.Environment("PROCESS").Remove("NODE_OPTIONS")
sh.Environment("PROCESS").Remove("NODE_NO_WARNINGS")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = appDir
sh.Run """" & appDir & "\node_modules\electron\dist\electron.exe"" .", 1, False