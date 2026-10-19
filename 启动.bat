@echo off
chcp 65001 >nul
title 智慧树掌握度助手
cd /d "%~dp0"

echo ================================================
echo    智慧树「掌握度」半自动练习助手
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto HAVEEDGE
set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto HAVEEDGE
echo [错误] 没有找到 Microsoft Edge 浏览器。
echo.
pause
exit /b

:NONODE
echo [错误] 这台电脑没有安装 Node.js。
echo.
echo    1. 打开 https://nodejs.org
echo    2. 下载 LTS 版本，一路点「下一步」安装
echo    3. 装完重新双击本文件
echo.
pause
exit /b

:HAVEEDGE
echo [第 1 步] 正在打开专用浏览器窗口...
start "" "%EDGE%" --remote-debugging-port=9223 --user-data-dir="%~dp0profile" --no-first-run --no-default-browser-check "https://studywisdomh5.zhihuishu.com/"
echo.
echo [第 2 步] 请在浏览器里完成：
echo          - 登录智慧树
echo          - 进入你的课程
echo          - 打开「掌握度」页面（能看到一排知识点卡片的那个）
echo          - 等卡片全部加载出来
echo.
echo 准备好后，回到本窗口按任意键开始...
pause >nul

echo.
echo [第 3 步] 启动助手...
echo.
set "CDP_MATCH=zhihuishu.com"
node mastery.mjs
echo.
pause
