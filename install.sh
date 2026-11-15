#!/usr/bin/env bash
# ==============================================================================
# SCRIPT CÀI ĐẶT TỰ ĐỘNG GOM ĐƠN PRO ENTERPRISE CHO UBUNTU 22.04 LTS
# ==============================================================================

set -e

# Màu sắc hiển thị
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Cấu hình mặc định
APP_NAME="GomDon Pro Enterprise"
APP_ID="ductinlogistics"
INSTALL_DIR="/opt/gomdon-pro"
SERVICE_NAME="gomdon"
APP_PORT=3000

# Link tải file binary độc lập (Admin thay link này bằng link CDN/GitHub/Server riêng)
BINARY_DOWNLOAD_URL="https://licensehub.shop/downloads/gomdon-server"

clear
echo -e "${CYAN}${BOLD}"
echo "================================================================================"
echo "    🚀 CHƯƠNG TRÌNH CÀI ĐẶT TỰ ĐỘNG - GOM ĐƠN PRO ENTERPRISE SERVER"
echo "    Bảo vệ bản quyền LicenseHub & Đóng gói Standalone Binary (Ubuntu 22.04)"
echo "================================================================================"
echo -e "${NC}"

# 1. Kiểm tra quyền root
if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}❌ Lỗi: Bạn phải chạy script này dưới quyền root!${NC}"
  echo -e "👉 Hãy chạy lại bằng lệnh: ${YELLOW}sudo bash install.sh${NC}\n"
  exit 1
fi

# 2. Thu thập thông tin từ khách hàng
echo -e "${YELLOW}${BOLD}📌 BƯỚC 1: THIẾT LẬP THÔNG TIN TRIỂN KHAI${NC}"
echo "--------------------------------------------------------------------------------"

# Nhập License Key
LICENSE_KEY=""
while [ -z "$LICENSE_KEY" ]; do
  read -p "$(echo -e "${CYAN}👉 Nhập License Key được cấp từ LicenseHub:${NC} ")" LICENSE_KEY
  LICENSE_KEY=$(echo "$LICENSE_KEY" | tr -d '[:space:]')
  if [ -z "$LICENSE_KEY" ]; then
    echo -e "${RED}⚠️ License Key không được để trống! Vui lòng nhập lại.${NC}"
  fi
done

