/**
 * tests/cod_advance/concurrencyStorageStress.test.ts
 * Challenger 1 Adversarial Stress Test Suite:
 * - Atomic file writing under high concurrency & race conditions
 * - Concurrent reads while writes are renaming
 * - Large batch order indexing (1,200+ orders)
 * - Order lookup edge cases (case-insensitivity, delimiters, prototype pollution, cross-shop isolation)
 * - Negative debt multi-day cascading rollover & closingDebt recording
 * - Rollback integrity under stress
 * - Invariance of existing periodic reconciliation files (SHA-256 snapshot comparison)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TEST_PORT = 3897;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const APP_ROOT = process.cwd();
const DATA_DIR = path.join(APP_ROOT, 'data');
const ADVANCE_SESSIONS_DIR = path.join(DATA_DIR, 'advance_sessions');

// Existing periodic reconciliation files to protect
const RECONCILIATION_FILES = [
  'sessions.json',
  'sessions_summary.json',
  'shops.json',
  'carriers.json',
  'carrier_data.json',
];

function getFileSha256(filePath: string): string {
  if (!fs.existsSync(filePath)) return 'FILE_NOT_FOUND';
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

let serverProcess: ChildProcess;
let authToken = '';
const initialChecksums = new Map<string, string>();

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiRequest(endpoint: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: json };
}

describe('Challenger 1: Concurrency & Storage Stress Test Suite', () => {
  before(async () => {
    // 1. Take snapshot of existing periodic reconciliation files
    for (const f of RECONCILIATION_FILES) {
      const fullPath = path.join(DATA_DIR, f);
      const hash = getFileSha256(fullPath);
      initialChecksums.set(f, hash);
    }

    // 2. Launch test server on TEST_PORT
    serverProcess = spawn('node', ['server.js'], {
      cwd: APP_ROOT,
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      try {
        const res = await fetch(`${BASE_URL}/api/system/status`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
    }
    assert.ok(ready, 'Test server failed to start within 6 seconds');

    // 3. Authenticate as Admin
    const loginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.strictEqual(loginRes.status, 200, 'Admin login failed');
    authToken = loginRes.body.token;
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(300);
    }
  });

  it('Stress-1: Baseline verification of existing reconciliation files', () => {
    for (const f of RECONCILIATION_FILES) {
      const hash = initialChecksums.get(f);
      assert.ok(hash && hash !== 'FILE_NOT_FOUND', `Reconciliation file ${f} must exist initially`);
    }
  });

  it('Stress-2: Atomic File Write under Concurrent Parallel Sessions', async () => {
    // Setup test shop
    const shopPayload = {
      id: 'adv_shop_stress_concurrency',
      code: 'STRESS_SHOP_01',
      name: 'Shop Kiểm Thử Cường Độ Cao',
      pricingPlan: {
        weightRules: [{ minWeight: 0, maxWeight: 1.0, price: 20000 }],
        extraStepWeight: 0.5,
        extraStepPrice: 5000,
      },
    };
    const shopRes = await apiRequest('/api/cod-advance/shops', {
      method: 'POST',
      body: JSON.stringify(shopPayload),
    });
    assert.strictEqual(shopRes.status, 200);

    // Launch 30 concurrent session saves with distinct session IDs
    const concurrentCount = 30;
    const sessionPromises = Array.from({ length: concurrentCount }, (_, i) => {
      const sess = {
        id: `adv_sess_stress_par_${i}`,
        shopId: 'adv_shop_stress_concurrency',
        shopCode: 'STRESS_SHOP_01',
        advanceDate: '2026-10-22',
        newOrders: [
          {
            id: `ord_par_${i}_1`,
            waybill: `WB_PAR_${i}_A`,
            weight: 0.5,
            codAmount: 100000 + i * 1000,
            appliedFee: 20000,
            netAdvance: 80000 + i * 1000,
          },
          {
            id: `ord_par_${i}_2`,
            waybill: `WB_PAR_${i}_B`,
            weight: 0.5,
            codAmount: 200000 + i * 1000,
            appliedFee: 20000,
            netAdvance: 180000 + i * 1000,
          },
        ],
        returnedOrders: [],
        weightAdjustments: [],
        previousDebt: 0,
      };
      return apiRequest('/api/cod-advance/sessions', {
        method: 'POST',
        body: JSON.stringify(sess),
      });
    });

    const results = await Promise.all(sessionPromises);
    for (let i = 0; i < concurrentCount; i++) {
      assert.strictEqual(results[i].status, 200, `Session ${i} failed to save under concurrency`);
      assert.strictEqual(results[i].body.success, true);
    }

    // Verify all 30 session files are written on disk and completely valid JSON
    for (let i = 0; i < concurrentCount; i++) {
      const filePath = path.join(ADVANCE_SESSIONS_DIR, `adv_sess_stress_par_${i}.json`);
      assert.ok(fs.existsSync(filePath), `File adv_sess_stress_par_${i}.json must exist`);
      const raw = fs.readFileSync(filePath, 'utf8');
      assert.ok(raw.length > 0, `File adv_sess_stress_par_${i}.json must not be empty`);
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.id, `adv_sess_stress_par_${i}`);
      assert.strictEqual(parsed.newOrders.length, 2);
    }

    // Verify zero leftover temporary files (*.tmp.*) in advance_sessions directory
    const sessionDirFiles = fs.readdirSync(ADVANCE_SESSIONS_DIR);
    const leakedTmp = sessionDirFiles.filter(f => f.includes('.tmp.'));
    assert.strictEqual(leakedTmp.length, 0, `No temporary files should be leaked: ${leakedTmp.join(', ')}`);

    // Clean up concurrent sessions
    for (let i = 0; i < concurrentCount; i++) {
      await apiRequest(`/api/cod-advance/sessions/adv_sess_stress_par_${i}`, { method: 'DELETE' });
    }
  });

  it('Stress-3: Concurrent Reads and Writes without Reading Partial/Corrupt Data', async () => {
    // Interleave 20 writes with 40 simultaneous reads on advance_sessions_summary and detail
    const testSessionId = 'adv_sess_readwrite_stress';
    const writeCount = 15;
    const readCount = 30;

    let writeErrors = 0;
    let readErrors = 0;
    let corruptedReads = 0;

    const writers = Array.from({ length: writeCount }, async (_, idx) => {
      await sleep(Math.floor(Math.random() * 20));
      const res = await apiRequest('/api/cod-advance/sessions', {
        method: 'POST',
        body: JSON.stringify({
          id: testSessionId,
          shopId: 'adv_shop_stress_concurrency',
          advanceDate: '2026-10-22',
          newOrders: [
            {
              id: `rw_${idx}`,
              waybill: `WB_RW_${idx}`,
              weight: 0.5,
              codAmount: 150000,
              appliedFee: 20000,
              netAdvance: 130000,
            },
          ],
          previousDebt: 0,
        }),
      });
      if (res.status !== 200 || !res.body.success) writeErrors++;
    });

    const readers = Array.from({ length: readCount }, async () => {
      await sleep(Math.floor(Math.random() * 25));
      const res = await apiRequest(`/api/cod-advance/sessions/${testSessionId}`);
      if (res.status === 200) {
        if (!res.body.session || typeof res.body.session !== 'object') {
          corruptedReads++;
        }
      } else if (res.status !== 404) {
        readErrors++;
      }
    });

    await Promise.all([...writers, ...readers]);

    assert.strictEqual(writeErrors, 0, 'No write errors should occur during concurrent R/W');
    assert.strictEqual(readErrors, 0, 'No unexpected read errors should occur during concurrent R/W');
    assert.strictEqual(corruptedReads, 0, 'No corrupted reads should occur during concurrent R/W');

    // Clean up
    await apiRequest(`/api/cod-advance/sessions/${testSessionId}`, { method: 'DELETE' });
  });

  it('Stress-4: Massive Batch Order Indexing (1,200 Orders in One Session)', async () => {
    const massiveCount = 1200;
    const newOrders = [];
    const waybillList: string[] = [];

    for (let i = 1; i <= massiveCount; i++) {
      const wb = `WB_MASSIVE_${String(i).padStart(6, '0')}`;
      waybillList.push(wb);
      newOrders.push({
        id: `ord_m_${i}`,
        waybill: wb,
        weight: 0.6,
        codAmount: 200000,
        appliedFee: 20000,
        netAdvance: 180000,
      });
    }

    const t0 = Date.now();
    const saveRes = await apiRequest('/api/cod-advance/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'adv_sess_massive_batch',
        shopId: 'adv_shop_stress_concurrency',
        advanceDate: '2026-10-22',
        newOrders,
        previousDebt: 0,
      }),
    });
    const saveDuration = Date.now() - t0;

    assert.strictEqual(saveRes.status, 200);
    assert.strictEqual(saveRes.body.success, true);
    assert.strictEqual(saveRes.body.session.totalNewOrdersCount, massiveCount);
    assert.strictEqual(saveRes.body.session.totalNewCod, massiveCount * 200000);
    assert.strictEqual(saveRes.body.session.totalNewFee, massiveCount * 20000);
    assert.strictEqual(saveRes.body.session.netAdvancePayout, massiveCount * 180000);

    // Verify disk index contains all 1,200 orders
    const orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
    assert.ok(orderIndex['WB_MASSIVE_000001'], 'First order must be indexed');
    assert.ok(orderIndex['WB_MASSIVE_000600'], 'Middle order must be indexed');
    assert.ok(orderIndex['WB_MASSIVE_001200'], 'Last order must be indexed');
    assert.strictEqual(orderIndex['WB_MASSIVE_000001'].codAmount, 200000);

    // Batch lookup all 1,200 orders at once
    const tLookup0 = Date.now();
    const lookupRes = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({
        waybills: waybillList,
        shopId: 'adv_shop_stress_concurrency',
      }),
    });
    const lookupDuration = Date.now() - tLookup0;

    assert.strictEqual(lookupRes.status, 200);
    assert.strictEqual(lookupRes.body.success, true);
    assert.strictEqual(lookupRes.body.count, massiveCount);
    // Latency must be performant (< 800ms for 1,200 orders)
    assert.ok(lookupDuration < 800, `Lookup duration ${lookupDuration}ms should be under 800ms`);

    // Test text-based newline-delimited batch lookup with 500 waybills
    const textWaybills = waybillList.slice(0, 500).join('\r\n');
    const textLookupRes = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({
        waybills: textWaybills,
        shopId: 'adv_shop_stress_concurrency',
      }),
    });
    assert.strictEqual(textLookupRes.status, 200);
    assert.strictEqual(textLookupRes.body.count, 500);

    // Clean up massive session
    const delRes = await apiRequest('/api/cod-advance/sessions/adv_sess_massive_batch', { method: 'DELETE' });
    assert.strictEqual(delRes.status, 200);

    // Verify un-indexing
    const cleanedIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
    assert.strictEqual(cleanedIndex['WB_MASSIVE_000001'], undefined, 'Orders must be un-indexed upon deletion');
  });

  it('Stress-5: Adversarial Waybill Lookup Edge Cases (Case-insensitivity, Whitespace, Delimiters, Cross-Shop Isolation)', async () => {
    // 1. Setup two shops
    await apiRequest('/api/cod-advance/shops', {
      method: 'POST',
      body: JSON.stringify({
        id: 'adv_shop_alpha',
        code: 'SHOP_ALPHA',
        name: 'Shop Alpha',
        pricingPlan: { weightRules: [{ minWeight: 0, maxWeight: 1.0, price: 20000 }] },
      }),
    });
    await apiRequest('/api/cod-advance/shops', {
      method: 'POST',
      body: JSON.stringify({
        id: 'adv_shop_beta',
        code: 'SHOP_BETA',
        name: 'Shop Beta',
        pricingPlan: { weightRules: [{ minWeight: 0, maxWeight: 1.0, price: 20000 }] },
      }),
    });

    // Save session for Shop Alpha with mixed-case waybill
    await apiRequest('/api/cod-advance/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'adv_sess_alpha_01',
        shopId: 'adv_shop_alpha',
        advanceDate: '2026-10-22',
        newOrders: [
          {
            id: 'ord_alpha_1',
            waybill: 'Vtp_Mixed_Case_123',
            weight: 0.5,
            codAmount: 350000,
            appliedFee: 20000,
            netAdvance: 330000,
          },
        ],
        previousDebt: 0,
      }),
    });

    // Save session for Shop Beta
    await apiRequest('/api/cod-advance/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'adv_sess_beta_01',
        shopId: 'adv_shop_beta',
        advanceDate: '2026-10-22',
        newOrders: [
          {
            id: 'ord_beta_1',
            waybill: 'BETA_ORDER_999',
            weight: 0.5,
            codAmount: 500000,
            appliedFee: 20000,
            netAdvance: 480000,
          },
        ],
        previousDebt: 0,
      }),
    });

    // 2. Case-insensitivity check: lookup using all-lowercase and leading/trailing whitespace
    const lookupLower = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({
        waybills: ['  vtp_mixed_case_123 \n '],
      }),
    });
    assert.strictEqual(lookupLower.status, 200);
    assert.strictEqual(lookupLower.body.count, 1);
    assert.ok(lookupLower.body.orders['VTP_MIXED_CASE_123'], 'Uppercase normalized waybill must match');
    assert.strictEqual(lookupLower.body.orders['VTP_MIXED_CASE_123'].codAmount, 350000);

    // 3. Delimiter variety check: comma, semicolon, newline mixed in string format
    const delimiterLookup = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({
        waybills: 'VTP_MIXED_CASE_123, BETA_ORDER_999; NON_EXISTENT_000\r\n',
      }),
    });
    assert.strictEqual(delimiterLookup.status, 200);
    assert.strictEqual(delimiterLookup.body.count, 2);
    assert.ok(delimiterLookup.body.orders['VTP_MIXED_CASE_123']);
    assert.ok(delimiterLookup.body.orders['BETA_ORDER_999']);
    assert.strictEqual(delimiterLookup.body.orders['NON_EXISTENT_000'], undefined);

    // 4. Cross-Shop Isolation: querying Alpha with shopId="adv_shop_beta" must NOT return Alpha orders
    const crossShopLookup = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({
        waybills: ['VTP_MIXED_CASE_123', 'BETA_ORDER_999'],
        shopId: 'adv_shop_beta',
      }),
    });
    assert.strictEqual(crossShopLookup.status, 200);
    assert.strictEqual(crossShopLookup.body.count, 1, 'Must only return Beta order when filtered by shopId');
    assert.strictEqual(crossShopLookup.body.orders['VTP_MIXED_CASE_123'], undefined, 'Must isolate Alpha order');
    assert.ok(crossShopLookup.body.orders['BETA_ORDER_999'], 'Must return Beta order');

    // 5. Prototype pollution & reserved keyword safety
    const prototypeLookup = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({
        waybills: ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'success', 'count'],
      }),
    });
    assert.strictEqual(prototypeLookup.status, 200);
    assert.strictEqual(prototypeLookup.body.success, true);
    assert.strictEqual(prototypeLookup.body.count, 0);

    // 6. Malformed and empty inputs
    const emptyArrayLookup = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({ waybills: [] }),
    });
    assert.strictEqual(emptyArrayLookup.status, 200);
    assert.strictEqual(emptyArrayLookup.body.count, 0);

    const nullLookup = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({ waybills: null }),
    });
    assert.strictEqual(nullLookup.status, 200);
    assert.strictEqual(nullLookup.body.count, 0);

    const numberLookup = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({ waybills: [123456, null, undefined, ''] }),
    });
    assert.strictEqual(numberLookup.status, 200);
    assert.strictEqual(numberLookup.body.count, 0);

    // Clean up
    await apiRequest('/api/cod-advance/sessions/adv_sess_alpha_01', { method: 'DELETE' });
    await apiRequest('/api/cod-advance/sessions/adv_sess_beta_01', { method: 'DELETE' });
  });

  it('Stress-6: Multi-Day Negative Debt Rollover, Accumulation and Recovery Mechanics', async () => {
    const shopId = 'adv_shop_debt_stress';
    await apiRequest('/api/cod-advance/shops', {
      method: 'POST',
      body: JSON.stringify({
        id: shopId,
        code: 'SHOP_DEBT_STRESS',
        name: 'Shop Thử Nghiệm Công Nợ Cuốn Chiếu',
        pricingPlan: { weightRules: [{ minWeight: 0, maxWeight: 1.0, price: 20000 }] },
      }),
    });

    // Verify initial debt is 0
    let debtCheck = await apiRequest(`/api/cod-advance/shops/${shopId}/current-debt`);
    assert.strictEqual(debtCheck.status, 200);
    assert.strictEqual(debtCheck.body.currentDebt, 0);

    // DAY 1: Return clawback exceeds new orders -> negative payout
    // New: 1 order COD 200k, fee 20k -> net 180k
    // Returns: 2 old orders totaling COD 1,000,000đ
    // Expected: 180k - 1,000k = -820k.
    const day1Session = {
      id: 'adv_sess_debt_day1',
      shopId,
      advanceDate: '2026-10-21',
      newOrders: [
        {
          id: 'ord_d1_1',
          waybill: 'WB_D1_NEW_1',
          weight: 0.5,
          codAmount: 200000,
          appliedFee: 20000,
          netAdvance: 180000,
        },
      ],
      returnedOrders: [
        {
          id: 'ret_d1_1',
          waybill: 'WB_D1_RET_OLD1',
          codAmount: 600000,
          returnFee: 0,
          isFromHistory: false,
        },
        {
          id: 'ret_d1_2',
          waybill: 'WB_D1_RET_OLD2',
          codAmount: 400000,
          returnFee: 0,
          isFromHistory: false,
        },
      ],
      previousDebt: 0,
    };

    const res1 = await apiRequest('/api/cod-advance/sessions', {
      method: 'POST',
      body: JSON.stringify(day1Session),
    });
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body.session.netAdvancePayout, -820000);
    assert.strictEqual(res1.body.session.closingDebt, -820000);
    assert.strictEqual(res1.body.session.payoutStatus, 'NEGATIVE_DEBT');

    // Verify debt endpoint and advance_shops.json reflect -820,000
    debtCheck = await apiRequest(`/api/cod-advance/shops/${shopId}/current-debt`);
    assert.strictEqual(debtCheck.body.currentDebt, -820000);
    let shopsDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_shops.json'), 'utf8'));
    let shopProfile = shopsDisk.find((s: any) => s.id === shopId);
    assert.strictEqual(shopProfile.currentDebt, -820000);

    // DAY 2: Consecutive negative session -> debt compounds
    // Opening debt = -820,000đ
    // New: net 200k - 20k = 180k.
    // Returns: 500k.
    // Formula: 180k - 500k + (-820k) = -1,140,000đ.
    const day2Session = {
      id: 'adv_sess_debt_day2',
      shopId,
      advanceDate: '2026-10-22',
      newOrders: [
        {
          id: 'ord_d2_1',
          waybill: 'WB_D2_NEW_1',
          weight: 0.5,
          codAmount: 200000,
          appliedFee: 20000,
          netAdvance: 180000,
        },
      ],
      returnedOrders: [
        {
          id: 'ret_d2_1',
          waybill: 'WB_D2_RET_1',
          codAmount: 500000,
          returnFee: 0,
          isFromHistory: false,
        },
      ],
      previousDebt: debtCheck.body.currentDebt, // -820,000
    };

    const res2 = await apiRequest('/api/cod-advance/sessions', {
      method: 'POST',
      body: JSON.stringify(day2Session),
    });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.session.previousDebt, -820000);
    assert.strictEqual(res2.body.session.netAdvancePayout, -1140000);
    assert.strictEqual(res2.body.session.closingDebt, -1140000);

    debtCheck = await apiRequest(`/api/cod-advance/shops/${shopId}/current-debt`);
    assert.strictEqual(debtCheck.body.currentDebt, -1140000);

    // DAY 3: Large positive session clears negative debt and yields net positive payout
    // Opening debt = -1,140,000đ
    // New: 10 orders, COD 2,000,000, fee 200,000 -> net 1,800,000đ.
    // Returns: 0.
    // Formula: 1,800,000 - 0 + (-1,140,000) = +660,000đ.
    // Closing debt should reset to 0 (cleared).
    const day3Session = {
      id: 'adv_sess_debt_day3',
      shopId,
      advanceDate: '2026-10-23',
      newOrders: [
        {
          id: 'ord_d3_1',
          waybill: 'WB_D3_NEW_1',
          weight: 0.5,
          codAmount: 2000000,
          appliedFee: 200000,
          netAdvance: 1800000,
        },
      ],
      returnedOrders: [],
      previousDebt: debtCheck.body.currentDebt, // -1,140,000
    };

    const res3 = await apiRequest('/api/cod-advance/sessions', {
      method: 'POST',
      body: JSON.stringify(day3Session),
    });
    assert.strictEqual(res3.status, 200);
    assert.strictEqual(res3.body.session.previousDebt, -1140000);
    assert.strictEqual(res3.body.session.netAdvancePayout, 660000);
    assert.strictEqual(res3.body.session.closingDebt, 0, 'Closing debt must reset to 0 upon positive payout');
    assert.strictEqual(res3.body.session.payoutStatus, 'UNPAID');

    // Verify current-debt endpoint now returns 0
    debtCheck = await apiRequest(`/api/cod-advance/shops/${shopId}/current-debt`);
    assert.strictEqual(debtCheck.body.currentDebt, 0);

    // Verify debt ledger contains all 3 entries with exact chain
    const ledger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_debt_ledger.json'), 'utf8'));
    const shopEntries = ledger.filter((l: any) => l.shopId === shopId);
    assert.strictEqual(shopEntries.length, 3, 'Must have 3 ledger entries');
    assert.strictEqual(shopEntries[0].closingDebt, -820000);
    assert.strictEqual(shopEntries[1].closingDebt, -1140000);
    assert.strictEqual(shopEntries[2].closingDebt, 0);

    // Rollback test: Delete Day 3, debt should revert to Day 2 closing debt (-1,140,000)
    await apiRequest('/api/cod-advance/sessions/adv_sess_debt_day3', { method: 'DELETE' });
    debtCheck = await apiRequest(`/api/cod-advance/shops/${shopId}/current-debt`);
    assert.strictEqual(debtCheck.body.currentDebt, -1140000, 'Rollback Day 3 must restore -1,140,000 debt');

    // Delete Day 2 & Day 1
    await apiRequest('/api/cod-advance/sessions/adv_sess_debt_day2', { method: 'DELETE' });
    debtCheck = await apiRequest(`/api/cod-advance/shops/${shopId}/current-debt`);
    assert.strictEqual(debtCheck.body.currentDebt, -820000, 'Rollback Day 2 must restore -820,000 debt');

    await apiRequest('/api/cod-advance/sessions/adv_sess_debt_day1', { method: 'DELETE' });
    debtCheck = await apiRequest(`/api/cod-advance/shops/${shopId}/current-debt`);
    assert.strictEqual(debtCheck.body.currentDebt, 0, 'Rollback Day 1 must restore 0 debt');
  });

  it('Stress-7: Complete Cleanup and SHA-256 Invariance of Existing Periodic Reconciliation Data', async () => {
    // 1. Clean up test shops from advance_shops.json
    const testShopIds = ['adv_shop_stress_concurrency', 'adv_shop_alpha', 'adv_shop_beta', 'adv_shop_debt_stress'];
    const shopsDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_shops.json'), 'utf8'));
    const filteredShops = shopsDisk.filter((s: any) => !testShopIds.includes(s.id));
    fs.writeFileSync(path.join(DATA_DIR, 'advance_shops.json'), JSON.stringify(filteredShops, null, 2), 'utf8');

    // Clean up debt ledger of any remaining test entries
    const ledgerDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_debt_ledger.json'), 'utf8'));
    const filteredLedger = ledgerDisk.filter((l: any) => !testShopIds.includes(l.shopId));
    fs.writeFileSync(path.join(DATA_DIR, 'advance_debt_ledger.json'), JSON.stringify(filteredLedger, null, 2), 'utf8');

    // 2. Compute final checksums of existing periodic reconciliation files
    for (const f of RECONCILIATION_FILES) {
      const fullPath = path.join(DATA_DIR, f);
      const postHash = getFileSha256(fullPath);
      const preHash = initialChecksums.get(f);

      assert.strictEqual(
        postHash,
        preHash,
        `CRITICAL VIOLATION: Existing reconciliation file ${f} was mutated! Pre-test: ${preHash}, Post-test: ${postHash}`
      );
    }
  });
});
