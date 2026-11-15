/**
 * src/services/codAdvanceService.ts
 * Core Business Logic, Pricing Engine, Excel Parser & Exporter for T+0 COD Advance
 *
 * Fully conforms to:
 * - ORIGINAL_REQUEST.md (§R1, §R2, §R3)
 * - PROJECT.md (§F4, §F5, §F6, §F7, §F9, §F10)
 * - SCOPE.md (Milestone 2 Contract)
 */

import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { BANK_CODES } from '../constants/banks.ts';
import type {
  AdvancePricingPlan,
  AdvanceWeightRule,
  AdvanceShopProfile,
  AdvanceSession,
  AdvanceOrderNew,
  AdvanceOrderReturned,
  AdvanceWeightAdjustment,
  AdvanceOrderHistoryRecord,
  OrderLifecycleItem,
  OrderTrackingConfig,
  OrderTrackingStats,
} from '../types/codAdvance.ts';

function saveBlobFile(blob: Blob, filename: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 150);
}

export type {
  AdvancePricingPlan,
  AdvanceWeightRule,
  AdvanceShopProfile,
  AdvanceSession,
  AdvanceOrderNew,
  AdvanceOrderReturned,
  AdvanceWeightAdjustment,
  AdvanceOrderHistoryRecord,
};

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface WeightRule {
  minWeight: number; // kg
  maxWeight: number; // kg
  price: number;     // VND
}

export interface NewOrderRow {
  waybill: string;
  rawWeight: string | number;
  codAmount: number;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
  note?: string;
}

export interface ProcessedNewOrder {
  waybill: string;
  weightKg: number;
  codAmount: number;
  fee: number;
  netAdvance: number;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
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
  bankCode?: string;
  bankName?: string;
  accountNumber: string;
  accountHolder: string;
}

export interface StatementSessionData {
  shopName: string;
  shopCode: string;
  advanceDate: string;
  bankAccount: BankAccountInfo;
  outbound: OutboundProcessResult;
  returns: ReturnProcessResult;
  discrepancy: DiscrepancyProcessResult;
  settlement: DailySettlementResult;
  previousDebt: number;
}

// ============================================================================
// Helper Functions for Text & Number Normalization
// ============================================================================

/**
 * Normalizes header string for column alias matching.
 * Lowercases, converts đ/Đ to d, removes diacritics, replaces non-alphanumerics with _.
 */
