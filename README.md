# 🚀 GOM ĐƠN PRO ENTERPRISE

> **Hệ thống Quản trị & Đối soát Logistics Gom Đơn Chuyên nghiệp (J&T Express, Giao Hàng Nhanh, COD T+0, Bảng kê & Công nợ)**

---

## 🌟 Giới thiệu

**GomDon Pro Enterprise** là nền tảng quản trị và đối soát doanh thu, chi phí, công nợ dành riêng cho các doanh nghiệp làm dịch vụ gom đơn, tổng kho thương mại điện tử và đối tác vận chuyển (Logistics Aggregators).

Phần mềm giải quyết triệt để bài toán:
- Tự động hóa đối soát chéo hàng trăm nghìn vận đơn từ nhiều nhà vận chuyển (J&T Express, Giao Hàng Nhanh - GHN,...).
- Khớp nối chính xác theo Mã vận đơn, Mã đơn khách hàng, Mã shop/kho kể cả các file Excel định dạng phức tạp (tiêu đề đa tầng, cột phân cách đặc thù).
- Quản lý **Ứng COD hàng ngày (T+0)**: Tính toán ứng tiền tức thì, tự động đối trừ đơn hoàn, truy thu chênh lệch cước cân nặng và tạo mã **VietQR** động thanh toán nợ.
- Theo dõi & Cảnh báo **Đơn hàng chậm/Thất lạc** theo chuẩn SLA (3 / 5 / 7 ngày).
- Tích hợp công cụ **Chẩn đoán File lỗi & Truy vết Dữ liệu (Audit & Inspection Modal)** giúp kế toán tìm ngay nguyên nhân các đơn lệch hoặc chưa khớp.
- Xuất báo cáo đa định dạng (Excel tổng hợp, Excel chi tiết từng Shop, file ZIP nén, PDF biên bản).
- Gửi báo cáo đối soát và thông báo công nợ tự động qua Email SMTP & Zalo ZNS.

---

## 📦 Yêu cầu hệ thống

- **Hệ điều hành:** Ubuntu 20.04 / 22.04 LTS, Debian 11+, macOS hoặc Linux bất kỳ.
- **Node.js:** Phiên bản `>= 18.0.0` (Khuyên dùng Node.js 20 LTS hoặc 22 LTS).
- **RAM:** Tối thiểu 1 GB (Khuyên dùng từ 2 GB trở lên cho các file đối soát trên 50.000 dòng).
- **Ổ cứng:** Tối thiểu 10 GB SSD.
- **Port mạng:** Mặc định cổng `3000` (được cấu hình qua biến môi trường `PORT`).

---

## 🛠 Hướng dẫn Cài đặt & Triển khai

### Cách 1: Cài đặt tự động bằng Script 1-Click (Khuyên dùng cho VPS Ubuntu)

Nếu bạn vừa thuê mới VPS Ubuntu 20.04/22.04 LTS:

1. Đăng nhập vào VPS với quyền `root`.
2. Tải mã nguồn về máy:
   ```bash
   git clone <URL_REPOSITORY_CUA_BAN> /opt/gomdon-pro
   cd /opt/gomdon-pro
   ```
3. Cấp quyền và chạy script cài đặt tự động:
   ```bash
   chmod +x install.sh
   sudo ./install.sh
   ```
4. Script sẽ tự động:
   - Hỏi License Key được cấp từ LicenseHub.
   - Nhập tên miền (Domain) và tự động cấu hình Nginx + cấp chứng chỉ SSL HTTPS miễn phí qua Let's Encrypt (Certbot).
   - Thiết lập dịch vụ chạy ngầm Systemd tự khởi động cùng VPS khi reboot.

---

### Cách 2: Triển khai thủ công bằng Node.js & PM2

#### Bước 1: Tải mã nguồn & Cài đặt gói phụ thuộc
```bash
git clone <URL_REPOSITORY_CUA_BAN> gomdon-app
cd gomdon-app

# Cài đặt toàn bộ thư viện cần thiết
npm install
```

#### Bước 2: Thiết lập biến môi trường
Tạo file `.env` từ file mẫu:
```bash
cp .env.example .env
```
Mở file `.env` và điền cấu hình (License Key, Port):
```env
PORT=3000
NODE_ENV=production
DATA_DIR=./data
LICENSE_KEY=MÃ_LICENSE_CỦA_BẠN
```

#### Bước 3: Build giao diện Frontend
```bash
npm run build
```

#### Bước 4: Kích hoạt bản quyền
Chạy lệnh kiểm tra mã phần cứng (Hardware ID) hoặc kích hoạt trực tiếp:
```bash
# Kiểm tra mã HWID của máy chủ:
node server.js --hwid

# Kích hoạt bản quyền:
node server.js --activate --key="MÃ_LICENSE_CỦA_BẠN"
```

