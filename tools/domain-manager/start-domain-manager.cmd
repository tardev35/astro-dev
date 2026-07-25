@echo off
REM Double-click to open the VPS Domain Manager (add a domain via ./add-site.sh).
REM Needs tools\domain-manager\.env with VPS_PASSWORD (copy from .env.example).
cd /d "%~dp0..\.."
if not exist "tools\domain-manager\.env" (
  echo [!] ยังไม่มีไฟล์ tools\domain-manager\.env
  echo     คัดลอกจาก .env.example แล้วใส่ VPS_PASSWORD ก่อนใช้งาน
  echo.
  pause
  exit /b 1
)
echo Starting Domain Manager...
echo   -^> http://localhost:3000   (Ctrl+C in this window to stop)
start "" http://localhost:3000
node --env-file=tools/domain-manager/.env tools/domain-manager/server.mjs
echo.
echo Server stopped. Press any key to close.
pause >nul