# Nhập Domain
DOMAIN=""
while [ -z "$DOMAIN" ]; do
  read -p "$(echo -e "${CYAN}👉 Nhập Tên miền (Domain) muốn sử dụng (ví dụ: app.cty.com):${NC} ")" DOMAIN
  DOMAIN=$(echo "$DOMAIN" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  if [ -z "$DOMAIN" ]; then
    echo -e "${RED}⚠️ Tên miền không được để trống! Vui lòng nhập lại.${NC}"
  fi
done

echo ""
echo -e "${GREEN}✅ Đã ghi nhận thông tin:${NC}"
echo -e "   - License Key: ${BOLD}${LICENSE_KEY}${NC}"
echo -e "   - Domain:      ${BOLD}https://${DOMAIN}${NC}"
echo -e "   - App ID:      ${BOLD}${APP_ID}${NC}"
echo ""

# Kiểm tra DNS Domain
echo -e "${YELLOW}🔍 Đang kiểm tra bản ghi DNS của tên miền ${DOMAIN}...${NC}"
SERVER_IP=$(curl -s -4 https://ifconfig.me || curl -s -4 https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN_IP=$(dig +short "$DOMAIN" | tail -n1 || echo "")

if [ -n "$DOMAIN_IP" ] && [ -n "$SERVER_IP" ]; then
  if [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
    echo -e "${YELLOW}⚠️ CẢNH BÁO: Domain ${DOMAIN} đang trỏ về IP (${DOMAIN_IP}), khác IP máy chủ hiện tại (${SERVER_IP})!${NC}"
    echo -e "👉 Hãy đảm bảo bạn đã tạo bản ghi A trỏ về IP ${SERVER_IP} để cấp chứng chỉ SSL thành công."
    read -p "Bạn có muốn tiếp tục cài đặt không? (y/N): " CONTINUE_SETUP
    if [[ ! "$CONTINUE_SETUP" =~ ^[Yy]$ ]]; then
      echo -e "${RED}❌ Quá trình cài đặt đã dừng theo yêu cầu của bạn.${NC}"
      exit 0
    fi
  else
    echo -e "${GREEN}✅ DNS hợp lệ: ${DOMAIN} đã trỏ chính xác về IP ${SERVER_IP}!${NC}"
  fi
else
  echo -e "${YELLOW}ℹ️ Không thể kiểm tra tự động DNS. Tiếp tục tiến trình...${NC}"
fi

echo ""
echo -e "${YELLOW}${BOLD}📌 BƯỚC 2: CHUẨN BỊ MÔI TRƯỜNG & TẢI FILE THỰC THI NHỊ PHÂN${NC}"
echo "--------------------------------------------------------------------------------"

# Cài đặt các gói phụ trợ
echo -e "${CYAN}📦 Cập nhật hệ thống và cài đặt Nginx, Certbot...${NC}"
apt-get update -y -q
apt-get install -y -q curl wget nginx certbot python3-certbot-nginx ufw dnsutils

# Mở Firewall nếu UFW đang bật
if ufw status | grep -q "Status: active"; then
  echo -e "${CYAN}🛡️ Cấu hình tường lửa UFW (Port 80, 443, 22)...${NC}"
  ufw allow 80/tcp >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  ufw allow 22/tcp >/dev/null 2>&1
fi

# Tạo thư mục cài đặt
echo -e "${CYAN}📁 Tạo thư mục hệ thống tại ${INSTALL_DIR}...${NC}"
mkdir -p "${INSTALL_DIR}/data"

# Kiểm tra nếu file binary có sẵn trong thư mục hiện tại (khi admin giải nén cài offline)
CURRENT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${CURRENT_SCRIPT_DIR}/gomdon-server" ]; then
  echo -e "${GREEN}✅ Tìm thấy file binary sẵn có tại thư mục cài đặt. Đang sao chép vào ${INSTALL_DIR}...${NC}"
  cp -f "${CURRENT_SCRIPT_DIR}/gomdon-server" "${INSTALL_DIR}/gomdon-server"
elif [ -f "${CURRENT_SCRIPT_DIR}/dist-bin/gomdon-server" ]; then
  echo -e "${GREEN}✅ Tìm thấy file binary tại dist-bin. Đang sao chép vào ${INSTALL_DIR}...${NC}"
  cp -f "${CURRENT_SCRIPT_DIR}/dist-bin/gomdon-server" "${INSTALL_DIR}/gomdon-server"
else
  echo -e "${CYAN}🌐 Đang tải Standalone Binary từ kho lưu trữ bảo mật...${NC}"
  if wget -q --show-progress "${BINARY_DOWNLOAD_URL}" -O "${INSTALL_DIR}/gomdon-server"; then
    echo -e "${GREEN}✅ Tải file thực thi thành công!${NC}"
  else
    echo -e "${RED}❌ Không thể tải file binary từ ${BINARY_DOWNLOAD_URL}${NC}"
    echo -e "👉 Vui lòng đặt file thực thi 'gomdon-server' vào ${INSTALL_DIR}/ hoặc chạy script trong cùng thư mục với file binary."
    exit 1
  fi
fi

chmod +x "${INSTALL_DIR}/gomdon-server"

# Tạo file cấu hình license
cat <<EOF > "${INSTALL_DIR}/data/license.json"
{
  "app_id": "${APP_ID}",
  "license_key": "${LICENSE_KEY}"
}
EOF

echo ""
echo -e "${YELLOW}${BOLD}📌 BƯỚC 3: XÁC THỰC & KÍCH HOẠT BẢN QUYỀN LICENSEHUB${NC}"
echo "--------------------------------------------------------------------------------"
echo -e "${CYAN}⚡ Đang kết nối tới https://licensehub.shop để kích hoạt bản quyền...${NC}"

# Chạy lệnh kích hoạt với cờ --activate
if "${INSTALL_DIR}/gomdon-server" --activate --key="${LICENSE_KEY}" --app-id="${APP_ID}"; then
  echo -e "${GREEN}✅ KÍCH HOẠT BẢN QUYỀN THÀNH CÔNG!${NC}"
else
  echo ""
  echo -e "${RED}❌ [CẢNH BÁO BẢN QUYỀN]: KÍCH HOẠT THẤT BẠI!${NC}"
  echo -e "${RED}👉 Mã License Key không hợp lệ, đã hết hạn hoặc không khớp với mã máy chủ này.${NC}"
  echo -e "👉 Vui lòng kiểm tra lại trên https://licensehub.shop hoặc liên hệ quản trị viên."
  # Dọn dẹp file cấu hình lỗi
  rm -f "${INSTALL_DIR}/data/license.json"
  exit 1
fi

echo ""
echo -e "${YELLOW}${BOLD}📌 BƯỚC 4: THIẾT LẬP DỊCH VỤ CHẠY NGẦM (SYSTEMD SERVICE)${NC}"
echo "--------------------------------------------------------------------------------"

cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.service
[Unit]
Description=${APP_NAME}
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/gomdon-server
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PORT=${APP_PORT}
Environment=NODE_ENV=production
Environment=DATA_DIR=${INSTALL_DIR}/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}.service
systemctl restart ${SERVICE_NAME}.service

echo -e "${GREEN}✅ Dịch vụ Systemd '${SERVICE_NAME}' đã được khởi tạo và kích hoạt tự bật khi khởi động VPS!${NC}"

# Đợi 2 giây kiểm tra trạng thái service
sleep 2
if systemctl is-active --quiet ${SERVICE_NAME}.service; then
  echo -e "${GREEN}✅ Tiến trình ứng dụng đang chạy ổn định (PID: $(systemctl show --property MainPID --value ${SERVICE_NAME})).${NC}"
else
  echo -e "${RED}⚠️ Dịch vụ chưa khởi chạy thành công. Kiểm tra nhật ký:${NC}"
  journalctl -u ${SERVICE_NAME} -n 15 --no-pager
  exit 1
fi

echo ""
echo -e "${YELLOW}${BOLD}📌 BƯỚC 5: CẤU HÌNH REVERSE PROXY NGINX & CẤP CHỨNG CHỈ SSL HTTPS${NC}"
echo "--------------------------------------------------------------------------------"

# Tạo cấu hình Nginx
cat <<EOF > /etc/nginx/sites-available/${DOMAIN}.conf
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 100M;

    # Kích hoạt nén Gzip (R3)
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/json
        application/javascript
        application/x-javascript
        application/xml
        application/xml+rss
        image/svg+xml;

    # Cấu hình Cache-Control cho static assets trong /assets/ (R3)
    location /assets/ {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/${DOMAIN}.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Kiểm tra cú pháp Nginx
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  echo -e "${GREEN}✅ Cấu hình Reverse Proxy Nginx thành công.${NC}"
else
  echo -e "${RED}❌ Lỗi cú pháp cấu hình Nginx!${NC}"
  nginx -t
  exit 1
fi

# Cấp chứng chỉ SSL miễn phí Let's Encrypt
echo -e "${CYAN}🔒 Đang tự động cấp chứng chỉ bảo mật SSL HTTPS (Let's Encrypt)...${NC}"
if certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
  echo -e "${GREEN}✅ Cấp chứng chỉ SSL HTTPS thành công! Tên miền đã có ổ khóa xanh.${NC}"
  FINAL_URL="https://${DOMAIN}"
else
  echo -e "${YELLOW}⚠️ Chưa thể cấp chứng chỉ SSL tự động (có thể do DNS tên miền chưa cập nhật hoàn tất).${NC}"
  echo -e "👉 Ứng dụng hiện tại có thể truy cập qua: ${CYAN}http://${DOMAIN}${NC}"
  echo -e "👉 Sau khi DNS đã cập nhật, bạn chỉ cần chạy lệnh sau để bật HTTPS:"
  echo -e "   ${BOLD}certbot --nginx -d ${DOMAIN}${NC}"
  FINAL_URL="http://${DOMAIN}"
fi

echo ""
echo -e "${GREEN}${BOLD}================================================================================${NC}"
echo -e "${GREEN}${BOLD}🎉 CHÚC MỪNG! HỆ THỐNG ĐÃ ĐƯỢC CÀI ĐẶT VÀ KHỞI CHẠY HOÀN TẤT TỪ A ĐẾN Z!${NC}"
echo -e "${GREEN}${BOLD}================================================================================${NC}"
echo ""
echo -e "🌐 ${BOLD}ĐƯỜNG DẪN TRUY CẬP ỨNG DỤNG:${NC} ${CYAN}${BOLD}${FINAL_URL}${NC}"
echo -e "🔑 ${BOLD}Trạng thái bản quyền:${NC}        ${GREEN}ĐÃ KÍCH HOẠT HỢP LỆ (LicenseHub)${NC}"
echo -e "🖥️ ${BOLD}Mã máy chủ (HWID):${NC}           ${YELLOW}$("${INSTALL_DIR}/gomdon-server" --hwid)${NC}"
echo -e "📁 ${BOLD}Thư mục dữ liệu:${NC}             ${INSTALL_DIR}/data"
echo -e "⚙️ ${BOLD}Tên dịch vụ Systemd:${NC}         ${SERVICE_NAME}"
echo ""
echo -e "${BOLD}Các câu lệnh hữu ích khi quản trị VPS:${NC}"
echo -e "  • Xem log hoạt động trực tiếp: ${YELLOW}journalctl -u ${SERVICE_NAME} -f${NC}"
echo -e "  • Khởi động lại ứng dụng:      ${YELLOW}systemctl restart ${SERVICE_NAME}${NC}"
echo -e "  • Kiểm tra trạng thái dịch vụ: ${YELLOW}systemctl status ${SERVICE_NAME}${NC}"
echo -e "  • Dừng ứng dụng:               ${YELLOW}systemctl stop ${SERVICE_NAME}${NC}"
echo ""
echo -e "${CYAN}Cảm ơn bạn đã tin tưởng sử dụng giải pháp phần mềm! Mở trình duyệt để bắt đầu ngay.${NC}\n"
