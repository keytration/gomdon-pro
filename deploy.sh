#!/usr/bin/env bash
# ==============================================================================
# SCRIPT TỰ ĐỘNG CẬP NHẬT VÀ BUILD GOM ĐƠN PRO ENTERPRISE TRÊN VPS
# ==============================================================================

set -e

echo "🚀 Bắt đầu cập nhật ứng dụng GomDon Pro Enterprise..."

# Kéo code mới nhất từ git
git pull origin main

# Cài đặt thư viện & build production
npm install
npm run build

# Khởi động lại service bằng PM2
pm2 restart gomdon-pro || pm2 restart server || pm2 start server.js --name "gomdon-pro"

echo "✅ Hoàn tất cập nhật ứng dụng thành công!"
