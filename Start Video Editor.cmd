@echo off
title Video Editor
cd /d "%~dp0"
echo.
echo   Video Editor is starting...
echo   Your browser will open automatically in a few seconds.
echo   KEEP THIS WINDOW OPEN while you use the editor (and during a Night Shift).
echo   Close this window to stop the Video Editor.
echo.
start "" cmd /c "timeout /t 6 /nobreak >nul & start http://127.0.0.1:4600"
bun start
