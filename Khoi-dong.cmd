@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title VietSub Studio
where node >nul 2>nul
if errorlevel 1 (
  echo Cần cài Node.js 24.21 trở lên rồi mở lại tệp này.
  pause
  exit /b 1
)
if not exist "node_modules\next\package.json" (
  echo Đang cài các thành phần của VietSub Studio...
  call npm install
  if errorlevel 1 goto :failed
)
if not exist ".next\BUILD_ID" (
  echo Đang tạo bản chạy của VietSub Studio...
  call npm run build
  if errorlevel 1 goto :failed
)
echo.
echo VietSub Studio đang khởi động. Mở địa chỉ được hiển thị bên dưới.
echo Giữ cửa sổ này mở khi xử lý video. Nhấn Ctrl+C để dừng.
echo.
call npm start
if errorlevel 1 goto :failed
exit /b 0
:failed
echo.
echo Chưa khởi động được. Xem thông báo phía trên để xử lý rồi thử lại.
pause
exit /b 1
