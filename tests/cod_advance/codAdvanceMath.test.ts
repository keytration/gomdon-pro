/**
 * tests/cod_advance/codAdvanceMath.test.ts
 * Tier 1 (Feature Coverage) & Tier 2 (Boundary & Corner Cases) Test Suite
 * Validates pricing brackets, 0đ return fee, zero COD, excess steps, text weight handling, settlement math.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWeightToKg,
  calculateWeightFee,
  processOutboundOrders,
  processReturnOrders,
  processCarrierWeightDiscrepancies,
  computeDailySettlement,
  toVietQrMemo,
  type AdvancePricingPlan,
  type NewOrderRow,
  type ReturnOrderRow,
  type HistoricalOrderRecord,
} from './mathEngine.ts';

// Standard test pricing plan
const standardPlan: AdvancePricingPlan = {
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

describe('Tier 1: Feature Coverage — Pricing Brackets & Weight Matching', () => {
  it('F1.1: matches base tier (<= 0.5kg)', () => {
    const fee = calculateWeightFee(0.2, standardPlan);
    assert.strictEqual(fee, 16000);
  });

  it('F1.2: matches exact upper boundary of base tier (0.5kg)', () => {
    const fee = calculateWeightFee(0.5, standardPlan);
    assert.strictEqual(fee, 16000);
  });

  it('F1.3: matches intermediate tier (0.5kg < weight <= 1.0kg)', () => {
    const fee = calculateWeightFee(0.8, standardPlan);
    assert.strictEqual(fee, 20000);
  });

  it('F1.4: matches exact boundary of second tier (1.0kg)', () => {
    const fee = calculateWeightFee(1.0, standardPlan);
    assert.strictEqual(fee, 20000);
  });

  it('F1.5: matches highest defined tier (1.0kg < weight <= 2.0kg)', () => {
    const fee = calculateWeightFee(1.5, standardPlan);
    assert.strictEqual(fee, 26000);
  });

  it('F1.6: calculates excess step fee for weight exceeding highest tier (2.3kg -> 1 step)', () => {
    // 2.3kg: excess 0.3kg over 2.0kg -> 1 step * 5000 -> 26000 + 5000 = 31000
    const fee = calculateWeightFee(2.3, standardPlan);
    assert.strictEqual(fee, 31000);
  });

  it('F1.7: calculates excess step fee for multiple steps (3.0kg -> 2 steps)', () => {
    // 3.0kg: excess 1.0kg over 2.0kg -> 2 steps * 5000 -> 26000 + 10000 = 36000
    const fee = calculateWeightFee(3.0, standardPlan);
    assert.strictEqual(fee, 36000);
  });
});

describe('Tier 1: Feature Coverage — Return Fee Strictly 0đ (R1, R2.2)', () => {
  const historyMap: Record<string, HistoricalOrderRecord> = {
    RET001: { waybill: 'RET001', codAmount: 200000, advanceDate: '2026-10-20' },
    RET002: { waybill: 'RET002', codAmount: 500000, advanceDate: '2026-10-20' },
  };

  it('F2.1: return order from history has strictly 0đ return fee', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'RET001' }];
    const res = processReturnOrders(rows, historyMap);
    assert.strictEqual(res.orders[0].returnFee, 0);
    assert.strictEqual(res.totalReturnFee, 0);
  });

  it('F2.2: return order from Excel fallback has strictly 0đ return fee', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'RET_EXT_01', codAmount: 150000 }];
    const res = processReturnOrders(rows, historyMap);
    assert.strictEqual(res.orders[0].returnFee, 0);
    assert.strictEqual(res.totalReturnFee, 0);
  });

  it('F2.3: batch of mixed returns maintains strictly 0đ return fee across all orders', () => {
    const rows: ReturnOrderRow[] = [
      { waybill: 'RET001' },
      { waybill: 'RET002' },
      { waybill: 'RET_EXT_02', codAmount: 300000 },
    ];
    const res = processReturnOrders(rows, historyMap);
    res.orders.forEach((o) => {
      assert.strictEqual(o.returnFee, 0);
    });
    assert.strictEqual(res.totalReturnFee, 0);
  });

  it('F2.4: pricing plan metadata verifies return fee is locked to free / 0%', () => {
    assert.strictEqual(standardPlan.returnFeeType, 'free');
    assert.strictEqual(standardPlan.returnFeePercent, 0);
  });

  it('F2.5: return fee is 0đ regardless of returned order value or weight', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'HIGH_VAL', codAmount: 20000000 }];
    const res = processReturnOrders(rows, historyMap);
    assert.strictEqual(res.orders[0].returnFee, 0);
    assert.strictEqual(res.totalReturnFee, 0);
  });
});

describe('Tier 1: Feature Coverage — Outbound Advance Formula (R2.1)', () => {
  it('F3.1: computes single order net advance = COD - Fee', () => {
    const orders: NewOrderRow[] = [{ waybill: 'ORD001', rawWeight: 0.4, codAmount: 200000 }];
    const res = processOutboundOrders(orders, standardPlan);
    assert.strictEqual(res.orders[0].codAmount, 200000);
    assert.strictEqual(res.orders[0].fee, 16000);
    assert.strictEqual(res.orders[0].netAdvance, 184000);
  });

  it('F3.2: aggregates multiple orders correctly', () => {
    const orders: NewOrderRow[] = [
      { waybill: 'ORD001', rawWeight: 0.4, codAmount: 200000 }, // Fee 16k -> 184k
      { waybill: 'ORD002', rawWeight: 0.8, codAmount: 300000 }, // Fee 20k -> 280k
      { waybill: 'ORD003', rawWeight: 1.5, codAmount: 500000 }, // Fee 26k -> 474k
    ];
    const res = processOutboundOrders(orders, standardPlan);
    assert.strictEqual(res.totalNewCod, 1000000);
    assert.strictEqual(res.totalNewFee, 62000);
    assert.strictEqual(res.netNewAdvance, 938000);
    assert.strictEqual(res.netNewAdvance, res.totalNewCod - res.totalNewFee);
  });

  it('F3.3: verifies netAdvance equals sum of individual order netAdvances', () => {
    const orders: NewOrderRow[] = [
      { waybill: 'A', rawWeight: 0.3, codAmount: 100000 },
      { waybill: 'B', rawWeight: 1.2, codAmount: 150000 },
    ];
    const res = processOutboundOrders(orders, standardPlan);
    const sumIndividual = res.orders.reduce((sum, o) => sum + o.netAdvance, 0);
    assert.strictEqual(res.netNewAdvance, sumIndividual);
  });

  it('F3.4: handles order with fee greater than COD (net negative advance for that order)', () => {
    const orders: NewOrderRow[] = [{ waybill: 'SMALL_COD', rawWeight: 0.3, codAmount: 10000 }];
    const res = processOutboundOrders(orders, standardPlan);
    // COD 10,000 - Fee 16,000 = -6,000
    assert.strictEqual(res.orders[0].netAdvance, -6000);
  });

  it('F3.5: processes 50 uniform orders accurately', () => {
    const orders: NewOrderRow[] = Array.from({ length: 50 }, (_, i) => ({
      waybill: `UNIFORM_${i + 1}`,
      rawWeight: 0.8,
      codAmount: 200000,
    }));
    const res = processOutboundOrders(orders, standardPlan);
    assert.strictEqual(res.totalNewCod, 10000000);
    assert.strictEqual(res.totalNewFee, 1000000); // 50 * 20k
    assert.strictEqual(res.netNewAdvance, 9000000);
  });
});

describe('Tier 1: Feature Coverage — Return Clawback & Historical Lookup (R2.2)', () => {
  const historyMap: Record<string, HistoricalOrderRecord> = {
    DAY1_001: { waybill: 'DAY1_001', codAmount: 200000, advanceSessionId: 'SES_01' },
    DAY1_002: { waybill: 'DAY1_002', codAmount: 350000, advanceSessionId: 'SES_01' },
    DAY1_003: { waybill: 'DAY1_003', codAmount: 120000, advanceSessionId: 'SES_01' },
  };

  it('F4.1: retrieves exact COD amount from historical session', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'DAY1_001' }];
    const res = processReturnOrders(rows, historyMap);
    assert.strictEqual(res.orders[0].recoveredCod, 200000);
    assert.strictEqual(res.orders[0].lookupSource, 'history');
    assert.strictEqual(res.orders[0].historySessionId, 'SES_01');
  });

  it('F4.2: falls back to Excel COD when waybill is not found in history', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'NEW_RETURN', codAmount: 175000 }];
    const res = processReturnOrders(rows, historyMap);
    assert.strictEqual(res.orders[0].recoveredCod, 175000);
    assert.strictEqual(res.orders[0].lookupSource, 'excel');
    assert.strictEqual(res.orders[0].historySessionId, undefined);
  });

  it('F4.3: prioritizes historical COD over Excel COD if both are provided', () => {
    // Excel row says 999k, but history recorded 200k
    const rows: ReturnOrderRow[] = [{ waybill: 'DAY1_001', codAmount: 999000 }];
    const res = processReturnOrders(rows, historyMap);
    assert.strictEqual(res.orders[0].recoveredCod, 200000);
    assert.strictEqual(res.orders[0].lookupSource, 'history');
  });

  it('F4.4: correctly aggregates total clawback across mixed sources', () => {
    const rows: ReturnOrderRow[] = [
      { waybill: 'DAY1_001' }, // 200k (history)
      { waybill: 'DAY1_002' }, // 350k (history)
      { waybill: 'EXT_001', codAmount: 150000 }, // 150k (excel)
    ];
    const res = processReturnOrders(rows, historyMap);
    assert.strictEqual(res.totalReturnedCodRecall, 700000);
  });

  it('F4.5: empty return row list yields 0 clawback', () => {
    const res = processReturnOrders([], historyMap);
    assert.strictEqual(res.totalReturnedCodRecall, 0);
    assert.strictEqual(res.orders.length, 0);
  });
});

describe('Tier 1: Feature Coverage — Carrier Weight Discrepancy (R2.3)', () => {
  it('F5.1: calculates surcharge when carrier actual weight > provisional weight', () => {
    // Prov: 0.4kg (16k) vs Actual: 0.8kg (20k) -> diff = 4000
    const res = processCarrierWeightDiscrepancies(
      [{ waybill: 'W001', provWeight: 0.4, actualWeight: 0.8 }],
      standardPlan
    );
    assert.strictEqual(res.items[0].discrepancyFee, 4000);
    assert.strictEqual(res.totalWeightAdjustment, 4000);
  });

  it('F5.2: clamps discrepancy at 0 when carrier weight is less than provisional', () => {
    // Prov: 1.5kg (26k) vs Actual: 0.4kg (16k) -> diff should NOT be negative refund
    const res = processCarrierWeightDiscrepancies(
      [{ waybill: 'W002', provWeight: 1.5, actualWeight: 0.4 }],
      standardPlan
    );
    assert.strictEqual(res.items[0].discrepancyFee, 0);
    assert.strictEqual(res.totalWeightAdjustment, 0);
  });

  it('F5.3: handles multi-step overweight jump from NVC', () => {
    // Prov: 0.5kg (16k) vs Actual: 3.0kg (26k + 2*5k = 36k) -> diff = 20000
    const res = processCarrierWeightDiscrepancies(
      [{ waybill: 'W003', provWeight: 0.5, actualWeight: 3.0 }],
      standardPlan
    );
    assert.strictEqual(res.items[0].discrepancyFee, 20000);
    assert.strictEqual(res.totalWeightAdjustment, 20000);
  });

  it('F5.4: includes manual adjustment amount in total adjustment', () => {
    const res = processCarrierWeightDiscrepancies(
      [{ waybill: 'W001', provWeight: 0.4, actualWeight: 0.8 }], // 4000
      standardPlan,
      50000 // Manual adjustment
    );
    assert.strictEqual(res.manualAdjustment, 50000);
    assert.strictEqual(res.totalWeightAdjustment, 54000);
  });

  it('F5.5: aggregates multiple discrepancy rows correctly', () => {
    const res = processCarrierWeightDiscrepancies(
      [
        { waybill: 'A', provWeight: 0.4, actualWeight: 0.8 }, // 4000
        { waybill: 'B', provWeight: 0.8, actualWeight: 1.5 }, // 6000 (20k -> 26k)
        { waybill: 'C', provWeight: 1.0, actualWeight: 1.0 }, // 0
      ],
      standardPlan
    );
    assert.strictEqual(res.totalDiscrepancyFromRows, 10000);
    assert.strictEqual(res.totalWeightAdjustment, 10000);
  });
});

describe('Tier 1: Feature Coverage — Daily Settlement Formula & Positive Payout (R2.4)', () => {
  it('F6.1: computes basic positive payout without deductions', () => {
    const res = computeDailySettlement({
      netNewAdvance: 18000000,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(res.netAdvancePayout, 18000000);
    assert.strictEqual(res.closingDebt, 0);
    assert.strictEqual(res.isNegativeDebt, false);
  });

  it('F6.2: computes payout with return clawback deducted', () => {
    const res = computeDailySettlement({
      netNewAdvance: 18000000,
      totalReturnedCodRecall: 2000000,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(res.netAdvancePayout, 16000000);
    assert.strictEqual(res.closingDebt, 0);
    assert.strictEqual(res.isNegativeDebt, false);
  });

  it('F6.3: computes payout with carrier weight adjustment deducted', () => {
    const res = computeDailySettlement({
      netNewAdvance: 18000000,
      totalReturnedCodRecall: 2000000,
      totalWeightAdjustment: 500000,
      previousDebt: 0,
    });
    assert.strictEqual(res.netAdvancePayout, 15500000);
    assert.strictEqual(res.closingDebt, 0);
    assert.strictEqual(res.isNegativeDebt, false);
  });

  it('F6.4: computes payout with positive prior balance (surplus)', () => {
    const res = computeDailySettlement({
      netNewAdvance: 10000000,
      totalReturnedCodRecall: 1000000,
      totalWeightAdjustment: 0,
      previousDebt: 2000000,
    });
    assert.strictEqual(res.netAdvancePayout, 11000000);
    assert.strictEqual(res.closingDebt, 0);
  });

  it('F6.5: computes payout when net advance exceeds previous negative debt', () => {
    const res = computeDailySettlement({
      netNewAdvance: 18000000,
      totalReturnedCodRecall: 2000000,
      totalWeightAdjustment: 0,
      previousDebt: -3000000, // Shop owed 3M from yesterday
    });
    // 18M - 2M + (-3M) = 13,000,000
    assert.strictEqual(res.netAdvancePayout, 13000000);
    assert.strictEqual(res.closingDebt, 0);
    assert.strictEqual(res.isNegativeDebt, false);
  });
});

describe('Tier 1: Feature Coverage — VietQR Memo Formatter (R3)', () => {
  it('F7.1: strips Vietnamese diacritics and transforms to uppercase', () => {
    const memo = toVietQrMemo('SHOP_ANH_VŨ', '22.10.2026');
    assert.strictEqual(memo, 'UNG COD SHOP_ANH_VU 22.10.2026');
  });

  it('F7.2: converts đ/Đ to d/D', () => {
    const memo = toVietQrMemo('ĐỨC_TÍN', '22.10.2026');
    assert.strictEqual(memo, 'UNG COD DUC_TIN 22.10.2026');
  });

  it('F7.3: replaces special characters and leaves clean alphanumeric string', () => {
    const memo = toVietQrMemo('SHOP#01/TEST!', '22.10.2026');
    assert.ok(!memo.includes('#'));
    assert.ok(!memo.includes('!'));
    assert.ok(!memo.includes('/'));
  });

  it('F7.4: caps length strictly at 50 characters for NAPAS 247 compliance', () => {
    const longShop = 'SHOP_RAT_DAI_VO_CUNG_DAI_KHONG_THE_TIN_NOI_DAI_QUA_DI_THOI';
    const memo = toVietQrMemo(longShop, '2026-10-22');
    assert.ok(memo.length <= 50, `Length ${memo.length} exceeds 50`);
  });

  it('F7.5: supports custom prefix', () => {
    const memo = toVietQrMemo('SHOP_ABC', '22.10', 'GD ADVANCE');
    assert.strictEqual(memo, 'GD ADVANCE SHOP_ABC 22.10');
  });
});

// =========================================================================
// TIER 2: BOUNDARY & CORNER CASES (>=5 per feature)
// =========================================================================

describe('Tier 2: Boundary Cases — Zero COD Orders (COD = 0 -> Advance = -Fee)', () => {
  it('B1.1: single order with COD = 0 produces netAdvance = -Fee', () => {
    const orders: NewOrderRow[] = [{ waybill: 'ZERO_01', rawWeight: 0.4, codAmount: 0 }];
    const res = processOutboundOrders(orders, standardPlan);
    assert.strictEqual(res.orders[0].codAmount, 0);
    assert.strictEqual(res.orders[0].fee, 16000);
    assert.strictEqual(res.orders[0].netAdvance, -16000);
    assert.strictEqual(res.netNewAdvance, -16000);
  });

  it('B1.2: multiple zero-COD orders accumulate negative net advance correctly', () => {
    const orders: NewOrderRow[] = [
      { waybill: 'ZERO_01', rawWeight: 0.4, codAmount: 0 }, // -16k
      { waybill: 'ZERO_02', rawWeight: 0.8, codAmount: 0 }, // -20k
    ];
    const res = processOutboundOrders(orders, standardPlan);
    assert.strictEqual(res.totalNewCod, 0);
    assert.strictEqual(res.totalNewFee, 36000);
    assert.strictEqual(res.netNewAdvance, -36000);
  });

  it('B1.3: batch of mixed positive and zero COD orders', () => {
    const orders: NewOrderRow[] = [
      { waybill: 'POS_01', rawWeight: 0.4, codAmount: 200000 }, // +184k
      { waybill: 'ZERO_01', rawWeight: 0.4, codAmount: 0 },      // -16k
    ];
    const res = processOutboundOrders(orders, standardPlan);
    assert.strictEqual(res.totalNewCod, 200000);
    assert.strictEqual(res.totalNewFee, 32000);
    assert.strictEqual(res.netNewAdvance, 168000);
  });

  it('B1.4: zero COD order with heavy excess weight produces large fee deduction', () => {
    // 5.0kg: excess 3.0kg -> 6 steps * 5k = 30k -> fee = 56000
    const orders: NewOrderRow[] = [{ waybill: 'HEAVY_ZERO', rawWeight: 5.0, codAmount: 0 }];
    const res = processOutboundOrders(orders, standardPlan);
    assert.strictEqual(res.orders[0].fee, 56000);
    assert.strictEqual(res.orders[0].netAdvance, -56000);
  });

  it('B1.5: zero COD order in daily settlement carries fee into debt if no other revenue exists', () => {
    const outbound = processOutboundOrders(
      [{ waybill: 'Z1', rawWeight: 0.4, codAmount: 0 }],
      standardPlan
    );
    const settlement = computeDailySettlement({
      netNewAdvance: outbound.netNewAdvance, // -16000
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(settlement.netAdvancePayout, 0);
    assert.strictEqual(settlement.closingDebt, -16000);
    assert.strictEqual(settlement.isNegativeDebt, true);
  });
});

describe('Tier 2: Boundary Cases — Text Weight Strings & Heuristic Normalization', () => {
  it('B2.1: parses grams with explicit "g" unit ("400g" -> 0.4kg)', () => {
    const weight = parseWeightToKg('400g');
    assert.strictEqual(weight, 0.4);
  });

  it('B2.2: parses explicit "kg" unit ("1.2kg" -> 1.2kg)', () => {
    const weight = parseWeightToKg('1.2kg');
    assert.strictEqual(weight, 1.2);
  });

  it('B2.3: parses Vietnamese decimal comma format ("0,75" -> 0.75kg)', () => {
    const weight = parseWeightToKg('0,75');
    assert.strictEqual(weight, 0.75);
  });

  it('B2.4: falls back to default 0.5kg when input contains non-numeric text ("Hà Nội")', () => {
    const weight = parseWeightToKg('Hà Nội');
    assert.strictEqual(weight, 0.5);
  });

  it('B2.5: falls back to 0.5kg on empty string, null, or undefined', () => {
    assert.strictEqual(parseWeightToKg(''), 0.5);
    assert.strictEqual(parseWeightToKg(null), 0.5);
    assert.strictEqual(parseWeightToKg(undefined), 0.5);
  });

  it('B2.6: converts numeric grams >50 to kg (e.g. 1500 -> 1.5kg)', () => {
    const weight = parseWeightToKg(1500);
    assert.strictEqual(weight, 1.5);
  });

  it('B2.7: clamps abnormal raw weight (>100kg without gram heuristic) to fallback 0.5kg', () => {
    const weight = parseWeightToKg(999999);
    assert.strictEqual(weight, 0.5);
  });
});

describe('Tier 2: Boundary Cases — Huge Excess Weight & Exact Tier Boundaries', () => {
  it('B3.1: calculates huge excess weight (15kg with 2kg base tier)', () => {
    // 15kg: base 2.0kg (26k), delta = 13.0kg, steps = 13 / 0.5 = 26 steps
    // 26 * 5000 = 130,000 -> fee = 26,000 + 130,000 = 156,000
    const fee = calculateWeightFee(15.0, standardPlan);
    assert.strictEqual(fee, 156000);
  });

  it('B3.2: calculates extreme weight (30kg)', () => {
    // 30kg: delta = 28kg, steps = 56 -> 56 * 5000 = 280,000 -> 26k + 280k = 306,000
    const fee = calculateWeightFee(30.0, standardPlan);
    assert.strictEqual(fee, 306000);
  });

  it('B3.3: fractional excess step boundary (2.001kg triggers 1 step)', () => {
    // 2.001kg: delta = 0.001kg -> ceil(0.001 / 0.5) = 1 step
    const fee = calculateWeightFee(2.001, standardPlan);
    assert.strictEqual(fee, 31000);
  });

  it('B3.4: exact step boundary (2.500kg is exactly 1 step)', () => {
    const fee = calculateWeightFee(2.5, standardPlan);
    assert.strictEqual(fee, 31000);
  });

  it('B3.5: exact boundary for 2 steps (3.000kg)', () => {
    const fee = calculateWeightFee(3.0, standardPlan);
    assert.strictEqual(fee, 36000);
  });
});

describe('Tier 2: Boundary Cases — Empty Inputs & Zero-Value Batches', () => {
  it('B4.1: empty new orders array produces all zeros', () => {
    const res = processOutboundOrders([], standardPlan);
    assert.strictEqual(res.orders.length, 0);
    assert.strictEqual(res.totalNewCod, 0);
    assert.strictEqual(res.totalNewFee, 0);
    assert.strictEqual(res.netNewAdvance, 0);
  });

  it('B4.2: empty return orders array produces 0 clawback', () => {
    const res = processReturnOrders([], {});
    assert.strictEqual(res.orders.length, 0);
    assert.strictEqual(res.totalReturnedCodRecall, 0);
    assert.strictEqual(res.totalReturnFee, 0);
  });

  it('B4.3: empty carrier discrepancy array produces 0 adjustment', () => {
    const res = processCarrierWeightDiscrepancies([], standardPlan, 0);
    assert.strictEqual(res.items.length, 0);
    assert.strictEqual(res.totalWeightAdjustment, 0);
  });

  it('B4.4: zero settlement when all components are zero', () => {
    const res = computeDailySettlement({
      netNewAdvance: 0,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(res.netAdvancePayout, 0);
    assert.strictEqual(res.closingDebt, 0);
    assert.strictEqual(res.isNegativeDebt, true); // <= 0 is considered debt / zero payout
  });

  it('B4.5: empty inputs with existing negative debt preserves full debt into closing debt', () => {
    const res = computeDailySettlement({
      netNewAdvance: 0,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: -2500000,
    });
    assert.strictEqual(res.netAdvancePayout, 0);
    assert.strictEqual(res.closingDebt, -2500000);
    assert.strictEqual(res.isNegativeDebt, true);
  });
});

describe('Tier 2: Boundary Cases — Return Fallbacks & Zero COD in Return File', () => {
  it('B5.1: return order not in history with 0 COD in Excel yields 0 recovered COD', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'EXT_ZERO', codAmount: 0 }];
    const res = processReturnOrders(rows, {});
    assert.strictEqual(res.orders[0].recoveredCod, 0);
    assert.strictEqual(res.orders[0].lookupSource, 'excel');
    assert.strictEqual(res.totalReturnedCodRecall, 0);
  });

  it('B5.2: return order with undefined COD in Excel defaults safely to 0', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'EXT_UNDEF' }];
    const res = processReturnOrders(rows, {});
    assert.strictEqual(res.orders[0].recoveredCod, 0);
    assert.strictEqual(res.totalReturnedCodRecall, 0);
  });

  it('B5.3: negative COD in Excel return row is clamped to 0', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'EXT_NEG', codAmount: -50000 }];
    const res = processReturnOrders(rows, {});
    assert.strictEqual(res.orders[0].recoveredCod, 0);
  });

  it('B5.4: historical record with 0 COD recovers 0 COD with history source tag', () => {
    const historyMap = {
      HIST_ZERO: { waybill: 'HIST_ZERO', codAmount: 0, advanceSessionId: 'SES_0' },
    };
    const rows: ReturnOrderRow[] = [{ waybill: 'HIST_ZERO' }];
    const res = processReturnOrders(rows, historyMap);
    assert.strictEqual(res.orders[0].recoveredCod, 0);
    assert.strictEqual(res.orders[0].lookupSource, 'history');
  });

  it('B5.5: returns with huge COD value processed without precision loss', () => {
    const rows: ReturnOrderRow[] = [{ waybill: 'BIG_RET', codAmount: 999999999 }];
    const res = processReturnOrders(rows, {});
    assert.strictEqual(res.orders[0].recoveredCod, 999999999);
    assert.strictEqual(res.totalReturnedCodRecall, 999999999);
  });
});

describe('Tier 2: Boundary Cases — Negative Rollover & Multi-Session Debt Accumulation', () => {
  it('B6.1: return clawback exceeding new advance produces negative closing debt and zero payout', () => {
    const res = computeDailySettlement({
      netNewAdvance: 1800000,
      totalReturnedCodRecall: 3800000,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(res.netAdvancePayout, 0);
    assert.strictEqual(res.closingDebt, -2000000);
    assert.strictEqual(res.isNegativeDebt, true);
  });

  it('B6.2: severe negative settlement where clawback is 10x new advance', () => {
    const res = computeDailySettlement({
      netNewAdvance: 500000,
      totalReturnedCodRecall: 5000000,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(res.netAdvancePayout, 0);
    assert.strictEqual(res.closingDebt, -4500000);
    assert.strictEqual(res.isNegativeDebt, true);
  });

  it('B6.3: consecutive negative rollover: negative debt compounds across two sessions', () => {
    // Session 1: -2,000,000
    const ses1 = computeDailySettlement({
      netNewAdvance: 1000000,
      totalReturnedCodRecall: 3000000,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });
    assert.strictEqual(ses1.closingDebt, -2000000);

    // Session 2: New advance 1M, clawback 2M, previousDebt -2M -> -3,000,000
    const ses2 = computeDailySettlement({
      netNewAdvance: 1000000,
      totalReturnedCodRecall: 2000000,
      totalWeightAdjustment: 0,
      previousDebt: ses1.closingDebt,
    });
    assert.strictEqual(ses2.netAdvancePayout, 0);
    assert.strictEqual(ses2.closingDebt, -3000000);
    assert.strictEqual(ses2.isNegativeDebt, true);
  });

  it('B6.4: partial recovery: strong new advance partially pays off negative debt but balance remains negative', () => {
    const res = computeDailySettlement({
      netNewAdvance: 3000000,
      totalReturnedCodRecall: 1000000,
      totalWeightAdjustment: 0,
      previousDebt: -5000000, // Owed 5M
    });
    // (3M - 1M) + (-5M) = -3,000,000
    assert.strictEqual(res.netAdvancePayout, 0);
    assert.strictEqual(res.closingDebt, -3000000);
    assert.strictEqual(res.isNegativeDebt, true);
  });

  it('B6.5: exact threshold: new advance exactly offsets previous debt down to 0đ', () => {
    const res = computeDailySettlement({
      netNewAdvance: 2000000,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: -2000000,
    });
    assert.strictEqual(res.rawSettlement, 0);
    assert.strictEqual(res.netAdvancePayout, 0);
    assert.strictEqual(res.closingDebt, 0);
  });
});
