@echo off
cd /d "%~dp0"
if not exist node_modules call npm.cmd install
if not exist node_modules\@resvg\resvg-js call npm.cmd install
if errorlevel 1 exit /b 1
if not exist .venv\Scripts\python.exe python -m venv .venv
if errorlevel 1 exit /b 1
.venv\Scripts\python.exe -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)"
if errorlevel 1 (
echo Python 3.11 or newer is required. Recreate .venv with a supported Python version.
exit /b 1
)
.venv\Scripts\python.exe -m pip install "pip>=26.3,<27" --disable-pip-version-check
if errorlevel 1 exit /b 1
.venv\Scripts\python.exe -m pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 exit /b 1
node server.mjs
pause
