@echo off
setlocal
cd /d "%~dp0.."
call npm run package
if errorlevel 1 exit /b 1
echo.
echo VSIX 已生成于本目录（pchat-*.vsix）。
endlocal
