#!/usr/bin/env node
// ==============================================================================
// 🔑 BỘ TẠO MÃ BẢN QUYỀN OFFLINE RSA - GOM ĐƠN PRO ENTERPRISE
// ==============================================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRIVATE_KEY_PATH = path.join(__dirname, 'license_private_key.pem');

if (!fs.existsSync(PRIVATE_KEY_PATH)) {
  console.error('\n❌ Lỗi: Không tìm thấy file khóa riêng tư: scripts/license_private_key.pem');
  process.exit(1);
}

const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');

// Phân tích tham số dòng lệnh
const args = process.argv.slice(2);
function getArg(name, defaultValue = '') {
  for (const arg of args) {
    if (arg.startsWith(`--${name}=`)) {
      return arg.split('=')[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  return defaultValue;
}

const customer = getArg('customer', 'Khách hàng GomDon Pro');
const daysStr = getArg('days', '365');
const days = parseInt(daysStr, 10);
const hwid = getArg('hwid', 'ANY').toUpperCase();
const appId = getArg('app', 'ductinlogistics');

let expiresAt = null;
let expiryText = 'Vĩnh viễn (Không thời hạn)';
if (days > 0) {
  const expDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  expiresAt = expDate.toISOString();
  expiryText = `${days} ngày (Hết hạn vào: ${expDate.toLocaleDateString('vi-VN')})`;
}

const payload = {
  v: 1,
  app_id: appId,
  customer,
  hwid,
  created_at: new Date().toISOString(),
  expires_at: expiresAt
};

const payloadJson = JSON.stringify(payload);
const signer = crypto.createSign('RSA-SHA256');
signer.update(payloadJson);
signer.end();
const signature = signer.sign(privateKey, 'base64url');
const payloadBase64 = Buffer.from(payloadJson).toString('base64url');

const licenseKey = `GMD1-${payloadBase64}.${signature}`;

console.log('\n======================================================================');
console.log('🎉 TẠO MÃ BẢN QUYỀN OFFLINE THÀNH CÔNG (GOM ĐƠN PRO ENTERPRISE)');
console.log('======================================================================');
console.log(`👤 Khách hàng:    ${customer}`);
console.log(`⏳ Hạn sử dụng:   ${expiryText}`);
console.log(`🖥️ Máy chủ HWID:  ${hwid === 'ANY' ? 'Áp dụng cho mọi máy chủ' : hwid}`);
console.log('----------------------------------------------------------------------');
console.log('🔑 LICENSE KEY CỦA KHÁCH:');
console.log('\n' + licenseKey + '\n');
console.log('----------------------------------------------------------------------');
console.log('👉 Hãy copy toàn bộ chuỗi trên và gửi cho khách hàng.');
console.log('======================================================================\n');