export function normalizeHeader(header: string): string {
  if (!header) return '';
  return header
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Robustly parses numeric strings from Excel files.
 * Correctly distinguishes Vietnamese dot-thousands (1.200.000) and decimal commas (0,75).
 */
export function parseNumber(val: unknown): number {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) || !isFinite(val) ? 0 : val;

  let str = String(val)
    .replace(/đ|vnd|₫/gi, '')
    .replace(/\s/g, '')
    .replace(/[^0-9,.-]/g, '');
  if (!str || str === '-' || str === '.' || str === ',') return 0;

  const commaCount = (str.match(/,/g) || []).length;
  const dotCount = (str.match(/\./g) || []).length;
  if (commaCount > 0 && dotCount > 0) {
    if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (commaCount > 0 || dotCount > 0) {
    const separator = commaCount > 0 ? ',' : '.';
    const count = commaCount || dotCount;
    const parts = str.split(separator);
    const decimalDigits = parts[parts.length - 1].length;
    const looksLikeThousands =
      count > 1 || (count === 1 && decimalDigits === 3 && parts[0].replace('-', '').length > 0);
    if (looksLikeThousands) {
      str = str.split(separator).join('');
    } else if (separator === ',') {
      str = str.replace(',', '.');
    }
  }

  const num = Number(str);
  return isNaN(num) || !isFinite(num) ? 0 : num;
}

/**
 * Checks and filters out summary footer rows (e.g. Tổng cộng, Total, Grand Total, Kế toán).
 */
export function isSummaryOrInvalidWaybill(waybillRaw: unknown): boolean {
  if (waybillRaw === undefined || waybillRaw === null) return true;
  const str = String(waybillRaw).trim().toLowerCase();
  if (
    !str ||
    str === '-' ||
    str === '--' ||
    str === '---' ||
    str === 'n/a' ||
    str === 'null' ||
    str === 'undefined'
  ) {
    return true;
  }

  const normalized = normalizeHeader(str);
  const summaryKeywords = [
    'tong',
    'tong_cong',
    'total',
    'grand_total',
    'tong_tien',
    'tong_cuoc',
    'tong_cod',
    'tong_so_don',
    'cong',
    'cong_lai',
    'ghi_chu',
    'luu_y',
    'ke_toan',
    'nguoi_lap',
    'chu_ky',
    'stt',
    'thong_ke',
    'tong_ket',
    'bao_cao',
    'so_luong',
  ];

  if (summaryKeywords.some((kw) => normalized === kw || normalized.startsWith(kw + '_'))) {
    return true;
  }

  if (
    (normalized.includes('tong_cong') || normalized.includes('total') || normalized.includes('tong_')) &&
    str.length < 35
  ) {
    return true;
  }

  return false;
}

/**
 * Safely converts file input into Uint8Array buffer across Node.js and Browser environments.
 */
async function toUint8Array(input: ArrayBuffer | Uint8Array | File | Blob | any): Promise<Uint8Array> {
  if (typeof File !== 'undefined' && input instanceof File) {
    const arrayBuffer = await input.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const arrayBuffer = await input.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
    return new Uint8Array(input);
  }
  return new Uint8Array(input);
}

/**
 * Parses date inputs from Excel cells (supports serial date, Date, DD/MM/YYYY, YYYY-MM-DD).
 */
function parseExcelDate(val: unknown): string | undefined {
  if (!val) return undefined;
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === 'number') {
    if (val > 25000 && val < 75000) {
      const date = new Date((val - (25567 + 2)) * 86400 * 1000);
      return date.toISOString().slice(0, 10);
    }
  }
  const str = String(val).trim();
  const dmy = str.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    const year = dmy[3];
    return `${year}-${month}-${day}`;
  }
  const ymd = str.match(/^(\d{4})[\/\.-](\d{1,2})[\/\.-](\d{1,2})/);
  if (ymd) {
    const year = ymd[1];
    const month = ymd[2].padStart(2, '0');
    const day = ymd[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return str || undefined;
}

// ============================================================================
// Core Math & Pricing Functions
// ============================================================================

/**
 * Standard weight parser:
 * - Handles strings like "400g", "1.2kg", "0,5", "1200", "Hà Nội" (fallback to fallbackKg)
 * - Converts grams (>50 && <=50000) to kg (/1000)
 * - Preserves kg (<=50)
 * - Clamps abnormal parcel weights > 100 to fallbackKg
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
export function calculateWeightFee(
  weightKg: number,
  plan: AdvancePricingPlan | { weightRules: WeightRule[]; extraStepWeight?: number; extraStepPrice?: number }
): number {
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
  const stepWeight = plan.extraStepWeight && plan.extraStepWeight > 0 ? plan.extraStepWeight : 0.5;
  const stepPrice = plan.extraStepPrice || 0;

  // Use integer micro-gram scaling to avoid float rounding artifacts
  const steps = Math.ceil(Math.round(excess * 10000) / (stepWeight * 10000));
  return highestRule.price + steps * stepPrice;
}

// ============================================================================
// Order Processing Functions
// ============================================================================

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
      receiverName: order.receiverName,
      receiverPhone: order.receiverPhone,
      receiverAddress: order.receiverAddress,
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
 * - If found: recoveredCod = history.codAmount, lookupSource = 'history'
 * - If not found: recoveredCod = order.codAmount || 0, lookupSource = 'excel'
 * Return fee is strictly 0đ.
 */
export function processReturnOrders(
  orders: ReturnOrderRow[],
  historyLookupMap: Record<string, HistoricalOrderRecord | AdvanceOrderHistoryRecord>
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

// ============================================================================
// VietQR Payment Helpers
// ============================================================================

/**
 * VietQR Memo Formatter:
 * Strips diacritics, spaces normalized, alphanumeric only, max 50 chars.
 * Format: "UNG COD <SHOP_CODE> <DATE>"
 */
export function toVietQrMemo(shopCode: string, dateStr: string, customPrefix = 'UNG COD'): string {
  const combined = `${customPrefix} ${shopCode} ${dateStr}`.trim();
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
 * Returns null if amount <= 0 or bank info is incomplete.
 */
export function generateVietQrUrl(
  bankInfo: BankAccountInfo,
  amount: number,
  memo: string
): string | null {
  if (!bankInfo || !bankInfo.accountNumber) return null;
  if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) return null;

  const rawBank = (bankInfo.bankCode || bankInfo.bankName || '').trim();
  if (!rawBank) return null;

  const bankCode = (BANK_CODES[rawBank] || rawBank).replace(/\s+/g, '');
  const cleanAccount = bankInfo.accountNumber.trim().replace(/\s+/g, '');
  if (!cleanAccount) return null;

  const roundedAmount = Math.round(amount);
  if (roundedAmount <= 0) return null;

  const encodedMemo = encodeURIComponent(memo);
  const encodedHolder = encodeURIComponent(bankInfo.accountHolder || '');

  return `https://img.vietqr.io/image/${bankCode}-${cleanAccount}-compact2.png?amount=${roundedAmount}&addInfo=${encodedMemo}&accountName=${encodedHolder}`;
}

// ============================================================================
// Excel File Parsers (XLSX / SheetJS)
// ============================================================================

/**
 * Parses Outbound (Đơn đi mới) Excel file.
 * Automatically identifies header row, resolves 2-tier headers, eliminates footer summaries.
 */
export async function parseOutboundExcel(
  fileOrBuffer: ArrayBuffer | Uint8Array | File | Blob | any,
  options?: { sheetName?: string }
): Promise<NewOrderRow[]> {
  const data = await toUint8Array(fileOrBuffer);
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('File Excel rỗng, không chứa trang tính (sheet) nào.');
  }

  const sheetName = options?.sheetName || workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error(`Không tìm thấy sheet "${sheetName}" trong file Excel.`);
  }

  const rawSheetData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  if (!rawSheetData || rawSheetData.length === 0) return [];

  // Detect header row index via scoring
  let headerRowIndex = 0;
  let bestScore = -1;
  for (let r = 0; r < Math.min(15, rawSheetData.length); r++) {
    const row = rawSheetData[r];
    if (!Array.isArray(row)) continue;
    const rowStr = row.map((c) => normalizeHeader(String(c))).join(' ');
    let score = 0;
    if (
      rowStr.includes('ma_van_don') ||
      rowStr.includes('tracking') ||
      rowStr.includes('mvd') ||
      rowStr.includes('ma_don')
    ) {
      score += 5;
    }
    if (
      rowStr.includes('tien_thu_ho') ||
      rowStr.includes('cod') ||
      rowStr.includes('tien_cod') ||
      rowStr.includes('thu_ho')
    ) {
      score += 4;
    }
    if (
      rowStr.includes('can_nang') ||
      rowStr.includes('khoi_luong') ||
      rowStr.includes('trong_luong') ||
      rowStr.includes('weight')
    ) {
      score += 3;
    }
    if (rowStr.includes('nguoi_nhan') || rowStr.includes('receiver') || rowStr.includes('sdt')) {
      score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      headerRowIndex = r;
    }
  }

  // Check for 2-tier merged headers (e.g. GHN format)
  let hasSecondHeaderRow = false;
  if (headerRowIndex + 1 < rawSheetData.length) {
    const nextRow = rawSheetData[headerRowIndex + 1];
    if (Array.isArray(nextRow)) {
      const nextRowStr = nextRow.map((c) => normalizeHeader(String(c))).join(' ');
      const isNextRowHeader =
        nextRowStr.includes('ma_van_don') ||
        nextRowStr.includes('tracking') ||
        nextRowStr.includes('mvd') ||
        nextRowStr.includes('ma_don') ||
        nextRowStr.includes('thu_ho') ||
        nextRowStr.includes('cod') ||
        nextRowStr.includes('trong_luong') ||
        nextRowStr.includes('can_nang') ||
        nextRowStr.includes('sdt');
      const hasRealNumericData = nextRow.some((val) => typeof val === 'number' && val > 100);
      if (isNextRowHeader && !hasRealNumericData) {
        hasSecondHeaderRow = true;
      }
    }
  }

  const topHeadersRow = rawSheetData[headerRowIndex] || [];
  const subHeadersRow = hasSecondHeaderRow ? rawSheetData[headerRowIndex + 1] || [] : [];
  const maxCols = Math.max(topHeadersRow.length, subHeadersRow.length);

  // Forward-fill merged parent headers
  let currentParentHeader = '';
  const resolvedTopHeaders: string[] = [];
  for (let cIdx = 0; cIdx < maxCols; cIdx++) {
    const topVal = String(topHeadersRow[cIdx] || '').trim();
    if (topVal) currentParentHeader = topVal;
    resolvedTopHeaders.push(topVal || currentParentHeader);
  }

  const headers: string[] = [];
  for (let cIdx = 0; cIdx < maxCols; cIdx++) {
    const topH = (resolvedTopHeaders[cIdx] || '').trim();
    const subH = String(subHeadersRow[cIdx] || '').trim();
    let finalHeaderName = '';
    if (topH && subH && topH !== subH && !topH.toLowerCase().startsWith('stt')) {
      finalHeaderName = `${topH}_${subH}`;
    } else if (subH) {
      finalHeaderName = subH;
    } else if (topH) {
      finalHeaderName = topH;
    } else {
      finalHeaderName = `col_${cIdx + 1}`;
    }
    headers.push(normalizeHeader(finalHeaderName));
  }

  const findCol = (aliases: string[], forbidden: string[] = []): number => {
    return headers.findIndex((h) => {
      if (forbidden.some((f) => h.includes(f))) return false;
      return aliases.some(
        (a) => h === a || h.startsWith(a + '_') || h.endsWith('_' + a) || h.includes(a)
      );
    });
  };

  const waybillColIdx = findCol(
    [
      'ma_van_don',
      'mvd',
      'tracking',
      'tracking_number',
      'tracking_code',
      'ma_don',
      'ma_don_hang',
      'so_hieu',
      'waybill',
      'order_code',
      'ma_bill',
      'stt_ma_don',
      'shipment_id',
      'bill_code',
      'ma_tra_cuu',
      'ma_kien_hang',
      'so_phieu_gui',
    ],
    ['tien', 'cod', 'cuoc', 'phi', 'nguoi_gui', 'nguoi_nhan', 'dia_chi', 'sdt', 'phone']
  );

  const weightColIdx = findCol(
    [
      'can_nang',
      'khoi_luong',
      'trong_luong',
      'weight',
      'gross_weight',
      'chargeable_weight',
      'actual_weight',
      'package_weight',
      'kl_quy_doi',
      'trong_luong_tinh_phi',
      'tl_tinh_phi',
      'can_nang_tinh_cuoc',
      'can_nang_kg',
      'khoi_luong_kg',
      'trong_luong_kg',
    ],
    ['dia_chi', 'sdt', 'phone', 'ten', 'name', 'tien', 'cod', 'cuoc', 'phi']
  );

  const codColIdx = findCol(
    [
      'tien_thu_ho',
      'cod',
      'tien_cod',
      'thu_ho',
      'so_tien_cod',
      'cod_amount',
      'collect_amount',
      'so_tien_thu_ho',
      'tong_cod',
      'cod_thu_ho',
      'so_tien_thu',
      'tong_tien_thu_ho',
      'tien_tra_nguoi_gui',
      'tien_co_cod',
      'cod_tra_shop',
    ],
    ['phi', 'cuoc', 'van_don', 'tracking', 'trong_luong', 'can_nang']
  );

  const receiverNameColIdx = findCol([
    'ten_nguoi_nhan',
    'ho_ten_nguoi_nhan',
    'nguoi_nhan',
    'receiver_name',
    'ten_khach_nhan',
    'khach_hang',
  ]);
  const receiverPhoneColIdx = findCol([
    'sdt_nhan',
    'sdt_nguoi_nhan',
    'dien_thoai_nhan',
    'receiver_phone',
    'so_dien_thoai_nhan',
    'sdt',
  ]);
  const receiverAddressColIdx = findCol([
    'dia_chi_nhan',
    'dia_chi_nguoi_nhan',
    'receiver_address',
    'dia_chi_giao_hang',
    'dia_chi',
  ]);
  const noteColIdx = findCol(['ghi_chu', 'note', 'notes', 'mo_ta']);

  if (waybillColIdx === -1) {
    throw new Error('Không tìm thấy cột Mã vận đơn (Waybill/Tracking) trong file Excel đơn đi.');
  }

  const dataStartRow = headerRowIndex + (hasSecondHeaderRow ? 2 : 1);
  const results: NewOrderRow[] = [];

  for (let r = dataStartRow; r < rawSheetData.length; r++) {
    const row = rawSheetData[r];
    if (!Array.isArray(row)) continue;
    if (row.every((v) => v === '' || v === null || v === undefined)) continue;

    const rawWaybill = row[waybillColIdx];
    if (isSummaryOrInvalidWaybill(rawWaybill)) continue;

    const waybill = String(rawWaybill).trim();
    if (!waybill || waybill === '-' || waybill === '--' || waybill.length < 3) continue;

    const rawWeight = weightColIdx !== -1 ? row[weightColIdx] : 0.5;
    const codAmount = codColIdx !== -1 ? parseNumber(row[codColIdx]) : 0;

    results.push({
      waybill,
      rawWeight: rawWeight !== '' && rawWeight !== undefined && rawWeight !== null ? rawWeight : 0.5,
      codAmount: Math.max(0, codAmount),
      receiverName:
        receiverNameColIdx !== -1 ? String(row[receiverNameColIdx] || '').trim() || undefined : undefined,
      receiverPhone:
        receiverPhoneColIdx !== -1 ? String(row[receiverPhoneColIdx] || '').trim() || undefined : undefined,
      receiverAddress:
        receiverAddressColIdx !== -1 ? String(row[receiverAddressColIdx] || '').trim() || undefined : undefined,
      note: noteColIdx !== -1 ? String(row[noteColIdx] || '').trim() || undefined : undefined,
    });
  }

  return results;
}

