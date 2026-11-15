/**
 * mathEngine.ts
 * Pure reference mathematical & business logic engine for "Quản Lý Ứng COD Hàng Ngày (T+0)"
 * Derived strictly from ORIGINAL_REQUEST.md (§R1, §R2, §R3) and TEST_INFRA.md.
 */

import ExcelJS from 'exceljs';

export interface WeightRule {
  minWeight: number; // kg
  maxWeight: number; // kg
  price: number;     // VND
}

export interface AdvancePricingPlan {
  weightRules: WeightRule[];
  extraStepWeight: number; // kg (default 0.5)
  extraStepPrice: number;  // VND per step (e.g. 5000)
  returnFeeType: 'free';
  returnFeePercent: 0;
}

export interface NewOrderRow {
  waybill: string;
  rawWeight: string | number;
  codAmount: number;
  note?: string;
}

export interface ProcessedNewOrder {
  waybill: string;
  weightKg: number;
  codAmount: number;
  fee: number;
  netAdvance: number;
  note?: string;
}

export interface OutboundProcessResult {
  orders: ProcessedNewOrder[];
  totalNewCod: number;
  totalNewFee: number;
  netNewAdvance: number;
}

export interface ReturnOrderRow {
  waybill: string;
  codAmount?: number;
  returnDate?: string;
  note?: string;
}

export interface HistoricalOrderRecord {
  waybill: string;
  codAmount: number;
  advanceSessionId?: string;
  advanceDate?: string;
  shopId?: string;
}

export interface ProcessedReturnOrder {
  waybill: string;
  recoveredCod: number;
  returnFee: 0; // Strictly 0đ
  lookupSource: 'history' | 'excel';
  historySessionId?: string;
  note?: string;
}

export interface ReturnProcessResult {
  orders: ProcessedReturnOrder[];
  totalReturnedCodRecall: number;
  totalReturnFee: 0;
}

export interface CarrierDiscrepancyRow {
  waybill: string;
  provWeight: number;
  actualWeight: number;
  note?: string;
}

export interface ProcessedCarrierDiscrepancy {
  waybill: string;
  provWeight: number;
  actualWeight: number;
  provFee: number;
  actualFee: number;
  discrepancyFee: number;
  note?: string;
}

export interface DiscrepancyProcessResult {
  items: ProcessedCarrierDiscrepancy[];
  totalDiscrepancyFromRows: number;
  manualAdjustment: number;
  totalWeightAdjustment: number;
}

export interface DailySettlementParams {
  netNewAdvance: number;
  totalReturnedCodRecall: number;
  totalWeightAdjustment: number;
  previousDebt?: number; // < 0 means shop owes money, > 0 means credit surplus
}

export interface DailySettlementResult {
  rawSettlement: number;
  netAdvancePayout: number;
  closingDebt: number;
  isNegativeDebt: boolean;
}

export interface BankAccountInfo {
  bankCode: string;
  accountNumber: string;
  accountHolder: string;
}

/**
 * Standard weight parser:
 * - Handles strings like "400g", "1.2kg", "0,5", "1200", "Hà Nội" (fallback to 0.5)
 * - Converts grams (>50 && <=50000) to kg (/1000)
 * - Preserves kg (<=50)
 * - Clamps abnormal numbers >100 to fallback 0.5kg
 */
export function parseWeightToKg(val: unknown, fallbackKg = 0.5): number {
  if (val === undefined || val === null || val === '') {
    return fallbackKg;
  }

  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) return fallbackKg;
    if (val <= 0) return 0;
    if (val > 50 && val <= 50000) {
      return Math.round((val / 1000) * 1000) / 1000;
    }
    if (val > 100) return fallbackKg;
    return Math.round(val * 1000) / 1000;
  }

  const str = String(val).trim().toLowerCase();
  if (!str) return fallbackKg;

  // Check for explicit "g" or "gram" suffix
  const isGramUnit = /(?:^|\d)\s*(?:g|gram|gr)(?:$|[^\w])/i.test(str);
  const isKgUnit = /(?:^|\d)\s*kg(?:$|[^\w])/i.test(str);

  // Extract first numeric group with either dot or comma
  const numMatch = str.match(/([0-9]+(?:[\.,][0-9]+)?)/);
  if (!numMatch) {
    return fallbackKg;
  }

  const rawNum = parseFloat(numMatch[1].replace(',', '.'));
  if (isNaN(rawNum) || !isFinite(rawNum) || rawNum <= 0) {
    return fallbackKg;
  }

  if (isGramUnit) {
    return Math.round((rawNum / 1000) * 1000) / 1000;
  }

  if (isKgUnit) {
    if (rawNum > 100) return fallbackKg;
    return Math.round(rawNum * 1000) / 1000;
  }

  // Automatic heuristic based on magnitude
  if (rawNum > 50 && rawNum <= 50000) {
    return Math.round((rawNum / 1000) * 1000) / 1000;
  }

  if (rawNum > 100) {
    return fallbackKg;
  }

  return Math.round(rawNum * 1000) / 1000;
}

