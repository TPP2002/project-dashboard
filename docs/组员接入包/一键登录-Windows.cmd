@echo off & chcp 65001 >nul & set "B=%USERPROFILE%\tools\board-member.cjs"
where node >nul 2>nul || (echo 这台电脑还没装 Node，浏览器会打开下载页，装好 LTS 版后再双击我 & start https://nodejs.org & pause & exit /b 1)
mkdir "%USERPROFILE%\tools" 2>nul & curl.exe -fsSo "%B%" https://124.222.101.139/board-member.cjs || (echo 下载失败，先用浏览器打开 https://124.222.101.139 看能不能访问 & pause & exit /b 1)
set "U=" & set /p U=看板用户名：
node "%B%" login --server https://124.222.101.139 --username "%U%" || (pause & exit /b 1)
node "%B%" projects & set "P=" & set /p P=默认项目编号（只有一个项目直接回车）：
if defined P node "%B%" use "%P%"
echo. & echo 配置完成。下一步：把「发给你的AI.txt」里的内容整段发给你的 AI。 & pause
