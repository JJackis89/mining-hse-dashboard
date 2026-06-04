@echo off
setlocal

REM Run from the project directory regardless of where the script is called from.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not installed or not on PATH.
  echo Install Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [INFO] node_modules not found. Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting Vite development server...
call npm run dev

if errorlevel 1 (
  echo [ERROR] Failed to start the app.
  pause
  exit /b 1
)

endlocal
