/**
 * tests/cod_advance/codAdvanceService.test.ts
 * Comprehensive Test Suite for src/services/codAdvanceService.ts
 *
 * Covers:
 * 1. Pricing Engine & Weight Normalization
 * 2. Outbound Orders Processing & Aggregations
 * 3. Return Orders Processing & Strict 0đ Return Fee
 * 4. Carrier Discrepancies & Asymmetric Surcharge Logic
 * 5. Daily Rolling Settlement & Negative Debt Rollover
 * 6. VietQR Generation & Memo Sanitization (NAPAS 247)
 * 7. 4-Sheet Excel Statement Generation & Blob Serialization
 * 8. Excel Ingestion (parseOutboundExcel, parseReturnExcel, parseCarrierDiscrepancyExcel)
 *    with dirty banners, 2-tier headers, summary footers, and text weights.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import {
  parseWeightToKg,
  calculateWeightFee,
  processOutboundOrders,
  processReturnOrders,
  processCarrierWeightDiscrepancies,
  computeDailySettlement,
  toVietQrMemo,
  generateVietQrUrl,
  generateStatementWorkbook,
  exportStatementExcelBlob,
  normalizeStatementSessionData,
  parseOutboundExcel,
  parseReturnExcel,
  parseCarrierDiscrepancyExcel,
  CodAdvanceService,
  type AdvancePricingPlan,
  type BankAccountInfo,
  type AdvanceSession,
} from '../../src/services/codAdvanceService.ts';

const samplePlan: AdvancePricingPlan = {
  id: 'plan_standard',
  name: 'Bảng giá chuẩn Shop Test',
  weightRules: [
    { minWeight: 0, maxWeight: 0.5, price: 16000 },
    { minWeight: 0.5, maxWeight: 1.0, price: 20000 },
    { minWeight: 1.0, maxWeight: 2.0, price: 26000 },
  ],
  extraStepWeight: 0.5,
  extraStepPrice: 5000,
  returnFeePercent: 0,
  returnFeeFixed: 0,
  returnFeeType: 'free',
};

const sampleBank: BankAccountInfo = {
  bankCode: 'MB',
  bankName: 'MB Bank',
  accountNumber: '0987654321',
  accountHolder: 'NGUYEN VAN A',
};

describe('codAdvanceService: Pricing & Weight Engine', () => {
  it('parses dirty weights to kg correctly', () => {
    assert.strictEqual(parseWeightToKg('400g'), 0.4);
    assert.strictEqual(parseWeightToKg('1.2kg'), 1.2);
    assert.strictEqual(parseWeightToKg('0,75'), 0.75);
    assert.strictEqual(parseWeightToKg(1500), 1.5);
    assert.strictEqual(parseWeightToKg('Hà Nội'), 0.5);
    assert.strictEqual(parseWeightToKg(''), 0.5);
    assert.strictEqual(parseWeightToKg(null), 0.5);
    assert.strictEqual(parseWeightToKg(undefined), 0.5);
    assert.strictEqual(parseWeightToKg(250), 0.25); // 250g -> 0.25kg
    assert.strictEqual(parseWeightToKg('250kg'), 0.5); // >100kg clamped to fallback
    assert.strictEqual(parseWeightToKg(0), 0);
  });

  it('calculates tiered weight fee and excess steps accurately', () => {
    assert.strictEqual(calculateWeightFee(0.3, samplePlan), 16000);
    assert.strictEqual(calculateWeightFee(0.5, samplePlan), 16000);
    assert.strictEqual(calculateWeightFee(0.8, samplePlan), 20000);
    assert.strictEqual(calculateWeightFee(1.0, samplePlan), 20000);
    assert.strictEqual(calculateWeightFee(1.5, samplePlan), 26000);
    assert.strictEqual(calculateWeightFee(2.0, samplePlan), 26000);

    // Excess steps: 2.0kg base (26k), 0.5kg extra step (5k)
    assert.strictEqual(calculateWeightFee(2.001, samplePlan), 31000);
    assert.strictEqual(calculateWeightFee(2.5, samplePlan), 31000);
    assert.strictEqual(calculateWeightFee(3.0, samplePlan), 36000);
    assert.strictEqual(calculateWeightFee(15.0, samplePlan), 156000);
  });
});

describe('codAdvanceService: Outbound, Return & Discrepancy Processing', () => {
  it('processes outbound orders with fee deduction and net advance', () => {
    const orders = [
      { waybill: 'OUT_1', rawWeight: '0.4kg', codAmount: 200000 },
      { waybill: 'OUT_2', rawWeight: '1.2kg', codAmount: 300000 },
      { waybill: 'OUT_3', rawWeight: '2.5kg', codAmount: 0 }, // COD 0
    ];

    const result = processOutboundOrders(orders, samplePlan);
    assert.strictEqual(result.orders.length, 3);
    assert.strictEqual(result.totalNewCod, 500000);
    assert.strictEqual(result.totalNewFee, 16000 + 26000 + 31000); // 73000
    assert.strictEqual(result.netNewAdvance, 500000 - 73000); // 427000
    assert.strictEqual(result.orders[2].netAdvance, -31000); // negative net advance for zero-COD
  });

  it('processes return orders with strict 0đ return fee and historical lookup precedence', () => {
    const historyMap = {
      RET_HIST: { waybill: 'RET_HIST', codAmount: 250000, advanceSessionId: 'sess_prev_1' },
    };

    const returnRows = [
      { waybill: 'RET_HIST', codAmount: 100000 }, // Excel says 100k, history must override to 250k
      { waybill: 'RET_NEW', codAmount: 180000 },  // Not in history, use Excel
      { waybill: 'RET_ZERO', codAmount: undefined }, // Not in history, defaults to 0
    ];

    const result = processReturnOrders(returnRows, historyMap);
    assert.strictEqual(result.orders.length, 3);
    assert.strictEqual(result.orders[0].recoveredCod, 250000);
    assert.strictEqual(result.orders[0].lookupSource, 'history');
    assert.strictEqual(result.orders[0].returnFee, 0);

    assert.strictEqual(result.orders[1].recoveredCod, 180000);
    assert.strictEqual(result.orders[1].lookupSource, 'excel');
    assert.strictEqual(result.orders[1].returnFee, 0);

    assert.strictEqual(result.orders[2].recoveredCod, 0);
    assert.strictEqual(result.orders[2].returnFee, 0);

    assert.strictEqual(result.totalReturnedCodRecall, 430000);
    assert.strictEqual(result.totalReturnFee, 0);
  });

  it('processes carrier discrepancies with asymmetric clamping at 0', () => {
    const discRows = [
      { waybill: 'DISC_1', provWeight: 0.5, actualWeight: 1.0 }, // 16k -> 20k, diff = 4000
      { waybill: 'DISC_2', provWeight: 1.0, actualWeight: 0.5 }, // 20k -> 16k, diff clamped to 0
      { waybill: 'DISC_3', provWeight: 0.5, actualWeight: 2.5 }, // 16k -> 31k, diff = 15000
    ];

    const result = processCarrierWeightDiscrepancies(discRows, samplePlan, 5000); // 5k manual adjustment
    assert.strictEqual(result.items.length, 3);
    assert.strictEqual(result.items[0].discrepancyFee, 4000);
    assert.strictEqual(result.items[1].discrepancyFee, 0);
    assert.strictEqual(result.items[2].discrepancyFee, 15000);
    assert.strictEqual(result.totalDiscrepancyFromRows, 19000);
    assert.strictEqual(result.manualAdjustment, 5000);
    assert.strictEqual(result.totalWeightAdjustment, 24000);
  });
});

describe('codAdvanceService: Daily Rolling Settlement', () => {
  it('computes positive net advance payout when balance > 0', () => {
    const settlement = computeDailySettlement({
      netNewAdvance: 18000000,
      totalReturnedCodRecall: 2000000,
      totalWeightAdjustment: 500000,
      previousDebt: 0,
    });

    assert.strictEqual(settlement.rawSettlement, 15500000);
    assert.strictEqual(settlement.netAdvancePayout, 15500000);
    assert.strictEqual(settlement.closingDebt, 0);
    assert.strictEqual(settlement.isNegativeDebt, false);
  });

  it('rolls negative balance into closing debt and suppresses payout to 0', () => {
    const settlement = computeDailySettlement({
      netNewAdvance: 1800000,
      totalReturnedCodRecall: 3800000,
      totalWeightAdjustment: 0,
      previousDebt: 0,
    });

    assert.strictEqual(settlement.rawSettlement, -2000000);
    assert.strictEqual(settlement.netAdvancePayout, 0);
    assert.strictEqual(settlement.closingDebt, -2000000);
    assert.strictEqual(settlement.isNegativeDebt, true);
  });

  it('deducts previous negative debt from today new advance', () => {
    const settlement = computeDailySettlement({
      netNewAdvance: 18000000,
      totalReturnedCodRecall: 0,
      totalWeightAdjustment: 0,
      previousDebt: -2000000, // Rolled over from yesterday
    });

    assert.strictEqual(settlement.rawSettlement, 16000000);
    assert.strictEqual(settlement.netAdvancePayout, 16000000);
    assert.strictEqual(settlement.closingDebt, 0);
    assert.strictEqual(settlement.isNegativeDebt, false);
  });
});

describe('codAdvanceService: VietQR Generator', () => {
  it('formats memo according to NAPAS 247 standard (diacritics stripped, uppercase, 50 char cap)', () => {
    const memo = toVietQrMemo('SHOP ĐỨC TÍN', '2026-10-22');
    assert.strictEqual(memo, 'UNG COD SHOP DUC TIN 2026-10-22');
    assert.ok(memo.length <= 50);

    const longMemo = toVietQrMemo('A'.repeat(60), '2026-10-22');
    assert.strictEqual(longMemo.length, 50);
  });

  it('generates VietQR URL for positive amount and suppresses (returns null) for 0 or negative debt', () => {
    const qrUrl = generateVietQrUrl(sampleBank, 15500000, 'UNG COD SHOP_A 2026-10-22');
    assert.ok(qrUrl !== null);
    assert.ok(qrUrl.includes('img.vietqr.io'));
    assert.ok(qrUrl.includes('amount=15500000'));
    assert.ok(qrUrl.includes('MB-0987654321-compact2.png'));

    // Suppression tests
    assert.strictEqual(generateVietQrUrl(sampleBank, 0, 'MEMO'), null);
    assert.strictEqual(generateVietQrUrl(sampleBank, -2000000, 'MEMO'), null);
    assert.strictEqual(generateVietQrUrl({ ...sampleBank, accountNumber: '' }, 100000, 'MEMO'), null);
  });
});

describe('codAdvanceService: Multi-Sheet Statement Export', () => {
  it('generates 4-sheet workbook and serializes to valid Blob', async () => {
    const mockSession: AdvanceSession = {
      id: 'sess_test_1',
      shopId: 'shop_1',
      shopCode: 'SHOP_TEST',
      shopName: 'Shop Thời Trang Mẫu',
      advanceDate: '2026-10-22',
      createdAt: '2026-10-22T08:00:00Z',
      createdByName: 'Admin',
      totalNewOrdersCount: 2,
      totalNewCod: 500000,
      totalNewFee: 40000,
      netNewAdvance: 460000,
      totalReturnedOrdersCount: 1,
      totalReturnedCodRecall: 200000,
      totalWeightAdjustment: 5000,
      manualAdjustmentAmount: 5000,
      previousDebt: 0,
      netAdvancePayout: 255000,
      closingDebt: 0,
      payoutStatus: 'UNPAID',
      bankInfo: {
        bankName: 'MB Bank',
        accountNumber: '0987654321',
        accountHolder: 'NGUYEN VAN A',
      },
      newOrders: [
        {
          id: 'ord_1',
          waybill: 'OUT_001',
          weight: 0.5,
          codAmount: 200000,
          appliedFee: 16000,
          netAdvance: 184000,
        },
        {
          id: 'ord_2',
          waybill: 'OUT_002',
          weight: 1.0,
          codAmount: 300000,
          appliedFee: 24000,
          netAdvance: 276000,
        },
      ],
      returnedOrders: [
        {
          id: 'ret_1',
          waybill: 'RET_001',
          codAmount: 200000,
          returnFee: 0,
          isFromHistory: true,
        },
      ],
      weightAdjustments: [
        {
          id: 'adj_1',
          waybill: 'OUT_001',
          advanceWeight: 0.5,
          actualWeight: 0.8,
          advanceFee: 16000,
          actualFee: 21000,
          feeDifference: 5000,
          source: 'nvc_file',
        },
      ],
    };

    const workbook = await generateStatementWorkbook(mockSession);
    const expectedSheets = [
      'TONG_HOP_UNG_COD',
      'CHI_TIET_DON_DI',
      'CHI_TIET_DON_HOAN',
      'CHENH_LECH_CUOC_NVC',
    ];
    assert.deepStrictEqual(workbook.worksheets.map((w) => w.name), expectedSheets);

    // Verify Blob generation
    const blob = await exportStatementExcelBlob(mockSession);
    assert.ok(blob instanceof Blob);
    assert.strictEqual(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(blob.size > 1000);
  });
});

describe('codAdvanceService: Excel Ingestion (XLSX Parsers)', () => {
  it('parses Outbound Excel with dirty title banner and summary footer', async () => {
    const rawData = [
      ['BẢNG KÊ ĐƠN ĐI GOM ĐƠN - NGÀY 22/10/2026'],
      ['Kế toán: Vũ Đức Anh', '', '', ''],
      [''], // empty row
      ['STT', 'Mã vận đơn', 'Khối lượng (kg)', 'Tiền thu hộ (COD)', 'Người nhận'],
      [1, 'WAYBILL_OUT_101', '400g', '250.000 đ', 'Khách A'],
      [2, 'WAYBILL_OUT_102', '1,2', '350.000', 'Khách B'],
      [3, 'WAYBILL_OUT_103', '1500', '180,000 đ', 'Khách C'],
      ['TỔNG CỘNG', '', '', '780.000 đ', ''],
      ['Kế toán xác nhận', '', '', '', ''],
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rawData);
    XLSX.utils.book_append_sheet(wb, ws, 'DonDi');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const orders = await parseOutboundExcel(buffer);
    assert.strictEqual(orders.length, 3);

    assert.strictEqual(orders[0].waybill, 'WAYBILL_OUT_101');
    assert.strictEqual(orders[0].rawWeight, '400g');
    assert.strictEqual(orders[0].codAmount, 250000);
    assert.strictEqual(orders[0].receiverName, 'Khách A');

    assert.strictEqual(orders[1].waybill, 'WAYBILL_OUT_102');
    assert.strictEqual(orders[1].codAmount, 350000);

    assert.strictEqual(orders[2].waybill, 'WAYBILL_OUT_103');
    assert.strictEqual(orders[2].codAmount, 180000);
  });

  it('parses Outbound Excel with 2-tier headers (GHN format)', async () => {
    const rawData = [
      ['Thông tin đơn hàng', '', 'Cước & COD', ''],
      ['Mã đơn', 'Cân nặng', 'Tiền COD', 'Ghi chú'],
      ['GHN_001', '0.5', 200000, 'Hàng dễ vỡ'],
      ['GHN_002', '1.0', 300000, 'Giao giờ hành chính'],
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rawData);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const orders = await parseOutboundExcel(buffer);
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].waybill, 'GHN_001');
    assert.strictEqual(orders[0].codAmount, 200000);
    assert.strictEqual(orders[0].note, 'Hàng dễ vỡ');
  });

  it('parses Return Excel with fallback COD and dates', async () => {
    const rawData = [
      ['DANH SÁCH ĐƠN HÀNG CHUYỂN HOÀN'],
      ['STT', 'Mã vận đơn', 'Tiền COD hoàn', 'Ngày hoàn', 'Lý do'],
      [1, 'RET_WB_01', '200.000', '22/10/2026', 'Khách từ chối nhận'],
      [2, 'RET_WB_02', '', '2026-10-21', 'Không liên lạc được'],
      ['TỔNG SỐ ĐƠN HOÀN: 2', '', '', '', ''],
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rawData);
    XLSX.utils.book_append_sheet(wb, ws, 'DonHoan');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const returns = await parseReturnExcel(buffer);
    assert.strictEqual(returns.length, 2);
    assert.strictEqual(returns[0].waybill, 'RET_WB_01');
    assert.strictEqual(returns[0].codAmount, 200000);
    assert.strictEqual(returns[0].returnDate, '2026-10-22');
    assert.strictEqual(returns[0].note, 'Khách từ chối nhận');

    assert.strictEqual(returns[1].waybill, 'RET_WB_02');
    assert.strictEqual(returns[1].codAmount, undefined); // undefined fallback
    assert.strictEqual(returns[1].returnDate, '2026-10-21');
  });

  it('parses Carrier Discrepancy Excel accurately', async () => {
    const rawData = [
      ['ĐỐI SOÁT VƯỢT CÂN NVC'],
      ['STT', 'Mã vận đơn', 'Khối lượng tạm tính (kg)', 'Khối lượng thực tế NVC (kg)', 'Lý do lệch'],
      [1, 'NVC_DISC_1', '0.5', '0.9', 'Đóng gói hộp to'],
      [2, 'NVC_DISC_2', '1.0', '1.8', 'Hàng cồng kềnh'],
      ['TỔNG', '', '', '', ''],
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rawData);
    XLSX.utils.book_append_sheet(wb, ws, 'VuotCan');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const disc = await parseCarrierDiscrepancyExcel(buffer);
    assert.strictEqual(disc.length, 2);
    assert.strictEqual(disc[0].waybill, 'NVC_DISC_1');
    assert.strictEqual(disc[0].provWeight, 0.5);
    assert.strictEqual(disc[0].actualWeight, 0.9);
    assert.strictEqual(disc[0].note, 'Đóng gói hộp to');

    assert.strictEqual(disc[1].waybill, 'NVC_DISC_2');
    assert.strictEqual(disc[1].provWeight, 1.0);
    assert.strictEqual(disc[1].actualWeight, 1.8);
  });
});

describe('codAdvanceService: CodAdvanceService Namespace Object', () => {
  it('exposes all required M2 <-> M3 contract methods on the namespace object', () => {
    assert.strictEqual(typeof CodAdvanceService.calculateWeightFee, 'function');
    assert.strictEqual(typeof CodAdvanceService.parseWeightToKg, 'function');
    assert.strictEqual(typeof CodAdvanceService.parseOutboundExcel, 'function');
    assert.strictEqual(typeof CodAdvanceService.processOutboundOrders, 'function');
    assert.strictEqual(typeof CodAdvanceService.parseReturnExcel, 'function');
    assert.strictEqual(typeof CodAdvanceService.processReturnOrders, 'function');
    assert.strictEqual(typeof CodAdvanceService.parseCarrierDiscrepancyExcel, 'function');
    assert.strictEqual(typeof CodAdvanceService.processCarrierWeightDiscrepancies, 'function');
    assert.strictEqual(typeof CodAdvanceService.computeDailySettlement, 'function');
    assert.strictEqual(typeof CodAdvanceService.toVietQrMemo, 'function');
    assert.strictEqual(typeof CodAdvanceService.generateVietQrUrl, 'function');
    assert.strictEqual(typeof CodAdvanceService.generateStatementWorkbook, 'function');
    assert.strictEqual(typeof CodAdvanceService.exportStatementExcelBlob, 'function');
    assert.strictEqual(typeof CodAdvanceService.exportStatementExcel, 'function');
    assert.strictEqual(typeof CodAdvanceService.exportAndDownloadStatementExcel, 'function');
    assert.strictEqual(typeof CodAdvanceService.normalizeStatementSessionData, 'function');
  });
});