/**
 * Parses Return (Đơn hoàn) Excel file.
 * Extracts waybill and optional COD fallback, returnDate, and note.
 */
export async function parseReturnExcel(
  fileOrBuffer: ArrayBuffer | Uint8Array | File | Blob | any,
  options?: { sheetName?: string }
): Promise<ReturnOrderRow[]> {
  const data = await toUint8Array(fileOrBuffer);
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('File Excel rỗng, không chứa trang tính (sheet) nào.');
  }

  const sheetName = options?.sheetName || workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error(`Không tìm thấy sheet "${sheetName}" trong file Excel.`);
  }

  const rawSheetData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  if (!rawSheetData || rawSheetData.length === 0) return [];

  let headerRowIndex = 0;
  let bestScore = -1;
  for (let r = 0; r < Math.min(15, rawSheetData.length); r++) {
    const row = rawSheetData[r];
    if (!Array.isArray(row)) continue;
    const rowStr = row.map((c) => normalizeHeader(String(c))).join(' ');
    let score = 0;
    if (rowStr.includes('ma_van_don') || rowStr.includes('tracking') || rowStr.includes('mvd')) score += 5;
    if (rowStr.includes('hoan') || rowStr.includes('return') || rowStr.includes('tra')) score += 4;
    if (rowStr.includes('cod') || rowStr.includes('thu_ho')) score += 3;
    if (rowStr.includes('ngay') || rowStr.includes('date')) score += 2;
    if (score > bestScore) {
      bestScore = score;
      headerRowIndex = r;
    }
  }

  const headers = (rawSheetData[headerRowIndex] || []).map((c) => normalizeHeader(String(c)));
  const findCol = (aliases: string[], forbidden: string[] = []): number => {
    return headers.findIndex((h) => {
      if (forbidden.some((f) => h.includes(f))) return false;
      return aliases.some(
        (a) => h === a || h.startsWith(a + '_') || h.endsWith('_' + a) || h.includes(a)
      );
    });
  };

  const waybillColIdx = findCol(
    [
      'ma_van_don',
      'mvd',
      'tracking',
      'tracking_number',
      'tracking_code',
      'ma_don',
      'so_hieu',
      'waybill',
      'order_code',
      'ma_bill',
    ],
    ['tien', 'cod', 'cuoc', 'phi']
  );

  const codColIdx = findCol([
    'tien_cod',
    'cod',
    'tien_thu_ho',
    'thu_ho',
    'tien_hoan',
    'so_tien_thu_ho',
    'cod_thu_ho',
    'cod_amount',
    'so_tien_cod',
  ]);

  const returnDateColIdx = findCol(
    ['ngay_hoan', 'ngay_tra', 'ngay_chuyen_hoan', 'ngay_nhan_hoan', 'return_date', 'date_returned', 'ngay'],
    ['sinh', 'tao', 'gui']
  );

  const noteColIdx = findCol([
    'ly_do_hoan',
    'ly_do',
    'ghi_chu',
    'note',
    'reason',
    'return_reason',
    'ly_do_chuyen_hoan',
  ]);

  if (waybillColIdx === -1) {
    throw new Error('Không tìm thấy cột Mã vận đơn trong file đơn hoàn.');
  }

  const results: ReturnOrderRow[] = [];
  for (let r = headerRowIndex + 1; r < rawSheetData.length; r++) {
    const row = rawSheetData[r];
    if (!Array.isArray(row)) continue;
    if (row.every((v) => v === '' || v === null || v === undefined)) continue;

    const rawWaybill = row[waybillColIdx];
    if (isSummaryOrInvalidWaybill(rawWaybill)) continue;

    const waybill = String(rawWaybill).trim();
    if (!waybill || waybill === '-' || waybill === '--' || waybill.length < 3) continue;

    const rawCod = codColIdx !== -1 ? row[codColIdx] : undefined;
    const codAmount =
      rawCod !== undefined && rawCod !== '' && rawCod !== null
        ? Math.max(0, parseNumber(rawCod))
        : undefined;

    const returnDate = returnDateColIdx !== -1 ? parseExcelDate(row[returnDateColIdx]) : undefined;

    results.push({
      waybill,
      codAmount,
      returnDate,
      note: noteColIdx !== -1 ? String(row[noteColIdx] || '').trim() || undefined : undefined,
    });
  }

  return results;
}

