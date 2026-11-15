#!/usr/bin/env bash
# ==============================================================================
# SCRIPT CÀI ĐẶT TỰ ĐỘNG GOM ĐƠN PRO ENTERPRISE CHO UBUNTU 20.04 / 22.04 LTS
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
CURRENT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${CURRENT_SCRIPT_DIR}"
SERVICE_NAME="gomdon"
APP_PORT=3000

clear
echo -e "${CYAN}${BOLD}"
echo "================================================================================"
echo "    🚀 CHƯƠNG TRÌNH CÀI ĐẶT TỰ ĐỘNG - GOM ĐƠN PRO ENTERPRISE SERVER"
echo "    Bảo vệ bản quyền Offline RSA 2048-bit & Tối ưu hoá vận hành trên Ubuntu"
echo "================================================================================"
echo -e "${NC}"

# 1. Kiểm tra quyền root
if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}❌ Lỗi: Bạn phải chạy script này dưới quyền root!${NC}"
  echo -e "👉 Hãy chạy lại bằng lệnh: ${YELLOW}sudo bash install.sh${NC}\n"
  exit 1
fi

# Hiển thị Hardware ID (HWID) máy chủ
SERVER_HWID=""
if [ -f "/etc/machine-id" ]; then
  SERVER_HWID=$(sha256sum /etc/machine-id | awk '{print toupper(substr($1,1,32))}')
elif [ -f "/var/lib/dbus/machine-id" ]; then
  SERVER_HWID=$(sha256sum /var/lib/dbus/machine-id | awk '{print toupper(substr($1,1,32))}')
fi

# 2. Thu thập thông tin từ khách hàng
echo -e "${YELLOW}${BOLD}📌 BƯỚC 1: THIẾT LẬP THÔNG TIN TRIỂN KHAI${NC}"
echo "--------------------------------------------------------------------------------"

if [ -n "$SERVER_HWID" ]; then
  echo -e "🖥️  ${BOLD}MÃ ĐỊNH DANH MÁY CHỦ (HWID):${NC} ${BOLD}${CYAN}${SERVER_HWID}${NC}"
  echo -e "👉 Cung cấp mã HWID này cho Admin nếu bạn đăng ký bản quyền khóa theo máy chủ."
  echo ""
fi

# Nhập License Key
LICENSE_KEY=""
while [ -z "$LICENSE_KEY" ]; do
  read -p "$(echo -e "${CYAN}👉 Nhập License Key của bạn (bắt đầu bằng GMD1-...):${NC} ")" LICENSE_KEY
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
echo -e "   - License Key: ${BOLD}${LICENSE_KEY:0:15}...${LICENSE_KEY: -10}${NC}"
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
echo -e "${YELLOW}${BOLD}📌 BƯỚC 2: CÀI ĐẶT MÔI TRƯỜNG & GÓI PHỤ THUỘC${NC}"
echo "--------------------------------------------------------------------------------"

# Cài đặt Nginx, Certbot, UFW, DNSUtils
echo -e "${CYAN}📦 Cập nhật hệ thống và cài đặt Nginx, Certbot...${NC}"
apt-get update -y -q
apt-get install -y -q curl wget nginx certbot python3-certbot-nginx ufw dnsutils

# Cài đặt Node.js 20 LTS nếu chưa có hoặc phiên bản cũ
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
  echo -e "${CYAN}📦 Đang cài đặt Node.js 20 LTS...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -q nodejs
fi
NODE_PATH=$(which node)
echo -e "${GREEN}✅ Node.js: $(node -v) (${NODE_PATH})${NC}"

# Mở Firewall nếu UFW đang bật
if ufw status | grep -q "Status: active"; then
  echo -e "${CYAN}🛡️ Cấu hình tường lửa UFW (Port 80, 443, 22)...${NC}"
  ufw allow 80/tcp >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  ufw allow 22/tcp >/dev/null 2>&1
fi

