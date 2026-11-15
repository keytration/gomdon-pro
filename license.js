import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const LICENSEHUB_API = process.env.LICENSEHUB_API_URL || 'https://licensehub.shop/api/v1/license';
const DEFAULT_APP_ID = process.env.LICENSEHUB_APP_ID || 'ductinlogistics';

/**
 * 1. Khởi tạo Hardware Fingerprint (HWID duy nhất của máy chủ)
 * Ưu tiên đọc /etc/machine-id trên Linux Ubuntu.
 * Fallback đọc /var/lib/dbus/machine-id hoặc hash từ CPU/Network/Hostname.
 */
export function getHardwareId() {
  let rawId = '';

  if (process.platform === 'linux') {
    try {
      if (fs.existsSync('/etc/machine-id')) {
        rawId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      } else if (fs.existsSync('/var/lib/dbus/machine-id')) {
        rawId = fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim();
      }
    } catch {
      // Ignored
    }
  }

  if (!rawId || rawId.length < 8) {
    const cpus = os.cpus().map(c => c.model).join('|');
    let macs = '';
    try {
      const ifaces = os.networkInterfaces();
      macs = Object.values(ifaces)
        .flat()
        .filter(i => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')
        .map(i => i.mac)
        .sort()
        .join(';');
    } catch {
      // Ignored
    }
    rawId = `${os.hostname()}-${os.platform()}-${os.arch()}-${cpus}-${macs}`;
  }

  // Chuẩn hóa SHA-256 32 ký tự HEX in hoa (Chuẩn định dạng LicenseHub)
  return crypto.createHash('sha256').update(rawId).digest('hex').substring(0, 32).toUpperCase();
}

/**
 * Tìm file lưu trữ thông tin license (license.json)
 */
export function getLicenseFilePath(dataDir) {
  if (process.env.LICENSE_FILE_PATH) {
    return process.env.LICENSE_FILE_PATH;
  }
  // Nếu có dataDir thì lưu trong dataDir
  if (dataDir && fs.existsSync(dataDir)) {
    return path.join(dataDir, 'license.json');
  }
  // Hoặc lưu cạnh file thực thi
  const isPackaged = Boolean(process.pkg);
  const appRoot = isPackaged ? path.dirname(process.execPath) : process.cwd();
  return path.join(appRoot, 'license.json');
}

/**
 * Đọc file license.json
 */
export function loadLicenseConfig(licenseFile) {
  try {
    if (fs.existsSync(licenseFile)) {
      const content = fs.readFileSync(licenseFile, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error(`[License] Lỗi đọc file ${licenseFile}:`, err.message);
  }
  return {};
}

/**
 * Lưu file license.json
 */
export function saveLicenseConfig(licenseFile, data) {
  try {
    const dir = path.dirname(licenseFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(licenseFile, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[License] Lỗi ghi file ${licenseFile}:`, err.message);
    return false;
  }
}

/**
 * 2. Kích hoạt bản quyền qua API LicenseHub
 * POST https://licensehub.shop/api/v1/license/activate
 */
export async function activateLicense({ appId, licenseKey, hwid, deviceName = 'Ubuntu Server' }) {
  const url = `${LICENSEHUB_API}/activate`;
  const payload = {
    app_id: appId || DEFAULT_APP_ID,
    license_key: licenseKey.trim().toUpperCase(),
    device_id: hwid,
    hwid: hwid,
    device_name: deviceName || 'Ubuntu Server'
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LicenseHub-Client-Node/1.0'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && (data.success === true || data.status === 'SUCCESS' || data.status === 'ACTIVATED')) {
      return {
        success: true,
        status: data.status || 'SUCCESS',
        message: data.message || 'Kích hoạt bản quyền thành công!',
        expires_at: data.expires_at || null,
        app_id: data.app_id || payload.app_id,
        raw: data
      };
    }

    return {
      success: false,
      status: data.status || 'FAILED',
      message: data.message || `Lỗi máy chủ (${res.status})`
    };
  } catch (err) {
    return {
      success: false,
      status: 'NETWORK_ERROR',
      message: `Không thể kết nối đến máy chủ LicenseHub: ${err.message}`
    };
  }
}

/**
 * 3. Xác thực bản quyền định kỳ / khi khởi động
 * POST https://licensehub.shop/api/v1/license/verify
 */
export async function verifyLicense({ appId, licenseKey, hwid }) {
  const url = `${LICENSEHUB_API}/verify`;
  const payload = {
    app_id: appId || DEFAULT_APP_ID,
    license_key: licenseKey.trim().toUpperCase(),
    hwid: hwid,
    device_id: hwid
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LicenseHub-Client-Node/1.0'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    // Kiểm tra hết hạn trên client nếu server trả về expires_at
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return {
        valid: false,
        status: 'EXPIRED',
        message: `Mã bản quyền đã hết hạn vào ngày ${new Date(data.expires_at).toLocaleDateString('vi-VN')}!`
      };
    }

    if (res.ok && data.valid === true) {
      return {
        valid: true,
        status: data.status || 'VALID',
        expires_at: data.expires_at || null,
        customer_name: data.customer_name || 'Khách hàng',
        signature: data.signature || null,
        raw: data
      };
    }

    return {
      valid: false,
      status: data.status || 'INVALID',
      message: data.message || 'Bản quyền không hợp lệ hoặc thiết bị chưa được ủy quyền!'
    };
  } catch (err) {
    return {
      valid: false,
      status: 'NETWORK_ERROR',
      message: `Không thể kết nối đến máy chủ xác thực LicenseHub: ${err.message}`
    };
  }
}

let activeLicenseInfo = null;

export function getActiveLicenseInfo() {
  return activeLicenseInfo;
}

/**
 * Khởi chạy bảo vệ bản quyền:
 * - Kiểm tra HWID
 * - Đọc license.json hoặc env
 * - Kích hoạt nếu chưa kích hoạt
 * - Verify bản quyền
 * - Thiết lập heartbeat định kỳ 24h
 */
export async function enforceLicenseProtection({ dataDir, forcedKey, forcedAppId }) {
  console.log('\n======================================================');
  console.log('🔒 ĐANG KIỂM TRA BẢN QUYỀN HỆ THỐNG (LICENSEHUB)...');
  console.log('======================================================');

  const hwid = getHardwareId();
  const licenseFile = getLicenseFilePath(dataDir);
  const saved = loadLicenseConfig(licenseFile);

  const licenseKey = (
    forcedKey ||
    process.env.LICENSE_KEY ||
    saved.license_key ||
    ''
  ).trim();

  const appId = (
    forcedAppId ||
    process.env.LICENSEHUB_APP_ID ||
    process.env.APP_ID ||
    saved.app_id ||
    DEFAULT_APP_ID
  ).trim();

  console.log(`📌 Mã định danh máy chủ (HWID): ${hwid}`);
  console.log(`📌 App ID:                     ${appId}`);

  if (!licenseKey) {
    console.error('\n❌ [LỖI BẢN QUYỀN]: KHÔNG TÌM THẤY LICENSE KEY!');
    console.error(`👉 Vui lòng tạo file "${licenseFile}" với nội dung:`);
    console.error(`   {\n     "app_id": "${appId}",\n     "license_key": "KEY-CỦA-BẠN"\n   }`);
    console.error(`👉 Hoặc đặt biến môi trường: export LICENSE_KEY="KEY-CỦA-BẠN"`);
    console.error(`👉 Hoặc chạy với cờ: ./gomdon-server --activate --key="KEY-CỦA-BẠN"\n`);
    process.exit(1);
  }

  console.log(`🔑 License Key:                ${licenseKey.slice(0, 8)}****${licenseKey.slice(-4)}`);

  // Nếu file license đã có thông tin kích hoạt trùng với HWID hiện tại
  let isAlreadyActivated = saved.license_key === licenseKey && saved.hwid === hwid && saved.status === 'active';

  if (!isAlreadyActivated) {
    console.log('⚡ Đang gửi yêu cầu kích hoạt bản quyền tới LicenseHub...');
    const actResult = await activateLicense({
      appId,
      licenseKey,
      hwid,
      deviceName: `${os.hostname()} (Ubuntu Server)`
    });

    if (!actResult.success) {
      console.error('\n❌ [KÍCH HOẠT THẤT BẠI]:');
      console.error(`   ${actResult.message}`);
      console.error(`   Trạng thái: ${actResult.status}`);
      console.error('👉 Vui lòng kiểm tra lại Key trên hệ thống https://licensehub.shop\n');
      process.exit(1);
    }

    console.log(`✅ ${actResult.message}`);
    const updatedConfig = {
      ...saved,
      app_id: appId,
      license_key: licenseKey,
      hwid: hwid,
      status: 'active',
      activated_at: new Date().toISOString(),
      expires_at: actResult.expires_at || null
    };
    saveLicenseConfig(licenseFile, updatedConfig);
    isAlreadyActivated = true;
  }

  // Verify lại với máy chủ
  console.log('🔍 Đang xác thực tính hợp lệ của bản quyền...');
  const verifyResult = await verifyLicense({ appId, licenseKey, hwid });

  if (!verifyResult.valid) {
    console.error('\n❌ [XÁC THỰC BẢN QUYỀN THẤT BẠI]:');
    console.error(`   ${verifyResult.message}`);
    console.error('👉 Dịch vụ đã bị từ chối cấp phép hoạt động.\n');
    process.exit(1);
  }

  const expText = verifyResult.expires_at
    ? new Date(verifyResult.expires_at).toLocaleString('vi-VN')
    : 'Vĩnh viễn (Lifetime)';

  console.log(`✅ Bản quyền HỢP LỆ! Khách hàng: ${verifyResult.customer_name || 'Doanh nghiệp'}`);
  console.log(`⏳ Hạn sử dụng:        ${expText}`);
  console.log('======================================================\n');

  activeLicenseInfo = {
    valid: true,
    appId,
    licenseKey: `${licenseKey.slice(0, 4)}****${licenseKey.slice(-4)}`,
    hwid,
    expiresAt: verifyResult.expires_at,
    expiresText: expText,
    customerName: verifyResult.customer_name,
    lastVerifiedAt: new Date().toISOString()
  };

  // 3. Kiểm tra định kỳ (Heartbeat mỗi 24 giờ)
  const HEARTBEAT_INTERVAL = 24 * 60 * 60 * 1000; // 24 giờ
  setInterval(async () => {
    console.log('[LicenseHub] Đang thực hiện kiểm tra bản quyền định kỳ 24h...');
    const check = await verifyLicense({ appId, licenseKey, hwid });
    if (!check.valid) {
      console.error('\n🚨 [CẢNH BÁO BẢN QUYỀN]: Key đã bị thu hồi hoặc hết hạn!');
      console.error(`Lý do: ${check.message}`);
      console.error('Ứng dụng sẽ tự động dừng lại ngay lập tức.');
      process.exit(1);
    }
    if (activeLicenseInfo) {
      activeLicenseInfo.lastVerifiedAt = new Date().toISOString();
      activeLicenseInfo.expiresAt = check.expires_at;
    }
    console.log(`[LicenseHub] Bản quyền hợp lệ. Lần kiểm tra tiếp theo sau 24h.`);
  }, HEARTBEAT_INTERVAL);

  return activeLicenseInfo;
}