/**
 * Parses Carrier Weight Discrepancy (Đối soát vượt cân NVC) Excel file.
 * Identifies actual weight from carrier and optional declared/provisional weight.
 */
export async function parseCarrierDiscrepancyExcel(
  fileOrBuffer: ArrayBuffer | Uint8Array | File | Blob | any,
  options?: { sheetName?: string }
): Promise<CarrierDiscrepancyRow[]> {
  const data = await toUint8Array(fileOrBuffer);
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('File Excel rỗng, không chứa trang tính (sheet) nào.');
  }

  const sheetName = options?.sheetName || workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error(`Không tìm thấy sheet "${sheetName}" trong file Excel.`);
  }

  const rawSheetData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  if (!rawSheetData || rawSheetData.length === 0) return [];

  let headerRowIndex = 0;
  let bestScore = -1;
  for (let r = 0; r < Math.min(15, rawSheetData.length); r++) {
    const row = rawSheetData[r];
    if (!Array.isArray(row)) continue;
    const rowStr = row.map((c) => normalizeHeader(String(c))).join(' ');
    let score = 0;
    if (rowStr.includes('ma_van_don') || rowStr.includes('tracking') || rowStr.includes('mvd')) score += 5;
    if (rowStr.includes('thuc_te') || rowStr.includes('nvc') || rowStr.includes('sau_kiem')) score += 4;
    if (rowStr.includes('tam_tinh') || rowStr.includes('khai_bao')) score += 3;
    if (score > bestScore) {
      bestScore = score;
      headerRowIndex = r;
    }
  }

  const headers = (rawSheetData[headerRowIndex] || []).map((c) => normalizeHeader(String(c)));
  const findCol = (aliases: string[], forbidden: string[] = []): number => {
    return headers.findIndex((h) => {
      if (forbidden.some((f) => h.includes(f))) return false;
      return aliases.some(
        (a) => h === a || h.startsWith(a + '_') || h.endsWith('_' + a) || h.includes(a)
      );
    });
  };

  const waybillColIdx = findCol(
    ['ma_van_don', 'mvd', 'tracking', 'tracking_number', 'ma_don', 'waybill'],
    ['tien', 'cod', 'cuoc', 'phi']
  );

  const actualWeightColIdx = findCol([
    'can_nang_thuc_te',
    'khoi_luong_thuc_te',
    'trong_luong_thuc_te',
    'can_nang_nvc',
    'khoi_luong_nvc',
    'can_nang_sau_kiem',
    'actual_weight',
    'carrier_weight',
    'billed_weight',
    'tl_thuc_te',
    'kl_thuc_te',
    'reconciled_weight',
    'trong_luong_nvc',
    'trong_luong_sau_kiem',
  ]);

  const provWeightColIdx = findCol([
    'can_nang_tam_tinh',
    'khoi_luong_tam_tinh',
    'trong_luong_tam_tinh',
    'can_nang_khai_bao',
    'khoi_luong_khai_bao',
    'prov_weight',
    'declared_weight',
    'advance_weight',
    'can_nang_shop',
    'can_nang_gui',
  ]);

  const noteColIdx = findCol(['ghi_chu', 'note', 'ly_do_lech', 'discrepancy_reason', 'ly_do']);

  if (waybillColIdx === -1) {
    throw new Error('Không tìm thấy cột Mã vận đơn trong file đối soát vượt cân NVC.');
  }
  if (actualWeightColIdx === -1) {
    throw new Error('Không tìm thấy cột Cân nặng thực tế NVC trong file đối soát vượt cân.');
  }

  const results: CarrierDiscrepancyRow[] = [];
  for (let r = headerRowIndex + 1; r < rawSheetData.length; r++) {
    const row = rawSheetData[r];
    if (!Array.isArray(row)) continue;
    if (row.every((v) => v === '' || v === null || v === undefined)) continue;

    const rawWaybill = row[waybillColIdx];
    if (isSummaryOrInvalidWaybill(rawWaybill)) continue;

    const waybill = String(rawWaybill).trim();
    if (!waybill || waybill === '-' || waybill === '--' || waybill.length < 3) continue;

    const actualWeight = parseWeightToKg(row[actualWeightColIdx]);
    const provWeight = provWeightColIdx !== -1 ? parseWeightToKg(row[provWeightColIdx]) : 0.5;

    results.push({
      waybill,
      actualWeight,
      provWeight,
      note: noteColIdx !== -1 ? String(row[noteColIdx] || '').trim() || undefined : undefined,
    });
  }

  return results;
}

// ============================================================================
// Multi-Sheet Statement Workbook Generator & Blob Export (ExcelJS)
// ============================================================================

/**
 * Normalizes AdvanceSession (from backend or state) or StatementSessionData (from calculation)
 * into a unified StatementSessionData structure for Excel generation.
 */
