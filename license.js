import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const LICENSEHUB_API = process.env.LICENSEHUB_API_URL || 'https://licensehub.shop/api/v1/license';
const DEFAULT_APP_ID = process.env.LICENSEHUB_APP_ID || 'ductinlogistics';

// Khóa công khai RSA 2048-bit dùng để xác thực chữ ký bản quyền Offline
const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyHk66ziqvVbeKcuTCisE
vLkc+X5IEBsrO6AcQwWX84q0FeRJjzyRCcIAcEOxLxKItTpIF4Sbl2SAAL7Bi0i9
LbhWNhgF142YeOn4sM31G38yxbg1kuYrv8mI4ZBq7wdDqHbb7PaKv+GlpkaTz7s8
nXZ74aPUabJFZXMfJsaPgLGLl0u59aFR0VLWsF1u4kXjUHMheHLd4MuJiRPIu4Av
IVSQD16YcbqEhV/iNZUoKY+hoEPsIKp3TPy14ltCYdfUaTFi3uNiwxEPeR4zzz0p
POJ/gro6zZpXRtyJ9KIlqJxsh9bey/+qOsEaTa/TVzFUIu+8nSioTXiKQkG4MQQ0
bQIDAQAB
-----END PUBLIC KEY-----`;

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

  // Chuẩn hóa SHA-256 32 ký tự HEX in hoa (Chuẩn định dạng License)
  return crypto.createHash('sha256').update(rawId).digest('hex').substring(0, 32).toUpperCase();
}

/**
 * Tìm file lưu trữ thông tin license (license.json)
 */
export function getLicenseFilePath(dataDir) {
  if (process.env.LICENSE_FILE_PATH) {
    return process.env.LICENSE_FILE_PATH;
  }
  if (dataDir && fs.existsSync(dataDir)) {
    return path.join(dataDir, 'license.json');
  }
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
 * 2. Xác thực bản quyền Offline bằng chữ ký điện tử RSA 2048-bit
 */
export function verifyOfflineLicense(licenseKey, currentHwid) {
  if (!licenseKey || !licenseKey.startsWith('GMD1-')) {
    return null; // Không phải định dạng khóa offline GMD1
  }

  try {
    const raw = licenseKey.substring(5); // Cắt bỏ 'GMD1-'
    const dotIdx = raw.lastIndexOf('.');
    if (dotIdx === -1) {
      return { valid: false, status: 'MALFORMED', message: 'Mã bản quyền không đúng định dạng!' };
    }

    const payloadBase64 = raw.substring(0, dotIdx);
    const signature = raw.substring(dotIdx + 1);

    const payloadJson = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);

    // Xác thực chữ ký số RSA
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(payloadJson);
    verifier.end();

    const isValid = verifier.verify(RSA_PUBLIC_KEY, signature, 'base64url');
    if (!isValid) {
      return { valid: false, status: 'INVALID_SIGNATURE', message: 'Chữ ký bản quyền không hợp lệ hoặc đã bị can thiệp!' };
    }

    // Kiểm tra thời hạn bản quyền
    if (payload.expires_at && new Date(payload.expires_at) < new Date()) {
      return {
        valid: false,
        status: 'EXPIRED',
        message: `Mã bản quyền đã hết hạn vào ngày ${new Date(payload.expires_at).toLocaleDateString('vi-VN')}!`
      };
    }

    // Kiểm tra ràng buộc mã máy chủ HWID
    const targetHwid = String(payload.hwid || 'ANY').trim().toUpperCase();
    const myHwid = String(currentHwid || '').trim().toUpperCase();

    if (targetHwid !== 'ANY' && targetHwid !== myHwid) {
      return {
        valid: false,
        status: 'DEVICE_MISMATCH',
        message: `Mã bản quyền này được cấp cho máy chủ khác (${targetHwid}), không khớp máy chủ hiện tại (${myHwid})!`
      };
    }

    return {
      valid: true,
      status: 'VALID',
      customer_name: payload.customer || 'Khách hàng',
      expires_at: payload.expires_at,
      app_id: payload.app_id || DEFAULT_APP_ID,
      raw: payload
    };
  } catch (err) {
    return { valid: false, status: 'ERROR', message: `Lỗi giải mã bản quyền: ${err.message}` };
  }
}

/**
 * 3. Kích hoạt bản quyền qua API (Hỗ trợ cả Offline RSA lẫn Online LicenseHub)
 */
export async function activateLicense({ appId, licenseKey, hwid, deviceName = 'Ubuntu Server' }) {
  const offlineCheck = verifyOfflineLicense(licenseKey, hwid);
  if (offlineCheck) {
    if (offlineCheck.valid) {
      return {
        success: true,
        status: 'SUCCESS',
        message: 'Kích hoạt bản quyền Offline RSA thành công!',
        customer_name: offlineCheck.customer_name,
        expires_at: offlineCheck.expires_at,
        app_id: offlineCheck.app_id,
        raw: offlineCheck.raw
      };
    } else {
      return {
        success: false,
        status: offlineCheck.status,
        message: offlineCheck.message
      };
    }
  }

  // Fallback Online LicenseHub
  const url = `${LICENSEHUB_API}/activate`;
  const payload = {
    app_id: appId || DEFAULT_APP_ID,
    license_key: licenseKey.trim(),
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
      message: `Không thể kết nối đến máy chủ xác thực: ${err.message}`
    };
  }
}

/**
 * 4. Xác thực bản quyền định kỳ / khi khởi động
 */
export async function verifyLicense({ appId, licenseKey, hwid }) {
  const offlineCheck = verifyOfflineLicense(licenseKey, hwid);
  if (offlineCheck) {
    return offlineCheck;
  }

  // Fallback Online LicenseHub
  const url = `${LICENSEHUB_API}/verify`;
  const payload = {
    app_id: appId || DEFAULT_APP_ID,
    license_key: licenseKey.trim(),
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
      message: `Không thể kết nối đến máy chủ xác thực: ${err.message}`
    };
  }
}

let activeLicenseInfo = null;

export function getActiveLicenseInfo() {
  return activeLicenseInfo;
}

/**
 * Khởi chạy kiểm tra và bảo vệ bản quyền
 */
export async function enforceLicenseProtection({ dataDir, forcedKey, forcedAppId }) {
  console.log('\n======================================================');
  console.log('🔒 ĐANG KIỂM TRA BẢN QUYỀN HỆ THỐNG...');
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
    console.error(`👉 Hoặc kích hoạt bằng lệnh: node server.js --activate --key="KEY-CỦA-BẠN"\n`);
    process.exit(1);
  }

  console.log(`🔑 License Key:                ${licenseKey.slice(0, 8)}****${licenseKey.slice(-6)}`);

  // Nếu file license đã có thông tin kích hoạt trùng với HWID hiện tại
  let isAlreadyActivated = saved.license_key === licenseKey && saved.hwid === hwid && saved.status === 'active';

  if (!isAlreadyActivated) {
    console.log('⚡ Đang xác thực và kích hoạt bản quyền...');
    const actResult = await activateLicense({
      appId,
      licenseKey,
      hwid,
      deviceName: `${os.hostname()} (Server)`
    });

    if (!actResult.success) {
      console.error('\n❌ [KÍCH HOẠT THẤT BẠI]:');
      console.error(`   ${actResult.message}`);
      console.error(`   Trạng thái: ${actResult.status}`);
      console.error('👉 Vui lòng liên hệ nhà phát hành để được cấp License Key hợp lệ.\n');
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
      customer_name: actResult.customer_name || 'Khách hàng',
      expires_at: actResult.expires_at || null
    };
    saveLicenseConfig(licenseFile, updatedConfig);
  }

  // Xác thực lại tính toàn vẹn
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

  console.log(`✅ Bản quyền HỢP LỆ!`);
  console.log(`👤 Khách hàng:         ${verifyResult.customer_name || 'Doanh nghiệp'}`);
  console.log(`⏳ Hạn sử dụng:        ${expText}`);
  console.log('======================================================\n');

  activeLicenseInfo = {
    valid: true,
    appId,
    licenseKey: `${licenseKey.slice(0, 8)}****${licenseKey.slice(-6)}`,
    hwid,
    expiresAt: verifyResult.expires_at,
    expiresText: expText,
    customerName: verifyResult.customer_name,
    lastVerifiedAt: new Date().toISOString()
  };

  // Kiểm tra định kỳ mỗi 24 giờ
  const HEARTBEAT_INTERVAL = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    const check = await verifyLicense({ appId, licenseKey, hwid });
    if (!check.valid) {
      console.error('\n🚨 [CẢNH BÁO BẢN QUYỀN]: Key đã hết hạn hoặc bị thu hồi!');
      console.error(`Lý do: ${check.message}`);
      process.exit(1);
    }
    if (activeLicenseInfo) {
      activeLicenseInfo.lastVerifiedAt = new Date().toISOString();
      activeLicenseInfo.expiresAt = check.expires_at;
    }
  }, HEARTBEAT_INTERVAL);

  return activeLicenseInfo;
}
