@echo off
title Phoenix Music Maker
REM Phoenix Music Maker Complete Startup Script for Windows
REM Starts Phoenix Engine + Backend + Frontend
setlocal EnableDelayedExpansion

echo ==================================
echo   Phoenix Music Maker Complete Startup
echo ==================================
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo Error: UI dependencies not installed!
    echo Please run setup.bat first.
    pause
    exit /b 1
)

if not exist "server\node_modules" (
    echo Error: Server dependencies not installed!
    echo Please run setup.bat first.
    pause
    exit /b 1
)

REM Get Phoenix Engine path from environment or use default
if not "%PHOENIX_ENGINE_PATH%"=="" (
    set ACESTEP_PATH=%PHOENIX_ENGINE_PATH%
)

if "%ACESTEP_PATH%"=="" (
    if exist "..\Phoenix-Engine\" (
        set ACESTEP_PATH=..\Phoenix-Engine
    ) else if exist "E:\Phoenix-Engine\" (
        set ACESTEP_PATH=E:\Phoenix-Engine
    ) else (
        set ACESTEP_PATH=..\ACE-Step-1.5
    )
)

REM Check if Phoenix Engine exists
if not exist "%ACESTEP_PATH%" (
    echo.
    echo Warning: Phoenix Engine not found at %ACESTEP_PATH%
    echo.
    echo Please set PHOENIX_ENGINE_PATH or place Phoenix-Engine next to Phoenix-Music-Maker-UI
    echo Example: set PHOENIX_ENGINE_PATH=E:\Phoenix-Engine
    echo.
    pause
    exit /b 1
)

REM Prefer non-turbo DiT so inference steps >8 are not clamped to 8 by turbo.
REM Must set BEFORE the ( ) block ? cmd expands %VAR% at parse time inside blocks.
REM Prefer Phoenix junction name when present; else legacy acestep-* folder.
REM Full Monty for babyUFO: prefer XL SFT DiT + LM 4B, NEVER turbo. RTX 4080 16GB needs CPU offload.
if "%ACESTEP_CONFIG_PATH%"=="" (
    if exist "%ACESTEP_PATH%\checkpoints\phoenix-v15-xl-sft\model.safetensors.index.json" (
        set "ACESTEP_CONFIG_PATH=phoenix-v15-xl-sft"
    ) else if exist "%ACESTEP_PATH%\checkpoints\acestep-v15-xl-sft\model.safetensors.index.json" (
        set "ACESTEP_CONFIG_PATH=acestep-v15-xl-sft"
    ) else if exist "%ACESTEP_PATH%\checkpoints\phoenix-v15-sft" (
        set "ACESTEP_CONFIG_PATH=phoenix-v15-sft"
    ) else if exist "%ACESTEP_PATH%\checkpoints\phoenix-v15-base" (
        set "ACESTEP_CONFIG_PATH=phoenix-v15-base"
    ) else (
        set "ACESTEP_CONFIG_PATH=acestep-v15-base"
    )
)
if "%ACESTEP_LM_MODEL_PATH%"=="" (
    if exist "%ACESTEP_PATH%\checkpoints\phoenix-5Hz-lm-4B\model.safetensors.index.json" (
        set "ACESTEP_LM_MODEL_PATH=phoenix-5Hz-lm-4B"
    ) else if exist "%ACESTEP_PATH%\checkpoints\acestep-5Hz-lm-4B\model.safetensors.index.json" (
        set "ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-4B"
    ) else if exist "%ACESTEP_PATH%\checkpoints\phoenix-5Hz-lm-1.7B" (
        set "ACESTEP_LM_MODEL_PATH=phoenix-5Hz-lm-1.7B"
    ) else (
        set "ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-1.7B"
    )
)
if "%ACESTEP_OFFLOAD_TO_CPU%"=="" set "ACESTEP_OFFLOAD_TO_CPU=true"
if "%ACESTEP_OFFLOAD_DIT_TO_CPU%"=="" set "ACESTEP_OFFLOAD_DIT_TO_CPU=true"
if "%ACESTEP_FORCE_LM_4B%"=="" set "ACESTEP_FORCE_LM_4B=true"
REM (removed stray closing paren that broke Full Monty startup)

REM Detect Phoenix Engine installation type
set API_COMMAND=
if exist "%ACESTEP_PATH%\python_embeded\python.exe" (
    echo [+] Detected Windows Portable Package
    set API_COMMAND=python_embeded\python acestep\acestep_v15_pipeline.py --port 8001 --server-name 127.0.0.1 --enable-api --backend pt --init_service true --config_path !ACESTEP_CONFIG_PATH! --lm_model_path !ACESTEP_LM_MODEL_PATH! --offload_to_cpu !ACESTEP_OFFLOAD_TO_CPU! --offload_dit_to_cpu !ACESTEP_OFFLOAD_DIT_TO_CPU!
) else (
    echo [+] Detected Standard Installation
    set API_COMMAND=uv run acestep-api --port 8001
)

REM Get local IP for LAN access
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        set LOCAL_IP=%%b
    )
)

echo.
echo ==================================
echo   Starting All Services...
echo ==================================
echo.

REM Start Phoenix Engine API in new window
echo [1/3] Starting Phoenix Engine API server...
start "Phoenix Engine API" cmd /k "cd /d "%ACESTEP_PATH%" && set ACESTEP_CONFIG_PATH=!ACESTEP_CONFIG_PATH! && set ACESTEP_FORCE_LM_4B=!ACESTEP_FORCE_LM_4B! && set ACESTEP_LM_MODEL_PATH=!ACESTEP_LM_MODEL_PATH! && !API_COMMAND!"

REM Wait for API to start
echo Waiting for API to initialize...
timeout /t 5 /nobreak >nul

REM Start backend in new window
echo [2/3] Starting backend server...
start "Phoenix Music Maker UI Backend" cmd /k "cd /d "%~dp0server" && npm run dev"

REM Wait for backend to start
echo Waiting for backend to start...
timeout /t 3 /nobreak >nul

REM Start frontend in new window
echo [3/3] Starting frontend...
start "Phoenix Music Maker UI" cmd /k "cd /d "%~dp0" && npm run dev"

REM Wait a moment
timeout /t 2 /nobreak >nul

echo.
echo ==================================
echo   All Services Running!
echo ==================================
echo.
echo   Phoenix Engine API: http://localhost:8001
echo   Backend:      http://localhost:3001
echo   Frontend:     http://localhost:3000
echo.
if defined LOCAL_IP (
    echo   LAN Access:   http://%LOCAL_IP%:3000
    echo.
)
echo   Close the terminal windows to stop all services.
echo.
echo ==================================
echo.
echo Opening browser...
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo.
echo Press any key to close this window (services will keep running)
pause >nul

