@echo off
cd /d "C:\Users\FAYAAS NAWODYA\whatsapp-group-bot"
echo Installing dependencies...
call npm install
echo.
echo Starting WhatsApp Bot...
echo.
node src/bot.js
pause
