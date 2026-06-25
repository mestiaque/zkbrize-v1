@echo off
title ZK Bridge Launcher
cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
)

:: Create logs folder if missing
if not exist "logs" mkdir logs

:: Check if PM2 is available
where pm2 >nul 2>&1
if %errorlevel% equ 0 (
    pm2 list | findstr "zk-bridge" >nul 2>&1
    if %errorlevel% equ 0 (
        echo Restarting existing server...
        pm2 restart zk-bridge
    ) else (
        echo Starting server with PM2...
        pm2 start ecosystem.config.js
    )
) else (
    echo Starting server...
    :: Kill any existing node process on port 3000
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr "LISTENING"') do (
        taskkill /f /pid %%a >nul 2>&1
    )
    start /b node src\server.js > logs\server.log 2>&1
)

echo Waiting for server to start...
timeout /t 4 /nobreak >nul

:: Open browser
start http://localhost:3000
echo.
echo Server is running at http://localhost:3000
echo Close this window to keep server running in background.
echo.
timeout /t 3 /nobreak >nul
exit /b 0
