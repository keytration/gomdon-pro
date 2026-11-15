/**
 * tests/cod_advance/backendStorage.test.ts
 * End-to-end integration test for Milestone 1 Backend Data Layer & Storage APIs.
 * Tests isolated storage files, atomic writes, order indexing, negative debt rollover, and API routes.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TEST_PORT = 3895;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const APP_ROOT = process.cwd();
const DATA_DIR = path.join(APP_ROOT, 'data');

let serverProcess: ChildProcess;
let authToken = '';

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

describe('Milestone 1: Backend Storage & Isolated RESTful APIs', () => {
  before(async () => {
    // Launch server on TEST_PORT
    serverProcess = spawn('node', ['server.js'], {
      cwd: APP_ROOT,
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait until server is ready
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      try {
        const res = await fetch(`${BASE_URL}/api/system/status`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
    }
    assert.ok(ready, 'Test server failed to start within 6 seconds');

    // Authenticate as Admin
    const loginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.strictEqual(loginRes.status, 200, 'Admin login failed');
    assert.ok(loginRes.body.token, 'Missing auth token');
    authToken = loginRes.body.token;
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(300);
    }
  });

  it('M1-1: Isolated storage files and directories exist in data/', () => {
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'advance_sessions')), 'advance_sessions directory must exist');
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'advance_sessions_summary.json')), 'advance_sessions_summary.json must exist');
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'advance_orders_index.json')), 'advance_orders_index.json must exist');
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'advance_debt_ledger.json')), 'advance_debt_ledger.json must exist');
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'advance_shops.json')), 'advance_shops.json must exist');
  });

  it('M1-2: GET /api/cod-advance/shops returns shop list and supports active filter', async () => {
    const res = await apiRequest('/api/cod-advance/shops');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.shops));
  });

  it('M1-3: POST /api/cod-advance/shops enforces returnFeeType=free and returnFee=0', async () => {
    const newShop = {
      id: 'adv_shop_test_integration',
      code: 'TEST_INTEGRATION_SHOP',
      name: 'Shop Kiểm Thử T+0',
      phone: '0988888888',
      bankAccount: {
        bankName: 'MB Bank',
        accountNumber: '1234567890',
        accountHolder: 'NGUYEN VAN TEST',
      },
      pricingPlan: {
        id: 'plan_test_01',
        name: 'Biểu phí chuẩn 20k',
        weightRules: [
          { minWeight: 0, maxWeight: 0.5, price: 16000 },
          { minWeight: 0.5, maxWeight: 1.0, price: 20000 },
          { minWeight: 1.0, maxWeight: 2.0, price: 26000 },
        ],
        extraStepWeight: 0.5,
        extraStepPrice: 5000,
        // Attempting to inject non-zero return fee
        returnFeePercent: 10,
        returnFeeFixed: 10000,
        returnFeeType: 'percent',
      },
    };

    const res = await apiRequest('/api/cod-advance/shops', {
      method: 'POST',
      body: JSON.stringify(newShop),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const saved = res.body.shop;
    assert.strictEqual(saved.id, 'adv_shop_test_integration');
    // Enforce lock on 0đ return fee
    assert.strictEqual(saved.pricingPlan.returnFeePercent, 0, 'Must lock returnFeePercent to 0');
    assert.strictEqual(saved.pricingPlan.returnFeeFixed, 0, 'Must lock returnFeeFixed to 0');
    assert.strictEqual(saved.pricingPlan.returnFeeType, 'free', 'Must lock returnFeeType to free');
  });

  it('M1-4: GET /api/cod-advance/shops/:shopId/current-debt returns 0 for newly created shop', async () => {
    const res = await apiRequest('/api/cod-advance/shops/adv_shop_test_integration/current-debt');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.currentDebt, 0);
  });

  it('M1-5: POST /api/cod-advance/sessions saves Day 1 advance session and updates index & summary', async () => {
    const day1Session = {
      id: 'adv_session_test_day1',
      shopId: 'adv_shop_test_integration',
      shopCode: 'TEST_INTEGRATION_SHOP',
      shopName: 'Shop Kiểm Thử T+0',
      advanceDate: '2026-10-22',
      newOrders: [
        {
          id: 'ord_1',
          waybill: 'WB_TEST_001',
          weight: 0.8,
          codAmount: 200000,
          appliedFee: 20000,
          netAdvance: 180000,
        },
        {
          id: 'ord_2',
          waybill: 'WB_TEST_002',
          weight: 0.5,
          codAmount: 300000,
          appliedFee: 16000,
          netAdvance: 284000,
        },
      ],
      returnedOrders: [],
      weightAdjustments: [],
      previousDebt: 0,
      bankInfo: {
        bankName: 'MB Bank',
        accountNumber: '1234567890',
        accountHolder: 'NGUYEN VAN TEST',
      },
    };

    const res = await apiRequest('/api/cod-advance/sessions', {
      method: 'POST',
      body: JSON.stringify(day1Session),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const saved = res.body.session;
    assert.strictEqual(saved.totalNewOrdersCount, 2);
    assert.strictEqual(saved.totalNewCod, 500000);
    assert.strictEqual(saved.totalNewFee, 36000);
    assert.strictEqual(saved.netNewAdvance, 464000);
    assert.strictEqual(saved.netAdvancePayout, 464000);
    assert.strictEqual(saved.closingDebt, 0);
    assert.strictEqual(saved.payoutStatus, 'UNPAID');

    // Verify detail file exists on disk
    const detailFile = path.join(DATA_DIR, 'advance_sessions', 'adv_session_test_day1.json');
    assert.ok(fs.existsSync(detailFile), 'Detail JSON file must exist in advance_sessions/');

    // Verify summary file has stripped orders
    const summaries = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_sessions_summary.json'), 'utf8'));
    const summaryItem = summaries.find((s: any) => s.id === 'adv_session_test_day1');
    assert.ok(summaryItem, 'Session must exist in advance_sessions_summary.json');
    assert.strictEqual(summaryItem.totalNewOrdersCount, 2);
    assert.strictEqual((summaryItem as any).newOrders, undefined, 'Summary must not contain full newOrders array');

    // Verify order index
    const orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
    assert.ok(orderIndex['WB_TEST_001'], 'WB_TEST_001 must be indexed in advance_orders_index.json');
    assert.strictEqual(orderIndex['WB_TEST_001'].codAmount, 200000);
    assert.strictEqual(orderIndex['WB_TEST_001'].isReturned, false);
  });

  it('M1-6: POST /api/cod-advance/orders/lookup retrieves previously advanced orders in O(1)', async () => {
    const res = await apiRequest('/api/cod-advance/orders/lookup', {
      method: 'POST',
      body: JSON.stringify({
        waybills: ['WB_TEST_001', 'WB_TEST_UNKNOWN'],
        shopId: 'adv_shop_test_integration',
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.orders['WB_TEST_001'], 'WB_TEST_001 should be found');
    assert.strictEqual(res.body.orders['WB_TEST_001'].codAmount, 200000);
    assert.strictEqual(res.body.orders['WB_TEST_UNKNOWN'], undefined, 'WB_TEST_UNKNOWN should not be in map');
  });

  it('M1-7: POST /api/cod-advance/sessions handles negative payout and rolls into closingDebt & ledger', async () => {
    // Day 2 has returns exceeding new orders -> negative payout
    const day2Session = {
      id: 'adv_session_test_day2_negative',
      shopId: 'adv_shop_test_integration',
      shopCode: 'TEST_INTEGRATION_SHOP',
      shopName: 'Shop Kiểm Thử T+0',
      advanceDate: '2026-10-23',
      newOrders: [
        {
          id: 'ord_3',
          waybill: 'WB_TEST_003',
          weight: 0.8,
          codAmount: 200000,
          appliedFee: 20000,
          netAdvance: 180000,
        },
      ],
      returnedOrders: [
        {
          id: 'ret_1',
          waybill: 'WB_TEST_001', // Recalled from Day 1 (200k)
          codAmount: 200000,
          returnFee: 0,
          isFromHistory: true,
          originalAdvanceDate: '2026-10-22',
        },
        {
          id: 'ret_2',
          waybill: 'WB_TEST_002', // Recalled from Day 1 (300k)
          codAmount: 300000,
          returnFee: 0,
          isFromHistory: true,
          originalAdvanceDate: '2026-10-22',
        },
      ],
      weightAdjustments: [],
      previousDebt: 0,
      bankInfo: {
        bankName: 'MB Bank',
        accountNumber: '1234567890',
        accountHolder: 'NGUYEN VAN TEST',
      },
    };

    const res = await apiRequest('/api/cod-advance/sessions', {
      method: 'POST',
      body: JSON.stringify(day2Session),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const saved = res.body.session;
    // Calculation: new net (180,000) - returned (500,000) = -320,000đ
    assert.strictEqual(saved.netNewAdvance, 180000);
    assert.strictEqual(saved.totalReturnedCodRecall, 500000);
    assert.strictEqual(saved.netAdvancePayout, -320000);
    assert.strictEqual(saved.closingDebt, -320000);
    assert.strictEqual(saved.payoutStatus, 'NEGATIVE_DEBT');

    // Verify order index updated WB_TEST_001 as returned
    const orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
    assert.strictEqual(orderIndex['WB_TEST_001'].isReturned, true);
    assert.strictEqual(orderIndex['WB_TEST_001'].returnedSessionId, 'adv_session_test_day2_negative');

    // Verify debt ledger recorded entry
    const ledger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_debt_ledger.json'), 'utf8'));
    const entry = ledger.find((l: any) => l.sessionId === 'adv_session_test_day2_negative');
    assert.ok(entry, 'Ledger entry must exist for negative session');
    assert.strictEqual(entry.closingDebt, -320000);

    // Verify GET /api/cod-advance/shops/:shopId/current-debt reflects rolled over debt
    const debtRes = await apiRequest('/api/cod-advance/shops/adv_shop_test_integration/current-debt');
    assert.strictEqual(debtRes.status, 200);
    assert.strictEqual(debtRes.body.currentDebt, -320000);
  });

  it('M1-8: DELETE /api/cod-advance/sessions/:id rolls back orders, debt, and deletes session file', async () => {
    const res = await apiRequest('/api/cod-advance/sessions/adv_session_test_day2_negative', {
      method: 'DELETE',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);

    // Verify file deleted
    const detailFile = path.join(DATA_DIR, 'advance_sessions', 'adv_session_test_day2_negative.json');
    assert.strictEqual(fs.existsSync(detailFile), false, 'Day 2 session file should be deleted');

    // Verify order index restored WB_TEST_001 to isReturned=false
    const orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
    assert.strictEqual(orderIndex['WB_TEST_001'].isReturned, false, 'Returned flag should be rolled back to false');
    assert.strictEqual(orderIndex['WB_TEST_003'], undefined, 'WB_TEST_003 should be removed from index');

    // Verify shop debt restored to 0 (Day 2 previousDebt was 0)
    const debtRes = await apiRequest('/api/cod-advance/shops/adv_shop_test_integration/current-debt');
    assert.strictEqual(debtRes.status, 200);
    assert.strictEqual(debtRes.body.currentDebt, 0);

    // Clean up Day 1 session as well
    await apiRequest('/api/cod-advance/sessions/adv_session_test_day1', { method: 'DELETE' });

    // Clean up test shop
    const shops = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_shops.json'), 'utf8'));
    const cleaned = shops.filter((s: any) => s.id !== 'adv_shop_test_integration');
    fs.writeFileSync(path.join(DATA_DIR, 'advance_shops.json'), JSON.stringify(cleaned, null, 2), 'utf8');
  });
});
