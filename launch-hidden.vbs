' Launch media-downloader tray silently (no console window)
' Auto-detect node.exe: prefer BUNDLED node, then global, then PATH.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
parentDir = fso.GetParentFolderName(appDir)
grandDir = fso.GetParentFolderName(parentDir)
sh.CurrentDirectory = appDir

' Search bundled node first (next to app, one level up, two levels up),
' then common global install locations, then PATH.
nodeExe = ""
candidates = Array( _
    appDir & "\node\node.exe", _
    parentDir & "\node\node.exe", _
    grandDir & "\node\node.exe", _
    "C:\veutools\node\node.exe", _
    "C:\Program Files\nodejs\node.exe", _
    "C:\Program Files (x86)\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%APPDATA%\crawbot\nodejs\node.exe"), _
    sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe") _
)
For Each p In candidates
    If fso.FileExists(p) Then
        nodeExe = p
        Exit For
    End If
Next

' Last resort: rely on PATH (just call "node")
If nodeExe = "" Then nodeExe = "node"

sh.Run """" & nodeExe & """ """ & appDir & "\tray.js""", 0, False
