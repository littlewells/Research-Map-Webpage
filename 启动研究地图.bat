@echo off
setlocal
cd /d "%~dp0"
set "PYTHONPYCACHEPREFIX=%~dp0cache\bytecode"
if exist "%~dp0runtime\python.exe" (
    "%~dp0runtime\python.exe" -X utf8 "%~dp0src\portable_launcher.py" %*
    if errorlevel 1 pause
    exit /b
)

set "PYTHON_EXE="
if exist "%~dp0.venv\Scripts\python.exe" set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
if defined PYTHON_EXE goto run_python
where.exe py.exe >nul 2>&1
if not errorlevel 1 goto run_launcher

rem Search PATH, skipping the Microsoft Store execution-alias stub.
if not defined PYTHON_EXE for /f "delims=" %%P in ('where.exe python.exe 2^>nul') do (
    echo %%P | find /i "\WindowsApps\" >nul
    if errorlevel 1 if not defined PYTHON_EXE set "PYTHON_EXE=%%P"
)

if defined PYTHON_EXE goto run_python

echo Python 3.11 or newer was not found.
echo Install Python, then run this file again.
goto finish

:run_python
"%PYTHON_EXE%" -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>&1
if errorlevel 1 (
    echo The Python interpreter found is older than 3.11: %PYTHON_EXE%
    echo Install Python 3.11 or newer, then run this file again.
    goto finish
)
"%PYTHON_EXE%" -X utf8 "%~dp0src\portable_launcher.py" %*
if errorlevel 1 pause
exit /b

:run_launcher
py -3 -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>&1
if errorlevel 1 (
    echo Python 3.11 or newer was not found through the Python launcher.
    goto finish
)
py -3 -X utf8 "%~dp0src\portable_launcher.py" %*
if errorlevel 1 pause
exit /b

:finish
pause
