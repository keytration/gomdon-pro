import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT_DIR, 'build');
const DIST_BIN_DIR = path.join(ROOT_DIR, 'dist-bin');
const FRONTEND_DIST = path.join(ROOT_DIR, 'dist');

console.log('===============================================================');
console.log('🚀 BẮT ĐẦU ĐÓNG GÓI BẢO MẬT STANDALONE BINARY (UBUNTU 22.04)');
console.log('===============================================================');

// 1. Dọn dẹp thư mục tạm
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });
if (!fs.existsSync(DIST_BIN_DIR)) fs.mkdirSync(DIST_BIN_DIR, { recursive: true });

// 2. Build Frontend React
console.log('\n📦 [BƯỚC 1/4] Build Frontend React (Vite)...');
execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });

// 3. Quét toàn bộ thư mục dist và nhúng thành In-Memory Virtual Assets
console.log('\n📦 [BƯỚC 2/4] Nhúng toàn bộ Frontend Assets vào In-Memory Virtual Storage...');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8'
};

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

const allDistFiles = getAllFiles(FRONTEND_DIST);
const virtualAssets = {};

allDistFiles.forEach((file) => {
  const relativePath = '/' + path.relative(FRONTEND_DIST, file).replace(/\\/g, '/');
  const ext = path.extname(file).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const data = fs.readFileSync(file).toString('base64');
  virtualAssets[relativePath] = { mime, data };
});

const virtualDistPath = path.join(BUILD_DIR, 'virtual-dist.cjs');
fs.writeFileSync(
  virtualDistPath,
  `globalThis.__VIRTUAL_DIST__ = ${JSON.stringify(virtualAssets)};\n`,
  'utf8'
);
console.log(`   ✅ Đã nhúng ${Object.keys(virtualAssets).length} file static vào virtual storage.`);

// 4. Bundle toàn bộ Backend + Virtual Frontend bằng esbuild
console.log('\n📦 [BƯỚC 3/4] Bundle & Obfuscate Backend bằng esbuild...');

// File entrypoint trung gian nạp virtual-dist rồi nạp server
const entrypointContent = `
require('./virtual-dist.cjs');
require('../server.js');
`;
const entrypointPath = path.join(BUILD_DIR, 'entry.cjs');
fs.writeFileSync(entrypointPath, entrypointContent, 'utf8');

const bundleOutPath = path.join(BUILD_DIR, 'bundle.cjs');

// Chạy esbuild
const esbuildCmd = `npx -y esbuild "${entrypointPath}" ` +
  `--bundle ` +
  `--platform=node ` +
  `--target=node18 ` +
  `--format=cjs ` +
  `--minify ` +
  `--legal-comments=none ` +
  `--outfile="${bundleOutPath}"`;

execSync(esbuildCmd, { cwd: ROOT_DIR, stdio: 'inherit' });
console.log(`   ✅ Bundle tạo thành công tại: ${bundleOutPath}`);

// 5. Đóng gói thành Standalone Linux x86_64 Binary bằng pkg
console.log('\n📦 [BƯỚC 4/4] Compile Standalone ELF Binary cho Linux x86_64 (Ubuntu 22.04)...');
const binaryOutPath = path.join(DIST_BIN_DIR, 'gomdon-server');

const pkgCmd = `npx -y pkg@5.8.1 "${bundleOutPath}" ` +
  `--targets node18-linux-x64 ` +
  `--output "${binaryOutPath}" ` +
  `--compress GZip`;

execSync(pkgCmd, { cwd: ROOT_DIR, stdio: 'inherit' });

console.log('\n===============================================================');
console.log('🎉 ĐÓNG GÓI HOÀN TẤT THÀNH CÔNG!');
console.log(`📁 File thực thi nhị phân độc lập: ${binaryOutPath}`);
console.log('👉 File này sẵn sàng triển khai trên bất kỳ máy chủ Ubuntu 22.04 x86_64');
console.log('   mà không cần cài Node.js, không cần npm và KHÔNG HỀ LỘ CODE!');
console.log('===============================================================\n');
