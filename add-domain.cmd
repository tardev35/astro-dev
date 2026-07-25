@echo off
REM Double-click to add a domain to the VPS (runs ./add-site.sh <domain> over SSH).
REM PowerShell prompts for the domain itself, so no risky text is handled here.
REM Requires your SSH key to the server set up (same as deploy.ps1).
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0add-domain.ps1"
echo.
pause
