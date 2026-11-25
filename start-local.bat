@echo off
rem Asveli: локальная админка на этом компьютере (Windows). Нужен Node.js 20.6+.
cd /d "%~dp0backend"
node scripts\local.js
pause
