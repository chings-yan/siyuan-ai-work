@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Package entry: keep the caller's cwd for explicit relative configuration.
set "ERRORLEVEL="
node.exe -e "process.exit(process.versions.node.split('.')[0] === '24' ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto runtime_error
node.exe "%~dp0scripts\pair.mjs"
set "bridgeExitCode=%errorlevel%"
if "%bridgeExitCode%"=="0" exit /b 0
echo Bridge preparation failed. Check configuration and private file permissions; see README.md.
goto readable_error

:runtime_error
set "bridgeExitCode=1"
echo Node.js 24 is required. Install it from https://nodejs.org/ then reopen this entry.
echo See README.md. This entry does not install software or change PATH.

:readable_error
echo This error window stays open for up to 15 seconds; press any key to close sooner.
rem Windows timeout returns immediately when stdin is redirected by automation.
"%SystemRoot%\System32\timeout.exe" /t 15 >nul 2>&1
exit /b %bridgeExitCode%
