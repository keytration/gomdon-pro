/**
 * Type definitions for Quản Lý Ứng COD Hàng Ngày (T+0)
 * Isolated module types per PROJECT.md Milestone 1.
 */

export interface AdvanceWeightRule {
  minWeight: number; // kg (e.g. 0)
  maxWeight: number; // kg (e.g. 1)
  price: number;     // VNĐ (e.g. 20000)
}

export interface AdvancePricingPlan {
  id: string;
  name: string;
  weightRules: AdvanceWeightRule[];
  extraStepWeight: number; // kg (e.g. 0.5 or 1)
  extraStepPrice: number;  // VNĐ (e.g. 5000)
  returnFeePercent: 0;     // Locked at 0
  returnFeeFixed: 0;       // Locked at 0
  returnFeeType: 'free';   // Locked to 'free' (miễn phí cước hoàn)
}

export interface AdvanceShopProfile {
  id: string;
  linkedShopId?: string;
  code: string;
  name: string;
  phone: string;
  address?: string;
  bankAccount: {
    bankName: string;
    accountNumber: string;
    accountHolder: string;
  };
  pricingPlan: AdvancePricingPlan;
  currentDebt: number; // Cumulative rolling debt (< 0 means shop owes Gom Đơn, >= 0 means cleared)
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdvanceOrderNew {
  id: string;
  waybill: string;
  weight: number;
  codAmount: number;
  appliedFee: number;
  netAdvance: number;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
  note?: string;
}

export interface AdvanceOrderReturned {
  id: string;
  waybill: string;
  codAmount: number;
  returnFee: 0;
  isFromHistory: boolean;
  originalAdvanceDate?: string;
  originalAdvanceSessionId?: string;
  note?: string;
}

export interface AdvanceWeightAdjustment {
  id: string;
  waybill?: string;
  advanceWeight?: number;
  actualWeight?: number;
  advanceFee?: number;
  actualFee?: number;
  feeDifference: number; // > 0 means surcharge to shop
  source: 'nvc_file' | 'manual';
  note?: string;
}

export interface AdvanceSession {
  id: string;
  shopId: string;
  shopCode: string;
  shopName: string;
  advanceDate: string; // YYYY-MM-DD
  createdAt: string;   // ISO timestamp
  createdByName: string;

  // Financial summary
  totalNewOrdersCount: number;
  totalNewCod: number;
  totalNewFee: number;
  netNewAdvance: number; // totalNewCod - totalNewFee

  totalReturnedOrdersCount: number;
  totalReturnedCodRecall: number;

  totalWeightAdjustment: number;
  manualAdjustmentAmount: number;
  manualAdjustmentNote?: string;

  previousDebt: number;    // Cumulative debt from previous days (< 0 if shop owes)
  netAdvancePayout: number;// Actual payout today = netNewAdvance - totalReturnedCodRecall - totalWeightAdjustment + previousDebt
  closingDebt: number;     // Rolled over closing debt (if netAdvancePayout < 0, closingDebt = netAdvancePayout; else 0)
  payoutStatus: 'UNPAID' | 'PAID' | 'NEGATIVE_DEBT';

  bankInfo: {
    bankName: string;
    accountNumber: string;
    accountHolder: string;
  };

  // Detailed lists
  newOrders: AdvanceOrderNew[];
  returnedOrders: AdvanceOrderReturned[];
  weightAdjustments: AdvanceWeightAdjustment[];
}

export interface AdvanceSessionSummary {
  id: string;
  shopId: string;
  shopCode: string;
  shopName: string;
  advanceDate: string;
  createdAt: string;
  createdByName: string;

  totalNewOrdersCount: number;
  totalNewCod: number;
  totalNewFee: number;
  netNewAdvance: number;

  totalReturnedOrdersCount: number;
  totalReturnedCodRecall: number;

  totalWeightAdjustment: number;
  manualAdjustmentAmount: number;
  manualAdjustmentNote?: string;

  previousDebt: number;
  netAdvancePayout: number;
  closingDebt: number;
  payoutStatus: 'UNPAID' | 'PAID' | 'NEGATIVE_DEBT';

  bankInfo: {
    bankName: string;
    accountNumber: string;
    accountHolder: string;
  };
}

export interface AdvanceOrderHistoryRecord {
  waybill: string;
  shopId: string;
  shopCode: string;
  advanceSessionId: string;
  advanceDate: string;
  weight: number;
  appliedFee: number;
  codAmount: number;
  isReturned: boolean;
  returnedSessionId?: string;
  returnedDate?: string;
  createdAt: string;
}

export interface AdvanceDebtLedgerRecord {
  id: string;
  shopId: string;
  sessionId?: string;
  sessionDate: string;
  type: 'SESSION_SETTLEMENT' | 'MANUAL_DEBT_ADJUSTMENT' | 'BANK_SETTLEMENT' | string;
  openingDebt: number;
  netSettlementChange: number;
  closingDebt: number;
  description: string;
  timestamp: string;
}

export interface AdvanceOrderLookupRequest {
  waybills: string[];
  shopId?: string;
}

export type AdvanceOrderLookupResponse = Record<string, AdvanceOrderHistoryRecord>;

// ─────────────────────────────────────────────────────────────────────────────
// 🛡️ ORDER LIFECYCLE & LOSS TRACKING TYPES (KIỂM SOÁT ĐƠN MẤT & HÀNG HOÀN J&T)
// ─────────────────────────────────────────────────────────────────────────────

export type OrderLifecycleStatus =
  | 'in_transit'        // Đang giao (Từ ngày gửi đến < số ngày cảnh báo, ví dụ < 13 ngày)
  | 'risk_delayed'      // Cảnh báo rủi ro / Chậm bất thường (Ví dụ 13 - 20 ngày)
  | 'suspected_lost'    // Nghi ngờ thất lạc / Mất hàng (> 20 ngày chưa giao/hoàn)
  | 'delivered'         // Giao thành công (Khớp từ file giao thành công)
  | 'returned'          // Đã hoàn về kho (Khớp từ file đơn hoàn)
  | 'partial_returned'; // Hoàn 1 phần (Ký 1 phần có đuôi -001)

export interface OrderLifecycleItem {
  id: string;
  waybill: string;
  originalWaybill: string; // Mã gốc sau khi cắt -001 hoặc "- 001"
  isPartialReturn: boolean; // Có đuôi -001 hay không
  carrierId: string;
  shopId?: string;
  shopName?: string;
  shopPhone?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
  productName?: string;
  weight?: number;
  codAmount?: number;
  sentDate: string; // YYYY-MM-DD
  completedDate?: string;
  returnedDate?: string;
  status: OrderLifecycleStatus;
  statusText?: string;
  totalDays: number; // Số ngày từ ngày gửi đến hiện tại
  claimStatus?: 'unprocessed' | 'unclaimed' | 'expediting' | 'claimed' | 'compensated' | 'resolved';
  claimNote?: string;
  lastUpdated: string;
  rawSentData?: Record<string, any>;
  rawCompletedData?: Record<string, any>;
  rawReturnedData?: Record<string, any>;
}

export interface OrderTrackingConfig {
  riskDaysThreshold: number; // Mặc định 13 ngày
  lostDaysThreshold: number; // Mặc định 20 ngày
}

export interface OrderTrackingStats {
  totalTracked: number;
  inTransitCount: number;
  riskDelayedCount: number;
  suspectedLostCount: number;
  deliveredCount: number;
  returnedCount: number;
  partialReturnedCount: number;
}
