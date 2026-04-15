@echo off
chcp 65001 >nul
REM PChat 一键打包 VSIX（Windows 版）
cd /d "%~dp0"
echo ==========================================
echo   PChat 一键打包 VSIX
echo   目录: %cd%
echo ==========================================
call scripts\package-vsix.bat
call npm run build && xcopy /Y /E dist\* "%USERPROFILE%\.cursor\extensions\local.pchat-1.0.1\dist\"
echo.
pause
