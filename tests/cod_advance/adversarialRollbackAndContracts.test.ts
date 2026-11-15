/**
 * tests/cod_advance/adversarialRollbackAndContracts.test.ts
 * Challenger 2: Adversarial Verification of Session Rollback, Pricing Enforcement, and Edge Case Lookups.
 * 
 * Verifies:
 * 1. Pricing Plan Enforcement: Locked 0đ return fee under adversarial injection (single, bulk, strings, malformed).
 * 2. Edge Case Lookups: Empty lists, delimiter strings, whitespace, casing, invalid types, tenant isolation, high volume.
 * 3. Session Creation & Rollback: Atomic delete, order index cleanup, return flag reset, unknown return handling,
 *    multi-day negative debt restoration, path traversal resistance, and strict RBAC enforcement.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TEST_PORT = 3896;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const APP_ROOT = process.cwd();
const DATA_DIR = path.join(APP_ROOT, 'data');

let serverProcess: ChildProcess;
let adminToken = '';
let staffToken = '';
let createdStaffUserId = '';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiRequest(endpoint: string, options: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  const activeToken = token !== undefined ? token : adminToken;
  if (activeToken) {
    headers['Authorization'] = `Bearer ${activeToken}`;
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: json };
}

describe('Challenger 2 — Adversarial Stress Suite: Rollback & Contracts', { concurrency: 1 }, () => {
  before(async () => {
    // 1. Launch server on TEST_PORT
    serverProcess = spawn('node', ['server.js'], {
      cwd: APP_ROOT,
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 2. Wait until server is healthy
    let ready = false;
    for (let i = 0; i < 35; i++) {
      await sleep(200);
      try {
        const res = await fetch(`${BASE_URL}/api/system/status`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
    }
    assert.ok(ready, 'Challenger test server failed to start within 7s');

    // 3. Admin login
    const adminLogin = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    }, '');
    assert.strictEqual(adminLogin.status, 200, 'Admin login failed');
    assert.ok(adminLogin.body.token, 'Missing admin token');
    adminToken = adminLogin.body.token;

    // 4. Create a temporary STAFF user to test RBAC boundaries
    const staffUsername = `staff_adv_${Date.now()}`;
    const createStaffRes = await apiRequest('/api/auth/users/create', {
      method: 'POST',
      body: JSON.stringify({
        username: staffUsername,
        password: 'Password123!',
        fullName: 'Staff Test Adversarial',
        role: 'STAFF',
      }),
    });
    assert.strictEqual(createStaffRes.status, 200, 'Failed to create temporary STAFF user');
    createdStaffUserId = createStaffRes.body.user.id;

    // 5. Staff login
    const staffLogin = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: staffUsername, password: 'Password123!', deviceId: 'dev_staff_01' }),
    }, '');
    assert.strictEqual(staffLogin.status, 200, 'Staff login failed');
    staffToken = staffLogin.body.token;
  });

  after(async () => {
    // Cleanup temporary staff user
    if (createdStaffUserId) {
      try {
        await apiRequest('/api/auth/users/delete', {
          method: 'POST',
          body: JSON.stringify({ id: createdStaffUserId }),
        });
      } catch {}
    }

    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(300);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 1: PRICING PLAN ENFORCEMENT (R1, Dispatch Task 2)
  // ══════════════════════════════════════════════════════════════════════════
  describe('Task 2: Pricing Plan Enforcement (0đ Return Fee)', { concurrency: 1 }, () => {
    const rogueShopId = 'adv_shop_rogue_pricing_test';

    it('ADV-PR-1: Single shop creation strictly overrides aggressive non-zero return fees', async () => {
      const rogueShop = {
        id: rogueShopId,
        code: 'ROGUE_SHOP_01',
        name: 'Shop Cố Tình Thu Cước Hoàn',
        pricingPlan: {
          id: 'plan_rogue',
          name: 'Biểu phí lậu',
          weightRules: [{ minWeight: 0, maxWeight: 1, price: 22000 }],
          extraStepWeight: 0.5,
          extraStepPrice: 5000,
          // Malicious injections:
          returnFeePercent: 15,
          returnFeeFixed: 20000,
          returnFeeType: 'custom_fee_type',
        },
      };

      const res = await apiRequest('/api/cod-advance/shops', {
        method: 'POST',
        body: JSON.stringify(rogueShop),
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      const saved = res.body.shop;

      // Assert hard lock to 0đ free return fee
      assert.strictEqual(saved.pricingPlan.returnFeePercent, 0, 'Must lock returnFeePercent to 0');
      assert.strictEqual(saved.pricingPlan.returnFeeFixed, 0, 'Must lock returnFeeFixed to 0');
      assert.strictEqual(saved.pricingPlan.returnFeeType, 'free', 'Must lock returnFeeType to free');

      // Verify directly on disk in advance_shops.json
      const diskShops = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_shops.json'), 'utf8'));
      const onDisk = diskShops.find((s: any) => s.id === rogueShopId);
      assert.ok(onDisk, 'Shop must be saved on disk');
      assert.strictEqual(onDisk.pricingPlan.returnFeePercent, 0);
      assert.strictEqual(onDisk.pricingPlan.returnFeeFixed, 0);
      assert.strictEqual(onDisk.pricingPlan.returnFeeType, 'free');
    });

    it('ADV-PR-2: Bulk shop update enforces returnFeeType=free and 0đ across all entries', async () => {
      const bulkPayload = {
        shops: [
          {
            id: 'adv_bulk_1',
            code: 'BULK_01',
            name: 'Bulk Shop 1',
            pricingPlan: { returnFeePercent: 25, returnFeeFixed: 15000, returnFeeType: 'percent' },
          },
          {
            id: 'adv_bulk_2',
            code: 'BULK_02',
            name: 'Bulk Shop 2',
            pricingPlan: { returnFeePercent: 99, returnFeeFixed: 99000, returnFeeType: 'fixed' },
          },
        ],
      };

      const res = await apiRequest('/api/cod-advance/shops', {
        method: 'POST',
        body: JSON.stringify(bulkPayload),
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Verify every returned shop has 0đ return fee
      for (const s of res.body.shops) {
        assert.strictEqual(s.pricingPlan.returnFeePercent, 0);
        assert.strictEqual(s.pricingPlan.returnFeeFixed, 0);
        assert.strictEqual(s.pricingPlan.returnFeeType, 'free');
      }

      // Cleanup bulk test shops
      const currentShops = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_shops.json'), 'utf8'));
      const filtered = currentShops.filter((s: any) => !s.id.startsWith('adv_bulk_') && s.id !== rogueShopId);
      fs.writeFileSync(path.join(DATA_DIR, 'advance_shops.json'), JSON.stringify(filtered, null, 2), 'utf8');
    });

    it('ADV-PR-3: Shop creation with missing pricingPlan supplies safe default rules and 0đ return fee', async () => {
      const minimalShop = {
        id: 'adv_shop_minimal',
        code: 'MINIMAL_01',
        name: 'Shop Không Có Biểu Phí',
      };

      const res = await apiRequest('/api/cod-advance/shops', {
        method: 'POST',
        body: JSON.stringify(minimalShop),
      });

      assert.strictEqual(res.status, 200);
      const plan = res.body.shop.pricingPlan;
      assert.ok(plan, 'Pricing plan must be auto-generated');
      assert.strictEqual(plan.returnFeePercent, 0);
      assert.strictEqual(plan.returnFeeFixed, 0);
      assert.strictEqual(plan.returnFeeType, 'free');
      assert.ok(Array.isArray(plan.weightRules) && plan.weightRules.length > 0);

      // Cleanup
      const currentShops = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_shops.json'), 'utf8'));
      fs.writeFileSync(path.join(DATA_DIR, 'advance_shops.json'), JSON.stringify(currentShops.filter((s: any) => s.id !== 'adv_shop_minimal'), null, 2), 'utf8');
    });

    it('ADV-PR-4: Shop creation with empty payload returns 400 Bad Request', async () => {
      const res = await apiRequest('/api/cod-advance/shops', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.success, false);
    });

    it('ADV-PR-5: Non-admin (STAFF) is blocked from modifying shop pricing (403 Forbidden)', async () => {
      const res = await apiRequest('/api/cod-advance/shops', {
        method: 'POST',
        body: JSON.stringify({ id: 'adv_unauth_shop', name: 'Unauthorized Shop' }),
      }, staffToken);

      assert.strictEqual(res.status, 403, 'STAFF must be forbidden from managing shop pricing');
      assert.strictEqual(res.body.success, false);
    });

    it('ADV-PR-6: Unauthenticated request to shop pricing is blocked (401 Unauthorized)', async () => {
      const res = await apiRequest('/api/cod-advance/shops', {
        method: 'POST',
        body: JSON.stringify({ id: 'adv_unauth_shop', name: 'Unauthorized Shop' }),
      }, '');

      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 2: EDGE CASE LOOKUPS (Dispatch Task 3)
  // ══════════════════════════════════════════════════════════════════════════
  describe('Task 3: Edge Case Lookups (POST /api/cod-advance/orders/lookup)', { concurrency: 1 }, () => {
    const shopA = 'adv_shop_lookup_a';
    const shopB = 'adv_shop_lookup_b';

    before(async () => {
      // Seed index with known orders for shop A and shop B
      const testIndex = {
        'WB_ALPHA_001': {
          waybill: 'WB_ALPHA_001',
          shopId: shopA,
          shopCode: 'SHOP_A',
          advanceSessionId: 'adv_sess_alpha',
          advanceDate: '2026-10-20',
          weight: 0.5,
          appliedFee: 16000,
          codAmount: 500000,
          isReturned: false,
        },
        'WB_ALPHA_002': {
          waybill: 'WB_ALPHA_002',
          shopId: shopA,
          shopCode: 'SHOP_A',
          advanceSessionId: 'adv_sess_alpha',
          advanceDate: '2026-10-20',
          weight: 1.2,
          appliedFee: 26000,
          codAmount: 750000,
          isReturned: true,
        },
        'WB_BETA_001': {
          waybill: 'WB_BETA_001',
          shopId: shopB,
          shopCode: 'SHOP_B',
          advanceSessionId: 'adv_sess_beta',
          advanceDate: '2026-10-21',
          weight: 0.8,
          appliedFee: 20000,
          codAmount: 320000,
          isReturned: false,
        },
      };

      const existingIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      fs.writeFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), JSON.stringify({ ...existingIndex, ...testIndex }, null, 2), 'utf8');
    });

    after(async () => {
      // Clean seeded index
      const existingIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      delete existingIndex['WB_ALPHA_001'];
      delete existingIndex['WB_ALPHA_002'];
      delete existingIndex['WB_BETA_001'];
      fs.writeFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), JSON.stringify(existingIndex, null, 2), 'utf8');
    });

    it('ADV-LK-1: Empty waybills array returns success with count 0 and empty orders object', async () => {
      const res = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify({ waybills: [] }),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.count, 0);
      assert.deepStrictEqual(res.body.orders, {});
    });

    it('ADV-LK-2: Missing waybills property or empty body defaults safely to count 0', async () => {
      const res = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.count, 0);
    });

    it('ADV-LK-3: String delimiter parsing handles comma, semicolon, newline, and carriage return', async () => {
      const stringPayload = {
        waybills: 'WB_ALPHA_001, WB_BETA_001;\nWB_ALPHA_002\r\nWB_NOT_EXIST',
      };
      const res = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify(stringPayload),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.count, 3);
      assert.ok(res.body.orders['WB_ALPHA_001']);
      assert.ok(res.body.orders['WB_BETA_001']);
      assert.ok(res.body.orders['WB_ALPHA_002']);
      assert.strictEqual(res.body.orders['WB_NOT_EXIST'], undefined);
    });

    it('ADV-LK-4: Case sensitivity & whitespace trimming normalizes lowercase with whitespace', async () => {
      const res = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify({
          waybills: ['  wb_alpha_001  ', '\twb_beta_001\n'],
        }),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.count, 2);
      assert.ok(res.body.orders['WB_ALPHA_001'], 'Should match normalized uppercase WB_ALPHA_001');
      assert.ok(res.body.orders['WB_BETA_001'], 'Should match normalized uppercase WB_BETA_001');
    });

    it('ADV-LK-5: Malformed elements in waybills array do not cause crash or 500 error', async () => {
      const res = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify({
          waybills: [null, undefined, '', '   ', 12345, false, {}, []],
        }),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      // Non-existent waybill elements should yield count 0 without crashing
      assert.strictEqual(res.body.count, 0);
    });

    it('ADV-LK-6: Strict tenant isolation when shopId is provided', async () => {
      // Lookup WB_ALPHA_001 (Shop A) but specify shopId = shopB
      const resForbiddenTenant = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify({
          waybills: ['WB_ALPHA_001'],
          shopId: shopB,
        }),
      });
      assert.strictEqual(resForbiddenTenant.status, 200);
      assert.strictEqual(resForbiddenTenant.body.count, 0, 'Shop B must not see Shop A order');
      assert.strictEqual(resForbiddenTenant.body.orders['WB_ALPHA_001'], undefined);

      // Lookup with correct shopId = shopA
      const resValidTenant = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify({
          waybills: ['WB_ALPHA_001', 'WB_BETA_001'],
          shopId: shopA,
        }),
      });
      assert.strictEqual(resValidTenant.status, 200);
      assert.strictEqual(resValidTenant.body.count, 1, 'Only Shop A orders returned');
      assert.ok(resValidTenant.body.orders['WB_ALPHA_001']);
      assert.strictEqual(resValidTenant.body.orders['WB_BETA_001'], undefined);
    });

    it('ADV-LK-7: M1 ↔ M2 contract dual compatibility: orders accessible at top-level and in .orders', async () => {
      const res = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify({ waybills: ['WB_ALPHA_001'] }),
      });
      assert.strictEqual(res.status, 200);
      // Dual compatibility check:
      assert.ok(res.body.orders['WB_ALPHA_001'], 'Accessible via res.body.orders[wb]');
      assert.ok(res.body['WB_ALPHA_001'], 'Accessible via res.body[wb] for PROJECT.md contract');
      assert.strictEqual(res.body.orders['WB_ALPHA_001'].codAmount, 500000);
    });

    it('ADV-LK-8: High-volume batch stress test (2,000 lookups) executes in < 100ms', async () => {
      const largeBatch: string[] = [];
      for (let i = 0; i < 2000; i++) {
        largeBatch.push(`WB_DUMMY_${i}`);
      }
      // Inject our valid waybill in the middle
      largeBatch[1000] = 'WB_ALPHA_001';

      const startTime = Date.now();
      const res = await apiRequest('/api/cod-advance/orders/lookup', {
        method: 'POST',
        body: JSON.stringify({ waybills: largeBatch }),
      });
      const durationMs = Date.now() - startTime;

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.count, 1);
      assert.ok(res.body.orders['WB_ALPHA_001']);
      assert.ok(durationMs < 100, `2000-item lookup took ${durationMs}ms, must be < 100ms`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SUITE 3: SESSION CREATION & ROLLBACK ON DELETE (Dispatch Task 1)
  // ══════════════════════════════════════════════════════════════════════════
  describe('Task 1: Session Creation and Rollback on Delete', { concurrency: 1 }, () => {
    const testShopId = 'adv_shop_rollback_test';
    const session1Id = 'adv_sess_rollback_s1';
    const session2Id = 'adv_sess_rollback_s2';

    before(async () => {
      // Create a test shop
      await apiRequest('/api/cod-advance/shops', {
        method: 'POST',
        body: JSON.stringify({
          id: testShopId,
          code: 'ROLLBACK_SHOP',
          name: 'Shop Kiểm Thử Hoàn Tác',
          currentDebt: 0,
        }),
      });
    });

    after(async () => {
      // Clean up test shop
      const currentShops = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_shops.json'), 'utf8'));
      fs.writeFileSync(path.join(DATA_DIR, 'advance_shops.json'), JSON.stringify(currentShops.filter((s: any) => s.id !== testShopId), null, 2), 'utf8');
    });

    it('ADV-RB-1: Full atomic session creation followed by clean DELETE rollback', async () => {
      const s1 = {
        id: session1Id,
        shopId: testShopId,
        shopCode: 'ROLLBACK_SHOP',
        advanceDate: '2026-10-22',
        newOrders: [
          { waybill: 'WB_RB_101', weight: 0.5, codAmount: 200000, appliedFee: 16000, netAdvance: 184000 },
          { waybill: 'WB_RB_102', weight: 1.0, codAmount: 300000, appliedFee: 20000, netAdvance: 280000 },
        ],
        returnedOrders: [],
        weightAdjustments: [],
        previousDebt: 0,
      };

      // 1. Create Session S1
      const createRes = await apiRequest('/api/cod-advance/sessions', {
        method: 'POST',
        body: JSON.stringify(s1),
      });
      assert.strictEqual(createRes.status, 200);

      // Verify files created
      const sessionFile = path.join(DATA_DIR, 'advance_sessions', `${session1Id}.json`);
      assert.ok(fs.existsSync(sessionFile), 'Session detail file must exist');

      const summariesBefore = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_sessions_summary.json'), 'utf8'));
      assert.ok(summariesBefore.some((s: any) => s.id === session1Id), 'Session must appear in summary');

      const indexBefore = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      assert.ok(indexBefore['WB_RB_101'], 'WB_RB_101 must be indexed');
      assert.ok(indexBefore['WB_RB_102'], 'WB_RB_102 must be indexed');

      // 2. Delete Session S1 via DELETE
      const deleteRes = await apiRequest(`/api/cod-advance/sessions/${session1Id}`, {
        method: 'DELETE',
      });
      assert.strictEqual(deleteRes.status, 200);
      assert.strictEqual(deleteRes.body.success, true);

      // 3. Verify Rollback Integrity
      assert.strictEqual(fs.existsSync(sessionFile), false, 'Session detail file must be deleted');

      const summariesAfter = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_sessions_summary.json'), 'utf8'));
      assert.strictEqual(summariesAfter.some((s: any) => s.id === session1Id), false, 'Session must be removed from summary');

      const indexAfter = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      assert.strictEqual(indexAfter['WB_RB_101'], undefined, 'WB_RB_101 must be un-indexed');
      assert.strictEqual(indexAfter['WB_RB_102'], undefined, 'WB_RB_102 must be un-indexed');
    });

    it('ADV-RB-2: Deletion via POST alias /api/cod-advance/sessions/:id/delete works identically', async () => {
      const aliasSessionId = 'adv_sess_alias_delete';
      await apiRequest('/api/cod-advance/sessions', {
        method: 'POST',
        body: JSON.stringify({
          id: aliasSessionId,
          shopId: testShopId,
          advanceDate: '2026-10-22',
          newOrders: [{ waybill: 'WB_ALIAS_01', weight: 0.5, codAmount: 100000, appliedFee: 16000 }],
        }),
      });

      const res = await apiRequest(`/api/cod-advance/sessions/${aliasSessionId}/delete`, {
        method: 'POST',
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      const sessionFile = path.join(DATA_DIR, 'advance_sessions', `${aliasSessionId}.json`);
      assert.strictEqual(fs.existsSync(sessionFile), false);
    });

    it('ADV-RB-3: Rollback properly clears returned flags on orders advanced in previous sessions', async () => {
      // Step 1: Create Session 1 with order WB_RB_CYCLE
      const s1 = {
        id: 'adv_sess_cycle_1',
        shopId: testShopId,
        advanceDate: '2026-10-21',
        newOrders: [
          { waybill: 'WB_RB_CYCLE', weight: 0.5, codAmount: 400000, appliedFee: 16000, netAdvance: 384000 },
        ],
      };
      await apiRequest('/api/cod-advance/sessions', { method: 'POST', body: JSON.stringify(s1) });

      // Check WB_RB_CYCLE is indexed and isReturned = false
      let orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      assert.strictEqual(orderIndex['WB_RB_CYCLE'].isReturned, false);

      // Step 2: Create Session 2 which claws back WB_RB_CYCLE as returned
      const s2 = {
        id: 'adv_sess_cycle_2',
        shopId: testShopId,
        advanceDate: '2026-10-22',
        newOrders: [],
        returnedOrders: [
          { waybill: 'WB_RB_CYCLE', codAmount: 400000, returnFee: 0, isFromHistory: true },
        ],
      };
      const s2Res = await apiRequest('/api/cod-advance/sessions', { method: 'POST', body: JSON.stringify(s2) });
      assert.strictEqual(s2Res.status, 200, `Session 2 creation failed: ${JSON.stringify(s2Res.body)}`);

      // Check WB_RB_CYCLE is marked isReturned = true
      orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      assert.strictEqual(orderIndex['WB_RB_CYCLE'].isReturned, true);
      assert.strictEqual(orderIndex['WB_RB_CYCLE'].returnedSessionId, 'adv_sess_cycle_2');

      // Step 3: Delete Session 2 (Rollback Session 2)
      const delRes = await apiRequest('/api/cod-advance/sessions/adv_sess_cycle_2', { method: 'DELETE' });
      assert.strictEqual(delRes.status, 200);

      // Verify WB_RB_CYCLE is reverted to isReturned = false and advanceSessionId preserved
      orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      assert.ok(orderIndex['WB_RB_CYCLE'], 'Order must still exist in index from Session 1');
      assert.strictEqual(orderIndex['WB_RB_CYCLE'].isReturned, false, 'isReturned flag must be restored to false');
      assert.strictEqual(orderIndex['WB_RB_CYCLE'].advanceSessionId, 'adv_sess_cycle_1', 'Original advanceSessionId must be intact');
      assert.strictEqual(orderIndex['WB_RB_CYCLE'].returnedSessionId, undefined, 'returnedSessionId must be removed');

      // Clean up Session 1
      await apiRequest('/api/cod-advance/sessions/adv_sess_cycle_1', { method: 'DELETE' });
    });

    it('ADV-RB-4: Empirical test of unknown return order deletion behavior', async () => {
      // Session with a return order that was NOT in history
      const sUnk = {
        id: 'adv_sess_unknown_return',
        shopId: testShopId,
        advanceDate: '2026-10-22',
        newOrders: [],
        returnedOrders: [
          { waybill: 'WB_UNKNOWN_GHOST', codAmount: 350000, returnFee: 0, isFromHistory: false },
        ],
      };

      await apiRequest('/api/cod-advance/sessions', { method: 'POST', body: JSON.stringify(sUnk) });

      let orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      assert.ok(orderIndex['WB_UNKNOWN_GHOST'], 'Index should track WB_UNKNOWN_GHOST');
      assert.strictEqual(orderIndex['WB_UNKNOWN_GHOST'].advanceSessionId, '');

      // Delete the session
      await apiRequest('/api/cod-advance/sessions/adv_sess_unknown_return', { method: 'DELETE' });

      orderIndex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), 'utf8'));
      // Note the observed behavior for empirical documentation:
      const ghostRecord = orderIndex['WB_UNKNOWN_GHOST'];
      // Cleanup ghost order if left
      if (ghostRecord) {
        delete orderIndex['WB_UNKNOWN_GHOST'];
        fs.writeFileSync(path.join(DATA_DIR, 'advance_orders_index.json'), JSON.stringify(orderIndex, null, 2), 'utf8');
      }
    });

    it('ADV-RB-5: Multi-session negative debt compounding and LIFO rollback restoration', async () => {
      // Initial debt is 0
      const debt0 = await apiRequest(`/api/cod-advance/shops/${testShopId}/current-debt`);
      assert.strictEqual(debt0.body.currentDebt, 0);

      // Session A: net payout is -250,000đ -> closingDebt = -250,000đ
      const sessA = {
        id: 'adv_sess_debt_a',
        shopId: testShopId,
        advanceDate: '2026-10-21',
        newOrders: [{ waybill: 'WB_DA_1', weight: 0.5, codAmount: 100000, appliedFee: 20000, netAdvance: 80000 }],
        returnedOrders: [{ waybill: 'WB_DA_RET', codAmount: 330000 }], // 80k - 330k = -250k
        previousDebt: 0,
      };
      await apiRequest('/api/cod-advance/sessions', { method: 'POST', body: JSON.stringify(sessA) });

      const debtA = await apiRequest(`/api/cod-advance/shops/${testShopId}/current-debt`);
      assert.strictEqual(debtA.body.currentDebt, -250000);

      // Session B: carries previousDebt = -250,000đ and adds another -150,000đ -> closingDebt = -400,000đ
      const sessB = {
        id: 'adv_sess_debt_b',
        shopId: testShopId,
        advanceDate: '2026-10-22',
        newOrders: [{ waybill: 'WB_DB_1', weight: 0.5, codAmount: 50000, appliedFee: 20000, netAdvance: 30000 }],
        returnedOrders: [{ waybill: 'WB_DB_RET', codAmount: 180000 }], // 30k - 180k = -150k + (-250k) = -400k
        previousDebt: -250000,
      };
      await apiRequest('/api/cod-advance/sessions', { method: 'POST', body: JSON.stringify(sessB) });

      const debtB = await apiRequest(`/api/cod-advance/shops/${testShopId}/current-debt`);
      assert.strictEqual(debtB.body.currentDebt, -400000);

      // Verify advance_debt_ledger.json has both entries
      const ledger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_debt_ledger.json'), 'utf8'));
      assert.ok(ledger.some((l: any) => l.sessionId === 'adv_sess_debt_b'));

      // Rollback Session B: shop debt should revert to Session B's previousDebt (-250,000đ)
      const delB = await apiRequest('/api/cod-advance/sessions/adv_sess_debt_b', { method: 'DELETE' });
      assert.strictEqual(delB.status, 200);

      const debtAfterB = await apiRequest(`/api/cod-advance/shops/${testShopId}/current-debt`);
      assert.strictEqual(debtAfterB.body.currentDebt, -250000, 'Shop debt must revert to -250,000đ after deleting Session B');

      // Verify Session B entry removed from ledger
      const ledgerAfterB = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'advance_debt_ledger.json'), 'utf8'));
      assert.strictEqual(ledgerAfterB.some((l: any) => l.sessionId === 'adv_sess_debt_b'), false, 'Ledger entry for Session B must be removed');

      // Rollback Session A: shop debt should revert to 0
      const delA = await apiRequest('/api/cod-advance/sessions/adv_sess_debt_a', { method: 'DELETE' });
      assert.strictEqual(delA.status, 200);

      const debtAfterA = await apiRequest(`/api/cod-advance/shops/${testShopId}/current-debt`);
      assert.strictEqual(debtAfterA.body.currentDebt, 0, 'Shop debt must revert to 0 after deleting Session A');
    });

    it('ADV-RB-6: Path traversal in DELETE endpoint is sanitized and rejected with 404', async () => {
      // Attempt to delete advance_shops.json using traversal
      const res = await apiRequest('/api/cod-advance/sessions/..%2F..%2Fadvance_shops', {
        method: 'DELETE',
      });
      assert.strictEqual(res.status, 404);
      // Ensure advance_shops.json still exists and was not touched
      assert.ok(fs.existsSync(path.join(DATA_DIR, 'advance_shops.json')));
    });

    it('ADV-RB-7: Deletion of non-existent session ID cleanly returns 404', async () => {
      const res = await apiRequest('/api/cod-advance/sessions/adv_sess_does_not_exist_9999', {
        method: 'DELETE',
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error);
    });

    it('ADV-RB-8: Strict RBAC on DELETE: Unauthenticated is 401, STAFF is 403, ADMIN is 200', async () => {
      // 1. Create a dummy session as ADMIN
      const dummyId = 'adv_sess_rbac_test';
      await apiRequest('/api/cod-advance/sessions', {
        method: 'POST',
        body: JSON.stringify({ id: dummyId, shopId: testShopId, advanceDate: '2026-10-22', newOrders: [] }),
      });

      // 2. Unauthenticated attempt -> 401
      const unauthRes = await apiRequest(`/api/cod-advance/sessions/${dummyId}`, { method: 'DELETE' }, '');
      assert.strictEqual(unauthRes.status, 401);

      // 3. STAFF attempt -> 403 Forbidden
      const staffRes = await apiRequest(`/api/cod-advance/sessions/${dummyId}`, { method: 'DELETE' }, staffToken);
      assert.strictEqual(staffRes.status, 403, 'STAFF must NOT have permission to delete/rollback advance session');

      // 4. ADMIN attempt -> 200 OK
      const adminRes = await apiRequest(`/api/cod-advance/sessions/${dummyId}`, { method: 'DELETE' });
      assert.strictEqual(adminRes.status, 200, 'ADMIN must be allowed to delete/rollback advance session');
    });

    it('ADV-RB-9: Empty/malformed session deletion handles empty order arrays safely', async () => {
      const emptySessId = 'adv_sess_empty_arrays';
      await apiRequest('/api/cod-advance/sessions', {
        method: 'POST',
        body: JSON.stringify({
          id: emptySessId,
          shopId: testShopId,
          advanceDate: '2026-10-22',
          newOrders: [],
          returnedOrders: [],
          weightAdjustments: [],
        }),
      });

      const res = await apiRequest(`/api/cod-advance/sessions/${emptySessId}`, { method: 'DELETE' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });
  });
});
