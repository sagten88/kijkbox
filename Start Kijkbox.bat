@echo off
title Kijkbox
cd /d "%~dp0"
set "PATH=%PATH%;%ProgramFiles%\nodejs"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is niet gevonden. Installeer het met: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

if not exist node_modules (
  echo Eerste keer: onderdelen installeren...
  call npm install --omit=dev --no-fund --no-audit
)

echo Laat dit venster open staan zolang je wilt kijken. Sluiten stopt de site.
node server/index.js
pause