/**
 * Calculates shipping fee based on shop's custom weight brackets & excess step policy.
 * Formula:
 * - Match tier where minWeight < weight <= maxWeight (or weight <= maxWeight for lowest tier)
 * - Excess beyond highest maxWeight: delta = weight - maxWeight
 *   steps = ceil(delta / extraStepWeight)
 *   fee = baseHighestPrice + steps * extraStepPrice
 */
export function calculateWeightFee(weightKg: number, plan: AdvancePricingPlan): number {
  if (!plan || !plan.weightRules || plan.weightRules.length === 0) {
    return 0;
  }

  const normalizedWeight = Math.max(0, weightKg);
  const sortedRules = [...plan.weightRules].sort((a, b) => a.maxWeight - b.maxWeight);

  // If weight is less than or equal to first tier max
  if (normalizedWeight <= sortedRules[0].maxWeight) {
    return sortedRules[0].price;
  }

  // Match inside intermediate tiers
  for (let i = 0; i < sortedRules.length; i++) {
    const rule = sortedRules[i];
    if (normalizedWeight <= rule.maxWeight) {
      return rule.price;
    }
  }

  // Excess weight calculation
  const highestRule = sortedRules[sortedRules.length - 1];
  const excess = normalizedWeight - highestRule.maxWeight;
  const stepWeight = plan.extraStepWeight > 0 ? plan.extraStepWeight : 0.5;
  const stepPrice = plan.extraStepPrice || 0;

  // Use fixed epsilon to avoid float rounding issues like 1.00000000001
  const steps = Math.ceil(Math.round(excess * 10000) / (stepWeight * 10000));
  return highestRule.price + steps * stepPrice;
}

/**
 * R2.1: Process Outbound Orders (Đơn Đi Mới)
 * netAdvance per order = codAmount - fee
 * Returns aggregated totals.
 */
export function processOutboundOrders(
  orders: NewOrderRow[],
  plan: AdvancePricingPlan
): OutboundProcessResult {
  let totalNewCod = 0;
  let totalNewFee = 0;

  const processedOrders: ProcessedNewOrder[] = orders.map((order) => {
    const weightKg = parseWeightToKg(order.rawWeight);
    const fee = calculateWeightFee(weightKg, plan);
    const codAmount = Number(order.codAmount) || 0;
    const netAdvance = codAmount - fee;

    totalNewCod += codAmount;
    totalNewFee += fee;

    return {
      waybill: order.waybill,
      weightKg,
      codAmount,
      fee,
      netAdvance,
      note: order.note,
    };
  });

  return {
    orders: processedOrders,
    totalNewCod,
    totalNewFee,
    netNewAdvance: totalNewCod - totalNewFee,
  };
}

/**
 * R2.2: Process Return Orders (Đơn Hoàn)
 * Lookup waybill in history:
 * - If found: recoveredCod = history.codAmount, source = 'history'
 * - If not found: recoveredCod = order.codAmount || 0, source = 'excel'
 * Return fee is strictly 0đ.
 */
export function processReturnOrders(
  orders: ReturnOrderRow[],
  historyLookupMap: Record<string, HistoricalOrderRecord>
): ReturnProcessResult {
  let totalReturnedCodRecall = 0;

  const processedOrders: ProcessedReturnOrder[] = orders.map((order) => {
    const hist = historyLookupMap[order.waybill];
    let recoveredCod = 0;
    let lookupSource: 'history' | 'excel' = 'excel';
    let historySessionId: string | undefined = undefined;

    if (hist && typeof hist.codAmount === 'number') {
      recoveredCod = hist.codAmount;
      lookupSource = 'history';
      historySessionId = hist.advanceSessionId;
    } else {
      recoveredCod = Math.max(0, Number(order.codAmount) || 0);
      lookupSource = 'excel';
    }

    totalReturnedCodRecall += recoveredCod;

    return {
      waybill: order.waybill,
      recoveredCod,
      returnFee: 0,
      lookupSource,
      historySessionId,
      note: order.note,
    };
  });

  return {
    orders: processedOrders,
    totalReturnedCodRecall,
    totalReturnFee: 0,
  };
}

