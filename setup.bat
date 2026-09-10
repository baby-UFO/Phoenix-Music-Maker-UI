@echo off
REM Phoenix Music Maker Setup Script for Windows
setlocal enabledelayedexpansion

echo ==================================
echo   Phoenix Music Maker Setup (Windows)
echo ==================================
echo.

REM Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js not found!
    echo Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

REM Show Node version
for /f "tokens=*" %%i in ('node --version') do echo Node.js version: %%i

REM Install frontend dependencies
echo.
echo Installing frontend dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo Error: Failed to install frontend dependencies
    pause
    exit /b 1
)

REM Install server dependencies
echo.
echo Installing server dependencies...
cd server
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo Error: Failed to install server dependencies
    cd ..
    pause
    exit /b 1
)
cd ..

REM Create server .env if it doesn't exist
if not exist "server\.env" (
    echo.
    echo Creating server\.env from example...
    copy server\.env.example server\.env
)

REM Create data directory
if not exist "server\data" (
    mkdir server\data
)

echo.
echo ==================================
echo   Setup Complete!
echo ==================================
echo.
echo Next steps:
echo.
echo   1. Start Phoenix Engine API (in engine folder):
echo      cd path\to\Phoenix Engine
echo      uv run acestep-api --port 8001
echo.
echo   2. Start Phoenix Music Maker:
echo      start.bat
echo.
echo   3. Open http://localhost:3000
echo.
pause
