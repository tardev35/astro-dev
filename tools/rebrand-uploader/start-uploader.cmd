@echo off
REM Double-click this file to run the Rebrand Uploader without opening VS Code.
REM It jumps to the repo root, opens the browser, and starts the local server.
REM Requires Node.js installed (the dev team already has it).
cd /d "%~dp0..\.."
echo Starting Rebrand Uploader...
echo   -^> http://localhost:4000   (Ctrl+C in this window to stop)
start "" http://localhost:4000
node tools\rebrand-uploader\server.mjs
echo.
echo Server stopped. Press any key to close.
pause >nul