/**
 * R2.3: Process Carrier Weight Discrepancy (Vượt Cân NVC)
 * Compares actual weight vs provisional weight using shop's pricing plan.
 * Clamps fee difference at 0 (only positive overcharges count).
 */
export function processCarrierWeightDiscrepancies(
  rows: CarrierDiscrepancyRow[],
  plan: AdvancePricingPlan,
  manualAdjustment = 0
): DiscrepancyProcessResult {
  let totalDiscrepancyFromRows = 0;

  const items: ProcessedCarrierDiscrepancy[] = rows.map((row) => {
    const provKg = parseWeightToKg(row.provWeight);
    const actualKg = parseWeightToKg(row.actualWeight);
    const provFee = calculateWeightFee(provKg, plan);
    const actualFee = calculateWeightFee(actualKg, plan);
    const discrepancyFee = Math.max(0, actualFee - provFee);

    totalDiscrepancyFromRows += discrepancyFee;

    return {
      waybill: row.waybill,
      provWeight: provKg,
      actualWeight: actualKg,
      provFee,
      actualFee,
      discrepancyFee,
      note: row.note,
    };
  });

  const totalWeightAdjustment = totalDiscrepancyFromRows + Math.max(0, manualAdjustment);

  return {
    items,
    totalDiscrepancyFromRows,
    manualAdjustment,
    totalWeightAdjustment,
  };
}

/**
 * R2.4 & R3: Daily Rolling Settlement Formula
 * Thực chuyển ứng hôm nay = (Tổng COD mới - Tổng cước mới) - Thu hồi COD đơn hoàn - Chênh lệch cước vượt cân NVC + Dư/Nợ lũy kế từ ngày trước
 *
 * S = netNewAdvance - totalReturnedCodRecall - totalWeightAdjustment + (previousDebt || 0)
 * - If S > 0: netAdvancePayout = S, closingDebt = 0, isNegativeDebt = false
 * - If S <= 0: netAdvancePayout = 0, closingDebt = S, isNegativeDebt = true
 */
export function computeDailySettlement(params: DailySettlementParams): DailySettlementResult {
  const {
    netNewAdvance,
    totalReturnedCodRecall,
    totalWeightAdjustment,
    previousDebt = 0,
  } = params;

  const rawSettlement =
    netNewAdvance - totalReturnedCodRecall - totalWeightAdjustment + previousDebt;

  if (rawSettlement > 0) {
    return {
      rawSettlement,
      netAdvancePayout: rawSettlement,
      closingDebt: 0,
      isNegativeDebt: false,
    };
  }

  return {
    rawSettlement,
    netAdvancePayout: 0,
    closingDebt: rawSettlement, // Negative value rolls over
    isNegativeDebt: true,
  };
}

/**
 * VietQR Memo Formatter:
 * Strips diacritics, spaces replaced or normalized, alphanumeric only, max 50 chars.
 * Format: "UNG COD <SHOP_CODE> <DATE>"
 */
