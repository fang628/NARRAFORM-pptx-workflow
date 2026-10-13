@echo off
cd /d "%~dp0"
if not exist node_modules call npm.cmd install
if not exist node_modules\@resvg\resvg-js call npm.cmd install
if errorlevel 1 exit /b 1
if not exist .venv\Scripts\python.exe python -m venv .venv
if errorlevel 1 exit /b 1
.venv\Scripts\python.exe -m pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 exit /b 1
node server.mjs
pause
