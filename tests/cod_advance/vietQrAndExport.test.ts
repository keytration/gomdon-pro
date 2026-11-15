/**
 * tests/cod_advance/vietQrAndExport.test.ts
 * VietQR Dynamic Generation & Multi-Sheet Excel Statement Export Test Suite
 * Validates NAPAS 247 URL formatting, memo sanitization, QR suppression, and 4-sheet Excel generation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  toVietQrMemo,
  generateVietQrUrl,
  generateStatementWorkbook,
  processOutboundOrders,
  processReturnOrders,
  processCarrierWeightDiscrepancies,
  computeDailySettlement,
  type AdvancePricingPlan,
  type BankAccountInfo,
} from './mathEngine.ts';

const testPlan: AdvancePricingPlan = {
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

const bankMB: BankAccountInfo = {
  bankCode: '970422',
  accountNumber: '0987 654 321', // contains spaces to test trimming
  accountHolder: 'VU DUC ANH',
};

const bankVCB: BankAccountInfo = {
  bankCode: '970436',
  accountNumber: '1012345678',
  accountHolder: 'CTY TNHH GOM DON',
};

describe('VietQR Dynamic Generation & Formatting (R3)', () => {
  it('QR1: generates standard VietQR URL with correct bank code and clean account number', () => {
    const memo = toVietQrMemo('SHOP01', '22.10.2026');
    const url = generateVietQrUrl(bankMB, 18000000, memo);

    assert.ok(url !== null);
    assert.ok(url.startsWith('https://img.vietqr.io/image/970422-0987654321-compact2.png'));
    assert.ok(url.includes('amount=18000000'));
    assert.ok(url.includes('addInfo=UNG%20COD%20SHOP01%2022.10.2026'));
    assert.ok(url.includes('accountName=VU%20DUC%20ANH'));
  });

  it('QR2: rounds decimal amounts to nearest whole VND integer', () => {
    const memo = toVietQrMemo('SHOP02', '22.10.2026');
    const url = generateVietQrUrl(bankVCB, 1500000.75, memo);
    assert.ok(url !== null);
    assert.ok(url.includes('amount=1500001'));
  });

  it('QR3: suppresses VietQR (returns null) when settlement amount is 0đ', () => {
    const memo = toVietQrMemo('SHOP_ZERO', '22.10.2026');
    const url = generateVietQrUrl(bankMB, 0, memo);
    assert.strictEqual(url, null);
  });

  it('QR4: suppresses VietQR (returns null) when settlement amount is negative (debt)', () => {
    const memo = toVietQrMemo('SHOP_DEBT', '22.10.2026');
    const url = generateVietQrUrl(bankMB, -2000000, memo);
    assert.strictEqual(url, null);
  });

  it('QR5: handles multiple national bank codes correctly', () => {
    const banks = [
      { code: '970407', name: 'Techcombank' },
      { code: '970415', name: 'VietinBank' },
      { code: '970418', name: 'BIDV' },
      { code: '970416', name: 'ACB' },
      { code: '970432', name: 'VPBank' },
    ];

    banks.forEach((b) => {
      const url = generateVietQrUrl(
        { bankCode: b.code, accountNumber: '123456789', accountHolder: 'SHOP TEST' },
        5000000,
        'UNG COD'
      );
      assert.ok(url !== null);
      assert.ok(url.includes(`${b.code}-123456789-compact2.png`));
    });
  });

  it('QR6: memo removes Vietnamese diacritics and enforces 50 char limit', () => {
    const complexShop = 'HỘ KINH DOANH ĐỨC TÍN PHÁT TÀI LỘC AN KHANG THỊNH VƯỢNG';
    const memo = toVietQrMemo(complexShop, '2026.10.22');
    assert.ok(memo.length <= 50, `Memo length ${memo.length} exceeds 50`);
    assert.ok(!/[đĐàáạảãèéẹẻẽìíịỉĩòóọỏõùúụủũưứừựửữơớờợởỡ]/i.test(memo));
  });
});

describe('Excel Statement Multi-Sheet Export (R3)', () => {
  async function createSampleSessionData(options?: {
    isNegative?: boolean;
    outCount?: number;
    retCount?: number;
    discCount?: number;
  }) {
    const outCount = options?.outCount ?? 5;
    const retCount = options?.retCount ?? 2;
    const discCount = options?.discCount ?? 2;

    const outOrders = Array.from({ length: outCount }, (_, i) => ({
      waybill: `EXP_OUT_${i + 1}`,
      rawWeight: 0.8,
      codAmount: 200000,
      note: `Giao hàng ngày ${i + 1}`,
    }));
    const outbound = processOutboundOrders(outOrders, testPlan);

    const retOrders = Array.from({ length: retCount }, (_, i) => ({
      waybill: `EXP_RET_${i + 1}`,
      codAmount: options?.isNegative ? 2000000 : 150000,
      note: 'Khách không nhận',
    }));
    const returns = processReturnOrders(retOrders, {});

    const discRows = Array.from({ length: discCount }, (_, i) => ({
      waybill: `EXP_OUT_${i + 1}`,
      provWeight: 0.5,
      actualWeight: 0.8,
      note: 'NVC cân lại',
    }));
    const discrepancy = processCarrierWeightDiscrepancies(discRows, testPlan, 10000);

    const settlement = computeDailySettlement({
      netNewAdvance: outbound.netNewAdvance,
      totalReturnedCodRecall: returns.totalReturnedCodRecall,
      totalWeightAdjustment: discrepancy.totalWeightAdjustment,
      previousDebt: 0,
    });

    return {
      shopName: 'Shop Thời Trang ABC',
      shopCode: 'SHOP_ABC',
      advanceDate: '2026-10-22',
      bankAccount: bankMB,
      outbound,
      returns,
      discrepancy,
      settlement,
      previousDebt: 0,
    };
  }

  it('EX1: creates a workbook with exactly 4 specified worksheets', async () => {
    const sessionData = await createSampleSessionData();
    const workbook = await generateStatementWorkbook(sessionData);

    const expectedSheets = [
      'TONG_HOP_UNG_COD',
      'CHI_TIET_DON_DI',
      'CHI_TIET_DON_HOAN',
      'CHENH_LECH_CUOC_NVC',
    ];

    const actualSheets = workbook.worksheets.map((w) => w.name);
    assert.deepStrictEqual(actualSheets, expectedSheets);
  });

  it('EX2: Sheet 1 (TONG_HOP_UNG_COD) contains all summary KPIs and metrics matching settlement', async () => {
    const sessionData = await createSampleSessionData();
    const workbook = await generateStatementWorkbook(sessionData);
    const sheet = workbook.getWorksheet('TONG_HOP_UNG_COD');
    assert.ok(sheet !== undefined);

    // Check header columns
    assert.strictEqual(sheet.getRow(1).getCell(1).value, 'Chỉ số quyết toán');
    assert.strictEqual(sheet.getRow(1).getCell(2).value, 'Giá trị (VND / Số lượng)');

    // Collect all metric labels and values
    const metrics: Record<string, any> = {};
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        const metricName = String(row.getCell(1).value || '');
        const metricVal = row.getCell(2).value;
        metrics[metricName] = metricVal;
      }
    });

    // Verify key metrics
    assert.strictEqual(metrics['1. Tổng số đơn mới'], sessionData.outbound.orders.length);
    assert.strictEqual(metrics['2. Tổng COD đơn mới'], sessionData.outbound.totalNewCod);
    assert.strictEqual(metrics['3. Tổng cước tạm tính đơn mới'], sessionData.outbound.totalNewFee);
    assert.strictEqual(metrics['4. Tiền ứng đơn mới (2 - 3)'], sessionData.outbound.netNewAdvance);
    assert.strictEqual(metrics['5. Tổng số đơn hoàn'], sessionData.returns.orders.length);
    assert.strictEqual(metrics['6. Cước hoàn phát sinh'], 0); // 0đ return fee
    assert.strictEqual(metrics['7. Thu hồi COD đơn hoàn'], sessionData.returns.totalReturnedCodRecall);
    assert.strictEqual(metrics['8. Chênh lệch cước vượt cân NVC'], sessionData.discrepancy.totalWeightAdjustment);
    assert.strictEqual(metrics['10. TỔNG THỰC CHUYỂN HÔM NAY'], sessionData.settlement.netAdvancePayout);
  });

  it('EX3: Sheet 2 (CHI_TIET_DON_DI) has correct headers, order rows, and SUM formulas', async () => {
    const sessionData = await createSampleSessionData({ outCount: 10 });
    const workbook = await generateStatementWorkbook(sessionData);
    const sheet = workbook.getWorksheet('CHI_TIET_DON_DI');
    assert.ok(sheet !== undefined);

    // Row 1: Headers
    const headers = [1, 2, 3, 4, 5, 6, 7].map((col) => sheet.getRow(1).getCell(col).value);
    assert.deepStrictEqual(headers, [
      'STT',
      'Mã Vận Đơn',
      'Cân Nặng (kg)',
      'Tiền COD (đ)',
      'Cước Phí (đ)',
      'Tiền Tạm Ứng (đ)',
      'Ghi Chú',
    ]);

    // Data rows: 10 orders -> rows 2 to 11
    assert.strictEqual(sheet.getRow(2).getCell(2).value, 'EXP_OUT_1');
    assert.strictEqual(sheet.getRow(11).getCell(2).value, 'EXP_OUT_10');

    // Total row: Row 12
    const totalRow = sheet.getRow(12);
    assert.strictEqual(totalRow.getCell(1).value, 'TỔNG CỘNG');
    assert.deepStrictEqual(totalRow.getCell(4).value, { formula: 'SUM(D2:D11)' });
    assert.deepStrictEqual(totalRow.getCell(5).value, { formula: 'SUM(E2:E11)' });
    assert.deepStrictEqual(totalRow.getCell(6).value, { formula: 'SUM(F2:F11)' });
  });

  it('EX4: Sheet 3 (CHI_TIET_DON_HOAN) has 0đ return fee across all rows and valid sum formula', async () => {
    const sessionData = await createSampleSessionData({ retCount: 4 });
    const workbook = await generateStatementWorkbook(sessionData);
    const sheet = workbook.getWorksheet('CHI_TIET_DON_HOAN');
    assert.ok(sheet !== undefined);

    // Row 1: Headers
    const headers = [1, 2, 3, 4, 5, 6].map((col) => sheet.getRow(1).getCell(col).value);
    assert.deepStrictEqual(headers, [
      'STT',
      'Mã Vận Đơn',
      'Tiền COD Thu Hồi (đ)',
      'Cước Hoàn (đ)',
      'Nguồn Tra Cứu',
      'Ghi Chú',
    ]);

    // Check data rows 2 to 5: Return fee must strictly be 0
    for (let r = 2; r <= 5; r++) {
      assert.strictEqual(sheet.getRow(r).getCell(4).value, 0); // 0đ
    }

    // Total row: Row 6
    const totalRow = sheet.getRow(6);
    assert.strictEqual(totalRow.getCell(1).value, 'TỔNG CỘNG');
    assert.deepStrictEqual(totalRow.getCell(3).value, { formula: 'SUM(C2:C5)' });
    assert.strictEqual(totalRow.getCell(4).value, 0);
  });

  it('EX5: Sheet 4 (CHENH_LECH_CUOC_NVC) populates discrepancy comparisons accurately', async () => {
    const sessionData = await createSampleSessionData({ discCount: 3 });
    const workbook = await generateStatementWorkbook(sessionData);
    const sheet = workbook.getWorksheet('CHENH_LECH_CUOC_NVC');
    assert.ok(sheet !== undefined);

    // Row 1: Headers
    const headers = [1, 2, 3, 4, 5, 6, 7, 8].map((col) => sheet.getRow(1).getCell(col).value);
    assert.deepStrictEqual(headers, [
      'STT',
      'Mã Vận Đơn',
      'Cân Nặng Tạm Tính (kg)',
      'Cân Nặng Thực Tế NVC (kg)',
      'Cước Tạm Tính (đ)',
      'Cước Thực Tế (đ)',
      'Chênh Lệch Cước (đ)',
      'Ghi Chú',
    ]);

    // Data row check
    const row2 = sheet.getRow(2);
    assert.strictEqual(row2.getCell(2).value, 'EXP_OUT_1');
    assert.strictEqual(row2.getCell(3).value, 0.5);
    assert.strictEqual(row2.getCell(4).value, 0.8);
    assert.strictEqual(row2.getCell(5).value, 16000);
    assert.strictEqual(row2.getCell(6).value, 20000);
    assert.strictEqual(row2.getCell(7).value, 4000);
  });

  it('EX6: workbook serializes to binary buffer and reloads without loss or corruption', async () => {
    const sessionData = await createSampleSessionData();
    const workbook = await generateStatementWorkbook(sessionData);

    // Serialize to buffer
    const buffer = await workbook.xlsx.writeBuffer();
    assert.ok(buffer.byteLength > 5000, `Buffer size ${buffer.byteLength} is unexpectedly small`);

    // Reload into brand new workbook instance
    const reloadedWorkbook = new ExcelJS.Workbook();
    await reloadedWorkbook.xlsx.load(buffer);

    // Verify reloaded structure
    const sheetNames = reloadedWorkbook.worksheets.map((s) => s.name);
    assert.deepStrictEqual(sheetNames, [
      'TONG_HOP_UNG_COD',
      'CHI_TIET_DON_DI',
      'CHI_TIET_DON_HOAN',
      'CHENH_LECH_CUOC_NVC',
    ]);

    const reloadedSummary = reloadedWorkbook.getWorksheet('TONG_HOP_UNG_COD');
    assert.ok(reloadedSummary !== undefined);
    assert.strictEqual(reloadedSummary.getRow(1).getCell(1).value, 'Chỉ số quyết toán');
  });

  it('EX7: exports negative settlement properly noting debt rollover', async () => {
    const sessionData = await createSampleSessionData({ isNegative: true });
    const workbook = await generateStatementWorkbook(sessionData);
    const sheet = workbook.getWorksheet('TONG_HOP_UNG_COD');
    assert.ok(sheet !== undefined);

    let payoutValue: any;
    let payoutNote: any;
    let debtValue: any;

    sheet.eachRow((row) => {
      const metric = String(row.getCell(1).value || '');
      if (metric.includes('TỔNG THỰC CHUYỂN')) {
        payoutValue = row.getCell(2).value;
        payoutNote = row.getCell(3).value;
      }
      if (metric.includes('Công nợ chuyển kỳ')) {
        debtValue = row.getCell(2).value;
      }
    });

    assert.strictEqual(payoutValue, 0); // 0đ paid
    assert.strictEqual(payoutNote, 'SHOP NỢ (KẾT CHUYỂN KỲ SAU)');
    assert.ok(typeof debtValue === 'number' && debtValue < 0);
  });
});