export function toVietQrMemo(shopCode: string, dateStr: string, customPrefix = 'UNG COD'): string {
  const combined = `${customPrefix} ${shopCode} ${dateStr}`.trim();
  // Strip Vietnamese diacritics
  const normalized = combined
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'))
    .replace(/[^a-zA-Z0-9\s\.\-_]/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();

  return normalized.slice(0, 50);
}

/**
 * VietQR dynamic payment URL generator (NAPAS 247).
 * Returns null if amount <= 0.
 */
export function generateVietQrUrl(
  bankInfo: BankAccountInfo,
  amount: number,
  memo: string
): string | null {
  if (!bankInfo || !bankInfo.bankCode || !bankInfo.accountNumber) return null;
  if (amount <= 0) return null;

  const cleanAccount = bankInfo.accountNumber.trim().replace(/\s+/g, '');
  const roundedAmount = Math.round(amount);
  const encodedMemo = encodeURIComponent(memo);
  const encodedHolder = encodeURIComponent(bankInfo.accountHolder || '');

  return `https://img.vietqr.io/image/${bankInfo.bankCode}-${cleanAccount}-compact2.png?amount=${roundedAmount}&addInfo=${encodedMemo}&accountName=${encodedHolder}`;
}

/**
 * Excel Statement Workbook Generator (4 sheets)
 * 1. TONG_HOP_UNG_COD: KPI summary & settlement figures
 * 2. CHI_TIET_DON_DI: List of outbound orders with formula sums
 * 3. CHI_TIET_DON_HOAN: List of return orders with 0đ return fee
 * 4. CHENH_LECH_CUOC_NVC: Discrepancy details
 */
export async function generateStatementWorkbook(sessionData: {
  shopName: string;
  shopCode: string;
  advanceDate: string;
  bankAccount: BankAccountInfo;
  outbound: OutboundProcessResult;
  returns: ReturnProcessResult;
  discrepancy: DiscrepancyProcessResult;
  settlement: DailySettlementResult;
  previousDebt: number;
}): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Gom Don T+0 COD Advance System';
  workbook.created = new Date();

  // --- SHEET 1: TONG_HOP_UNG_COD ---
  const sheetSummary = workbook.addWorksheet('TONG_HOP_UNG_COD');
  sheetSummary.columns = [
    { header: 'Chỉ số quyết toán', key: 'metric', width: 40 },
    { header: 'Giá trị (VND / Số lượng)', key: 'value', width: 25 },
    { header: 'Ghi chú', key: 'note', width: 35 },
  ];

  sheetSummary.addRows([
    { metric: 'Shop', value: `${sessionData.shopName} (${sessionData.shopCode})`, note: '' },
    { metric: 'Ngày ứng COD', value: sessionData.advanceDate, note: 'T+0 Hàng ngày' },
    { metric: 'Tài khoản thụ hưởng', value: `${sessionData.bankAccount.bankCode} - ${sessionData.bankAccount.accountNumber}`, note: sessionData.bankAccount.accountHolder },
    { metric: '------------------------------', value: '--------------------', note: '' },
    { metric: '1. Tổng số đơn mới', value: sessionData.outbound.orders.length, note: 'Đơn gửi đi trong ngày' },
    { metric: '2. Tổng COD đơn mới', value: sessionData.outbound.totalNewCod, note: 'Tổng tiền thu hộ' },
    { metric: '3. Tổng cước tạm tính đơn mới', value: sessionData.outbound.totalNewFee, note: 'Theo bảng giá riêng của Shop' },
    { metric: '4. Tiền ứng đơn mới (2 - 3)', value: sessionData.outbound.netNewAdvance, note: 'COD mới - Cước mới' },
    { metric: '------------------------------', value: '--------------------', note: '' },
    { metric: '5. Tổng số đơn hoàn', value: sessionData.returns.orders.length, note: 'Đơn hoàn về trong ngày' },
    { metric: '6. Cước hoàn phát sinh', value: 0, note: 'Miễn phí cước hoàn (0đ)' },
    { metric: '7. Thu hồi COD đơn hoàn', value: sessionData.returns.totalReturnedCodRecall, note: 'Tra cứu lịch sử / file Excel' },
    { metric: '------------------------------', value: '--------------------', note: '' },
    { metric: '8. Chênh lệch cước vượt cân NVC', value: sessionData.discrepancy.totalWeightAdjustment, note: 'Đối soát NVC + Nhập tay' },
    { metric: '9. Dư/Nợ lũy kế kỳ trước', value: sessionData.previousDebt, note: 'Âm là Nợ, Dương là Dư' },
    { metric: '------------------------------', value: '--------------------', note: '' },
    { metric: '10. TỔNG THỰC CHUYỂN HÔM NAY', value: sessionData.settlement.netAdvancePayout, note: sessionData.settlement.isNegativeDebt ? 'SHOP NỢ (KẾT CHUYỂN KỲ SAU)' : 'ĐÃ TẠO MÃ VIETQR' },
    { metric: '11. Công nợ chuyển kỳ tiếp theo', value: sessionData.settlement.closingDebt, note: sessionData.settlement.closingDebt < 0 ? 'Khấu trừ vào ngày tiếp theo' : '0đ' },
  ]);

  // --- SHEET 2: CHI_TIET_DON_DI ---
  const sheetOutbound = workbook.addWorksheet('CHI_TIET_DON_DI');
  sheetOutbound.columns = [
    { header: 'STT', key: 'stt', width: 8 },
    { header: 'Mã Vận Đơn', key: 'waybill', width: 22 },
    { header: 'Cân Nặng (kg)', key: 'weight', width: 15 },
    { header: 'Tiền COD (đ)', key: 'cod', width: 18 },
    { header: 'Cước Phí (đ)', key: 'fee', width: 18 },
    { header: 'Tiền Tạm Ứng (đ)', key: 'netAdvance', width: 20 },
    { header: 'Ghi Chú', key: 'note', width: 25 },
  ];

  sessionData.outbound.orders.forEach((ord, index) => {
    sheetOutbound.addRow({
      stt: index + 1,
      waybill: ord.waybill,
      weight: ord.weightKg,
      cod: ord.codAmount,
      fee: ord.fee,
      netAdvance: ord.netAdvance,
      note: ord.note || '',
    });
  });

  const lastOutRow = sessionData.outbound.orders.length + 1;
  sheetOutbound.addRow({
    stt: 'TỔNG CỘNG',
    waybill: '',
    weight: '',
    cod: { formula: `SUM(D2:D${lastOutRow})` },
    fee: { formula: `SUM(E2:E${lastOutRow})` },
    netAdvance: { formula: `SUM(F2:F${lastOutRow})` },
    note: '',
  });

  // --- SHEET 3: CHI_TIET_DON_HOAN ---
  const sheetReturns = workbook.addWorksheet('CHI_TIET_DON_HOAN');
  sheetReturns.columns = [
    { header: 'STT', key: 'stt', width: 8 },
    { header: 'Mã Vận Đơn', key: 'waybill', width: 22 },
    { header: 'Tiền COD Thu Hồi (đ)', key: 'codRecall', width: 22 },
    { header: 'Cước Hoàn (đ)', key: 'returnFee', width: 16 },
    { header: 'Nguồn Tra Cứu', key: 'source', width: 25 },
    { header: 'Ghi Chú', key: 'note', width: 25 },
  ];

  sessionData.returns.orders.forEach((ord, index) => {
    sheetReturns.addRow({
      stt: index + 1,
      waybill: ord.waybill,
      codRecall: ord.recoveredCod,
      returnFee: 0,
      source: ord.lookupSource === 'history' ? 'Lịch sử ứng COD' : 'File Excel đơn hoàn',
      note: ord.note || '',
    });
  });

  const lastRetRow = sessionData.returns.orders.length + 1;
  sheetReturns.addRow({
    stt: 'TỔNG CỘNG',
    waybill: '',
    codRecall: { formula: `SUM(C2:C${lastRetRow})` },
    returnFee: 0,
    source: '',
    note: '',
  });

  // --- SHEET 4: CHENH_LECH_CUOC_NVC ---
  const sheetDiscrepancy = workbook.addWorksheet('CHENH_LECH_CUOC_NVC');
  sheetDiscrepancy.columns = [
    { header: 'STT', key: 'stt', width: 8 },
    { header: 'Mã Vận Đơn', key: 'waybill', width: 22 },
    { header: 'Cân Nặng Tạm Tính (kg)', key: 'provWeight', width: 24 },
    { header: 'Cân Nặng Thực Tế NVC (kg)', key: 'actualWeight', width: 26 },
    { header: 'Cước Tạm Tính (đ)', key: 'provFee', width: 20 },
    { header: 'Cước Thực Tế (đ)', key: 'actualFee', width: 20 },
    { header: 'Chênh Lệch Cước (đ)', key: 'diff', width: 20 },
    { header: 'Ghi Chú', key: 'note', width: 25 },
  ];

  sessionData.discrepancy.items.forEach((item, index) => {
    sheetDiscrepancy.addRow({
      stt: index + 1,
      waybill: item.waybill,
      provWeight: item.provWeight,
      actualWeight: item.actualWeight,
      provFee: item.provFee,
      actualFee: item.actualFee,
      diff: item.discrepancyFee,
      note: item.note || '',
    });
  });

  return workbook;
}
