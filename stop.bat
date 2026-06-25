@echo off
title ZK Bridge - Stop Server

:: Try PM2 first
where pm2 >nul 2>&1
if %errorlevel% equ 0 (
    pm2 stop zk-bridge >nul 2>&1
    echo Server stopped (PM2).
) else (
    :: Kill node processes running server.js
    wmic process where "name='node.exe' and commandline like '%%server.js%%'" delete >nul 2>&1
    if %errorlevel% equ 0 (
        echo Server stopped.
    ) else (
        echo No running server found.
    )
)
pause
