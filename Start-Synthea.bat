@echo off
REM ---------------------------------------------------------------------------
REM  Synthea Simulation - one-click start for Windows
REM  Needs Python 3.11 or 3.12 (python.org, tick "Add python.exe to PATH").
REM  First run installs the scientific packages (a few minutes); later runs start in seconds.
REM  Everything stays on this computer: the engine only listens on 127.0.0.1 (localhost).
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0backend"
title Synthea Simulation - compute engine

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Python was not found. Install Python 3.12 from https://www.python.org/downloads/
  echo  and tick "Add python.exe to PATH" during installation, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the local Python environment ^(first run only^)...
  python -m venv .venv || goto :fail
)

if not exist ".venv\.installed" (
  echo Installing scientific packages ^(first run only, needs internet, several minutes^)...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip || goto :fail
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail
  echo ok> ".venv\.installed"
)

echo.
echo  Starting Synthea Simulation at http://localhost:8000
echo  Keep this window open while you use the platform. Close it to stop.
echo.
start "" cmd /c "timeout /t 6 >nul & start http://localhost:8000"
".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
goto :eof

:fail
echo.
echo  Setup failed - see the messages above. Check your internet connection and try again.
pause
exit /b 1
