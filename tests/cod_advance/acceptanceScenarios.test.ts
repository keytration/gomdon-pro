/**
 * tests/cod_advance/acceptanceScenarios.test.ts
 * Tier 3 (Pairwise Combinations) & Tier 4 (Real-World Acceptance Scenarios)
 * Validates Day 1 (18M), Day 2 (16M), History lookup vs Excel fallback, Negative rollover, and multi-day ledger rolling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateWeightFee,
  processOutboundOrders,
  processReturnOrders,
  processCarrierWeightDiscrepancies,
  computeDailySettlement,
  generateVietQrUrl,
  type AdvancePricingPlan,
  type NewOrderRow,
  type ReturnOrderRow,
  type HistoricalOrderRecord,
  type BankAccountInfo,
} from './mathEngine.ts';

// Standard acceptance pricing plan per ORIGINAL_REQUEST.md
// Base rule: 0.8kg has fee 20,000đ
const shopPlan: AdvancePricingPlan = {
  weightRules: [
    { minWeight: 0, maxWeight: 0.5, price: 16000 },
    { minWeight: 0.5, maxWeight: 1.0, price: 20000 },
    { minWeight: 1.0, maxWeight: 2.0, price: 26000 },
  ],
  extraStepWeight: 0.5,
  extraStepPrice: 5000,
  returnFeeType: 'free',
  returnFeePercent: 0,
};

const shopBank: BankAccountInfo = {
  bankCode: '970422', // MB Bank
  accountNumber: '0987654321',
  accountHolder: 'NGUYEN VAN A',
};

// =========================================================================
// TIER 4: REAL-WORLD ACCEPTANCE SCENARIOS (ORIGINAL_REQUEST.md §Acceptance Criteria)
// =========================================================================

describe('Tier 4: Acceptance Scenario 1 — Day 1 Standard Advance (18,000,000đ)', () => {
  it('S1: 100 new orders with 200k COD and 20k fee yields exactly 18,000,000đ net payout', () => {
    // 100 orders: COD 200,000đ, weight 0.8kg (matches 0.5-1.0kg tier -> 20,000đ fee)
    const day1Orders: NewOrderRow[] = Array.from({ length: 100 }, (_, i) => ({
      waybill: `D1_WAYBILL_${String(i + 1).padStart(3, '0')}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));

    // Step 1: Outbound processing
    const outboundResult = processOutboundOrders(day1Orders, shopPlan);
    assert.strictEqual(outboundResult.orders.length, 100);
    assert.strictEqual(outboundResult.totalNewCod, 20000000); // 20,000,000đ
    assert.strictEqual(outboundResult.totalNewFee, 2000000);  // 2,000,000đ
    assert.strictEqual(outboundResult.netNewAdvance, 18000000); // 18,000,000đ

    // Step 2: No returns on Day 1
    const returnResult = processReturnOrders([], {});
    assert.strictEqual(returnResult.totalReturnedCodRecall, 0);
    assert.strictEqual(returnResult.totalReturnFee, 0);

    // Step 3: No carrier discrepancy on Day 1
    const discrepancyResult = processCarrierWeightDiscrepancies([], shopPlan, 0);
    assert.strictEqual(discrepancyResult.totalWeightAdjustment, 0);

    // Step 4: Settlement computation (previousDebt = 0)
    const settlement = computeDailySettlement({
      netNewAdvance: outboundResult.netNewAdvance,
      totalReturnedCodRecall: returnResult.totalReturnedCodRecall,
      totalWeightAdjustment: discrepancyResult.totalWeightAdjustment,
      previousDebt: 0,
    });

    // Verification against Acceptance Criteria
    assert.strictEqual(settlement.rawSettlement, 18000000);
    assert.strictEqual(settlement.netAdvancePayout, 18000000); // EXACT 18,000,000đ
    assert.strictEqual(settlement.closingDebt, 0);
    assert.strictEqual(settlement.isNegativeDebt, false);

    // Step 5: VietQR is generated for 18,000,000đ
    const qrUrl = generateVietQrUrl(shopBank, settlement.netAdvancePayout, 'UNG COD SHOP01 22.10.2026');
    assert.ok(qrUrl !== null);
    assert.ok(qrUrl.includes('amount=18000000'));
    assert.ok(qrUrl.includes('970422-0987654321-compact2.png'));
  });
});

describe('Tier 4: Acceptance Scenario 2 — Day 2 Standard Advance with 10 Returns (16,000,000đ)', () => {
  it('S2: 100 new orders + 10 returns previously advanced yields exactly 16,000,000đ net payout', () => {
    // Build Day 1 historical waybill index (simulating database storage)
    const historyDb: Record<string, HistoricalOrderRecord> = {};
    for (let i = 1; i <= 100; i++) {
      const waybill = `D1_WAYBILL_${String(i).padStart(3, '0')}`;
      historyDb[waybill] = {
        waybill,
        codAmount: 200000,
        advanceSessionId: 'SESSION_DAY_1',
        advanceDate: '2026-10-21',
      };
    }

    // Day 2 Outbound: 100 new orders (COD 200k, fee 20k)
    const day2Orders: NewOrderRow[] = Array.from({ length: 100 }, (_, i) => ({
      waybill: `D2_WAYBILL_${String(i + 1).padStart(3, '0')}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const outboundResult = processOutboundOrders(day2Orders, shopPlan);
    assert.strictEqual(outboundResult.totalNewCod, 20000000);
    assert.strictEqual(outboundResult.totalNewFee, 2000000);
    assert.strictEqual(outboundResult.netNewAdvance, 18000000);

    // Day 2 Returns: 10 returned orders from Day 1
    const day2Returns: ReturnOrderRow[] = Array.from({ length: 10 }, (_, i) => ({
      waybill: `D1_WAYBILL_${String(i + 1).padStart(3, '0')}`,
    }));
    const returnResult = processReturnOrders(day2Returns, historyDb);

    // Assertions on returns
    assert.strictEqual(returnResult.orders.length, 10);
    assert.strictEqual(returnResult.totalReturnedCodRecall, 2000000); // 10 * 200,000đ = 2,000,000đ
    assert.strictEqual(returnResult.totalReturnFee, 0); // Strictly 0đ
    returnResult.orders.forEach((r) => {
      assert.strictEqual(r.recoveredCod, 200000);
      assert.strictEqual(r.returnFee, 0);
      assert.strictEqual(r.lookupSource, 'history');
      assert.strictEqual(r.historySessionId, 'SESSION_DAY_1');
    });

    // Settlement computation (Day 1 was paid, previousDebt = 0)
    const settlement = computeDailySettlement({
      netNewAdvance: outboundResult.netNewAdvance,        // 18,000,000
      totalReturnedCodRecall: returnResult.totalReturnedCodRecall, // 2,000,000
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });

    // Verification against Acceptance Criteria
    assert.strictEqual(settlement.rawSettlement, 16000000);
    assert.strictEqual(settlement.netAdvancePayout, 16000000); // EXACT 16,000,000đ
    assert.strictEqual(settlement.closingDebt, 0);
    assert.strictEqual(settlement.isNegativeDebt, false);

    // VietQR is generated for 16,000,000đ
    const qrUrl = generateVietQrUrl(shopBank, settlement.netAdvancePayout, 'UNG COD SHOP01 23.10.2026');
    assert.ok(qrUrl !== null);
    assert.ok(qrUrl.includes('amount=16000000'));
  });
});

describe('Tier 4: Acceptance Scenario 3 — History Lookup vs Excel Fallback', () => {
  it('S3: accurately resolves mixed returns between historical records and Excel column fallback', () => {
    // Historical database contains only WB_HIST_01 (200k) and WB_HIST_02 (300k)
    const historyDb: Record<string, HistoricalOrderRecord> = {
      WB_HIST_01: { waybill: 'WB_HIST_01', codAmount: 200000, advanceDate: '2026-10-20' },
      WB_HIST_02: { waybill: 'WB_HIST_02', codAmount: 300000, advanceDate: '2026-10-20' },
    };

    // Return file contains 4 orders: 2 historical, 2 external/new
    const returnRows: ReturnOrderRow[] = [
      { waybill: 'WB_HIST_01', codAmount: 999999 }, // Should ignore 999k and use 200k
      { waybill: 'WB_HIST_02' },                    // Should use 300k
      { waybill: 'WB_NEW_EXT_01', codAmount: 150000 }, // External: should use 150k
      { waybill: 'WB_NEW_EXT_02', codAmount: 250000 }, // External: should use 250k
    ];

    const result = processReturnOrders(returnRows, historyDb);

    // Order 1: Historical
    assert.strictEqual(result.orders[0].waybill, 'WB_HIST_01');
    assert.strictEqual(result.orders[0].recoveredCod, 200000);
    assert.strictEqual(result.orders[0].lookupSource, 'history');
    assert.strictEqual(result.orders[0].returnFee, 0);

    // Order 2: Historical
    assert.strictEqual(result.orders[1].waybill, 'WB_HIST_02');
    assert.strictEqual(result.orders[1].recoveredCod, 300000);
    assert.strictEqual(result.orders[1].lookupSource, 'history');
    assert.strictEqual(result.orders[1].returnFee, 0);

    // Order 3: External Excel Fallback
    assert.strictEqual(result.orders[2].waybill, 'WB_NEW_EXT_01');
    assert.strictEqual(result.orders[2].recoveredCod, 150000);
    assert.strictEqual(result.orders[2].lookupSource, 'excel');
    assert.strictEqual(result.orders[2].returnFee, 0);

    // Order 4: External Excel Fallback
    assert.strictEqual(result.orders[3].waybill, 'WB_NEW_EXT_02');
    assert.strictEqual(result.orders[3].recoveredCod, 250000);
    assert.strictEqual(result.orders[3].lookupSource, 'excel');
    assert.strictEqual(result.orders[3].returnFee, 0);

    // Total clawback: 200k + 300k + 150k + 250k = 900,000đ
    assert.strictEqual(result.totalReturnedCodRecall, 900000);
    assert.strictEqual(result.totalReturnFee, 0);
  });
});

describe('Tier 4: Acceptance Scenario 4 — Negative Rollover & Automatic Deduction Next Session', () => {
  it('S4: Day 3 negative result (-2,000,000đ) rolls into Day 4 opening debt and is automatically deducted', () => {
    // --- DAY 3: Negative Settlement ---
    // Outbound: 10 orders (COD 200k, fee 20k) -> net advance = 1,800,000đ
    const day3Orders: NewOrderRow[] = Array.from({ length: 10 }, (_, i) => ({
      waybill: `D3_OUT_${i}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const day3Outbound = processOutboundOrders(day3Orders, shopPlan);
    assert.strictEqual(day3Outbound.netNewAdvance, 1800000);

    // Returns: 19 orders (each 200k) -> total clawback = 3,800,000đ
    const day3Returns: ReturnOrderRow[] = Array.from({ length: 19 }, (_, i) => ({
      waybill: `D3_RET_${i}`,
      codAmount: 200000,
    }));
    const day3ReturnResult = processReturnOrders(day3Returns, {});
    assert.strictEqual(day3ReturnResult.totalReturnedCodRecall, 3800000);

    // Day 3 Settlement: 1,800,000 - 3,800,000 = -2,000,000đ
    const day3Settlement = computeDailySettlement({
      netNewAdvance: day3Outbound.netNewAdvance,
      totalReturnedCodRecall: day3ReturnResult.totalReturnedCodRecall,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });

    assert.strictEqual(day3Settlement.rawSettlement, -2000000);
    assert.strictEqual(day3Settlement.netAdvancePayout, 0); // No money paid to shop
    assert.strictEqual(day3Settlement.closingDebt, -2000000); // 2M debt recorded
    assert.strictEqual(day3Settlement.isNegativeDebt, true);

    // VietQR is suppressed when in debt
    const day3Qr = generateVietQrUrl(shopBank, day3Settlement.netAdvancePayout, 'UNG COD DAY 3');
    assert.strictEqual(day3Qr, null);

    // --- DAY 4: Rollover into Next Session ---
    // Opening debt = Day 3 closing debt (-2,000,000đ)
    const day4OpeningDebt = day3Settlement.closingDebt;
    assert.strictEqual(day4OpeningDebt, -2000000);

    // Day 4 Outbound: 100 orders with 200k COD and 20k fee -> net advance = 18,000,000đ
    const day4Orders: NewOrderRow[] = Array.from({ length: 100 }, (_, i) => ({
      waybill: `D4_OUT_${i}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const day4Outbound = processOutboundOrders(day4Orders, shopPlan);
    assert.strictEqual(day4Outbound.netNewAdvance, 18000000);

    // Day 4 Settlement with -2M debt: 18,000,000 + (-2,000,000) = 16,000,000đ
    const day4Settlement = computeDailySettlement({
      netNewAdvance: day4Outbound.netNewAdvance,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: day4OpeningDebt,
    });

    assert.strictEqual(day4Settlement.rawSettlement, 16000000);
    assert.strictEqual(day4Settlement.netAdvancePayout, 16000000); // Successfully deducted 2M debt!
    assert.strictEqual(day4Settlement.closingDebt, 0); // Debt cleared
    assert.strictEqual(day4Settlement.isNegativeDebt, false);

    // VietQR for Day 4 generated for 16,000,000đ
    const day4Qr = generateVietQrUrl(shopBank, day4Settlement.netAdvancePayout, 'UNG COD DAY 4');
    assert.ok(day4Qr !== null);
    assert.ok(day4Qr.includes('amount=16000000'));
  });
});

describe('Tier 4: Acceptance Scenario 5 — Carrier Discrepancy & Manual Surcharge Integration', () => {
  it('S5: combines file-based carrier overweight and manual adjustments into daily settlement', () => {
    // Outbound: 20 orders with COD 300,000đ and weight 0.5kg (fee 16,000đ)
    // netAdvance = 20 * (300k - 16k) = 20 * 284,000 = 5,680,000đ
    const orders: NewOrderRow[] = Array.from({ length: 20 }, (_, i) => ({
      waybill: `NVC_ORD_${i}`,
      rawWeight: 0.5,
      codAmount: 300000,
    }));
    const outbound = processOutboundOrders(orders, shopPlan);
    assert.strictEqual(outbound.netNewAdvance, 5680000);

    // Carrier reconciliation file: 4 orders are overweight
    // 2 orders: prov 0.5kg (16k) -> actual 0.8kg (20k) -> +4,000 each = +8,000
    // 2 orders: prov 0.5kg (16k) -> actual 1.5kg (26k) -> +10,000 each = +20,000
    // Discrepancy from file = 28,000đ
    const carrierRows = [
      { waybill: 'NVC_ORD_0', provWeight: 0.5, actualWeight: 0.8 },
      { waybill: 'NVC_ORD_1', provWeight: 0.5, actualWeight: 0.8 },
      { waybill: 'NVC_ORD_2', provWeight: 0.5, actualWeight: 1.5 },
      { waybill: 'NVC_ORD_3', provWeight: 0.5, actualWeight: 1.5 },
    ];
    // Manual adjustment: 72,000đ (bulky packaging surcharge)
    const discrepancy = processCarrierWeightDiscrepancies(carrierRows, shopPlan, 72000);
    assert.strictEqual(discrepancy.totalDiscrepancyFromRows, 28000);
    assert.strictEqual(discrepancy.manualAdjustment, 72000);
    assert.strictEqual(discrepancy.totalWeightAdjustment, 100000); // Exactly 100,000đ total surcharge

    // Returns: 1 order with 500,000đ COD
    const returnResult = processReturnOrders([{ waybill: 'RET_NVC', codAmount: 500000 }], {});
    assert.strictEqual(returnResult.totalReturnedCodRecall, 500000);

    // Settlement: 5,680,000 - 500,000 (returns) - 100,000 (NVC adjustment) = 5,080,000đ
    const settlement = computeDailySettlement({
      netNewAdvance: outbound.netNewAdvance,
      totalReturnedCodRecall: returnResult.totalReturnedCodRecall,
      totalWeightAdjustment: discrepancy.totalWeightAdjustment,
      previousDebt: 0,
    });

    assert.strictEqual(settlement.rawSettlement, 5080000);
    assert.strictEqual(settlement.netAdvancePayout, 5080000);
    assert.strictEqual(settlement.closingDebt, 0);
  });
});

describe('Tier 4: Acceptance Scenario 6 — 5-Day Consecutive Rolling Ledger Simulation', () => {
  it('S6: simulates Monday to Friday rolling advances, debt transitions, and full recovery', () => {
    let currentDebt = 0;
    const historyDb: Record<string, HistoricalOrderRecord> = {};

    // Monday (Day 1): 50 orders (200k COD, 20k fee) -> Net: 50 * 180k = 9,000,000đ
    const monOrders: NewOrderRow[] = Array.from({ length: 50 }, (_, i) => ({
      waybill: `MON_${i}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const monOut = processOutboundOrders(monOrders, shopPlan);
    monOrders.forEach((o) => {
      historyDb[o.waybill] = { waybill: o.waybill, codAmount: 200000, advanceDate: 'Monday' };
    });
    const monSet = computeDailySettlement({
      netNewAdvance: monOut.netNewAdvance,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: currentDebt,
    });
    assert.strictEqual(monSet.netAdvancePayout, 9000000);
    currentDebt = monSet.closingDebt; // 0

    // Tuesday (Day 2): 40 orders (7.2M advance), 5 returns from Mon (1M recall)
    const tueOrders: NewOrderRow[] = Array.from({ length: 40 }, (_, i) => ({
      waybill: `TUE_${i}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const tueOut = processOutboundOrders(tueOrders, shopPlan);
    tueOrders.forEach((o) => {
      historyDb[o.waybill] = { waybill: o.waybill, codAmount: 200000, advanceDate: 'Tuesday' };
    });
    const tueReturns = processReturnOrders(
      Array.from({ length: 5 }, (_, i) => ({ waybill: `MON_${i}` })),
      historyDb
    );
    const tueSet = computeDailySettlement({
      netNewAdvance: tueOut.netNewAdvance, // 7.2M
      totalReturnedCodRecall: tueReturns.totalReturnedCodRecall, // 1.0M
      totalWeightAdjustment: 0,
      previousDebt: currentDebt, // 0
    });
    assert.strictEqual(tueSet.netAdvancePayout, 6200000); // 7.2M - 1M = 6.2M
    currentDebt = tueSet.closingDebt; // 0

    // Wednesday (Day 3): Low volume (5 orders = 900k advance), heavy returns (15 orders = 3M clawback)
    const wedOrders: NewOrderRow[] = Array.from({ length: 5 }, (_, i) => ({
      waybill: `WED_${i}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const wedOut = processOutboundOrders(wedOrders, shopPlan); // 900k
    const wedReturns = processReturnOrders(
      Array.from({ length: 15 }, (_, i) => ({ waybill: `MON_${i + 5}` })),
      historyDb
    ); // 15 * 200k = 3M
    const wedSet = computeDailySettlement({
      netNewAdvance: wedOut.netNewAdvance, // 900k
      totalReturnedCodRecall: wedReturns.totalReturnedCodRecall, // 3M
      totalWeightAdjustment: 0,
      previousDebt: currentDebt, // 0
    });
    // 900k - 3M = -2,100,000đ
    assert.strictEqual(wedSet.netAdvancePayout, 0);
    assert.strictEqual(wedSet.closingDebt, -2100000);
    currentDebt = wedSet.closingDebt; // -2.1M

    // Thursday (Day 4): Moderate volume (20 orders = 3.6M advance), opening debt -2.1M
    const thuOrders: NewOrderRow[] = Array.from({ length: 20 }, (_, i) => ({
      waybill: `THU_${i}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const thuOut = processOutboundOrders(thuOrders, shopPlan); // 3.6M
    const thuSet = computeDailySettlement({
      netNewAdvance: thuOut.netNewAdvance, // 3.6M
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: currentDebt, // -2.1M
    });
    // 3.6M + (-2.1M) = 1,500,000đ
    assert.strictEqual(thuSet.netAdvancePayout, 1500000);
    assert.strictEqual(thuSet.closingDebt, 0); // Debt fully cleared!
    currentDebt = thuSet.closingDebt; // 0

    // Friday (Day 5): Normal clean volume (30 orders = 5.4M advance), 0 debt
    const friOrders: NewOrderRow[] = Array.from({ length: 30 }, (_, i) => ({
      waybill: `FRI_${i}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const friOut = processOutboundOrders(friOrders, shopPlan);
    const friSet = computeDailySettlement({
      netNewAdvance: friOut.netNewAdvance,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: currentDebt,
    });
    assert.strictEqual(friSet.netAdvancePayout, 5400000);
    assert.strictEqual(friSet.closingDebt, 0);
  });
});

// =========================================================================
// TIER 3: PAIRWISE COMBINATORIAL TESTS (>= 15 tests covering cross-feature interactions)
// =========================================================================

describe('Tier 3: Pairwise Combinatorial Matrix', () => {
  // Test combinations across [Order Volume] x [Weight Tiers] x [Return Types] x [Debt State]

  it('P1: Small volume (1 order) + Base tier + No returns + Zero debt', () => {
    const out = processOutboundOrders([{ waybill: 'P1', rawWeight: 0.3, codAmount: 100000 }], shopPlan);
    const set = computeDailySettlement({
      netNewAdvance: out.netNewAdvance, // 100k - 16k = 84k
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(set.netAdvancePayout, 84000);
    assert.strictEqual(set.closingDebt, 0);
  });

  it('P2: Small volume (1 order) + Excess weight + Historical return + Zero debt', () => {
    // 2.5kg -> 26k + 5k = 31k fee. COD 200k -> net 169k
    const out = processOutboundOrders([{ waybill: 'P2', rawWeight: 2.5, codAmount: 200000 }], shopPlan);
    const ret = processReturnOrders([{ waybill: 'HIST_P2' }], {
      HIST_P2: { waybill: 'HIST_P2', codAmount: 100000 },
    });
    const set = computeDailySettlement({
      netNewAdvance: out.netNewAdvance, // 169k
      totalReturnedCodRecall: ret.totalReturnedCodRecall, // 100k
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(set.netAdvancePayout, 69000);
  });

  it('P3: Medium volume (20 orders) + Tier 2 + Excel return + Negative debt', () => {
    // 20 orders: 200k COD, 20k fee -> 3.6M net
    const out = processOutboundOrders(
      Array.from({ length: 20 }, (_, i) => ({ waybill: `P3_${i}`, rawWeight: 0.8, codAmount: 200000 })),
      shopPlan
    );
    // Excel returns: 500k
    const ret = processReturnOrders([{ waybill: 'EXT_P3', codAmount: 500000 }], {});
    // Previous debt: -4,000,000
    const set = computeDailySettlement({
      netNewAdvance: out.netNewAdvance, // 3.6M
      totalReturnedCodRecall: ret.totalReturnedCodRecall, // 500k
      totalWeightAdjustment: 0,
      previousDebt: -4000000,
    });
    // 3.6M - 500k - 4M = -900,000
    assert.strictEqual(set.netAdvancePayout, 0);
    assert.strictEqual(set.closingDebt, -900000);
  });

  it('P4: Medium volume + Excess steps + Carrier surcharge + Positive surplus', () => {
    // 10 orders: 3kg (36k fee), 500k COD -> net 10 * 464k = 4,640,000
    const out = processOutboundOrders(
      Array.from({ length: 10 }, (_, i) => ({ waybill: `P4_${i}`, rawWeight: 3.0, codAmount: 500000 })),
      shopPlan
    );
    const disc = processCarrierWeightDiscrepancies([], shopPlan, 140000);
    const set = computeDailySettlement({
      netNewAdvance: out.netNewAdvance, // 4,640,000
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: disc.totalWeightAdjustment, // 140,000
      previousDebt: 500000, // surplus +500k
    });
    // 4,640,000 - 140,000 + 500,000 = 5,000,000
    assert.strictEqual(set.netAdvancePayout, 5000000);
  });

  it('P5: Large volume (150 orders) + Mixed weights + Mixed returns + Surcharge + Zero debt', () => {
    const orders: NewOrderRow[] = [];
    for (let i = 0; i < 50; i++) orders.push({ waybill: `P5_1_${i}`, rawWeight: 0.4, codAmount: 150000 });
    for (let i = 0; i < 50; i++) orders.push({ waybill: `P5_2_${i}`, rawWeight: 0.9, codAmount: 250000 });
    for (let i = 0; i < 50; i++) orders.push({ waybill: `P5_3_${i}`, rawWeight: 1.5, codAmount: 350000 });
    const out = processOutboundOrders(orders, shopPlan);

    const historyMap = {
      RET_HIST_1: { waybill: 'RET_HIST_1', codAmount: 500000 },
    };
    const ret = processReturnOrders(
      [{ waybill: 'RET_HIST_1' }, { waybill: 'RET_EXT_1', codAmount: 300000 }],
      historyMap
    ); // Total 800k

    const disc = processCarrierWeightDiscrepancies(
      [{ waybill: 'P5_1_0', provWeight: 0.4, actualWeight: 0.8 }], // 4000
      shopPlan,
      46000
    ); // Total 50k

    const set = computeDailySettlement({
      netNewAdvance: out.netNewAdvance,
      totalReturnedCodRecall: ret.totalReturnedCodRecall,
      totalWeightAdjustment: disc.totalWeightAdjustment,
      previousDebt: 0,
    });

    assert.ok(set.netAdvancePayout > 0);
    assert.strictEqual(set.closingDebt, 0);
    assert.strictEqual(
      set.netAdvancePayout,
      out.netNewAdvance - 800000 - 50000
    );
  });

  it('P6: Zero volume (no new orders) + Only returns + Zero debt -> immediate debt rollover', () => {
    const ret = processReturnOrders([{ waybill: 'EXT_ONLY', codAmount: 1200000 }], {});
    const set = computeDailySettlement({
      netNewAdvance: 0,
      totalReturnedCodRecall: ret.totalReturnedCodRecall, // 1.2M
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(set.netAdvancePayout, 0);
    assert.strictEqual(set.closingDebt, -1200000);
  });

  it('P7: Zero volume + Zero returns + Carrier adjustment only -> debt rollover', () => {
    const disc = processCarrierWeightDiscrepancies([], shopPlan, 350000);
    const set = computeDailySettlement({
      netNewAdvance: 0,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: disc.totalWeightAdjustment, // 350k
      previousDebt: 0,
    });
    assert.strictEqual(set.netAdvancePayout, 0);
    assert.strictEqual(set.closingDebt, -350000);
  });

  it('P8: Large volume + Zero COD orders mixed with normal orders', () => {
    const orders: NewOrderRow[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ waybill: `Z_${i}`, rawWeight: 0.5, codAmount: 0 })), // 10 * -16k = -160k
      ...Array.from({ length: 10 }, (_, i) => ({ waybill: `N_${i}`, rawWeight: 0.5, codAmount: 200000 })), // 10 * 184k = 1.84M
    ];
    const out = processOutboundOrders(orders, shopPlan);
    assert.strictEqual(out.netNewAdvance, 1680000); // 1.84M - 160k = 1.68M
  });

  it('P9: Return clawback exactly equal to net advance -> exact 0đ payout', () => {
    const set = computeDailySettlement({
      netNewAdvance: 3500000,
      totalReturnedCodRecall: 3500000,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(set.rawSettlement, 0);
    assert.strictEqual(set.netAdvancePayout, 0);
    assert.strictEqual(set.closingDebt, 0);
  });

  it('P10: High manual surcharge exceeding advance -> rolls into debt', () => {
    const set = computeDailySettlement({
      netNewAdvance: 1000000,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 1500000, // Surcharge 1.5M
      previousDebt: 0,
    });
    assert.strictEqual(set.netAdvancePayout, 0);
    assert.strictEqual(set.closingDebt, -500000);
  });

  it('P11: Positive prior surplus covers return clawback completely', () => {
    const set = computeDailySettlement({
      netNewAdvance: 0,
      totalReturnedCodRecall: 500000,
      totalWeightAdjustment: 0,
      previousDebt: 1200000, // surplus 1.2M
    });
    // 0 - 500k + 1.2M = 700,000
    assert.strictEqual(set.netAdvancePayout, 700000);
    assert.strictEqual(set.closingDebt, 0);
  });

  it('P12: Extreme weight order (20kg) with standard return order', () => {
    // 20kg: 26k + (18 / 0.5) * 5k = 26k + 180k = 206,000 fee
    // COD 500k -> net 294k
    const out = processOutboundOrders([{ waybill: 'EXTREME', rawWeight: 20.0, codAmount: 500000 }], shopPlan);
    assert.strictEqual(out.orders[0].fee, 206000);
    assert.strictEqual(out.orders[0].netAdvance, 294000);

    const ret = processReturnOrders([{ waybill: 'RET', codAmount: 100000 }], {});
    const set = computeDailySettlement({
      netNewAdvance: out.netNewAdvance,
      totalReturnedCodRecall: ret.totalReturnedCodRecall,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(set.netAdvancePayout, 194000);
  });

  it('P13: Discrepancy where actual weight is identical to provisional (0đ diff)', () => {
    const disc = processCarrierWeightDiscrepancies(
      [{ waybill: 'SAME', provWeight: 0.8, actualWeight: 0.8 }],
      shopPlan,
      0
    );
    assert.strictEqual(disc.totalWeightAdjustment, 0);
  });

  it('P14: Gram string weight in outbound with historical return', () => {
    const out = processOutboundOrders([{ waybill: 'GRAM_ORD', rawWeight: '800g', codAmount: 200000 }], shopPlan);
    assert.strictEqual(out.orders[0].weightKg, 0.8);
    assert.strictEqual(out.orders[0].fee, 20000);
    assert.strictEqual(out.orders[0].netAdvance, 180000);
  });

  it('P15: Full chain combined: dirty text weight + duplicate waybills handled independently + fallback return + manual fee', () => {
    const out = processOutboundOrders(
      [
        { waybill: 'CHAIN_1', rawWeight: 'Hà Nội', codAmount: 100000 }, // 0.5kg -> 16k fee -> 84k
        { waybill: 'CHAIN_2', rawWeight: '1,2kg', codAmount: 300000 },  // 1.2kg -> 26k fee -> 274k
      ],
      shopPlan
    );
    assert.strictEqual(out.netNewAdvance, 358000);

    const ret = processReturnOrders([{ waybill: 'CHAIN_RET', codAmount: 158000 }], {});
    const disc = processCarrierWeightDiscrepancies([], shopPlan, 50000);

    const set = computeDailySettlement({
      netNewAdvance: out.netNewAdvance, // 358k
      totalReturnedCodRecall: ret.totalReturnedCodRecall, // 158k
      totalWeightAdjustment: disc.totalWeightAdjustment, // 50k
      previousDebt: -50000, // debt 50k
    });

    // 358k - 158k - 50k - 50k = 100,000đ
    assert.strictEqual(set.netAdvancePayout, 100000);
    assert.strictEqual(set.closingDebt, 0);
  });
});
