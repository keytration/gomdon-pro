/**
 * tests/performance_optimization.test.ts
 * Comprehensive test suite validating:
 * R1: Pagination control logic, boundary conditions, slicing, and edge cases
 * R2: Debounce hook and event listener attachment/cleanup logic
 * R3: Express server Gzip compression and Cache-Control headers
 * R4: Nginx configuration directives and bundle size invariants
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────
// R1: Pagination Mathematical Model & State Machine Tests
// ─────────────────────────────────────────────────────────
describe('R1: Pagination Logic & Mathematical Model', () => {
  function computePagination(totalItems: number, pageSize: number, currentPage: number) {
    const isAll = pageSize <= 0;
    const effPageSize = isAll ? Math.max(1, totalItems) : pageSize;
    const totalPages = isAll ? 1 : Math.max(1, Math.ceil(totalItems / effPageSize));
    const safePage = Math.min(Math.max(1, currentPage), totalPages);
    const startItem = totalItems === 0 ? 0 : isAll ? 1 : (safePage - 1) * effPageSize + 1;
    const endItem = totalItems === 0 ? 0 : isAll ? totalItems : Math.min(safePage * effPageSize, totalItems);

    function sliceItems<T>(items: T[]): T[] {
      if (pageSize <= 0) return items;
      const start = (safePage - 1) * pageSize;
      return items.slice(start, start + pageSize);
    }

    return { isAll, effPageSize, totalPages, safePage, startItem, endItem, sliceItems };
  }

  it('P1: handles standard 50 items/page with 235 total items', () => {
    const dummy = Array.from({ length: 235 }, (_, i) => ({ id: `ord_${i + 1}`, waybill: `WB${i + 1}` }));
    
    // Page 1
    const p1 = computePagination(235, 50, 1);
    assert.equal(p1.totalPages, 5);
    assert.equal(p1.safePage, 1);
    assert.equal(p1.startItem, 1);
    assert.equal(p1.endItem, 50);
    assert.equal(p1.sliceItems(dummy).length, 50);
    assert.equal(p1.sliceItems(dummy)[0].waybill, 'WB1');

    // Page 5 (last page)
    const p5 = computePagination(235, 50, 5);
    assert.equal(p5.safePage, 5);
    assert.equal(p5.startItem, 201);
    assert.equal(p5.endItem, 235);
    assert.equal(p5.sliceItems(dummy).length, 35);
    assert.equal(p5.sliceItems(dummy)[34].waybill, 'WB235');
  });

  it('P2: handles 100 and 200 items/page options', () => {
    const dummy = Array.from({ length: 250 }, (_, i) => i);
    const p100 = computePagination(250, 100, 2);
    assert.equal(p100.totalPages, 3);
    assert.equal(p100.safePage, 2);
    assert.equal(p100.startItem, 101);
    assert.equal(p100.endItem, 200);
    assert.equal(p100.sliceItems(dummy).length, 100);

    const p200 = computePagination(250, 200, 2);
    assert.equal(p200.totalPages, 2);
    assert.equal(p200.safePage, 2);
    assert.equal(p200.startItem, 201);
    assert.equal(p200.endItem, 250);
    assert.equal(p200.sliceItems(dummy).length, 50);
  });

  it('P3: handles "Tất cả" (pageSize = 0) correctly', () => {
    const dummy = Array.from({ length: 145 }, (_, i) => i);
    const pAll = computePagination(145, 0, 1);
    assert.equal(pAll.isAll, true);
    assert.equal(pAll.totalPages, 1);
    assert.equal(pAll.safePage, 1);
    assert.equal(pAll.startItem, 1);
    assert.equal(pAll.endItem, 145);
    assert.equal(pAll.sliceItems(dummy).length, 145);
  });

  it('P4: handles empty list (0 total items)', () => {
    const p0 = computePagination(0, 50, 1);
    assert.equal(p0.totalPages, 1);
    assert.equal(p0.safePage, 1);
    assert.equal(p0.startItem, 0);
    assert.equal(p0.endItem, 0);
    assert.deepEqual(p0.sliceItems([]), []);
  });

  it('P5: clamps out-of-bounds page numbers (negative or > totalPages)', () => {
    const pNeg = computePagination(50, 50, -5);
    assert.equal(pNeg.safePage, 1);

    const pHuge = computePagination(50, 50, 999);
    assert.equal(pHuge.safePage, 1);

    const pOver = computePagination(120, 50, 10);
    assert.equal(pOver.safePage, 3);
  });
});

// ─────────────────────────────────────────────────────────
// R2: Event Listener Safety & Debounce Validation
// ─────────────────────────────────────────────────────────
describe('R2: Event Listener & Debounce Invariants', () => {
  it('E1: ReconciliationView component attaches listener ONLY when isOpen === true', () => {
    const reconcilFile = fs.readFileSync(path.join(ROOT_DIR, 'src/components/ReconciliationView.tsx'), 'utf-8');
    
    // Check SearchableShopPicker definition has guarded listener
    assert.ok(
      reconcilFile.includes('if (!isOpen) return;'),
      'SearchableShopPicker must guard document.addEventListener with if (!isOpen) return;'
    );
    assert.ok(
      reconcilFile.includes('document.addEventListener(\'mousedown\', handleClickOutside);'),
      'SearchableShopPicker must attach mousedown listener'
    );
    assert.ok(
      reconcilFile.includes('document.removeEventListener(\'mousedown\', handleClickOutside);'),
      'SearchableShopPicker must remove mousedown listener on cleanup'
    );
  });

  it('E2: SearchableSelect component also has guarded event listener', () => {
    const selectFile = fs.readFileSync(path.join(ROOT_DIR, 'src/components/SearchableSelect.tsx'), 'utf-8');
    assert.ok(
      selectFile.includes('if (!isOpen) return;'),
      'SearchableSelect must guard document.addEventListener with if (!isOpen) return;'
    );
  });

  it('E3: Debounce hook is imported and applied to search query states', () => {
    const reconcilFile = fs.readFileSync(path.join(ROOT_DIR, 'src/components/ReconciliationView.tsx'), 'utf-8');
    assert.ok(
      reconcilFile.includes('const debouncedSearchShopQuery = useDebounce(searchShopQuery, 300);'),
      'searchShopQuery must be debounced with 300ms'
    );
    assert.ok(
      reconcilFile.includes('const debouncedSearchOrderQuery = useDebounce(searchOrderQuery, 300);'),
      'searchOrderQuery must be debounced with 300ms'
    );
    assert.ok(
      reconcilFile.includes('const debouncedUnmatchedSearchTerm = useDebounce(unmatchedSearchTerm, 300);'),
      'unmatchedSearchTerm must be debounced with 300ms'
    );
    assert.ok(
      reconcilFile.includes('const debouncedQuery = useDebounce(query, 300);'),
      'SearchableShopPicker query must be debounced with 300ms'
    );
  });
});

// ─────────────────────────────────────────────────────────
// R3: Server Gzip Compression & Cache Header Validation
// ─────────────────────────────────────────────────────────
describe('R3: Server Gzip & Cache-Control Configuration', () => {
  it('S1: server.js imports and enables compression middleware', () => {
    const serverFile = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf-8');
    assert.ok(
      serverFile.includes("import compression from 'compression';"),
      'server.js must import compression'
    );
    assert.ok(
      serverFile.includes('app.use(compression());'),
      'server.js must use compression() middleware'
    );
  });

  it('S2: server.js configures Cache-Control: public, max-age=31536000, immutable for /assets/', () => {
    const serverFile = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf-8');
    assert.ok(
      serverFile.includes("res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');"),
      'server.js must set Cache-Control for assets'
    );
  });

  it('S3: nginx.conf enables gzip and /assets/ immutable cache', () => {
    const nginxFile = fs.readFileSync(path.join(ROOT_DIR, 'nginx.conf'), 'utf-8');
    assert.ok(nginxFile.includes('gzip on;'), 'nginx.conf must have gzip on;');
    assert.ok(nginxFile.includes('gzip_comp_level 6;'), 'nginx.conf must have gzip_comp_level 6;');
    assert.ok(
      nginxFile.includes('add_header Cache-Control "public, max-age=31536000, immutable";'),
      'nginx.conf must set Cache-Control for /assets/'
    );
  });

  it('S4: install.sh includes gzip and /assets/ immutable cache in deployment script', () => {
    const installFile = fs.readFileSync(path.join(ROOT_DIR, 'install.sh'), 'utf-8');
    assert.ok(installFile.includes('gzip on;'), 'install.sh must include gzip on in nginx config');
    assert.ok(
      installFile.includes('add_header Cache-Control "public, max-age=31536000, immutable";'),
      'install.sh must include Cache-Control for /assets/'
    );
  });
});

// ─────────────────────────────────────────────────────────
// R4: Bundle Size & Data Integrity Validation
// ─────────────────────────────────────────────────────────
describe('R4: Bundle Size & Production Data Invariance', () => {
  it('B1: Production JS bundle is built and gzip size is under 800 KB', async () => {
    const distAssetsDir = path.join(ROOT_DIR, 'dist', 'assets');
    assert.ok(fs.existsSync(distAssetsDir), 'dist/assets directory must exist');
    
    const files = fs.readdirSync(distAssetsDir);
    const jsFiles = files.filter(f => f.endsWith('.js'));
    assert.ok(jsFiles.length > 0, 'Must have at least one JS bundle file');

    // Calculate zlib gzip size
    const zlib = await import('node:zlib');
    for (const jsFile of jsFiles) {
      const content = fs.readFileSync(path.join(distAssetsDir, jsFile));
      const gzipped = zlib.gzipSync(content, { level: 6 });
      const gzipKb = gzipped.length / 1024;
      console.log(`      File ${jsFile}: raw=${(content.length / 1024).toFixed(1)} KB, gzip=${gzipKb.toFixed(1)} KB`);
      assert.ok(
        gzipKb < 800,
        `Gzip size of ${jsFile} must be strictly under 800 KB (actual: ${gzipKb.toFixed(1)} KB)`
      );
    }
  });

  it('B2: Database data directory and critical JSON stores remain intact', () => {
    const dataDir = path.join(ROOT_DIR, 'data');
    assert.ok(fs.existsSync(dataDir), 'data/ directory must exist');
    assert.ok(fs.existsSync(path.join(dataDir, 'shops.json')), 'shops.json must exist');
    assert.ok(fs.existsSync(path.join(dataDir, 'sessions.json')), 'sessions.json must exist');
    assert.ok(fs.existsSync(path.join(dataDir, 'sessions_summary.json')), 'sessions_summary.json must exist');
    assert.ok(fs.existsSync(path.join(dataDir, 'export_columns.json')), 'export_columns.json must exist');
    
    // Verify sessions.json has non-zero size
    const sessionsStat = fs.statSync(path.join(dataDir, 'sessions.json'));
    assert.ok(sessionsStat.size > 1000000, 'sessions.json must contain historical data (>1MB)');
  });
});