#### Bước 5: Khởi chạy bằng PM2 (Chạy nền vĩnh viễn)
```bash
# Cài đặt PM2 toàn cục (nếu chưa có)
npm install -g pm2

# Khởi chạy ứng dụng
pm2 start server.js --name "gomdon-pro"

# Lưu tiến trình để tự bật khi VPS khởi động lại
pm2 save
pm2 startup
```

---

### Cách 3: Triển khai bằng Docker & Docker Compose

Nếu bạn sử dụng môi trường Docker:

1. Chuẩn bị file `.env`:
   ```bash
   cp .env.example .env
   # Sửa LICENSE_KEY trong .env
   ```
2. Khởi chạy container bằng Docker Compose:
   ```bash
   docker compose up -d --build
   ```
3. Kiểm tra log ứng dụng:
   ```bash
   docker compose logs -f
   ```

---

## 🌐 Cấu hình Nginx & SSL HTTPS

Tạo file cấu hình Nginx tại `/etc/nginx/sites-available/app.domaincuaban.com`:

```nginx
server {
    listen 80;
    server_name app.domaincuaban.com;

    client_max_body_size 100M;

    # Nén Gzip tăng tốc độ tải
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;

    # Bộ nhớ đệm tài nguyên tĩnh (Vite Assets)
    location /assets/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Proxy toàn bộ API & Frontend
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
```

Kích hoạt cấu hình và cấp chứng chỉ SSL:
```bash
sudo ln -s /etc/nginx/sites-available/app.domaincuaban.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Cấp chứng chỉ SSL HTTPS miễn phí
sudo certbot --nginx -d app.domaincuaban.com
```

---

## 🔄 Cập nhật phiên bản mới (Update)

Mỗi khi có phiên bản cập nhật tính năng mới:
```bash
# Cách 1: Chạy script cập nhật tự động
./deploy.sh

# Cách 2: Cập nhật thủ công
git pull origin main
npm install
npm run build
pm2 restart gomdon-pro
```

---

## 💾 Quản lý Cơ sở Dữ liệu & Sao lưu (Backup)

- Toàn bộ cơ sở dữ liệu hệ thống (danh sách shop, bảng giá, các phiên đối soát, công nợ, ứng COD) được lưu trữ tại thư mục: `./data/`
- **Cơ chế Snapshot tự động:** Hệ thống tự động tạo bản lưu an toàn (`snapshot`) mỗi khi khởi động và định kỳ mỗi 6 giờ tại `./data/backups/`.
- **Sao lưu thủ công:** Quản trị viên chỉ cần nén thư mục `data/`:
  ```bash
  tar -czvf backup_gomdon_$(date +%F).tar.gz ./data/
  ```

---

## 📂 Cấu trúc Thư mục Dự án

```
├── .env.example              # Mẫu cấu hình biến môi trường
├── Dockerfile                # File đóng gói Docker nhiều tầng tối ưu
├── docker-compose.yml        # Cấu hình triển khai nhanh bằng Docker Compose
├── deploy.sh                 # Script cập nhật phiên bản trên VPS
├── install.sh                # Script cài đặt tự động 1-click cho Ubuntu
├── license.js                # Module bảo vệ bản quyền phần cứng LicenseHub
├── nginx.conf                # Mẫu cấu hình Nginx Reverse Proxy
├── package.json              # Khai báo dependencies và scripts
├── server.js                 # Backend Node.js Express (RESTful APIs, Session Store)
├── src/                      # Frontend React 19 + TypeScript + Tailwind CSS
│   ├── App.tsx               # Routing & Điều hướng trung tâm
│   ├── components/           # Toàn bộ giao diện phân hệ chức năng
│   │   ├── DailyAdvanceManagementView.tsx  # Phân hệ Quản lý Ứng COD T+0
│   │   ├── OrderLossTrackingTab.tsx        # Phân hệ Theo dõi Đơn thất lạc SLA
│   │   ├── FileAuditInspectionModal.tsx    # Công cụ Chẩn đoán & Tra cứu File lỗi
│   │   ├── ReconciliationView.tsx          # Đối soát kéo thả chính
│   │   ├── DebtAndPayoutView.tsx           # Quản lý Công nợ & Đi tiền
│   │   └── ...
│   ├── services/             # Logic nghiệp vụ xử lý dữ liệu (Excel, Đọc file, ...)
│   └── types/                # Khai báo TypeScript Interfaces & Contracts
└── tests/                    # Bộ kiểm thử tích hợp tự động (Unit & Integration Tests)
```

---

## 📞 Hỗ trợ & Bản quyền

- Bản quyền phần mềm được phát hành và bảo vệ bởi **LicenseHub**.
- Để được cấp mã bản quyền hoặc hỗ trợ kỹ thuật triển khai, vui lòng liên hệ quản trị viên hệ thống.
