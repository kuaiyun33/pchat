@echo off
chcp 65001 >nul
REM PChat VSIX 打包子脚本（Windows 版）
cd /d "%~dp0\.."
if not exist node_modules (
  echo [pchat] 未检测到 node_modules，正在执行 npm install…
  call npm install
)
del /Q pchat-*.vsix 2>nul
call npm run package
echo.
for /f "delims=" %%f in ('dir /b /o-d pchat-*.vsix 2^>nul') do (
  echo VSIX: %cd%\%%f
  goto :done
)
echo 未在当前目录找到 pchat-*.vsix，请查看上方 vsce 输出。
:done