export function normalizeStatementSessionData(
  sessionOrData: AdvanceSession | StatementSessionData
): StatementSessionData {
  if ('outbound' in sessionOrData && 'returns' in sessionOrData) {
    return sessionOrData as StatementSessionData;
  }

  const session = sessionOrData as AdvanceSession;
  const outboundOrders = (session.newOrders || []).map((o: AdvanceOrderNew) => ({
    waybill: o.waybill,
    weightKg: o.weight,
    codAmount: o.codAmount,
    fee: o.appliedFee,
    netAdvance: o.netAdvance,
    note: o.note,
  }));

  const returnOrders = (session.returnedOrders || []).map((r: AdvanceOrderReturned) => ({
    waybill: r.waybill,
    recoveredCod: r.codAmount,
    returnFee: 0 as const,
    lookupSource: (r.isFromHistory ? 'history' : 'excel') as 'history' | 'excel',
    historySessionId: r.originalAdvanceSessionId,
    note: r.note,
  }));

  const discrepancyItems = (session.weightAdjustments || []).map((w: AdvanceWeightAdjustment) => ({
    waybill: w.waybill || '',
    provWeight: w.advanceWeight || 0,
    actualWeight: w.actualWeight || 0,
    provFee: w.advanceFee || 0,
    actualFee: w.actualFee || 0,
    discrepancyFee: w.feeDifference || 0,
    note: w.note,
  }));

  const totalDiscrepancyFromRows = discrepancyItems.reduce((sum: number, item) => sum + item.discrepancyFee, 0);

  return {
    shopName: session.shopName || '',
    shopCode: session.shopCode || '',
    advanceDate: session.advanceDate || '',
    bankAccount: {
      bankCode: session.bankInfo?.bankName
        ? BANK_CODES[session.bankInfo.bankName] || session.bankInfo.bankName
        : undefined,
      bankName: session.bankInfo?.bankName,
      accountNumber: session.bankInfo?.accountNumber || '',
      accountHolder: session.bankInfo?.accountHolder || '',
    },
    outbound: {
      orders: outboundOrders,
      totalNewCod: session.totalNewCod || 0,
      totalNewFee: session.totalNewFee || 0,
      netNewAdvance: session.netNewAdvance || 0,
    },
    returns: {
      orders: returnOrders,
      totalReturnedCodRecall: session.totalReturnedCodRecall || 0,
      totalReturnFee: 0,
    },
    discrepancy: {
      items: discrepancyItems,
      totalDiscrepancyFromRows,
      manualAdjustment: session.manualAdjustmentAmount || 0,
      totalWeightAdjustment: session.totalWeightAdjustment || 0,
    },
    settlement: {
      rawSettlement:
        (session.netNewAdvance || 0) -
        (session.totalReturnedCodRecall || 0) -
        (session.totalWeightAdjustment || 0) +
        (session.previousDebt || 0),
      netAdvancePayout: session.netAdvancePayout || 0,
      closingDebt: session.closingDebt || 0,
      isNegativeDebt: session.closingDebt < 0 || session.payoutStatus === 'NEGATIVE_DEBT',
    },
    previousDebt: session.previousDebt || 0,
  };
}

/**
 * Excel Statement Workbook Generator (4 sheets):
 * 1. TONG_HOP_UNG_COD: KPI summary & settlement figures
 * 2. CHI_TIET_DON_DI: List of outbound orders with formula sums
 * 3. CHI_TIET_DON_HOAN: List of return orders with 0đ return fee
 * 4. CHENH_LECH_CUOC_NVC: Discrepancy details
 */