# Cài đặt dependencies và build giao diện
echo -e "${CYAN}📦 Đang cài đặt thư viện npm và build giao diện...${NC}"
cd "${INSTALL_DIR}"
npm install
npm run build

# Tạo thư mục dữ liệu data/
mkdir -p "${INSTALL_DIR}/data"

# Tạo file cấu hình license
cat <<EOF > "${INSTALL_DIR}/data/license.json"
{
  "app_id": "${APP_ID}",
  "license_key": "${LICENSE_KEY}"
}
EOF

echo ""
echo -e "${YELLOW}${BOLD}📌 BƯỚC 3: XÁC THỰC BẢN QUYỀN HỆ THỐNG${NC}"
echo "--------------------------------------------------------------------------------"
echo -e "${CYAN}⚡ Đang xác thực chữ ký bản quyền...${NC}"

# Chạy lệnh kích hoạt với cờ --activate
if "${NODE_PATH}" "${INSTALL_DIR}/server.js" --activate --key="${LICENSE_KEY}" --app-id="${APP_ID}"; then
  echo -e "${GREEN}✅ KÍCH HOẠT BẢN QUYỀN THÀNH CÔNG!${NC}"
else
  echo ""
  echo -e "${RED}❌ [CẢNH BÁO BẢN QUYỀN]: KÍCH HOẠT THẤT BẠI!${NC}"
  echo -e "${RED}👉 Mã License Key không hợp lệ, đã hết hạn hoặc không khớp với máy chủ này.${NC}"
  echo -e "👉 Vui lòng liên hệ quản trị viên để nhận mã License Key mới."
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
ExecStart=${NODE_PATH} ${INSTALL_DIR}/server.js
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

# Kiểm tra cú pháp Nginx
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  echo -e "${GREEN}✅ Nginx Reverse Proxy đã cấu hình thành công!${NC}"
else
  echo -e "${RED}❌ Lỗi cấu hình Nginx. Vui lòng kiểm tra lại.${NC}"
  exit 1
fi

# Cấp chứng chỉ SSL HTTPS qua Certbot
echo ""
echo -e "${CYAN}🔒 Đang yêu cầu cấp chứng chỉ bảo mật SSL HTTPS từ Let's Encrypt...${NC}"
if certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
  echo -e "${GREEN}✅ ĐÃ CẤP CHỨNG CHỈ SSL HTTPS THÀNH CÔNG!${NC}"
else
  echo -e "${YELLOW}⚠️ Cấp chứng chỉ SSL tự động chưa thành công (Do DNS chưa cập nhật kịp hoặc chưa trỏ về VPS).${NC}"
  echo -e "👉 Ứng dụng vẫn có thể truy cập qua HTTP: ${BOLD}http://${DOMAIN}${NC}"
  echo -e "👉 Sau khi DNS đã trỏ xong, bạn chỉ cần gõ lệnh: ${CYAN}sudo certbot --nginx -d ${DOMAIN}${NC}"
fi

echo ""
echo -e "${GREEN}${BOLD}================================================================================${NC}"
echo -e "${GREEN}${BOLD}       🎉 CHÚC MỪNG BẠN ĐÃ CÀI ĐẶT THÀNH CÔNG GOM ĐƠN PRO ENTERPRISE!${NC}"
echo -e "${GREEN}${BOLD}================================================================================${NC}"
echo -e "🌐 Đường dẫn truy cập:   ${BOLD}${CYAN}https://${DOMAIN}${NC}"
echo -e "📂 Thư mục cài đặt:      ${BOLD}${INSTALL_DIR}${NC}"
echo -e "⚙️  Dịch vụ Systemd:      ${BOLD}systemctl status ${SERVICE_NAME}${NC}"
echo -e "📜 Xem nhật ký ứng dụng: ${BOLD}journalctl -u ${SERVICE_NAME} -f${NC}"
echo -e "${GREEN}================================================================================${NC}\n"
