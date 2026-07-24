' Launches the Dot-Connector AI Serendipity Engine silently in the background.
' A copy of this file in shell:startup makes it start with Windows.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\akara\Steve Jobs\dot-connector"
sh.Run "cmd /c node server.js", 0, False