export async function generateStatementWorkbook(
  sessionOrData: AdvanceSession | StatementSessionData
): Promise<ExcelJS.Workbook> {
  const sessionData = normalizeStatementSessionData(sessionOrData);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Gom Don T+0 COD Advance System';
  workbook.created = new Date();

  const bankCode =
    sessionData.bankAccount.bankCode ||
    (sessionData.bankAccount.bankName ? BANK_CODES[sessionData.bankAccount.bankName] || sessionData.bankAccount.bankName : '') ||
    'NH';

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
    {
      metric: 'Tài khoản thụ hưởng',
      value: `${bankCode} - ${sessionData.bankAccount.accountNumber}`,
      note: sessionData.bankAccount.accountHolder,
    },
    { metric: '------------------------------', value: '--------------------', note: '' },
    { metric: '1. Tổng số đơn mới', value: sessionData.outbound.orders.length, note: 'Đơn gửi đi trong ngày' },
    { metric: '2. Tổng COD đơn mới', value: sessionData.outbound.totalNewCod, note: 'Tổng tiền thu hộ' },
    {
      metric: '3. Tổng cước tạm tính đơn mới',
      value: sessionData.outbound.totalNewFee,
      note: 'Theo bảng giá riêng của Shop',
    },
    { metric: '4. Tiền ứng đơn mới (2 - 3)', value: sessionData.outbound.netNewAdvance, note: 'COD mới - Cước mới' },
    { metric: '------------------------------', value: '--------------------', note: '' },
    { metric: '5. Tổng số đơn hoàn', value: sessionData.returns.orders.length, note: 'Đơn hoàn về trong ngày' },
    { metric: '6. Cước hoàn phát sinh', value: 0, note: 'Miễn phí cước hoàn (0đ)' },
    {
      metric: '7. Thu hồi COD đơn hoàn',
      value: sessionData.returns.totalReturnedCodRecall,
      note: 'Tra cứu lịch sử / file Excel',
    },
    { metric: '------------------------------', value: '--------------------', note: '' },
    {
      metric: '8. Chênh lệch cước vượt cân NVC',
      value: sessionData.discrepancy.totalWeightAdjustment,
      note: 'Đối soát NVC + Nhập tay',
    },
    { metric: '9. Dư/Nợ lũy kế kỳ trước', value: sessionData.previousDebt, note: 'Âm là Nợ, Dương là Dư' },
    { metric: '------------------------------', value: '--------------------', note: '' },
    {
      metric: '10. TỔNG THỰC CHUYỂN HÔM NAY',
      value: sessionData.settlement.netAdvancePayout,
      note: sessionData.settlement.isNegativeDebt ? 'SHOP NỢ (KẾT CHUYỂN KỲ SAU)' : 'ĐÃ TẠO MÃ VIETQR',
    },
    {
      metric: '11. Công nợ chuyển kỳ tiếp theo',
      value: sessionData.settlement.closingDebt,
      note: sessionData.settlement.closingDebt < 0 ? 'Khấu trừ vào ngày tiếp theo' : '0đ',
    },
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

/**
 * Serializes the statement workbook into a binary Blob suitable for browser download.
 */
export async function exportStatementExcelBlob(
  sessionOrData: AdvanceSession | StatementSessionData
): Promise<Blob> {
  const workbook = await generateStatementWorkbook(sessionOrData);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Triggers direct browser download for an advance statement Excel file.
 */
export async function exportAndDownloadStatementExcel(
  sessionOrData: AdvanceSession | StatementSessionData,
  customFilename?: string
): Promise<void> {
  const sessionData = normalizeStatementSessionData(sessionOrData);
  const blob = await exportStatementExcelBlob(sessionData);

  const cleanShop = (sessionData.shopCode || 'SHOP').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanDate = (sessionData.advanceDate || new Date().toISOString().slice(0, 10)).replace(/[^0-9]/g, '');
  const filename = customFilename || `Bang_Ke_Tam_Ung_COD_${cleanShop}_${cleanDate}.xlsx`;

  saveBlobFile(blob, filename);
}

// ============================================================================
// REST API Client Helpers (M1 <-> M3 Integration with LocalStorage Fallback)
// ============================================================================

const LS_ADVANCE_SHOPS_KEY = 'gomdon_cod_advance_shops_v1';
const LS_ADVANCE_SESSIONS_KEY = 'gomdon_cod_advance_sessions_v1';
const LS_ADVANCE_LEDGER_KEY = 'gomdon_cod_advance_ledger_v1';

function getAuthHeadersSafe(): Record<string, string> {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  const token = window.localStorage.getItem('gomdon_auth_token_v1');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchAdvanceShops(): Promise<AdvanceShopProfile[]> {
  try {
    const res = await fetch('/api/cod-advance/shops', {
      headers: { ...getAuthHeadersSafe() },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.shops)) {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(LS_ADVANCE_SHOPS_KEY, JSON.stringify(data.shops));
        }
        return data.shops;
      }
    }
  } catch {
    // Fallback to localStorage
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(LS_ADVANCE_SHOPS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  return [];
}

export async function saveAdvanceShopApi(shop: Partial<AdvanceShopProfile>): Promise<AdvanceShopProfile | null> {
  const sanitizedShop: Partial<AdvanceShopProfile> = {
    ...shop,
    pricingPlan: {
      id: shop.pricingPlan?.id || `plan_${shop.id || Date.now()}`,
      name: shop.pricingPlan?.name || `Biểu phí ${shop.name || 'Shop'}`,
      weightRules: shop.pricingPlan?.weightRules || [
        { minWeight: 0, maxWeight: 1, price: 20000 },
        { minWeight: 1, maxWeight: 2, price: 25000 },
      ],
      extraStepWeight: shop.pricingPlan?.extraStepWeight ?? 0.5,
      extraStepPrice: shop.pricingPlan?.extraStepPrice ?? 5000,
      returnFeePercent: 0,
      returnFeeFixed: 0,
      returnFeeType: 'free',
    },
  };

  try {
    const res = await fetch('/api/cod-advance/shops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeadersSafe() },
      body: JSON.stringify({ shop: sanitizedShop }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.shops) && typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(LS_ADVANCE_SHOPS_KEY, JSON.stringify(data.shops));
      }
      return data.shop || null;
    }
  } catch {}

  // Offline fallback
  if (typeof window !== 'undefined' && window.localStorage) {
    const list = await fetchAdvanceShops();
    const now = new Date().toISOString();
    const full: AdvanceShopProfile = {
      id: sanitizedShop.id || `adv_shop_${Date.now()}`,
      code: sanitizedShop.code || sanitizedShop.name || 'SHOP',
      name: sanitizedShop.name || 'Shop Ứng COD',
      phone: sanitizedShop.phone || '',
      address: sanitizedShop.address || '',
      bankAccount: sanitizedShop.bankAccount || { bankName: '', accountNumber: '', accountHolder: '' },
      pricingPlan: sanitizedShop.pricingPlan!,
      currentDebt: sanitizedShop.currentDebt ?? 0,
      active: sanitizedShop.active !== false,
      createdAt: sanitizedShop.createdAt || now,
      updatedAt: now,
    };
    const idx = list.findIndex(s => s.id === full.id);
    if (idx >= 0) list[idx] = full;
    else list.push(full);
    window.localStorage.setItem(LS_ADVANCE_SHOPS_KEY, JSON.stringify(list));
    return full;
  }
  return null;
}

export async function fetchAdvanceShopDebt(shopId: string): Promise<number> {
  try {
    const res = await fetch(`/api/cod-advance/shops/${encodeURIComponent(shopId)}/current-debt`, {
      headers: { ...getAuthHeadersSafe() },
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.currentDebt === 'number') return data.currentDebt;
    }
  } catch {}
  return 0;
}

export async function lookupHistoricalOrdersApi(
  waybills: string[],
  shopId?: string
): Promise<Record<string, AdvanceOrderHistoryRecord>> {
  if (!waybills || waybills.length === 0) return {};
  try {
    const res = await fetch('/api/cod-advance/orders/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeadersSafe() },
      body: JSON.stringify({ waybills, shopId }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.orders || {};
    }
  } catch {}
  return {};
}

export async function fetchAdvanceSessions(): Promise<AdvanceSession[]> {
  try {
    const res = await fetch('/api/cod-advance/sessions', {
      headers: { ...getAuthHeadersSafe() },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.sessions)) {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(LS_ADVANCE_SESSIONS_KEY, JSON.stringify(data.sessions));
        }
        return data.sessions;
      }
    }
  } catch {}
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(LS_ADVANCE_SESSIONS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  return [];
}

export async function fetchAdvanceSessionDetail(id: string): Promise<AdvanceSession | null> {
  try {
    const res = await fetch(`/api/cod-advance/sessions/${encodeURIComponent(id)}`, {
      headers: { ...getAuthHeadersSafe() },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.session) return data.session;
    }
  } catch {}
  return null;
}

export async function saveAdvanceSessionApi(session: Partial<AdvanceSession>): Promise<{ success: boolean; session?: AdvanceSession; error?: string }> {
  try {
    const res = await fetch('/api/cod-advance/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeadersSafe() },
      body: JSON.stringify({ session }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return { success: true, session: data.session };
    }
    return { success: false, error: data.error || 'Không thể lưu kỳ ứng COD' };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Lỗi kết nối máy chủ' };
  }
}

export async function deleteAdvanceSessionApi(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/cod-advance/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { ...getAuthHeadersSafe() },
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return { success: true };
    }
    return { success: false, error: data.error || 'Không thể xóa kỳ ứng COD' };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Lỗi kết nối máy chủ' };
  }
}

export async function fetchAdvanceLedger(shopId?: string): Promise<any[]> {
  try {
    const url = shopId
      ? `/api/cod-advance/ledger?shopId=${encodeURIComponent(shopId)}`
      : '/api/cod-advance/ledger';
    const res = await fetch(url, {
      headers: { ...getAuthHeadersSafe() },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.ledger)) {
        if (typeof window !== 'undefined' && window.localStorage && !shopId) {
          window.localStorage.setItem(LS_ADVANCE_LEDGER_KEY, JSON.stringify(data.ledger));
        }
        return data.ledger;
      }
    }
  } catch {}
  return [];
}

export async function adjustAdvanceDebtApi(
  shopId: string,
  adjustmentAmount: number,
  description: string
): Promise<{ success: boolean; currentDebt?: number; error?: string }> {
  try {
    const res = await fetch('/api/cod-advance/ledger/adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeadersSafe() },
      body: JSON.stringify({ shopId, adjustmentAmount, description }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return { success: true, currentDebt: data.currentDebt };
    }
    return { success: false, error: data.error || 'Không thể điều chỉnh công nợ' };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Lỗi kết nối máy chủ' };
  }
}

// ============================================================================
// 🛡️ Order Lifecycle & Loss Tracking (J&T Hàng Hoàn & Cảnh Báo Đơn Mất)
// ============================================================================

export async function fetchOrderLifecycleApi(): Promise<{
  config: OrderTrackingConfig;
  stats: OrderTrackingStats;
  orders: OrderLifecycleItem[];
}> {
  try {
    const res = await fetch('/api/carrier/order-lifecycle', {
      headers: { ...getAuthHeadersSafe() },
    });
    if (res.ok) {
      const data = await res.json();
      return {
        config: data.config || { riskDaysThreshold: 13, lostDaysThreshold: 20 },
        stats: data.stats || { totalTracked: 0, inTransitCount: 0, riskDelayedCount: 0, suspectedLostCount: 0, deliveredCount: 0, returnedCount: 0, partialReturnedCount: 0 },
        orders: Array.isArray(data.orders) ? data.orders : [],
      };
    }
  } catch {}
  return {
    config: { riskDaysThreshold: 13, lostDaysThreshold: 20 },
    stats: { totalTracked: 0, inTransitCount: 0, riskDelayedCount: 0, suspectedLostCount: 0, deliveredCount: 0, returnedCount: 0, partialReturnedCount: 0 },
    orders: [],
  };
}

export async function updateOrderTrackingConfigApi(config: OrderTrackingConfig): Promise<boolean> {
  try {
    const res = await fetch('/api/carrier/order-lifecycle/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeadersSafe() },
      body: JSON.stringify(config),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function syncOrderLifecycleApi(
  type: 'sent' | 'delivered' | 'returned',
  orders: any[],
  carrierId: string = 'jnt'
): Promise<{ success: boolean; message?: string; stats?: OrderTrackingStats; orders?: OrderLifecycleItem[]; error?: string }> {
  try {
    const res = await fetch('/api/carrier/order-lifecycle/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeadersSafe() },
      body: JSON.stringify({ type, orders, carrierId }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return { success: true, message: data.message, stats: data.stats, orders: data.orders };
    }
    return { success: false, error: data.error || 'Đồng bộ thất bại' };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Lỗi mạng khi đồng bộ' };
  }
}

export async function updateOrderClaimStatusApi(
  waybills: string[],
  claimStatus: string,
  claimNote?: string
): Promise<boolean> {
  try {
    const res = await fetch('/api/carrier/order-lifecycle/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeadersSafe() },
      body: JSON.stringify({ waybills, claimStatus, claimNote }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearOrderLifecycleApi(
  waybills?: string[],
  clearAll?: boolean
): Promise<boolean> {
  try {
    const res = await fetch('/api/carrier/order-lifecycle/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeadersSafe() },
      body: JSON.stringify({ waybills, clearAll }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function parseLifecycleExcelFile(
  fileOrBuffer: any
): Promise<{
  waybill: string;
  originalWaybill: string;
  isPartialReturn: boolean;
  shopName?: string;
  shopPhone?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
  productName?: string;
  weight?: number;
  codAmount?: number;
  sentDate?: string;
  completedDate?: string;
  returnedDate?: string;
  rawData?: Record<string, any>;
}[]> {
  const data = await toUint8Array(fileOrBuffer);
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) return [];
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!worksheet) return [];

  const rawRows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  if (!rawRows || rawRows.length === 0) return [];

  let headerRowIdx = 0;
  for (let r = 0; r < Math.min(10, rawRows.length); r++) {
    const row = rawRows[r];
    if (row && row.some((cell: any) => {
      const s = String(cell).toLowerCase();
      return s.includes('vận đơn') || s.includes('van don') || s.includes('tracking') || s.includes('mã đơn') || s.includes('ma don');
    })) {
      headerRowIdx = r;
      break;
    }
  }

  const headers = rawRows[headerRowIdx].map((h: any) => String(h || '').trim());
  const dataRows = rawRows.slice(headerRowIdx + 1);

  let wbIdx = -1;
  let shopNameIdx = -1;
  let shopPhoneIdx = -1;
  let receiverNameIdx = -1;
  let receiverPhoneIdx = -1;
  let receiverAddressIdx = -1;
  let weightIdx = -1;
  let codIdx = -1;
  let dateIdx = -1;

  for (let i = 0; i < headers.length; i++) {
    const norm = normalizeHeader(headers[i]);
    if (wbIdx === -1 && (norm === 'so_van_don' || norm === 'ma_van_don' || norm === 'mvd' || norm === 'tracking' || norm.includes('van_don'))) {
      if (!norm.includes('don_con')) wbIdx = i;
    }
    if (shopNameIdx === -1 && (norm === 'ten_nguoi_gui' || norm === 'ten_shop' || norm === 'shop_name' || norm.includes('nguoi_gui'))) {
      shopNameIdx = i;
    }
    if (shopPhoneIdx === -1 && (norm.includes('sdt_gui') || norm.includes('sdt_nguoi_gui') || norm.includes('so_dien_thoai_di_dong_cua_nguoi_gui_hang') || norm.includes('phone_shop'))) {
      shopPhoneIdx = i;
    }
    if (receiverNameIdx === -1 && (norm === 'ten_nguoi_nhan' || norm === 'nguoi_nhan' || norm.includes('nguoi_nhan') || norm.includes('khach_nhan'))) {
      receiverNameIdx = i;
    }
    if (receiverPhoneIdx === -1 && (norm.includes('sdt_nhan') || norm.includes('sdt_nguoi_nhan') || norm.includes('dien_thoai_nhan') || norm.includes('phone_nhan'))) {
      receiverPhoneIdx = i;
    }
    if (receiverAddressIdx === -1 && (norm.includes('dia_chi_nhan') || norm.includes('dia_chi_giao') || norm.includes('dia_chi_khach') || norm.includes('dia_chi_hanh_chinh') || norm === 'dia_chi')) {
      receiverAddressIdx = i;
    }
    if (weightIdx === -1 && (norm.includes('trong_luong') || norm.includes('khoi_luong') || norm.includes('can_nang') || norm === 'weight')) {
      weightIdx = i;
    }
    if (codIdx === -1 && (norm.includes('tien_thu_ho') || norm.includes('cod') || norm.includes('thu_ho'))) {
      codIdx = i;
    }
    if (dateIdx === -1 && (norm.includes('ngay_gui') || norm.includes('thoi_gian_tao') || norm.includes('thoi_gian_nhan') || norm.includes('thoi_gian_lay') || norm.includes('ngay_tao') || norm.includes('ngay_nhan') || norm.includes('thoi_gian_ky_nhan'))) {
      dateIdx = i;
    }
  }

  if (wbIdx === -1) wbIdx = 0;

  const results: any[] = [];
  for (const row of dataRows) {
    const rawWb = String(row[wbIdx] || '').trim();
    if (!rawWb || rawWb.length < 4 || rawWb.toLowerCase().includes('tổng') || rawWb.toLowerCase().includes('tong')) continue;

    const isPartialReturn = /[-_]\s*0*1$/i.test(rawWb);
    const originalWaybill = rawWb.replace(/[-_]\s*0*1$/i, '').trim();

    let dateStr = '';
    if (dateIdx !== -1 && row[dateIdx]) {
      const dVal = row[dateIdx];
      if (dVal instanceof Date && !isNaN(dVal.getTime())) {
        dateStr = dVal.toISOString().slice(0, 10);
      } else {
        const s = String(dVal).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
          dateStr = s.slice(0, 10);
        } else if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/.test(s)) {
          const parts = s.split(/[\/-]/);
          const dd = parts[0].padStart(2, '0');
          const mm = parts[1].padStart(2, '0');
          const yyyy = parts[2].slice(0, 4);
          dateStr = `${yyyy}-${mm}-${dd}`;
        }
      }
    }

    const rowObj: Record<string, any> = {};
    headers.forEach((h: string, idx: number) => {
      rowObj[h || `Cột_${idx + 1}`] = row[idx];
    });

    results.push({
      waybill: rawWb,
      originalWaybill,
      isPartialReturn,
      shopName: shopNameIdx !== -1 ? String(row[shopNameIdx] || '').trim() : undefined,
      shopPhone: shopPhoneIdx !== -1 ? String(row[shopPhoneIdx] || '').trim() : undefined,
      receiverName: receiverNameIdx !== -1 ? String(row[receiverNameIdx] || '').trim() : undefined,
      receiverPhone: receiverPhoneIdx !== -1 ? String(row[receiverPhoneIdx] || '').trim() : undefined,
      receiverAddress: receiverAddressIdx !== -1 ? String(row[receiverAddressIdx] || '').trim() : undefined,
      weight: weightIdx !== -1 ? parseWeightToKg(row[weightIdx]) : undefined,
      codAmount: codIdx !== -1 ? parseNumber(row[codIdx]) : undefined,
      sentDate: dateStr || undefined,
      completedDate: dateStr || undefined,
      returnedDate: dateStr || undefined,
      rawData: rowObj,
    });
  }

  return results;
}

export async function exportClaimReportExcel(
  orders: OrderLifecycleItem[],
  customFilename?: string
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Kế Toán PRO Enterprise';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Danh Sách Khiếu Nại NVC', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
    views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }],
  });

  worksheet.mergeCells('A1:L1');
  const titleCell = worksheet.getCell('A1');
  titleCell.value = 'DANH SÁCH VẬN ĐƠN YÊU CẦU KIỂM TRA & KHIẾU NẠI THẤT LẠC NVC';
  titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF991B1B' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  worksheet.getRow(1).height = 30;

  worksheet.mergeCells('A2:L2');
  const subCell = worksheet.getCell('A2');
  subCell.value = `Thời gian xuất: ${new Date().toLocaleString('vi-VN')} | Tổng số đơn quá hạn/nghi ngờ mất: ${orders.length} đơn`;
  subCell.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF475569' } };
  subCell.alignment = { horizontal: 'center', vertical: 'middle' };
  worksheet.getRow(2).height = 20;

  worksheet.getRow(3).height = 10;

  const headerRow = worksheet.getRow(4);
  headerRow.values = [
    'STT',
    'Mã Vận Đơn',
    'Mã Gốc (Nếu Hoàn 1P)',
    'Loại Đơn',
    'Tên Shop Gửi',
    'SĐT Shop',
    'Người Nhận',
    'SĐT Người Nhận',
    'Địa Chỉ Nhận Hàng',
    'Ngày Gửi',
    'Số Ngày Toàn Trình',
    'Mức Độ Cảnh Báo / Yêu Cầu Xử Lý'
  ];
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF94A3B8' } },
      bottom: { style: 'thin', color: { argb: 'FF94A3B8' } },
      left: { style: 'thin', color: { argb: 'FF94A3B8' } },
      right: { style: 'thin', color: { argb: 'FF94A3B8' } },
    };
  });

  worksheet.columns = [
    { key: 'stt', width: 6 },
    { key: 'waybill', width: 18 },
    { key: 'originalWaybill', width: 18 },
    { key: 'type', width: 16 },
    { key: 'shopName', width: 22 },
    { key: 'shopPhone', width: 14 },
    { key: 'receiverName', width: 18 },
    { key: 'receiverPhone', width: 14 },
    { key: 'receiverAddress', width: 35 },
    { key: 'sentDate', width: 13 },
    { key: 'totalDays', width: 15 },
    { key: 'riskLevel', width: 30 },
  ];

  orders.forEach((o, idx) => {
    const isLost = o.status === 'suspected_lost';
    const isRisk = o.status === 'risk_delayed';
    const row = worksheet.addRow({
      stt: idx + 1,
      waybill: o.waybill,
      originalWaybill: o.isPartialReturn ? o.originalWaybill : '',
      type: o.isPartialReturn ? 'Hoàn 1 phần (-001)' : o.status === 'returned' ? 'Đã hoàn về' : 'Đơn đi',
      shopName: o.shopName || '',
      shopPhone: o.shopPhone || '',
      receiverName: o.receiverName || '',
      receiverPhone: o.receiverPhone || '',
      receiverAddress: o.receiverAddress || '',
      sentDate: o.sentDate || '',
      totalDays: `${o.totalDays} ngày`,
      riskLevel: isLost ? '🚨 NGHI NGỜ THẤT LẠC (Yêu cầu đền bù)' : isRisk ? '⚠️ RỦI RO (Yêu cầu giao/hoàn gấp)' : o.statusText || 'Đang giao'
    });

    row.height = 22;
    row.eachCell((cell, colNum) => {
      cell.font = { name: 'Arial', size: 9.5 };
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNum === 1 || colNum === 2 || colNum === 3 || colNum === 4 || colNum === 6 || colNum === 8 || colNum === 10 || colNum === 11 ? 'center' : 'left'
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };

      if (isLost) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF1F2' } };
      } else if (isRisk) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } };
      }
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = customFilename || `Bien_Ban_Khieu_Nai_NVC_${new Date().toISOString().slice(0, 10)}.xlsx`;
  saveBlobFile(blob, filename);
}

// ============================================================================
// Service Object Export (M2 <-> M3 Interface Contract)
// ============================================================================

export const CodAdvanceService = {
  parseWeightToKg,
  calculateWeightFee,
  parseOutboundExcel,
  processOutboundOrders,
  parseReturnExcel,
  processReturnOrders,
  parseCarrierDiscrepancyExcel,
  processCarrierWeightDiscrepancies,
  computeDailySettlement,
  toVietQrMemo,
  generateVietQrUrl,
  generateStatementWorkbook,
  exportStatementExcelBlob,
  exportStatementExcel: exportStatementExcelBlob,
  exportAndDownloadStatementExcel,
  normalizeStatementSessionData,
  fetchAdvanceShops,
  saveAdvanceShopApi,
  fetchAdvanceShopDebt,
  lookupHistoricalOrdersApi,
  fetchAdvanceSessions,
  fetchAdvanceSessionDetail,
  saveAdvanceSessionApi,
  deleteAdvanceSessionApi,
  fetchAdvanceLedger,
  adjustAdvanceDebtApi,
  fetchOrderLifecycleApi,
  updateOrderTrackingConfigApi,
  syncOrderLifecycleApi,
  updateOrderClaimStatusApi,
  clearOrderLifecycleApi,
  parseLifecycleExcelFile,
  exportClaimReportExcel,
};

export default CodAdvanceService;
