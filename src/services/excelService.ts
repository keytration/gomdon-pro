import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import type { ShopSettlementStatement, ReconciliationSession, ExportColumnSettings, ExportColumnItem } from '../types';
import { normalizeHeader } from './smartColumnDetector';
import { StorageService } from './storage';

import { extractRowField } from './reconciliationService';

export function getCleanCarrierTag(carrierId?: string, carrierName?: string): string {
  const combined = `${carrierId || ''} ${carrierName || ''}`.toLowerCase().trim();
  if (combined.includes('j&t') || combined.includes('jnt')) return 'J&T';
  if (combined.includes('ghn') || combined.includes('giao hàng nhanh') || combined.includes('giaohangnhanh')) return 'GHN';
  if (combined.includes('ghtk') || combined.includes('tiết kiệm') || combined.includes('tietkiem')) return 'GHTK';
  if (combined.includes('viettel') || combined.includes('vtp')) return 'ViettelPost';
  if (combined.includes('spx') || combined.includes('shopee')) return 'SPX';
  if (combined.includes('vnpost') || combined.includes('ems')) return 'VNPost';
  if (carrierName && carrierName.trim()) return carrierName.trim().replace(/[^a-zA-Z0-9_\u00C0-\u1EF9]/g, '_');
  if (carrierId && carrierId.trim()) return carrierId.trim().toUpperCase().replace(/[^a-zA-Z0-9]/g, '_');
  return 'NVC';
}

export function formatAnyDateValue(val: any): string {
  if (val === undefined || val === null || val === '') return '';

  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    return formatDateToString(val, true);
  }

  let str = String(val).trim();
  if (!str) return '';

  // Handle European/Vietnamese decimal comma (e.g. "46239,64141" -> "46239.64141")
  const normalizedStr = str.replace(',', '.');
  const num = Number(normalizedStr);
  if (!isNaN(num) && num > 25000 && num < 75000) {
    const jsTimestamp = Math.round((num - 25569) * 86400 * 1000);
    const dateObj = new Date(jsTimestamp);
    if (!isNaN(dateObj.getTime())) {
      const hasTime = num % 1 !== 0;
      return formatDateToString(dateObj, hasTime);
    }
  }

  if ((str.includes('-') || str.includes('/') || str.includes('T')) && !str.match(/^[a-zA-Z0-9\s]+$/)) {
    const parsedDate = new Date(str);
    if (!isNaN(parsedDate.getTime()) && parsedDate.getFullYear() > 1990 && parsedDate.getFullYear() < 2100) {
      return formatDateToString(parsedDate, str.includes(':') || str.includes('T'));
    }
  }

  return str;
}

function formatDateToString(d: Date, includeTime: boolean = false): string {
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear();
  
  if (includeTime) {
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    if (hours !== '00' || minutes !== '00') {
      return `${day}/${month}/${year} ${hours}:${minutes}`;
    }
  }

  return `${day}/${month}/${year}`;
}

export function saveBlobFile(blob: Blob, filename: string): void {
  try {
    saveAs(blob, filename);
  } catch (err) {
    console.warn('saveAs failed, falling back to anchor click:', err);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }
}

export function isDateColumn(normLabel: string, normSrc?: string): boolean {
  const combined = `${normLabel} ${normSrc || ''}`;
  const isDateKeyword = combined.includes('ngay') || combined.includes('date') || combined.includes('thoi_gian');
  const isExcluded = combined.includes('tien') || combined.includes('cuoc') || combined.includes('phi') || combined.includes('cod') || combined.includes('tra');
  return isDateKeyword && !isExcluded;
}

function isValidRealHeader(headerName: string): boolean {
  if (!headerName) return false;
  const t = headerName.trim();
  // Do NOT filter out multi-file canonical columns containing "(chuẩn hóa" or "đa file"
  if (/[-–]\s*(80\d{8,}|\d{8,}|0\d{8,})/.test(t)) return false;
  if (/[-–]\s*(Giao thành công|Đã lấy hàng|Hủy|Đang giao)/i.test(t)) return false;
  if (t.length > 80) return false;
  return true;
}

export function buildDynamicColumnsFromOrders(
  orders: any[],
  customExportSettings?: ExportColumnSettings,
  isMaster: boolean = false
): ExportColumnItem[] {
  // If user provided custom export settings or saved specific enabled columns in settings
  if (customExportSettings) {
    const cols = isMaster
      ? (customExportSettings.masterColumns || customExportSettings.shopColumns || [])
      : (customExportSettings.shopColumns || []);
    
    // Explicitly preserve all columns enabled by the user
    const enabled = cols.filter(c => c.enabled !== false);
    if (enabled.length > 0) {
      return enabled;
    }
  }

  // 🌟 DEFAULT BEHAVIOR: Output ALL columns from the 2 merged files (NVC + App) + shop finance columns
  const discoveredCols: ExportColumnItem[] = [];
  const seenHeaders = new Set<string>();

  // 1. STT always first
  discoveredCols.push({ id: 'stt', label: 'STT', enabled: true, category: 'basic' });
  seenHeaders.add('stt');

  // 2. Discover all NVC headers from rawNvcData
  orders.forEach(order => {
    if (order.rawNvcData) {
      Object.keys(order.rawNvcData).forEach(key => {
        if (!isValidRealHeader(key)) return;
        const trimmed = key.trim();
        const norm = normalizeHeader(trimmed);
        if (!trimmed || seenHeaders.has(norm)) return;
        seenHeaders.add(norm);
        discoveredCols.push({
          id: `nvc_${norm}`,
          label: trimmed,
          sourceHeader: trimmed,
          enabled: true,
          category: 'carrier',
        });
      });
    }
  });

  // 3. Discover all App headers from rawAppData
  orders.forEach(order => {
    if (order.rawAppData) {
      Object.keys(order.rawAppData).forEach(key => {
        if (!isValidRealHeader(key)) return;
        const trimmed = key.trim();
        const cleanKey = trimmed.replace(/\s*[-–]\s*[^\s].*$/, '').trim() || trimmed;
        if (!isValidRealHeader(cleanKey)) return;
        const norm = normalizeHeader(cleanKey);
        if (!cleanKey || seenHeaders.has(norm)) return;
        seenHeaders.add(norm);
        discoveredCols.push({
          id: `app_${norm}`,
          label: cleanKey,
          sourceHeader: trimmed,
          enabled: true,
          category: 'basic',
        });
      });
    }
  });

  // 4. Financial calculation columns
  if (!seenHeaders.has('cuoc_tinh_shop_vnd') && !seenHeaders.has('cuoc_phi_van_chuyen')) {
    discoveredCols.push({ id: 'shopFee', label: 'Cước Tính Shop (VNĐ)', enabled: true, category: 'finance' });
  }
  if (!seenHeaders.has('phu_phi_shop_vnd') && !seenHeaders.has('phi_khac_phu_thu_hoan')) {
    discoveredCols.push({ id: 'shopOtherFee', label: 'Phụ Phí Shop (VNĐ)', enabled: true, category: 'finance' });
  }
  if (!seenHeaders.has('thuc_chuyen_cho_shop_vnd') && !seenHeaders.has('so_tien_thuc_chuyen_shop')) {
    discoveredCols.push({ id: 'netPayout', label: 'Thực Chuyển Cho Shop (VNĐ)', enabled: true, category: 'finance' });
  }
  if (isMaster && !seenHeaders.has('loi_nhuan_gom_don_vnd') && !seenHeaders.has('lai_rong_nha_gom')) {
    discoveredCols.push({ id: 'profit', label: 'Lợi Nhuận Gom Đơn (VNĐ)', enabled: true, category: 'finance' });
  }

  // 🌟 Smart fallback for legacy sessions that lack raw data objects
  if (discoveredCols.length <= 4) {
    return [
      { id: 'stt', label: 'STT', enabled: true, category: 'basic' },
      { id: 'waybill', label: 'Mã Vận Đơn', enabled: true, category: 'basic' },
      { id: 'refOrderCode', label: 'Mã Đơn Khách Hàng', enabled: true, category: 'basic' },
      { id: 'shopName', label: 'Tên Shop', enabled: true, category: 'basic' },
      { id: 'receiverName', label: 'Tên Người Nhận', enabled: true, category: 'receiver' },
      { id: 'receiverPhone', label: 'SĐT Người Nhận', enabled: true, category: 'receiver' },
      { id: 'receiverAddress', label: 'Địa Chỉ Nhận', enabled: true, category: 'receiver' },
      { id: 'productName', label: 'Nội Dung Hàng Hóa', enabled: true, category: 'basic' },
      { id: 'weight', label: 'Khối Lượng (kg)', enabled: true, category: 'basic' },
      { id: 'status', label: 'Trạng Thái', enabled: true, category: 'basic' },
      { id: 'codAmount', label: 'Tiền Thu Hộ (COD)', enabled: true, category: 'finance' },
      { id: 'shopFee', label: 'Cước Tính Shop (VNĐ)', enabled: true, category: 'finance' },
      { id: 'shopOtherFee', label: 'Phụ Phí Shop (VNĐ)', enabled: true, category: 'finance' },
      { id: 'netPayout', label: 'Thực Chuyển Cho Shop (VNĐ)', enabled: true, category: 'finance' },
      ...(isMaster ? [{ id: 'profit', label: 'Lợi Nhuận Gom Đơn (VNĐ)', enabled: true, category: 'finance' as const }] : []),
    ];
  }

  return discoveredCols;
}

export function resolveOrderColumnValue(order: any, col: ExportColumnItem, idx: number, carrierName?: string): any {
  const normId = normalizeHeader(col.id || '');
  const normLabel = normalizeHeader(col.label || '');
  const normSrc = normalizeHeader(col.sourceHeader || '');

  // 1. Direct standard IDs & Key Semantics
  if (normId === 'stt' || normLabel === 'stt') return idx + 1;
  if (normId === 'waybill' || normLabel === 'ma_van_don' || normLabel === 'mvd' || normLabel === 'tracking' || normLabel === 'ma_don') {
    return order.waybill;
  }
  if (normId === 'carrier' || normLabel.includes('don_vi_van_chuyen') || normLabel.includes('hang_van_chuyen') || normLabel.includes('nvc')) {
    return carrierName || order.carrierId || '';
  }
  if (normId === 'matchstatus' || normLabel.includes('khop_shop') || normLabel.includes('tinh_trang_khop')) {
    return order.matched ? 'Đã khớp Shop' : 'Chưa nhận diện Shop';
  }

  // 2. Direct lookup in raw data by sourceHeader, label, id FIRST (if specified by user)
  const candidates = [col.sourceHeader, col.label, col.id].filter(Boolean) as string[];
  for (const c of candidates) {
    if (order.rawAppData && order.rawAppData[c] !== undefined && order.rawAppData[c] !== '') {
      let val = order.rawAppData[c];
      return isDateColumn(normLabel, normSrc) ? formatAnyDateValue(val) : val;
    }
    if (order.rawNvcData && order.rawNvcData[c] !== undefined && order.rawNvcData[c] !== '') {
      let val = order.rawNvcData[c];
      return isDateColumn(normLabel, normSrc) ? formatAnyDateValue(val) : val;
    }
  }

  // 3. Phone numbers (Receiver phone vs Shop/Sender phone)
  const isPhoneCol = normLabel.includes('sdt') || normLabel.includes('dien_thoai') || normLabel.includes('phone') || normLabel.includes('mobile');
  if (isPhoneCol) {
    const isSenderPhone = normLabel.includes('gui') || normLabel.includes('shop') || normId === 'shopphone' || normSrc.includes('gui') || normSrc.includes('shop');
    if (isSenderPhone) {
      return order.shopPhone ||
        order.rawAppData?.['Số điện thoại di động của người gửi hàng'] ||
        order.rawAppData?.['SĐT người gửi (chuẩn hóa đa file)'] ||
        order.rawAppData?.['SĐT người gửi'] ||
        order.rawAppData?.['Số điện thoại người gửi'] ||
        extractRowField(order.rawAppData, order.rawNvcData, undefined, ['sdt_nguoi_gui', 'sdt_gui', 'so_dien_thoai_nguoi_gui', 'phone_shop', 'sdt_shop']) || '';
    } else {
      return order.receiverPhone ||
        order.rawNvcData?.['Số điện thoại người nhận'] ||
        order.rawAppData?.['SĐT người nhận'] ||
        order.rawAppData?.['SĐT người nhận (chuẩn hóa đa file)'] ||
        extractRowField(order.rawAppData, order.rawNvcData, undefined, ['sdt_nguoi_nhan', 'so_dien_thoai', 'phone', 'mobile', 'sdt']) || '';
    }
  }

  // 4. Addresses (Receiver address vs Shop/Sender address)
  const isAddressCol = normLabel.includes('dia_chi') || normLabel.includes('address') || normLabel.includes('dc_');
  if (isAddressCol) {
    const isSenderAddr = normLabel.includes('gui') || normLabel.includes('kho') || normId === 'shopaddress' || normSrc.includes('gui') || normSrc.includes('kho');
    if (isSenderAddr) {
      return order.shopAddress ||
        order.rawAppData?.['Địa chỉ người gửi'] ||
        order.rawAppData?.['Địa chỉ người gửi (chuẩn hóa đa file)'] ||
        order.rawAppData?.['Địa chỉ kho'] ||
        extractRowField(order.rawAppData, order.rawNvcData, undefined, ['dia_chi_gui', 'kho_gui', 'dia_chi_kho', 'dia_chi_nguoi_gui']) || '';
    } else {
      return order.receiverAddress ||
        order.rawNvcData?.['Địa chỉ người nhận'] ||
        order.rawAppData?.['Địa chỉ người nhận'] ||
        order.rawAppData?.['Địa chỉ người nhận (chuẩn hóa đa file)'] ||
        order.rawAppData?.['Địa chỉ hành chính'] ||
        extractRowField(order.rawAppData, order.rawNvcData, undefined, ['dia_chi', 'address', 'dc_nhan', 'giao_hang', 'dia_chi_nhan', 'dc', 'dia_chi_giao', 'dia_chi_nguoi_nhan']) || '';
    }
  }

  // 5. Sender Name / Shop Name (Ensure it's NOT a phone or address or code)
  const isShopNameCol = normId === 'shopname' ||
    normLabel.includes('ten_shop') ||
    normLabel.includes('ten_nguoi_gui') ||
    normLabel.includes('cua_hang') ||
    (normLabel.includes('nguoi_gui') && !normLabel.includes('sdt') && !normLabel.includes('dia_chi') && !normLabel.includes('ma_'));
  if (isShopNameCol) {
    return order.rawAppData?.['Tên người gửi'] ||
      order.rawAppData?.['Tên người gửi (chuẩn hóa đa file)'] ||
      order.shopName ||
      extractRowField(order.rawAppData, order.rawNvcData, undefined, ['ten_nguoi_gui', 'ten_shop', 'cua_hang', 'nguoi_gui', 'shop_name']) || '';
  }

  // 6. Shop Code
  if (normId === 'shopcode' || normLabel.includes('ma_shop') || normLabel.includes('ma_khach_hang')) {
    return order.shopCode || order.shopId || order.rawAppData?.['Mã shop (chuẩn hóa đa file)'] || '';
  }

  // 7. Receiver Name
  if (normId === 'receivername' || normLabel.includes('ten_nguoi_nhan') || normLabel.includes('nguoi_nhan') || normLabel.includes('ten_khach')) {
    return order.receiverName ||
      order.rawNvcData?.['Tên người nhận'] ||
      order.rawAppData?.['Tên người nhận'] ||
      order.rawAppData?.['Tên người nhận (chuẩn hóa đa file)'] ||
      extractRowField(order.rawAppData, order.rawNvcData, undefined, ['ten_nguoi_nhan', 'nguoi_nhan', 'ten_khach', 'receiver', 'nguoi_mua']) || '';
  }

  // 8. Financial fields
  if (normId === 'codamount' || normLabel === 'tien_thu_ho_cod' || normLabel === 'tien_cod' || normLabel === 'cod' || normLabel.includes('tien_cod') || normLabel.includes('thu_ho')) {
    return order.codAmount ?? 0;
  }
  if (normId === 'shopfee' || normLabel === 'cuoc_phi_van_chuyen' || normLabel === 'cuoc_thu_shop' || normLabel === 'cuoc_tinh_shop_vnd') {
    return (order.shopCalculatedFee !== undefined) ? order.shopCalculatedFee : (order.shopFee || 0);
  }
  if (normId === 'shopotherfee' || normLabel === 'phu_phi_shop_vnd' || normLabel === 'phi_khac_phu_thu_hoan' || normLabel === 'phu_thu') {
    return order.shopOtherFee ?? 0;
  }
  if (normId === 'nvcfee' || normLabel === 'cuoc_goc_tra_nvc' || normLabel === 'cuoc_goc' || normLabel === 'cuoc_nvc') {
    return (order.nvcBaseFee || 0) + (order.nvcOtherFee || 0);
  }
  if (normId === 'profit' || normLabel === 'lai_rong_nha_gom' || normLabel === 'loi_nhuan_gom_don_vnd' || normLabel === 'loi_nhuan' || normLabel === 'lai_rong') {
    return order.profitMargin ?? 0;
  }
  if (normId === 'netpayout' || normLabel === 'thuc_chuyen_cho_shop_vnd' || normLabel === 'so_tien_thuc_chuyen_shop' || normLabel === 'thuc_chuyen_cho_shop' || normLabel === 'thuc_chuyen' || normLabel === 'thuc_tra') {
    return order.netShopPayout ?? 0;
  }

  // 9. Weight
  if (normId === 'weight' || normLabel === 'khoi_luong_kg' || normLabel === 'trong_luong_tinh_phi' || normLabel.includes('khoi_luong') || normLabel.includes('trong_luong') || normLabel.includes('can_nang')) {
    return order.weight ?? 0.5;
  }

  // 10. Status
  if (normId === 'status' || normLabel === 'trang_thai_don_hang' || normLabel === 'trang_thai_van_don' || normLabel === 'trang_thai') {
    return order.statusText || order.status || order.rawAppData?.['Trạng thái vận đơn'] || '';
  }

  // 11. Product Name / Goods content
  if (normId === 'productname' || normLabel === 'ten_san_pham_hang_hoa' || normLabel === 'noi_dung_hang_hoa' || normLabel.includes('san_pham') || normLabel.includes('hang_hoa') || normLabel.includes('noi_dung')) {
    return order.productName || order.rawAppData?.['Nội dung hàng hóa'] || extractRowField(order.rawAppData, order.rawNvcData, undefined, ['ten_san_pham', 'hang_hoa', 'ten_hang', 'san_pham', 'noi_dung', 'mo_ta', 'product', 'items', 'noi_dung_hang_hoa']) || '';
  }

  // 12. Reference Order Code
  if (normId === 'refordercode' || normLabel.includes('ma_don_phu') || normLabel.includes('ma_don_kh') || normLabel.includes('ma_don_khach_hang') || normLabel.includes('ma_don_ghn')) {
    return order.rawAppData?.['Mã đơn phụ'] || order.rawAppData?.['Mã đơn hàng'] || order.rawAppData?.['Mã đơn KH'] || order.rawNvcData?.['Mã đơn KH'] || extractRowField(order.rawAppData, order.rawNvcData, undefined, ['ma_don_phu', 'ma_don_kh', 'ma_don_khach_hang', 'ref', 'order_id', 'ma_don_ghn']) || '';
  }

  // 13. Dates
  if (normId === 'date' || normLabel.includes('ngay_gui') || normLabel.includes('ngay_tao') || normLabel.includes('thoi_gian_tao') || normLabel.includes('ngay_doi_soat')) {
    const rawDate = order.rawNvcData?.['Ngày Gửi Hàng'] || order.rawNvcData?.['Ngày'] || order.rawAppData?.['Thời gian tạo đơn'] || order.rawAppData?.['Thời gian lấy hàng'] || order.rawAppData?.['Ngày'] || extractRowField(order.rawAppData, order.rawNvcData, undefined, ['ngay_gui', 'ngay_tao', 'ngay', 'date', 'thoi_gian_tao_don', 'thoi_gian_lay_hang', 'thoi_gian']);
    return formatAnyDateValue(rawDate);
  }
  if (normLabel.includes('ngay_giao') || normLabel.includes('ngay_tra') || normLabel.includes('ky_nhan') || normLabel.includes('thoi_gian_ky_nhan')) {
    const rawDate = order.rawNvcData?.['Thời gian Ký Nhận'] || order.rawAppData?.['Thời gian ký nhận'] || extractRowField(order.rawAppData, order.rawNvcData, undefined, ['ngay_giao', 'ngay_tra', 'ky_nhan', 'thoi_gian_ky_nhan', 'ngay_giao_tra']);
    return formatAnyDateValue(rawDate);
  }

  // 14. Normalized header lookup in raw data keys
  const allRawData = [order.rawAppData, order.rawNvcData];
  for (const raw of allRawData) {
    if (!raw) continue;
    for (const key of Object.keys(raw)) {
      const normKey = normalizeHeader(key);
      if (normKey === normLabel || normKey === normSrc || normKey === normId) {
        let val = raw[key];
        if (isDateColumn(normLabel, normSrc)) {
          val = formatAnyDateValue(val);
        }
        return val;
      }
    }
  }

  return '';
}

export interface ParsedExcelSheetInfo {
  name: string;
  rowCount: number;
}

export interface ParsedExcelFile {
  headers: string[];
  rows: Record<string, any>[];
  format: 'standard' | 'ghn_settlement' | 'ghn_cod_transfer';
  sheets?: ParsedExcelSheetInfo[];
  ignoredSheetNames?: string[];
}

const GHN_SETTLEMENT_HEADERS = [
  'Mã đơn GHN',
  'Mã đơn khách hàng',
  'Cửa hàng',
  'Mã Shop/Kho',
  'Người nhận',
  'SĐT Người nhận',
  'Địa chỉ nhận',
  'Ngày tạo',
  'Ngày giao/trả',
  'Trạng thái',
  'Tiền COD',
  'Cước phí',
  'Loại dòng đối soát',
  'Sheet đối soát GHN',
];

// GHN's "Phiên chuyển tiền COD" export is a 2-tier header settlement document.
// The parser dynamically merges Row 0 and Row 1 to discover all actual columns.

const ghnShopCodeFrom = (value: any) => {
  const text = String(value || '').trim();
  const match = text.match(/^\s*([A-Za-z0-9]+)\s*[-–]/);
  return match ? match[1] : '';
};

const ghnShopNameFrom = (value: any) => String(value || '')
  .replace(/^\s*[A-Za-z0-9]+\s*[-–]\s*/, '')
  .trim();

const ghnNumber = (value: any) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

function parseGhnCodTransferSheet(rawSheetData: any[][], sheetName: string): { rows: Record<string, any>[]; headers: string[] } | null {
  for (let rowIndex = 0; rowIndex < Math.min(30, rawSheetData.length); rowIndex++) {
    const rawSubHeaders = rawSheetData[rowIndex] || [];
    const rawSuperHeaders = rowIndex > 0 ? (rawSheetData[rowIndex - 1] || []) : [];
    const headers = rawSubHeaders.map(cell => normalizeHeader(String(cell || '')));
    const groupHeaders = rawSuperHeaders.map(cell => normalizeHeader(String(cell || '')));

    // Helper to find column across both subheaders (current row) and superheaders (previous row)
    const findCol = (predicate: (h: string) => boolean): number => {
      const subIdx = headers.findIndex(predicate);
      if (subIdx >= 0) return subIdx;
      return groupHeaders.findIndex(predicate);
    };

    const waybillIndex = findCol(h =>
      h === 'ma_don_ghn' || h === 'ma_don' || h === 'ma_van_don' || h === 'tracking' ||
      h === 'ma_don_hang' || h.startsWith('ma_don') || h.startsWith('ma_van_don')
    );

    const shopIndex = findCol(h =>
      h === 'cua_hang' || h === 'ten_shop' || h === 'shop' || h === 'kho' ||
      h.includes('cua_hang') || h.includes('ten_shop') || h.includes('ma_shop') || h.includes('ma_kho')
    );

    const statusIndex = findCol(h =>
      h === 'trang_thai' || h.startsWith('trang_thai') || h === 'tinh_trang'
    );

    const codIndex = findCol(h =>
      h === 'tien_cod' || h.startsWith('tien_cod') || h === 'cod' || h.startsWith('cod') ||
      h.includes('thu_ho')
    );

    const settlementIndex = findCol(h =>
      h === 'tong_doi_soat' || h.startsWith('tong_doi_soat') || h.includes('tong_doi_soat') ||
      h === 'thuc_nhan' || h === 'tong_thanh_toan' || h.includes('thanh_toan')
    );

    const feeIndexes: number[] = [];
    const maxScanCols = Math.max(headers.length, groupHeaders.length);
    for (let c = 0; c < maxScanCols; c++) {
      const h = headers[c] || '';
      const gh = groupHeaders[c] || '';
      if (
        h === 'phi_dich_vu' || h.startsWith('phi_dich_vu') || h.includes('cuoc') || h.includes('phi_giao') ||
        gh === 'phi_dich_vu' || gh.startsWith('phi_dich_vu') || gh.includes('cuoc') || gh.includes('phi_giao')
      ) {
        feeIndexes.push(c);
      }
    }

    // Must identify waybill column and at least shop/status, and at least one financial column
    if (waybillIndex < 0 || (shopIndex < 0 && statusIndex < 0) || (codIndex < 0 && settlementIndex < 0 && feeIndexes.length === 0)) {
      continue;
    }

    const validWaybill = (value: any) => {
      const text = String(value || '').trim();
      if (text.length < 4) return false;
      // Pure serial number (1 to 4 digits like 1, 2, 1500) is a line number, never a waybill
      if (/^\d{1,4}$/.test(text)) return false;
      const norm = normalizeHeader(text);
      if (['ma_don_ghn', 'ma_don', 'tong_cong', 'tong_doi_soat', 'tong_so_don', 'ngay', 'no_ton', 'thuc_nhan', 'danh_sach'].includes(norm)) {
        return false;
      }
      return true;
    };

    // Construct full 2-tier column names from Row - 1 (Super header) + Row (Sub header)
    const maxCols = Math.max(rawSuperHeaders.length, rawSubHeaders.length);
    const colNameMap: { index: number; name: string }[] = [];
    const discoveredHeadersSet = new Set<string>();

    for (let c = 0; c < maxCols; c++) {
      const h1 = String(rawSuperHeaders[c] || '').trim();
      const h2 = String(rawSubHeaders[c] || '').trim();
      let label = '';
      if (h1 && h2) {
        if (h1.toLowerCase().includes('danh sách đơn')) {
          label = h2;
        } else if (h2.startsWith('(') && (h2.endsWith(')') || h2.includes('+'))) {
          label = `${h1} ${h2}`;
        } else if (h1.toLowerCase() === h2.toLowerCase()) {
          label = h1;
        } else {
          label = `${h1} - ${h2}`;
        }
      } else if (h2) {
        label = h2;
      } else if (h1) {
        label = h1;
      }

      if (label) {
        colNameMap.push({ index: c, name: label });
        discoveredHeadersSet.add(label);
      }
    }

    // Find summary fee column (5) or sub-columns (5.1 to 5.6)
    const summaryFeeCol = colNameMap.find(c => {
      const n = normalizeHeader(c.name);
      return n === 'phi_dich_vu_5' || n === 'phi_dich_vu' || n.includes('phi_dich_vu');
    });
    const subFeeCols = colNameMap.filter(c => {
      const n = normalizeHeader(c.name);
      return n.startsWith('phi_giao_hang') || n.startsWith('phi_giao_lai') || n.startsWith('phi_khai_gia') || n.startsWith('phi_hoan_hang') || n.startsWith('phi_doi_dia_chi');
    });

    const rows: Record<string, any>[] = [];
    for (let dataIndex = rowIndex + 1; dataIndex < rawSheetData.length; dataIndex++) {
      const row = rawSheetData[dataIndex] || [];
      const waybill = row[waybillIndex];
      if (!validWaybill(waybill)) continue;
      const shopRaw = shopIndex >= 0 ? (row[shopIndex] ?? '') : '';
      // GHN stores service fees as negative deductions. The reconciliation
      // engine represents carrier cost as a positive number and adjustment as
      // a signed offset, yielding COD - fee + adjustment = total settlement.
      let fee = 0;
      if (summaryFeeCol && row[summaryFeeCol.index] !== undefined && row[summaryFeeCol.index] !== '') {
        fee = Math.abs(ghnNumber(row[summaryFeeCol.index]));
      }
      if (fee === 0 && subFeeCols.length > 0) {
        fee = subFeeCols.reduce((sum, col) => sum + Math.abs(ghnNumber(row[col.index])), 0);
      }
      if (fee === 0 && feeIndexes.length > 0) {
        fee = Math.abs(ghnNumber(row[feeIndexes[0]]));
      }

      const codOnly = codIndex >= 0 ? ghnNumber(row[codIndex]) : 0;
      // GHN column (2) is 'Giao thất bại - thu tiền'. In GHN settlement, this is collected money paid out to the shop.
      const failCollection = (codIndex >= 0 && row[codIndex + 1] !== undefined) ? ghnNumber(row[codIndex + 1]) : 0;
      const cod = codOnly + failCollection;
      const settlement = settlementIndex >= 0 ? ghnNumber(row[settlementIndex]) : (cod - fee);

      // Extract customer order code from column next to waybill if available
      let maDonKH = '';
      if (waybillIndex >= 0 && row[waybillIndex + 1] !== undefined) {
        const candidate = String(row[waybillIndex + 1] || '').trim();
        if (candidate && candidate !== String(waybill).trim() && !candidate.includes('/')) {
          maDonKH = candidate;
        }
      }

      const rowObj: Record<string, any> = {
        'Mã đơn GHN': String(waybill).trim(),
        'Mã đơn khách hàng': maDonKH,
        'Cửa hàng': ghnShopNameFrom(shopRaw),
        'Tên Shop': ghnShopNameFrom(shopRaw),
        'Mã Shop/Kho': ghnShopCodeFrom(shopRaw),
        'Người nhận': shopIndex >= 0 ? (row[shopIndex + 1] ?? '') : '',
        'Địa chỉ nhận': shopIndex >= 0 ? (row[shopIndex + 2] ?? '') : '',
        'Ngày tạo': shopIndex >= 0 ? (row[shopIndex + 3] ?? '') : '',
        'Ngày giao/trả': shopIndex >= 0 ? (row[shopIndex + 4] ?? '') : '',
        'Trạng thái': statusIndex >= 0 ? (row[statusIndex] ?? '') : '',
        'Tiền COD': cod,
        'Tiền COD thuần': codOnly,
        'Giao thất bại - thu tiền': failCollection,
        'Giao thất bại - thu tiền (2)': failCollection,
        'Cước phí': fee,
        'Điều chỉnh': settlement - cod + fee,
        'Tổng đối soát': settlement,
        'Loại dòng đối soát': 'Phiên chuyển tiền COD GHN',
        'Sheet đối soát GHN': sheetName,
      };

      // Populate every raw 2-tier column value into rowObj
      colNameMap.forEach(({ index, name }) => {
        const val = row[index];
        if (val !== undefined && val !== null) {
          rowObj[name] = val;
          const normN = normalizeHeader(name);
          if (normN.includes('ma_don_khach') || normN.includes('ma_kh') || normN === 'ma_don_kh') {
            const vStr = String(val).trim();
            if (vStr) rowObj['Mã đơn khách hàng'] = vStr;
          }
        }
      });

      rows.push(rowObj);
    }
    if (rows.length > 0) {
      return { rows, headers: Array.from(discoveredHeadersSet) };
    }
  }
  return null;
}

export function parseGhnCodTransferWorkbook(workbook: XLSX.WorkBook, sheetNames?: string[]): ParsedExcelFile | null {
  const allDiscoveredHeaders = new Set<string>();

  // Filter sheets: skip summary / index sheets like 'Phiên' or 'Tổng quan' if multiple sheets exist
  const candidateSheetNames = workbook.SheetNames.filter(name => {
    if (workbook.SheetNames.length <= 1) return true;
    const n = normalizeHeader(name);
    if (n === 'phien' || n === 'tong_quan' || n === 'bao_cao' || n === 'summary' || n === 'index') return false;
    const ws = workbook.Sheets[name];
    if (!ws) return false;
    const sample: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const maxCols = Math.max(0, ...sample.slice(0, 15).map(r => (Array.isArray(r) ? r.length : 0)));
    return maxCols >= 3;
  });

  // Prioritize sheets whose name starts with COD_ or contains chi_tiet
  candidateSheetNames.sort((a, b) => {
    const aIsCod = normalizeHeader(a).startsWith('cod_') ? 1 : 0;
    const bIsCod = normalizeHeader(b).startsWith('cod_') ? 1 : 0;
    return bIsCod - aIsCod;
  });

  const targetNames = candidateSheetNames.length > 0 ? candidateSheetNames : workbook.SheetNames;

  const ghnSheets = targetNames.map(sheetName => {
    const ws = workbook.Sheets[sheetName];
    if (!ws) return null;
    const rawSheetData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const result = parseGhnCodTransferSheet(rawSheetData, sheetName);
    if (result && result.rows.length > 0) {
      result.headers.forEach(h => allDiscoveredHeaders.add(h));
      return { name: sheetName, rows: result.rows };
    }
    return null;
  }).filter((sheet): sheet is { name: string; rows: Record<string, any>[] } => !!sheet);

  if (ghnSheets.length === 0) return null;
  const selectedSheets = sheetNames === undefined ? ghnSheets : ghnSheets.filter(sheet => sheetNames.includes(sheet.name));
  return {
    headers: Array.from(allDiscoveredHeaders),
    rows: selectedSheets.flatMap(sheet => sheet.rows),
    format: 'ghn_cod_transfer',
    sheets: ghnSheets.map(sheet => ({ name: sheet.name, rowCount: sheet.rows.length })),
    ignoredSheetNames: workbook.SheetNames.filter(name => !ghnSheets.some(sheet => sheet.name === name)),
  };
}

function findGhnHeaderRow(rawSheetData: any[][]): number {
  for (let rowIndex = 0; rowIndex < Math.min(60, rawSheetData.length); rowIndex++) {
    const normalized = (rawSheetData[rowIndex] || []).map(cell => normalizeHeader(String(cell || '')));
    const waybillCount = normalized.filter(header => header === 'ma_don_ghn').length;
    if (waybillCount >= 2 && normalized.includes('cua_hang')) return rowIndex;
  }
  return -1;
}

/**
 * GHN settlement workbooks place two independent ledgers side-by-side:
 * delivered COD orders on the left and shipment fees charged in the period on
 * the right. A waybill can appear once in each ledger: it is one shipment,
 * not a duplicate. Merge only that unambiguous one-to-one case; every other
 * repetition remains separate so the reconciliation gate can hold it for
 * manual verification.
 */
function parseGhnSettlementSheet(rawSheetData: any[][], sheetName: string): Record<string, any>[] | null {
  const headerRowIndex = findGhnHeaderRow(rawSheetData);
  if (headerRowIndex < 0) return null;

  const headers = rawSheetData[headerRowIndex] || [];
  const normalized = headers.map(cell => normalizeHeader(String(cell || '')));
  const waybillIndexes = normalized
    .map((header, index) => header === 'ma_don_ghn' ? index : -1)
    .filter(index => index >= 0);
  if (waybillIndexes.length < 2) return null;

  const [deliveredStart, feeStart] = waybillIndexes;
  const deliveredRows: Record<string, any>[] = [];
  const feeRows: Record<string, any>[] = [];
  const valueAt = (row: any[], index: number) => row[index] ?? '';
  const validWaybill = (value: any) => {
    const text = String(value || '').trim();
    return text.length >= 4 && !['ma_don_ghn', 'tong_cong', 'tổng cộng'].includes(normalizeHeader(text));
  };
  const shopCodeFrom = ghnShopCodeFrom;
  const shopNameKey = (value: any) => normalizeHeader(String(value || '').replace(/^\s*[A-Za-z0-9]+\s*[-–]\s*/, ''));
  const codesByShopName = new Map<string, Set<string>>();
  for (let rowIndex = headerRowIndex + 1; rowIndex < rawSheetData.length; rowIndex++) {
    const shopValue = valueAt(rawSheetData[rowIndex] || [], deliveredStart + 2);
    const code = shopCodeFrom(shopValue);
    const key = shopNameKey(shopValue);
    if (code && key) {
      const codes = codesByShopName.get(key) || new Set<string>();
      codes.add(code);
      codesByShopName.set(key, codes);
    }
  }

  for (let rowIndex = headerRowIndex + 1; rowIndex < rawSheetData.length; rowIndex++) {
    const row = rawSheetData[rowIndex] || [];
    const deliveredWaybill = valueAt(row, deliveredStart);
    const feeWaybill = valueAt(row, feeStart);

    if (validWaybill(deliveredWaybill)) {
      deliveredRows.push({
        'Mã đơn GHN': String(deliveredWaybill).trim(),
        'Mã đơn khách hàng': valueAt(row, deliveredStart + 1),
        'Cửa hàng': valueAt(row, deliveredStart + 2),
        'Mã Shop/Kho': shopCodeFrom(valueAt(row, deliveredStart + 2)),
        'Người nhận': valueAt(row, deliveredStart + 3),
        'Địa chỉ nhận': valueAt(row, deliveredStart + 4),
        'Ngày tạo': valueAt(row, deliveredStart + 5),
        'Ngày giao/trả': valueAt(row, deliveredStart + 6),
        'Trạng thái': valueAt(row, deliveredStart + 7),
        // GHN uses the third COD column: (1) + (2).
        'Tiền COD': valueAt(row, deliveredStart + 10),
        'Cước phí': 0,
        'Loại dòng đối soát': 'COD đã phát thành công',
        'Sheet đối soát GHN': sheetName,
      });
    }

    if (validWaybill(feeWaybill)) {
      const rawFee = valueAt(row, feeStart + 7);
      const numericFee = typeof rawFee === 'number' ? rawFee : Number(String(rawFee).replace(/[^0-9.-]/g, ''));
      const feeShopName = valueAt(row, feeStart + 2);
      const feeShopCodes = codesByShopName.get(shopNameKey(feeShopName));
      const inferredFeeShopCode = feeShopCodes?.size === 1 ? Array.from(feeShopCodes)[0] : '';
      feeRows.push({
        'Mã đơn GHN': String(feeWaybill).trim(),
        'Mã đơn khách hàng': valueAt(row, feeStart + 1),
        'Cửa hàng': feeShopName,
        // GHN's right-hand fee ledger often omits the numeric prefix. Infer it
        // only when the same normalized shop name maps to exactly one code in
        // the left COD ledger of this very sheet; otherwise leave it blank.
        'Mã Shop/Kho': shopCodeFrom(feeShopName) || inferredFeeShopCode,
        'Người nhận': valueAt(row, feeStart + 3),
        'SĐT Người nhận': valueAt(row, feeStart + 4),
        'Địa chỉ nhận': valueAt(row, feeStart + 5),
        'Ngày tạo': valueAt(row, feeStart + 6),
        'Ngày giao/trả': '',
        'Trạng thái': 'Đã cấn cước GHN',
        // GHN writes charged fees as negative numbers; reconciliation stores
        // carrier costs as positive amounts.
        'Tiền COD': 0,
        'Cước phí': Number.isFinite(numericFee) ? Math.abs(numericFee) : 0,
        'Loại dòng đối soát': 'Cước GHN đã cấn trừ',
        'Sheet đối soát GHN': sheetName,
      });
    }
  }
  const byWaybill = (items: Record<string, any>[]) => items.reduce((map, item) => {
    const waybill = String(item['Mã đơn GHN'] || '').trim().toUpperCase();
    const list = map.get(waybill) || [];
    list.push(item);
    map.set(waybill, list);
    return map;
  }, new Map<string, Record<string, any>[]>());
  const deliveredByWaybill = byWaybill(deliveredRows);
  const feesByWaybill = byWaybill(feeRows);
  const rows: Record<string, any>[] = [];
  const mergedWaybills = new Set<string>();

  deliveredRows.forEach(delivered => {
    const waybill = String(delivered['Mã đơn GHN'] || '').trim().toUpperCase();
    const deliveredMatches = deliveredByWaybill.get(waybill) || [];
    const feeMatches = feesByWaybill.get(waybill) || [];
    if (deliveredMatches.length === 1 && feeMatches.length === 1) {
      const fee = feeMatches[0];
      rows.push({
        ...delivered,
        'Cước phí': fee['Cước phí'],
        'Loại dòng đối soát': 'COD + cước GHN đã cấn trừ',
      });
      mergedWaybills.add(waybill);
      return;
    }
    rows.push(delivered);
  });

  feeRows.forEach(fee => {
    const waybill = String(fee['Mã đơn GHN'] || '').trim().toUpperCase();
    if (!mergedWaybills.has(waybill)) rows.push(fee);
  });

  return rows;
}

export function parseGhnSettlementWorkbook(workbook: XLSX.WorkBook, sheetNames?: string[]): ParsedExcelFile | null {
  const ghnSheets = workbook.SheetNames.map(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rawSheetData: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const rows = parseGhnSettlementSheet(rawSheetData, sheetName);
    return rows ? { name: sheetName, rows } : null;
  }).filter((sheet): sheet is { name: string; rows: Record<string, any>[] } => !!sheet);

  if (ghnSheets.length === 0) return null;
  const selectedSheets = sheetNames === undefined
    ? ghnSheets
    : ghnSheets.filter(sheet => sheetNames.includes(sheet.name));
  return {
    headers: GHN_SETTLEMENT_HEADERS,
    rows: selectedSheets.flatMap(sheet => sheet.rows),
    format: 'ghn_settlement',
    sheets: ghnSheets.map(sheet => ({ name: sheet.name, rowCount: sheet.rows.length })),
    ignoredSheetNames: workbook.SheetNames.filter(name => !ghnSheets.some(sheet => sheet.name === name)),
  };
}

export const ExcelService = {
  // Intelligent parser supporting title banners, multi-line headers and multiple sheets
  async parseExcelFile(file: File, options?: { sheetNames?: string[] }): Promise<ParsedExcelFile> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });

          const ghnCodTransferParsed = parseGhnCodTransferWorkbook(workbook, options?.sheetNames);
          if (ghnCodTransferParsed) {
            resolve(ghnCodTransferParsed);
            return;
          }

          // const ghnParsed = parseGhnSettlementWorkbook(workbook, options?.sheetNames);
          // if (ghnParsed) {
          //   resolve(ghnParsed);
          //   return;
          // }

          // Intelligent Sheet Selection Fallback:
          // Never blind-pick Sheet 0 if Sheet 0 is a 2-column index sheet like 'Phiên'!
          let targetSheetName = workbook.SheetNames[0];
          if (workbook.SheetNames.length > 1) {
            // Find a sheet starting with COD_ or containing chi_tiet/don_hang/danh_sach
            const candidate = workbook.SheetNames.find(sn => {
              const n = normalizeHeader(sn);
              return n.startsWith('cod_') || n.includes('chi_tiet') || n.includes('don_hang') || n.includes('danh_sach');
            });
            if (candidate) {
              targetSheetName = candidate;
            } else {
              // Pick sheet with greatest column count (avoiding 1-2 column summary sheets)
              let maxColsFound = 0;
              for (const sn of workbook.SheetNames) {
                const ws = workbook.Sheets[sn];
                if (!ws) continue;
                const sample: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
                const cols = Math.max(0, ...sample.slice(0, 10).map(r => (Array.isArray(r) ? r.length : 0)));
                if (cols > maxColsFound) {
                  maxColsFound = cols;
                  targetSheetName = sn;
                }
              }
            }
          }

          const worksheet = workbook.Sheets[targetSheetName];
          
          // Convert sheet to 2D array of rows to inspect headers
          const rawSheetData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
          
          if (!rawSheetData || rawSheetData.length === 0) {
            resolve({ headers: [], rows: [], format: 'standard' });
            return;
          }

          // Search top 10 rows to find the actual header row(s) containing key logistics terms
          let headerRowIndex = -1;
          let bestScore = 0;

          for (let r = 0; r < Math.min(10, rawSheetData.length); r++) {
            const row = rawSheetData[r];
            if (!Array.isArray(row)) continue;
            
            const rowStr = row.map(c => normalizeHeader(String(c))).join(' ');
            let score = 0;
            if (rowStr.includes('ma_van_don') || rowStr.includes('tracking') || rowStr.includes('mvd') || rowStr.includes('ma_don')) score += 5;
            if (rowStr.includes('thu_ho') || rowStr.includes('cod')) score += 3;
            if (rowStr.includes('ten_shop') || rowStr.includes('nguoi_gui') || rowStr.includes('kho_gui') || rowStr.includes('cua_hang')) score += 3;
            if (rowStr.includes('cuoc') || rowStr.includes('phi')) score += 2;
            if (rowStr.includes('trong_luong') || rowStr.includes('can_nang') || rowStr.includes('khoi_luong')) score += 2;
            if (rowStr.includes('trang_thai') || rowStr.includes('status')) score += 2;

            if (score > bestScore) {
              bestScore = score;
              headerRowIndex = r;
            }
          }

          if (headerRowIndex === -1) {
            headerRowIndex = 0;
          }

          // Check if headerRowIndex + 1 is ALSO a header row (2-header Excel layout like GHN)
          let hasSecondHeaderRow = false;
          if (headerRowIndex + 1 < rawSheetData.length) {
            const nextRow = rawSheetData[headerRowIndex + 1];
            if (Array.isArray(nextRow) && nextRow.length > 0) {
              // Ensure nextRow is not a real data row containing order details, phone numbers, waybill codes or numeric amounts
              const hasRealOrderData = nextRow.some(val => {
                if (val === null || val === undefined || val === '') return false;
                if (typeof val === 'number' && val > 100) return true;
                const s = String(val).trim();
                if (!s) return false;
                // Numeric amount > 100
                if (/^\d{3,}$/.test(s) && Number(s) > 100 && !s.startsWith('0')) return true;
                // Vietnamese phone number (09xx, 08xx, 07xx, 03xx, 05xx)
                if (/^0[1-9]\d{8,9}$/.test(s.replace(/[\s.-]/g, ''))) return true;
                // Date/time timestamp (e.g. 2026-10-19, 19/10/2026)
                if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return true;
                // Waybill code (10 to 15 digits)
                if (/^\d{10,15}$/.test(s)) return true;
                return false;
              });

              if (!hasRealOrderData) {
                const nextRowStr = nextRow.map(c => normalizeHeader(String(c))).join(' ');
                const isNextRowHeader = (
                  nextRowStr.includes('ma_van_don') ||
                  nextRowStr.includes('so_van_don') ||
                  nextRowStr.includes('tracking') ||
                  nextRowStr.includes('mvd') ||
                  nextRowStr.includes('ma_don') ||
                  nextRowStr.includes('ten_shop') ||
                  nextRowStr.includes('nguoi_gui') ||
                  nextRowStr.includes('thu_ho') ||
                  nextRowStr.includes('cod') ||
                  nextRowStr.includes('cuoc') ||
                  nextRowStr.includes('phi') ||
                  nextRowStr.includes('trong_luong') ||
                  nextRowStr.includes('can_nang') ||
                  nextRowStr.includes('sdt') ||
                  nextRowStr.includes('dien_thoai') ||
                  nextRowStr.includes('trang_thai') ||
                  nextRowStr.includes('dia_chi')
                );

                if (isNextRowHeader) {
                  hasSecondHeaderRow = true;
                }
              }
            }
          }

          // Extract and merge headers
          const topHeadersRow = rawSheetData[headerRowIndex] || [];
          const subHeadersRow = hasSecondHeaderRow ? (rawSheetData[headerRowIndex + 1] || []) : [];
          
          const maxCols = Math.max(topHeadersRow.length, subHeadersRow.length);
          const headers: string[] = [];

          // Forward-fill merged parent headers (Excel merged cells e.g. "Thông tin người gửi" spanning cols)
          let currentParentHeader = '';
          const resolvedTopHeaders: string[] = [];
          for (let cIdx = 0; cIdx < maxCols; cIdx++) {
            const topVal = String(topHeadersRow[cIdx] || '').trim();
            if (topVal) {
              currentParentHeader = topVal;
            }
            resolvedTopHeaders.push(topVal || currentParentHeader);
          }

          for (let cIdx = 0; cIdx < maxCols; cIdx++) {
            const topH = (resolvedTopHeaders[cIdx] || '').trim();
            const subH = String(subHeadersRow[cIdx] || '').trim();

            let finalHeaderName = '';
            if (topH && subH && topH !== subH && !topH.toLowerCase().startsWith('stt')) {
              finalHeaderName = `${topH} - ${subH}`;
            } else if (subH) {
              finalHeaderName = subH;
            } else if (topH) {
              finalHeaderName = topH;
            } else {
              finalHeaderName = `Cột_${cIdx + 1}`;
            }

            headers.push(finalHeaderName);
          }

          // 🔑 Waybill Anchor Alignment Engine: Find exact column index of waybill
          let waybillColIdx = -1;
          for (let c = 0; c < headers.length; c++) {
            const hNorm = normalizeHeader(headers[c]);
            if (hNorm.includes('ma_van_don') || hNorm.includes('mvd') || hNorm.includes('tracking') || hNorm.includes('ma_don')) {
              waybillColIdx = c;
              break;
            }
          }

          // Scan downwards to find the FIRST row that contains a real Waybill code
          let dataStartRowIndex = hasSecondHeaderRow ? headerRowIndex + 2 : headerRowIndex + 1;
          if (waybillColIdx !== -1) {
            for (let r = headerRowIndex + 1; r < Math.min(headerRowIndex + 10, rawSheetData.length); r++) {
              const rowVal = String(rawSheetData[r]?.[waybillColIdx] || '').trim();
              const normVal = normalizeHeader(rowVal);
              const isHeaderVal = normVal.includes('ma_van_don') || normVal.includes('ma_don') || normVal.includes('tracking') || normVal.includes('stt') || normVal.includes('tong');
              
              if (rowVal && rowVal.length >= 3 && !isHeaderVal) {
                dataStartRowIndex = r;
                break;
              }
            }
          }

          // Build object rows from subsequent data rows
          const rows: Record<string, any>[] = [];
          for (let r = dataStartRowIndex; r < rawSheetData.length; r++) {
            const rowData = rawSheetData[r];
            if (!Array.isArray(rowData)) continue;

            const isRowEmpty = rowData.every(val => val === '' || val === null || val === undefined);
            if (isRowEmpty) continue;

            const rowObj: Record<string, any> = {};
            headers.forEach((headerName, cIdx) => {
              rowObj[headerName] = rowData[cIdx] !== undefined ? rowData[cIdx] : '';
            });
            rows.push(rowObj);
          }

          resolve({ headers, rows, format: 'standard' });
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  },

  formatMoney(num: number): string {
    if (num === undefined || num === null || isNaN(num)) return '0';
    return new Intl.NumberFormat('vi-VN').format(num);
  },



  async createShopStatementWorkbook(statement: ShopSettlementStatement, customExportSettings?: ExportColumnSettings): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();
    
    // Auto-fetch full session orders if current statement in memory lacks order items
    if (!statement.orders || statement.orders.length === 0) {
      const allSessions = StorageService.getSessions();
      const parentSession = allSessions.find(s => (s.statements || []).some(st => st.shopId === statement.shopId || st.shopCode === statement.shopCode || st.shopName === statement.shopName));
      if (parentSession) {
        const fullSession = await StorageService.getSessionDetail(parentSession.id);
        const fullStmt = fullSession?.statements?.find(st => st.shopId === statement.shopId || st.shopCode === statement.shopCode || st.shopName === statement.shopName);
        if (fullStmt && fullStmt.orders && fullStmt.orders.length > 0) {
          statement = fullStmt;
        }
      }
    }

    const carrierId = statement.orders?.[0]?.carrierId;
    const savedSettings = customExportSettings || (carrierId ? StorageService.getCarrierExportSettings(carrierId) : StorageService.getExportColumnSettings()) || StorageService.getExportColumnSettings();
    
    // Default to ALL merged columns from the 2 files if no custom carrier settings exist
    const activeCols = buildDynamicColumnsFromOrders(statement.orders, savedSettings, false);
    const company = StorageService.getCompanyInfo();

    const companyTitle = (company.companyName || 'CÔNG TY GOM ĐƠN VẬN CHUYỂN & LOGISTICS').toUpperCase();
    const companySubtitle = `Địa chỉ: ${company.address || ''}${company.phone ? ' | SĐT: ' + company.phone : ''}${company.taxCode ? ' | MST: ' + company.taxCode : ''}`;

    // ──────────────────────────────────────────
    // SHEET 1: TỔNG HỢP CÔNG NỢ
    // ──────────────────────────────────────────
    const wsSummary = workbook.addWorksheet('TONG_HOP_CONG_NO');
    wsSummary.views = [{ showGridLines: false }]; // 🌟 Yêu cầu 3: Ẩn đường kẻ lưới dạng hóa đơn

    wsSummary.columns = [
      { width: 44 },
      { width: 30 },
      { width: 18 },
      { width: 44 },
    ];

    const thinBorder = {
      top: { style: 'thin' as const, color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin' as const, color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin' as const, color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin' as const, color: { argb: 'FFCBD5E1' } },
    };

    // 🌟 Yêu cầu 4: Tên công ty to trên cùng gộp ô A1:D1 và căn giữa
    const row1 = wsSummary.addRow([companyTitle, '', '', '']);
    wsSummary.mergeCells('A1:D1');
    row1.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF1E3A8A' } }; // Dark Navy
    row1.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };

    const row2 = wsSummary.addRow([companySubtitle, '', '', '']);
    wsSummary.mergeCells('A2:D2');
    row2.font = { name: 'Arial', size: 10.5, italic: true, color: { argb: 'FF475569' } }; // Slate Gray
    row2.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };

    const row3 = wsSummary.addRow(['BẢNG KÊ ĐỐI SOÁT TIỀN THU HỘ (COD) VÀ CƯỚC PHÍ VẬN CHUYỂN', '', '', '']);
    wsSummary.mergeCells('A3:D3');
    row3.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF4F46E5' } }; // Indigo
    row3.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };

    const row4 = wsSummary.addRow([`Kỳ đối soát: ${statement.periodName}`, '', `Ngày xuất phiếu: ${new Date().toLocaleDateString('vi-VN')}`, '']);
    row4.font = { name: 'Arial', size: 11, color: { argb: 'FF334155' } };

    wsSummary.addRow([]); // Blank line

    // Section I: Shop Info Box
    const sec1 = wsSummary.addRow(['I. THÔNG TIN KHÁCH HÀNG (SHOP)', '', '', '']);
    sec1.font = { name: 'Arial', size: 11.5, bold: true, color: { argb: 'FF1E293B' } };

    const r7 = wsSummary.addRow(['Tên Shop:', statement.shopName, 'Mã khách hàng:', statement.shopCode]);
    const r8 = wsSummary.addRow(['Số điện thoại:', statement.shopPhone, 'Email:', statement.shopEmail || '']);
    const r9 = wsSummary.addRow(['Địa chỉ gửi:', statement.shopAddress || '', '', '']);

    [r7, r8, r9].forEach(r => {
      r.eachCell({ includeEmpty: true }, cell => {
        cell.border = thinBorder;
      });
      r.getCell(1).font = { bold: true };
      r.getCell(3).font = { bold: true };
    });

    wsSummary.addRow([]);

    // Section II: Bank Info Box
    const sec2 = wsSummary.addRow(['II. THÔNG TIN TÀI KHOẢN NHẬN TIỀN COD', '', '', '']);
    sec2.font = { name: 'Arial', size: 11.5, bold: true, color: { argb: 'FF1E293B' } };

    const r12 = wsSummary.addRow(['Ngân hàng:', statement.bankInfo?.bankName || 'Chưa cập nhật', '', '']);
    const r13 = wsSummary.addRow(['Số tài khoản:', statement.bankInfo?.accountNumber || 'Chưa cập nhật', '', '']);
    const r14 = wsSummary.addRow(['Chủ tài khoản:', statement.bankInfo?.accountHolder || statement.shopName || 'Chưa cập nhật', '', '']);

    [r12, r13, r14].forEach(r => {
      r.eachCell({ includeEmpty: true }, cell => {
        cell.border = thinBorder;
      });
      r.getCell(1).font = { bold: true };
    });

    wsSummary.addRow([]);

    // Section III: Financial Summary Table
    const sec3 = wsSummary.addRow(['III. BẢNG TỔNG HỢP DÒNG TIỀN ĐỐI SOÁT', '', '', '']);
    sec3.font = { name: 'Arial', size: 11.5, bold: true, color: { argb: 'FF1E293B' } };

    const tblHeader = wsSummary.addRow(['Hạng mục', 'Số lượng / Giá trị', 'Đơn vị tính', 'Ghi chú']);
    tblHeader.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = thinBorder;
    });

    // 🌟 Thống kê chi tiết tài chính: Tách chuẩn xác Đơn Giao Thành Công (Hoàn COD) và Đơn Gửi Hàng (Tính Cước)
    // CHỈ cấn trừ công nợ đầu kỳ khi Shop bị nợ cước âm (< 0), tuyệt đối không cộng dồn số tiền dương của kỳ trước.
    const previousDebtVal = (statement.previousDebt && statement.previousDebt < 0) ? statement.previousDebt : 0;
    const netBalance = statement.totalNetPayout + previousDebtVal;
    const finalPayout = netBalance; // Giữ nguyên dấu âm (-) nếu Shop bị âm tiền theo yêu cầu người dùng
    const amountShopOwes = Math.max(0, -netBalance);

    const codOrders = statement.orders.filter(o => (o.codAmount || 0) > 0);
    const feeOrders = statement.orders.filter(o => ((o.shopCalculatedFee || 0) + (o.shopOtherFee || 0)) > 0 || (Math.abs(o.nvcBaseFee || 0) + Math.abs(o.nvcOtherFee || 0)) > 0 || o.status === 'in_transit' || o.status === 'fee_charged');
    const returnedOrdersList = statement.orders.filter(o => o.status === 'returned' || o.status === 'returning');
    const partialOrdersList = statement.orders.filter(o => o.isPartialDelivery);

    const shopFeeVal = statement.totalShopFee > 0 ? -Math.abs(statement.totalShopFee) : 0;
    const otherFeeVal = statement.totalShopOtherFee > 0 ? -Math.abs(statement.totalShopOtherFee) : 0;

    const rowsData = [
      ['1. Tổng số dòng đối soát trong kỳ', statement.totalOrders, 'Đơn', 'Tổng đơn xuất đối soát trong kỳ'],
      ['2. Số đơn giao thành công (Hoàn COD)', codOrders.length, 'Đơn', `Tiền COD hoàn: ${statement.totalCod.toLocaleString('vi-VN')} VNĐ | Cước: 0 VNĐ`],
      ['3. Số đơn phát sinh gửi hàng (Tính cước)', statement.shippingOrders !== undefined ? statement.shippingOrders : feeOrders.length, 'Đơn', `Cước gửi: ${(statement.totalShopFee + statement.totalShopOtherFee).toLocaleString('vi-VN')} VNĐ`],
      ['4. Số đơn chuyển hoàn', returnedOrdersList.length, 'Đơn', returnedOrdersList.length > 0 ? `Phí hoàn: ${(statement.totalReturnedFee || 0).toLocaleString('vi-VN')} VNĐ` : 'Không có'],
      ['5. Số đơn giao 1 phần (GH1P)', partialOrdersList.length, 'Đơn', partialOrdersList.length > 0 ? `COD: ${(statement.totalPartialCod || 0).toLocaleString('vi-VN')} VNĐ | Cước/Phí: ${(statement.totalPartialFee || 0).toLocaleString('vi-VN')} VNĐ` : 'Không có'],
      ['6. TỔNG TIỀN THU HỘ (COD) (+)', statement.totalCod, 'VNĐ', 'Tổng tiền COD NVC đã thu từ người nhận'],
      ['7. TỔNG CƯỚC PHÍ VẬN CHUYỂN (-)', shopFeeVal, 'VNĐ', 'Cước tính theo biểu giá riêng của Shop'],
      ['8. Phí phụ thu / Khai giá / GH1P / Bảo hiểm (-)', otherFeeVal, 'VNĐ', 'Bao gồm phụ phí, khai giá và cước GH1P'],
      ['9. Công nợ kỳ trước mang sang (-)', previousDebtVal, 'VNĐ', previousDebtVal < 0 ? 'Shop nợ công ty (trừ vào kỳ này)' : 'Không có công nợ kỳ trước'],
      ['10. Shop còn nợ công ty', amountShopOwes > 0 ? -amountShopOwes : 0, 'VNĐ', amountShopOwes > 0 ? 'Tự chuyển sang kỳ sau để cấn trừ' : 'Không phát sinh'],
    ];

    rowsData.forEach(r => {
      const addedRow = wsSummary.addRow(r);
      addedRow.eachCell({ includeEmpty: true }, cell => {
        cell.border = thinBorder;
      });

      const valCell = addedRow.getCell(2);
      if (typeof r[1] === 'number' && (typeof r[0] === 'string' && (r[0].includes('TỔNG') || r[0].includes('Công nợ') || r[0].includes('nợ')))) {
        valCell.numFmt = '#,##0;[Red]-#,##0';
        valCell.font = { bold: true, color: (r[1] < 0) ? { argb: 'FFFF0000' } : undefined };
      }
      addedRow.getCell(3).alignment = { horizontal: 'center' };
    });

    // 🌟 GRAND TOTAL ROW (SỐ TIỀN THỰC CHUYỂN FOR SHOP) - Yellow Fill + Bold Red Text (Hiển thị số âm nếu Shop bị âm tiền)
    const grandRow = wsSummary.addRow([
      '▶ SỐ TIỀN THỰC CHUYỂN CHO SHOP (=)',
      finalPayout,
      'VNĐ',
      finalPayout < 0 ? 'Shop đang nợ cước công ty; tự động cấn trừ sang kỳ sau' : 'Tiền công ty sẽ chuyển khoản cho Shop'
    ]);
    grandRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }; // Yellow
      cell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFF0000' } }; // Red
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'double', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } },
      };
    });
    grandRow.getCell(2).numFmt = '#,##0;[Red]-#,##0';
    grandRow.getCell(3).alignment = { horizontal: 'center' };

    wsSummary.addRow([]);

    // 🌟 Yêu cầu 2: Thay "ĐẠI DIỆN NHÀ GOM ĐƠN" thành "ĐẠI DIỆN CÔNG TY KÝ"
    const sigRow1 = wsSummary.addRow(['ĐẠI DIỆN CÔNG TY KÝ', '', 'ĐẠI DIỆN KHÁCH HÀNG (SHOP)']);
    sigRow1.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF1E293B' } };
    sigRow1.getCell(1).alignment = { horizontal: 'center' };
    sigRow1.getCell(3).alignment = { horizontal: 'center' };

    const sigRow2 = wsSummary.addRow(['(Ký & Ghi rõ họ tên)', '', '(Ký & Ghi rõ họ tên)']);
    sigRow2.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF64748B' } };
    sigRow2.getCell(1).alignment = { horizontal: 'center' };
    sigRow2.getCell(3).alignment = { horizontal: 'center' };

    // ──────────────────────────────────────────
    // SHEET 2: CHI TIẾT ĐƠN HÀNG (DYNAMIC NON-EMPTY COLUMNS)
    // ──────────────────────────────────────────
    const wsOrders = workbook.addWorksheet('CHI_TIET_VAN_DON');

    // Column Widths
    wsOrders.columns = activeCols.map((col: ExportColumnItem) => {
      const lowerLabel = (col.label || col.id).toLowerCase();
      if (col.id === 'stt') return { width: 8 };
      if (col.id === 'waybill') return { width: 22 };
      if (col.id === 'receiverAddress') return { width: 38 };
      if (col.id === 'receiverName' || col.id === 'productName') return { width: 26 };
      if (col.id === 'date' || lowerLabel.includes('ngay') || lowerLabel.includes('date') || lowerLabel.includes('thoi_gian')) return { width: 22 };
      return { width: 20 };
    });

    // Sheet 2 Company Header
    const oRow1 = wsOrders.addRow([companyTitle]);
    oRow1.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF1E3A8A' } };

    const oRow2 = wsOrders.addRow([companySubtitle]);
    oRow2.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF475569' } };

    const oRow3 = wsOrders.addRow([`BẢNG KÊ CHI TIẾT MÃ VẬN ĐƠN ĐỐI SOÁT - SHOP: ${statement.shopName.toUpperCase()}`]);
    oRow3.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF4F46E5' } };

    wsOrders.addRow([]); // Blank line

    // Table Header Row
    const headersRow = activeCols.map((c: ExportColumnItem) => c.label);
    const oTblHeader = wsOrders.addRow(headersRow);
    oTblHeader.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Orders Data Rows
    statement.orders.forEach((order, idx) => {
      const rowData: any[] = [];
      activeCols.forEach((col: ExportColumnItem) => {
        let val: any = '';
        const normLabel = normalizeHeader(col.label || col.id || '');
        const normSrc = normalizeHeader(col.sourceHeader || '');

        if (col.id === 'stt' || normLabel === 'stt') {
          val = idx + 1;
        } else if (
          col.id === 'shopFee' ||
          normLabel === 'cuoc_tinh_shop_vnd' ||
          normLabel === 'cuoc_thu_shop' ||
          normLabel === 'cuoc_phi_van_chuyen' ||
          normSrc === 'cuoc_phi' ||
          normSrc.includes('phi_giao_hang') ||
          normSrc.includes('phi_dich_vu') ||
          normSrc.includes('tien_cuoc') ||
          normSrc.includes('cuoc_pp_pm') ||
          (normLabel.includes('phi_giao_hang') && !normLabel.includes('giao_lai')) ||
          (normLabel.includes('phi_dich_vu')) ||
          (normLabel.includes('tien_cuoc')) ||
          (normLabel.includes('cuoc_phi') && !normLabel.includes('khac')) ||
          (normLabel.includes('cuoc') && !normLabel.includes('khac') && !normLabel.includes('goc') && !normLabel.includes('nvc'))
        ) {
          // 🛡️ CƯỚC GIAO HÀNG TÍNH THEO GIÁ SHOP:
          // Nếu đơn hàng có phát sinh cước gửi, xuất đúng giá thỏa thuận của Shop (ví dụ -17.000đ hoặc 13.000đ).
          // Nếu là đơn hoàn COD (cước = 0), xuất 0đ.
          const fee = order.shopCalculatedFee ?? 0;
          if (fee > 0) {
            // Nếu cột gốc có dấu âm (-), giữ format âm
            const rawVal = order.rawNvcData?.[col.sourceHeader || ''] ?? order.rawNvcData?.[col.label || ''] ?? order.rawAppData?.[col.sourceHeader || ''] ?? order.rawAppData?.[col.label || ''];
            val = (typeof rawVal === 'number' && rawVal < 0) || (typeof rawVal === 'string' && rawVal.startsWith('-')) ? -fee : fee;
          } else {
            val = 0;
          }
        } else if (
          col.id === 'shopOtherFee' ||
          normLabel === 'phu_phi_shop_vnd' ||
          normLabel.includes('phu_thu')
        ) {
          val = order.shopOtherFee ?? 0;
        } else if (
          col.id === 'netPayout' ||
          normLabel === 'thuc_chuyen_cho_shop_vnd' ||
          normLabel.includes('so_tien_phai_tra_sau_can_tru') ||
          normLabel.includes('thuc_chuyen') ||
          normLabel.includes('thuc_tra') ||
          normSrc.includes('so_tien_phai_tra_sau_can_tru')
        ) {
          // 🛡️ SỐ TIỀN THỰC CHUYỂN (= COD - Cước Shop)
          val = order.netShopPayout ?? 0;
        } else if (
          normLabel.includes('tong_doi_soat') ||
          normSrc.includes('tong_doi_soat')
        ) {
          // Cột Tổng đối soát của GHN: = COD - Cước Shop
          val = (order.codAmount || 0) - (order.shopCalculatedFee || 0) - (order.shopOtherFee || 0);
        } else if (
          col.id === 'profit' ||
          col.id === 'nvcFee' ||
          normLabel.includes('loi_nhuan') ||
          normLabel.includes('lai_rong') ||
          normLabel.includes('cuoc_goc') ||
          normLabel.includes('cuoc_nvc') ||
          normSrc.includes('cuoc_goc') ||
          normSrc.includes('cuoc_nvc')
        ) {
          // 🛡️ TUYỆT ĐỐI ẨN LỢI NHUẬN / CƯỚC GỐC KHỎI FILE SHOP
          val = 0;
        } else {
          val = (order.rawNvcData && col.sourceHeader && order.rawNvcData[col.sourceHeader] !== undefined ? order.rawNvcData[col.sourceHeader] : undefined) ??
                (order.rawAppData && col.sourceHeader && order.rawAppData[col.sourceHeader] !== undefined ? order.rawAppData[col.sourceHeader] : undefined) ??
                (order.rawNvcData && order.rawNvcData[col.label] !== undefined ? order.rawNvcData[col.label] : undefined) ??
                (order.rawAppData && order.rawAppData[col.label] !== undefined ? order.rawAppData[col.label] : undefined) ??
                resolveOrderColumnValue(order, col, idx);
        }

        const isDateCol = (normLabel.includes('ngay') || normLabel.includes('date') || normLabel.includes('thoi_gian') ||
                           normSrc.includes('ngay') || normSrc.includes('date') || normSrc.includes('thoi_gian')) &&
                          !normLabel.includes('tien') && !normLabel.includes('cuoc') && !normLabel.includes('phi') && !normLabel.includes('cod') && !normLabel.includes('tra') &&
                          !normSrc.includes('tien') && !normSrc.includes('cuoc') && !normSrc.includes('phi') && !normSrc.includes('cod') && !normSrc.includes('tra');
        
        if (isDateCol && val !== undefined && val !== null && val !== '') {
          val = formatAnyDateValue(val);
        }
        rowData.push(val ?? '');
      });

      const addedOrderRow = wsOrders.addRow(rowData);
      
      // Formatting cell values
      activeCols.forEach((col, cIdx) => {
        const cell = addedOrderRow.getCell(cIdx + 1);
        const normId = normalizeHeader(col.id || '');
        const normLabel = normalizeHeader(col.label || '');

        if (
          normId === 'codamount' || normId === 'shopfee' || normId === 'shopotherfee' || normId === 'netpayout' || normId === 'nvcfee' || normId === 'profit' ||
          normLabel.includes('cod') || normLabel.includes('thu_ho') || normLabel.includes('cuoc') || normLabel.includes('thuc_chuyen') || normLabel.includes('thuc_tra') || normLabel.includes('phi') || normLabel.includes('tien_')
        ) {
          const rawNum = cell.value !== null && cell.value !== undefined && cell.value !== '' ? Number(String(cell.value).replace(/,/g, '')) : NaN;
          if (!isNaN(rawNum)) {
            cell.value = rawNum;
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'right' };
          }
        } else if (normId === 'weight' || normLabel.includes('khoi_luong') || normLabel.includes('trong_luong') || normLabel.includes('can_nang')) {
          const rawNum = cell.value !== null && cell.value !== undefined && cell.value !== '' ? Number(String(cell.value).replace(/,/g, '')) : NaN;
          if (!isNaN(rawNum)) {
            cell.value = rawNum;
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right' };
          }
        } else if (
          normId === 'stt' || normId === 'waybill' || normId === 'date' ||
          normLabel.includes('stt') || normLabel.includes('ma_van_don') || normLabel.includes('ngay') || normLabel.includes('date') || normLabel.includes('thoi_gian') || normLabel.includes('gui_hang')
        ) {
          cell.alignment = { horizontal: 'center' };
        }
      });
    });

    // 🌟 TOTAL SUMMARY ROW (TỔNG CỘNG BÔI VÀNG Ô CHỮ ĐỎ)
    const totalWeight = Number(statement.orders.reduce((sum, o) => sum + (o.weight || 0), 0).toFixed(2));
    const totalRowData: any[] = [];
    activeCols.forEach((col: ExportColumnItem) => {
      const normId = normalizeHeader(col.id || '');
      const normLabel = normalizeHeader(col.label || '');
      const src = col.sourceHeader || '';

      if (normId === 'stt' || normLabel === 'stt') {
        totalRowData.push('TỔNG CỘNG');
      } else if (normId === 'waybill' || src === 'Mã vận đơn' || normLabel === 'ma_van_don') {
        totalRowData.push(`${statement.orders.length} đơn`);
      } else if (normId === 'weight' || normLabel === 'khoi_luong' || normLabel === 'trong_luong' || normLabel === 'can_nang') {
        totalRowData.push(totalWeight);
      } else if (col.id === 'codAmount' || src === 'Tiền COD đã ký nhận' || src === 'Tiền thu hộ COD' || src === 'COD thực thu' || normLabel === 'tien_cod_da_ky_nhan' || normLabel === 'tien_thu_ho_cod') {
        totalRowData.push(statement.totalCod);
      } else if (
        col.id === 'shopFee' ||
        normLabel === 'cuoc_tinh_shop_vnd' ||
        normLabel === 'cuoc_thu_shop' ||
        normLabel === 'cuoc_phi' ||
        normLabel.includes('cuoc_phi') ||
        normLabel.includes('cuoc_chinh') ||
        normLabel.includes('tien_cuoc_pp_pm') ||
        normLabel.includes('phi_giao_hang') ||
        normLabel.includes('phi_dich_vu') ||
        src === 'Tiền cước PP_PM' ||
        src === 'Cước phí' ||
        src.includes('phi_giao_hang') ||
        src.includes('phi_dich_vu')
      ) {
        totalRowData.push(statement.totalShopFee);
      } else if (col.id === 'shopOtherFee' || normLabel === 'phu_phi_shop_vnd') {
        totalRowData.push(statement.totalShopOtherFee);
      } else if (
        col.id === 'netPayout' ||
        normLabel === 'thuc_chuyen_cho_shop_vnd' ||
        normLabel.includes('so_tien_phai_tra_sau_can_tru') ||
        normLabel.includes('thuc_chuyen') ||
        normLabel.includes('thuc_tra') ||
        normLabel.includes('tong_doi_soat') ||
        src === 'Số tiền phải trả sau cấn trừ' ||
        src.includes('tong_doi_soat')
      ) {
        totalRowData.push(statement.totalNetPayout);
      } else if (
        (col.id === 'codAmount' || normLabel.includes('cod') || normLabel.includes('thu_ho') ||
         col.id === 'failCod' || normLabel.includes('that_bai') ||
         col.id === 'prepaid' || normLabel.includes('thanh_toan_truoc') ||
         normLabel.includes('khuyen_mai') ||
         normLabel.includes('phi_') || normLabel.includes('cuoc_') ||
         src.includes('Tiền') || src.includes('Phí') || src.includes('Cước')) &&
        !normId.includes('code') && !normId.includes('id') &&
        !normLabel.includes('ma_') && !normLabel.includes('so_dt') && !normLabel.includes('sdt') && !normLabel.includes('ngay') && !normLabel.includes('date')
      ) {
        const colSum = statement.orders.reduce((sum, o) => {
          const v = (o.rawNvcData && col.sourceHeader ? o.rawNvcData[col.sourceHeader] : undefined) ??
                    (o.rawAppData && col.sourceHeader ? o.rawAppData[col.sourceHeader] : undefined) ??
                    (o.rawNvcData ? o.rawNvcData[col.label] : undefined) ??
                    (o.rawAppData ? o.rawAppData[col.label] : undefined);
          const n = typeof v === 'number' ? v : Number(String(v || '').replace(',', '.'));
          return sum + (!isNaN(n) ? n : 0);
        }, 0);
        totalRowData.push(colSum !== 0 ? colSum : 0);
      } else {
        totalRowData.push('');
      }
    });

    const oGrandRow = wsOrders.addRow(totalRowData);
    activeCols.forEach((col, cIdx) => {
      const cell = oGrandRow.getCell(cIdx + 1);
      const normId = normalizeHeader(col.id || '');
      const normLabel = normalizeHeader(col.label || '');

      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }; // Yellow Fill
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFF0000' } }; // Bold Red Text
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'double', color: { argb: 'FF000000' } }
      };

      if (
        normId === 'codamount' || normId === 'shopfee' || normId === 'shopotherfee' || normId === 'netpayout' ||
        normLabel.includes('cod') || normLabel.includes('thu_ho') || normLabel.includes('cuoc') || normLabel.includes('thuc_chuyen') || typeof cell.value === 'number'
      ) {
        if (typeof cell.value === 'number') {
          cell.numFmt = '#,##0';
          cell.alignment = { horizontal: 'right' };
        }
      } else if (normId === 'weight' || normLabel.includes('khoi_luong')) {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else if (normId === 'stt' || normId === 'waybill' || normLabel === 'stt' || normLabel.includes('ma_van_don')) {
        cell.alignment = { horizontal: 'center' };
      }
    });

    return workbook;
  },

  async downloadShopStatement(statement: ShopSettlementStatement, customExportSettings?: ExportColumnSettings): Promise<void> {
    const carrierId = statement.orders?.[0]?.carrierId;
    const carrierTag = getCleanCarrierTag(carrierId);
    const exportSettings = customExportSettings || (carrierId ? StorageService.getCarrierExportSettings(carrierId) : StorageService.getExportColumnSettings());
    const workbook = await this.createShopStatementWorkbook(statement, exportSettings);
    const buffer = await workbook.xlsx.writeBuffer();
    const cleanShopName = (statement.shopName || statement.shopCode || 'Shop').replace(/[^a-zA-Z0-9_\u00C0-\u1EF9]/g, '_');
    const cleanPeriod = (statement.periodName || 'Ky_Doi_Soat').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `Doi_Soat_${carrierTag}_${cleanShopName}_${cleanPeriod}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveBlobFile(blob, filename);
  },

  async createMasterProfitWorkbook(session: ReconciliationSession, customExportSettings?: ExportColumnSettings): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();
    const carrierId = session.carrierId;
    const company = StorageService.getCompanyInfo();

    const companyTitle = (company.companyName || 'CÔNG TY GOM ĐƠN VẬN CHUYỂN & LOGISTICS').toUpperCase();
    const companySubtitle = `Địa chỉ: ${company.address || ''}${company.phone ? ' | SĐT: ' + company.phone : ''}${company.taxCode ? ' | MST: ' + company.taxCode : ''}`;

    // ──────────────────────────────────────────
    // SHEET 1: TỔNG HỢP THEO SHOP
    // ──────────────────────────────────────────
    const wsMaster = workbook.addWorksheet('TONG_HOP_DOANH_THU_LOI_NHUAN');
    wsMaster.columns = [
      { width: 12 },
      { width: 14 },
      { width: 28 },
      { width: 16 },
      { width: 12 },
      { width: 22 },
      { width: 20 },
      { width: 20 },
      { width: 24 },
      { width: 24 },
      { width: 42 },
    ];

    const mRow1 = wsMaster.addRow([companyTitle]);
    mRow1.font = { name: 'Arial', size: 15, bold: true, color: { argb: 'FF1E3A8A' } };

    const mRow2 = wsMaster.addRow([companySubtitle]);
    mRow2.font = { name: 'Arial', size: 10.5, italic: true, color: { argb: 'FF475569' } };

    const mRow3 = wsMaster.addRow(['BÁO CÁO TỔNG HỢP ĐỐI SOÁT & LỢI NHUẬN NHÀ GOM ĐƠN']);
    mRow3.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF4F46E5' } };

    wsMaster.addRow([`Kỳ đối soát: ${session.sessionName}`, '', `Hãng VC: ${session.carrierName}`, '', `Ngày tạo: ${new Date(session.createdAt).toLocaleString('vi-VN')}`]);
    wsMaster.addRow([]);

    const mTblHeader = wsMaster.addRow([
      'STT',
      'Mã Shop',
      'Tên Shop',
      'Số ĐT',
      'Số Đơn',
      'Tổng COD Thu Hộ (đ)',
      'Cước Thu Shop (đ)',
      'Cước Trả NVC (đ)',
      'LỢI NHUẬN NHÀ GOM (đ)',
      'THỰC TRẢ CHO SHOP (đ)',
      'Số TK Ngân Hàng',
    ]);
    mTblHeader.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    let masterTotalPayable = 0;

    session.statements.forEach((stmt, idx) => {
      const debtVal = stmt.previousDebt || 0;
      const shopPayable = Math.max(0, stmt.totalNetPayout + debtVal);
      masterTotalPayable += shopPayable;

      const addedRow = wsMaster.addRow([
        idx + 1,
        stmt.shopCode,
        stmt.shopName,
        stmt.shopPhone,
        stmt.totalOrders,
        stmt.totalCod,
        stmt.totalShopFee + stmt.totalShopOtherFee,
        stmt.totalNvcCost,
        stmt.totalProfit,
        shopPayable,
        `${stmt.bankInfo.bankName} - ${stmt.bankInfo.accountNumber} (${stmt.bankInfo.accountHolder})`,
      ]);

      [6, 7, 8, 9, 10].forEach(cIdx => {
        const cell = addedRow.getCell(cIdx);
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
      });
    });

    // Master Summary Row - Yellow Fill + Red Text
    const mGrandRow = wsMaster.addRow([
      'TỔNG CỘNG',
      '',
      '',
      '',
      session.matchedOrdersCount,
      session.totalCod,
      session.totalShopRevenue,
      session.totalNvcCost,
      session.totalProfit,
      masterTotalPayable,
      '',
    ]);

    mGrandRow.eachCell((cell, colNum) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFF0000' } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'double', color: { argb: 'FF000000' } }
      };

      if (colNum >= 6 && colNum <= 10) {
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
      }
    });

    // ──────────────────────────────────────────
    // SHEET 2: DANH SÁCH CHI TIẾT TẤT CẢ ĐƠN HÀNG
    // ──────────────────────────────────────────
    const allOrders: any[] = [];
    session.statements.forEach(stmt => {
      stmt.orders.forEach(o => allOrders.push(o));
    });
    session.unmatchedOrders.forEach(o => allOrders.push(o));

    // Respect user's explicit master column configuration or default to ALL merged columns from 2 files
    const savedMasterSettings = customExportSettings || (carrierId ? StorageService.getCarrierExportSettings(carrierId) : StorageService.getExportColumnSettings()) || StorageService.getExportColumnSettings();
    const activeMasterCols = buildDynamicColumnsFromOrders(allOrders, savedMasterSettings, true);

    const wsDetails = workbook.addWorksheet('CHI_TIET_TOAN_BO_DON_HANG');
    wsDetails.columns = activeMasterCols.map((col: ExportColumnItem) => {
      const lowerLabel = (col.label || col.id).toLowerCase();
      if (col.id === 'stt') return { width: 8 };
      if (col.id === 'waybill') return { width: 22 };
      if (col.id === 'receiverAddress') return { width: 38 };
      if (col.id === 'receiverName' || col.id === 'productName') return { width: 26 };
      if (col.id === 'date' || lowerLabel.includes('ngay') || lowerLabel.includes('date') || lowerLabel.includes('thoi_gian')) return { width: 22 };
      return { width: 20 };
    });

    const mdRow1 = wsDetails.addRow([companyTitle]);
    mdRow1.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF1E3A8A' } };

    const mdRow2 = wsDetails.addRow([companySubtitle]);
    mdRow2.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF475569' } };

    const mdRow3 = wsDetails.addRow([`BÁO CÁO CHI TIẾT TOÀN BỘ ĐƠN HÀNG - KỲ: ${session.sessionName.toUpperCase()}`]);
    mdRow3.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF4F46E5' } };

    wsDetails.addRow([]);

    const masterHeaders = activeMasterCols.map((c: ExportColumnItem) => c.label);
    const mdTblHeader = wsDetails.addRow(masterHeaders);
    mdTblHeader.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    let grandCod = 0;
    let grandShopFee = 0;
    let grandNvcFee = 0;
    let grandProfit = 0;
    let grandNetPayout = 0;
    let grandWeight = 0;

    allOrders.forEach((order, idx) => {
      grandCod += order.codAmount || 0;
      grandShopFee += (order.shopCalculatedFee || 0) + (order.shopOtherFee || 0);
      grandNvcFee += (order.nvcBaseFee || 0) + (order.nvcOtherFee || 0);
      grandProfit += order.profitMargin || 0;
      grandNetPayout += order.netShopPayout || 0;
      grandWeight += order.weight || 0;

      const rowData: any[] = [];
      activeMasterCols.forEach((col: ExportColumnItem) => {
        let val: any = '';
        if (col.id === 'stt' || normalizeHeader(col.label) === 'stt') {
          val = idx + 1;
        } else if (col.id === 'shopFee' || normalizeHeader(col.label) === 'cuoc_tinh_shop_vnd') {
          val = order.shopCalculatedFee ?? 0;
        } else if (col.id === 'shopOtherFee' || normalizeHeader(col.label) === 'phu_phi_shop_vnd') {
          val = order.shopOtherFee ?? 0;
        } else if (col.id === 'netPayout' || normalizeHeader(col.label) === 'thuc_chuyen_cho_shop_vnd') {
          val = order.netShopPayout ?? 0;
        } else if (col.id === 'profit' || normalizeHeader(col.label) === 'loi_nhuan_gom_don_vnd') {
          val = order.profitMargin ?? 0;
        } else {
          val = (order.rawNvcData && col.sourceHeader && order.rawNvcData[col.sourceHeader] !== undefined ? order.rawNvcData[col.sourceHeader] : undefined) ??
                (order.rawAppData && col.sourceHeader && order.rawAppData[col.sourceHeader] !== undefined ? order.rawAppData[col.sourceHeader] : undefined) ??
                (order.rawNvcData && order.rawNvcData[col.label] !== undefined ? order.rawNvcData[col.label] : undefined) ??
                (order.rawAppData && order.rawAppData[col.label] !== undefined ? order.rawAppData[col.label] : undefined) ??
                resolveOrderColumnValue(order, col, idx, session.carrierName);
        }

        const normLabel = normalizeHeader(col.label || col.id || '');
        const normSrc = normalizeHeader(col.sourceHeader || '');
        const isDateCol = (normLabel.includes('ngay') || normLabel.includes('date') || normLabel.includes('thoi_gian') ||
                           normSrc.includes('ngay') || normSrc.includes('date') || normSrc.includes('thoi_gian')) &&
                          !normLabel.includes('tien') && !normLabel.includes('cuoc') && !normLabel.includes('phi') && !normLabel.includes('cod') && !normLabel.includes('tra') &&
                          !normSrc.includes('tien') && !normSrc.includes('cuoc') && !normSrc.includes('phi') && !normSrc.includes('cod') && !normSrc.includes('tra');
        
        if (isDateCol && val !== undefined && val !== null && val !== '') {
          val = formatAnyDateValue(val);
        }
        rowData.push(val ?? '');
      });

      const addedMdRow = wsDetails.addRow(rowData);
      activeMasterCols.forEach((col, cIdx) => {
        const cell = addedMdRow.getCell(cIdx + 1);
        const normId = normalizeHeader(col.id || '');
        const normLabel = normalizeHeader(col.label || '');

        if (
          normId === 'codamount' || normId === 'shopfee' || normId === 'nvcfee' || normId === 'profit' || normId === 'netpayout' ||
          normLabel.includes('cod') || normLabel.includes('thu_ho') || normLabel.includes('cuoc') || normLabel.includes('lai_rong') || normLabel.includes('loi_nhuan') || normLabel.includes('thuc_chuyen') || normLabel.includes('thuc_tra')
        ) {
          const rawNum = cell.value !== null && cell.value !== undefined && cell.value !== '' ? Number(String(cell.value).replace(/,/g, '')) : NaN;
          if (!isNaN(rawNum)) {
            cell.value = rawNum;
            cell.numFmt = '#,##0';
            cell.alignment = { horizontal: 'right' };
          }
        } else if (normId === 'weight' || normLabel.includes('khoi_luong') || normLabel.includes('trong_luong') || normLabel.includes('can_nang')) {
          const rawNum = cell.value !== null && cell.value !== undefined && cell.value !== '' ? Number(String(cell.value).replace(/,/g, '')) : NaN;
          if (!isNaN(rawNum)) {
            cell.value = rawNum;
            cell.numFmt = '#,##0.00';
            cell.alignment = { horizontal: 'right' };
          }
        } else if (
          normId === 'stt' || normId === 'waybill' || normId === 'date' ||
          normLabel.includes('stt') || normLabel.includes('ma_van_don') || normLabel.includes('ngay') || normLabel.includes('date') || normLabel.includes('thoi_gian') || normLabel.includes('gui_hang')
        ) {
          cell.alignment = { horizontal: 'center' };
        }
      });
    });

    // Master Details Grand Total Row - Yellow Fill + Red Text
    const mdGrandRowData: any[] = [];
    activeMasterCols.forEach((col: ExportColumnItem) => {
      switch (col.id) {
        case 'stt': mdGrandRowData.push('TỔNG CỘNG'); break;
        case 'waybill': mdGrandRowData.push(`${allOrders.length} đơn`); break;
        case 'weight': mdGrandRowData.push(Number(grandWeight.toFixed(2))); break;
        case 'codAmount': mdGrandRowData.push(grandCod); break;
        case 'shopFee': mdGrandRowData.push(grandShopFee); break;
        case 'nvcFee': mdGrandRowData.push(grandNvcFee); break;
        case 'profit': mdGrandRowData.push(grandProfit); break;
        case 'netPayout': mdGrandRowData.push(grandNetPayout); break;
        default: mdGrandRowData.push('');
      }
    });

    const mdGrandRow = wsDetails.addRow(mdGrandRowData);
    activeMasterCols.forEach((col, cIdx) => {
      const cell = mdGrandRow.getCell(cIdx + 1);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFF0000' } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'double', color: { argb: 'FF000000' } }
      };

      if (['codAmount', 'shopFee', 'nvcFee', 'profit', 'netPayout'].includes(col.id)) {
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
      } else if (col.id === 'weight') {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      }
    });

    return workbook;
  },

  async downloadMasterProfitReport(session: ReconciliationSession): Promise<void> {
    const carrierId = session.carrierId;
    const carrierTag = getCleanCarrierTag(session.carrierId, session.carrierName);
    const exportSettings = carrierId ? StorageService.getCarrierExportSettings(carrierId) : StorageService.getExportColumnSettings();
    const workbook = await this.createMasterProfitWorkbook(session, exportSettings);
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Bao_Cao_Tong_Hop_Loi_Nhuan_${carrierTag}_${session.sessionName.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveBlobFile(blob, filename);
  },

  async downloadAllStatementsZip(session: ReconciliationSession, onProgress?: (percent: number, currentShop: string) => void): Promise<void> {
    // Auto-fetch full session orders if statements are stripped
    if (session.statements.some(st => !st.orders || st.orders.length === 0)) {
      const full = await StorageService.getSessionDetail(session.id);
      if (full) {
        session = full;
      }
    }

    const zip = new JSZip();
    const carrierTag = getCleanCarrierTag(session.carrierId, session.carrierName);
    const rootFolder = zip.folder(`DOI_SOAT_${carrierTag}_${session.sessionName.replace(/[^a-zA-Z0-9]/g, '_')}`);

    const carrierId = session.carrierId;
    const exportSettings = carrierId ? StorageService.getCarrierExportSettings(carrierId) : StorageService.getExportColumnSettings();

    const masterWb = await this.createMasterProfitWorkbook(session, exportSettings);
    const masterBuffer = await masterWb.xlsx.writeBuffer();
    rootFolder?.file(`00_BAO_CAO_TONG_HOP_LOI_NHUAN_${carrierTag}.xlsx`, masterBuffer);

    const total = session.statements.length;
    for (let i = 0; i < total; i++) {
      const stmt = session.statements[i];
      if (onProgress) {
        onProgress(Math.round(((i + 1) / total) * 100), stmt.shopName);
      }

      const cleanShopFolder = (stmt.shopName || stmt.shopCode || 'Shop').replace(/[^a-zA-Z0-9_\u00C0-\u1EF9]/g, '_');
      const shopSubFolder = rootFolder?.folder(cleanShopFolder);
      
      const shopWb = await this.createShopStatementWorkbook(stmt, exportSettings);
      const shopBuffer = await shopWb.xlsx.writeBuffer();
      const filename = `Doi_Soat_${carrierTag}_${cleanShopFolder}.xlsx`;
      
      shopSubFolder?.file(filename, shopBuffer);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    saveBlobFile(zipBlob, `Bo_Ho_So_Doi_Soat_${carrierTag}_${session.sessionName.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
  },

  async downloadCtvCommissionReport(session: ReconciliationSession): Promise<void> {
    const carrierTag = getCleanCarrierTag(session.carrierId, session.carrierName);
    const ctvMap = new Map<string, { ctvCode: string; ctvName: string; orders: any[] }>();

    for (const stmt of session.statements) {
      for (const order of stmt.orders) {
        if (order.ctvId) {
          if (!ctvMap.has(order.ctvId)) {
            ctvMap.set(order.ctvId, {
              ctvCode: order.ctvId,
              ctvName: order.ctvName || 'Cộng tác viên',
              orders: [],
            });
          }
          ctvMap.get(order.ctvId)!.orders.push(order);
        }
      }
    }

    const workbook = new ExcelJS.Workbook();
    const wsSummary = workbook.addWorksheet('Tổng Hợp CTV');

    wsSummary.addRow(['BÁO CÁO HOA HỒNG CỘNG TÁC VIÊN (CTV)']);
    wsSummary.addRow([`Hãng vận chuyển: ${session.carrierName || carrierTag} | Kỳ đối soát: ${session.sessionName}`]);
    wsSummary.addRow([]);

    const header = wsSummary.addRow(['STT', 'Mã CTV', 'Tên CTV', 'Số đơn', 'Tổng cân nặng (kg)', 'Hoa hồng được hưởng (VNĐ)']);
    header.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    let idx = 1;
    let grandTotalOrders = 0;
    let grandTotalCommission = 0;

    ctvMap.forEach((data) => {
      const totalOrders = data.orders.length;
      const totalWeight = data.orders.reduce((s, o) => s + (o.weight || 0), 0);
      const totalCommission = data.orders.reduce((s, o) => s + (o.ctvCommission || 0), 0);

      grandTotalOrders += totalOrders;
      grandTotalCommission += totalCommission;

      const r = wsSummary.addRow([idx++, data.ctvCode, data.ctvName, totalOrders, totalWeight, totalCommission]);
      r.getCell(6).numFmt = '#,##0';
    });

    const totalRow = wsSummary.addRow(['TỔNG CỘNG', '', '', grandTotalOrders, '', grandTotalCommission]);
    totalRow.font = { bold: true };
    totalRow.getCell(6).numFmt = '#,##0';

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Bao_Cao_Hoa_Hong_CTV_${carrierTag}_${session.sessionName.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveBlobFile(blob, filename);
  },

  async downloadSingleCtvStatementReport(
    ctv: any,
    session: ReconciliationSession,
    orders: any[],
    companyInfo?: any
  ): Promise<void> {
    const carrierTag = getCleanCarrierTag(session.carrierId, session.carrierName);
    const workbook = new ExcelJS.Workbook();
    
    // Worksheet 1: Summary & Details
    const ws = workbook.addWorksheet(`Bảng Kê CTV ${ctv.code}`);

    // Company Header
    if (companyInfo && companyInfo.companyName) {
      ws.addRow([companyInfo.companyName.toUpperCase()]);
      ws.addRow([`Địa chỉ: ${companyInfo.address || ''} | Hotline: ${companyInfo.phone || ''}`]);
    }
    ws.addRow(['BẢNG ĐỐI SOÁT & QUYẾT TOÁN HOA HỒNG CỘNG TÁC VIÊN']);
    ws.addRow([`Kỳ đối soát: ${session.sessionName} | Hãng vận chuyển: ${session.carrierName || carrierTag}`]);
    ws.addRow([`Cộng Tác Viên: ${ctv.name} (${ctv.code}) | SĐT: ${ctv.phone || '---'} | STK: ${ctv.bankAccount?.accountNumber || '---'} (${ctv.bankAccount?.bankName || ''} - ${ctv.bankAccount?.accountHolder || ''})`]);
    ws.addRow([`Ngày xuất báo cáo: ${new Date().toLocaleDateString('vi-VN')}`]);
    ws.addRow([]);

    // KPI Summary
    const totalOrders = orders.length;
    const deliveredOrders = orders.filter(o => o.status === 'delivered').length;
    const returnedOrders = orders.filter(o => o.status === 'returned').length;
    const totalCod = orders.reduce((sum, o) => sum + (o.codAmount || 0), 0);
    const totalShopFee = orders.reduce((sum, o) => sum + (o.shopCalculatedFee || 0), 0);
    const totalNvcFee = orders.reduce((sum, o) => sum + (o.nvcBaseFee || 0), 0);
    const totalCommission = orders.reduce((sum, o) => sum + (o.ctvCommission || 0), 0);

    ws.addRow(['TỔNG KẾT TÀI CHÍNH KỲ NÀY']);
    const summaryHeader = ws.addRow(['Tổng đơn hàng', 'Đơn giao thành công', 'Đơn hoàn', 'Tổng COD thu hộ', 'Tổng cước thu khách', 'Cước gốc nhà gom', 'HOA HỒNG CTV THỰC NHẬN']);
    summaryHeader.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center' };
    });

    const summaryRow = ws.addRow([
      totalOrders,
      deliveredOrders,
      returnedOrders,
      totalCod,
      totalShopFee,
      totalNvcFee,
      totalCommission
    ]);
    summaryRow.font = { bold: true };
    summaryRow.getCell(4).numFmt = '#,##0';
    summaryRow.getCell(5).numFmt = '#,##0';
    summaryRow.getCell(6).numFmt = '#,##0';
    summaryRow.getCell(7).numFmt = '#,##0';
    summaryRow.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    ws.addRow([]);

    // Order Details Table
    ws.addRow(['DANH SÁCH CHI TIẾT ĐƠN HÀNG CỦA KHÁCH HÀNG THUỘC CTV']);
    const detailHeaders = ws.addRow([
      'STT',
      'Mã Vận Đơn',
      'Mã Shop',
      'Tên Shop',
      'SĐT Shop',
      'Người Nhận',
      'SĐT Nhận',
      'Địa Chỉ Nhận',
      'Khối Lượng (kg)',
      'Trạng Thái',
      'Tiền COD (VNĐ)',
      'Cước Thu Shop (VNĐ)',
      'Cước Nhà Gom (VNĐ)',
      'Hoa Hồng CTV (VNĐ)'
    ]);

    detailHeaders.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    orders.forEach((order, idx) => {
      const r = ws.addRow([
        idx + 1,
        order.waybill,
        order.shopId || '',
        order.shopName,
        order.shopPhone || '',
        order.receiverName || '',
        order.receiverPhone || '',
        order.receiverAddress || '',
        order.weight || 0,
        order.status === 'delivered' ? 'Giao thành công' : (order.status === 'returned' ? 'Đơn hoàn' : order.statusText || order.status),
        order.codAmount || 0,
        order.shopCalculatedFee || 0,
        order.nvcBaseFee || 0,
        order.ctvCommission || 0
      ]);

      r.getCell(11).numFmt = '#,##0';
      r.getCell(12).numFmt = '#,##0';
      r.getCell(13).numFmt = '#,##0';
      r.getCell(14).numFmt = '#,##0';
    });

    const totalDetailRow = ws.addRow([
      'TỔNG CỘNG',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      totalCod,
      totalShopFee,
      totalNvcFee,
      totalCommission
    ]);
    totalDetailRow.font = { bold: true };
    totalDetailRow.getCell(11).numFmt = '#,##0';
    totalDetailRow.getCell(12).numFmt = '#,##0';
    totalDetailRow.getCell(13).numFmt = '#,##0';
    totalDetailRow.getCell(14).numFmt = '#,##0';

    ws.columns = [
      { width: 6 },
      { width: 18 },
      { width: 12 },
      { width: 22 },
      { width: 14 },
      { width: 20 },
      { width: 14 },
      { width: 30 },
      { width: 14 },
      { width: 16 },
      { width: 16 },
      { width: 16 },
      { width: 16 },
      { width: 18 },
    ];

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Bang_Ke_CTV_${ctv.code}_${session.sessionName.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveBlobFile(blob, filename);
  },

  async exportBankPayoutExcel(items: {
    shopCode: string;
    shopName: string;
    bankName: string;
    accountNumber: string;
    accountHolder: string;
    amount: number;
    sessionName: string;
    statusText: string;
  }[], sessionName: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Danh Sách Đi Tiền Ngân Hàng');

    ws.addRow(['DANH SÁCH CHUYỂN KHOẢN NGÂN HÀNG (IBANKING BATCH PAYOUT)']);
    ws.addRow([`Kỳ đối soát: ${sessionName} | Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}`]);
    ws.addRow([]);

    const headers = ws.addRow([
      'STT',
      'Mã Shop',
      'Tên Khách Hàng / Shop',
      'Tên Ngân Hàng',
      'Số Tài Khoản',
      'Chủ Tài Khoản Ngân Hàng',
      'Số Tiền Chuyển Khoản (VNĐ)',
      'Nội Dung Chuyển Khoản',
      'Trạng Thái'
    ]);

    headers.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    let grandTotal = 0;

    items.forEach((item, idx) => {
      grandTotal += item.amount;
      const row = ws.addRow([
        idx + 1,
        item.shopCode,
        item.shopName,
        item.bankName || 'Chưa có',
        item.accountNumber || 'Chưa có',
        item.accountHolder || item.shopName,
        item.amount,
        `Thanh toan doi soat ${sessionName} shop ${item.shopCode}`,
        item.statusText,
      ]);

      row.getCell(7).numFmt = '#,##0';
    });

    const totalRow = ws.addRow(['TỔNG CỘNG CHUYỂN KHOẢN', '', '', '', '', '', grandTotal, '', '']);
    totalRow.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFF0000' } };
    totalRow.getCell(7).numFmt = '#,##0';

    ws.columns = [
      { width: 8 },
      { width: 15 },
      { width: 28 },
      { width: 20 },
      { width: 22 },
      { width: 25 },
      { width: 24 },
      { width: 40 },
      { width: 16 },
    ];

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Danh_Sach_Di_Tien_Ngan_Hang_${sessionName.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveBlobFile(blob, filename);
  },

  /**
   * 📤 Xuất danh sách thông tin các Shop và Bảng giá cước bậc thang chi tiết ra Excel
   */
  async exportShopsDirectoryExcel(shops: any[], carrierName?: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'GomDon Pro';
    workbook.created = new Date();

    const borderThin: Partial<ExcelJS.Borders> = {
      top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    };

    // ──────────────────────────────────────────
    // SHEET 1: DANH SÁCH THÔNG TIN SHOP
    // ──────────────────────────────────────────
    const wsShops = workbook.addWorksheet('Danh Sách Shop', {
      views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }]
    });

    const titleRow1 = wsShops.addRow(['DANH SÁCH HỒ SƠ & THÔNG TIN SHOP ĐỐI SOÁT']);
    titleRow1.font = { name: 'Arial', size: 15, bold: true, color: { argb: 'FF1E293B' } };
    wsShops.mergeCells('A1:L1');

    const subTitleRow1 = wsShops.addRow([
      `Đơn vị vận chuyển: ${carrierName || 'Tất cả'} | Tổng số shop: ${shops.length} | Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}`
    ]);
    subTitleRow1.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF64748B' } };
    wsShops.mergeCells('A2:L2');
    wsShops.addRow([]);

    const headers1 = wsShops.addRow([
      'STT',
      'Mã Shop',
      'Tên Shop',
      'Số Điện Thoại',
      'Email Đối Soát',
      'Địa Chỉ Kho',
      'Ngân Hàng',
      'Số Tài Khoản',
      'Chủ Tài Khoản',
      'ĐVVC Phụ Trách',
      'CTV Quản Lý',
      'Tên Nhãn Gửi Phụ'
    ]);

    headers1.height = 26;
    headers1.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      cell.font = { name: 'Arial', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = borderThin;
    });

    shops.forEach((shop, idx) => {
      const phones = [shop.phone, ...(shop.phoneList || [])].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      const emails = [shop.email, ...(shop.emailList || [])].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      const aliases = (shop.nameAliases || []).filter(Boolean).join(', ');

      const row = wsShops.addRow([
        idx + 1,
        shop.code || '',
        shop.name || '',
        phones || 'Chưa có',
        emails || 'Chưa có',
        shop.address || 'Chưa có',
        shop.bankAccount?.bankName || 'Chưa có',
        shop.bankAccount?.accountNumber ? String(shop.bankAccount.accountNumber) : 'Chưa có',
        shop.bankAccount?.accountHolder || '',
        (shop.carrierId || '').toUpperCase() || 'MẶC ĐỊNH',
        shop.ctvName || (shop.ctvId ? `CTV #${shop.ctvId}` : 'Chưa phân công'),
        aliases || ''
      ]);

      row.height = 22;
      row.eachCell((cell, colNumber) => {
        cell.border = borderThin;
        cell.font = { name: 'Arial', size: 10 };
        if (colNumber === 1 || colNumber === 2 || colNumber === 10) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNumber === 4 || colNumber === 8) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }
      });
      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        });
      }
    });

    wsShops.columns = [
      { width: 7 },
      { width: 14 },
      { width: 28 },
      { width: 18 },
      { width: 24 },
      { width: 28 },
      { width: 16 },
      { width: 18 },
      { width: 22 },
      { width: 16 },
      { width: 18 },
      { width: 24 },
    ];

    // ──────────────────────────────────────────
    // SHEET 2: BẢNG GIÁ CHI TIẾT CÁC SHOP (TỔNG HỢP)
    // ──────────────────────────────────────────
    const wsPricing = workbook.addWorksheet('Bảng Giá Chi Tiết', {
      views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }]
    });

    const titleRow2 = wsPricing.addRow(['BẢNG GIÁ CƯỚC BẬC THANG & PHỤ PHÍ CHI TIẾT CỦA CÁC SHOP']);
    titleRow2.font = { name: 'Arial', size: 15, bold: true, color: { argb: 'FF1E293B' } };
    wsPricing.mergeCells('A1:J1');

    const subTitleRow2 = wsPricing.addRow([
      `Đơn vị vận chuyển: ${carrierName || 'Tất cả'} | Tổng số shop: ${shops.length} | Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}`
    ]);
    subTitleRow2.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF64748B' } };
    wsPricing.mergeCells('A2:J2');
    wsPricing.addRow([]);

    const headers2 = wsPricing.addRow([
      'STT',
      'Mã Shop',
      'Tên Shop',
      'Tên Biểu Giá',
      'Bậc Thang Cân Nặng (Chi Tiết Mức Giá)',
      'Vượt Cân (Mỗi nấc)',
      'Giá Vượt Cân (VNĐ)',
      'Quy Định Cước Hoàn',
      'Phí Bảo Hiểm / Khai Giá',
      'Phụ Phí Cố Định'
    ]);

    headers2.height = 26;
    headers2.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
      cell.font = { name: 'Arial', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = borderThin;
    });

    shops.forEach((shop, idx) => {
      const plan = shop.pricingPlan || {};
      const rules = plan.weightRules || [];
      
      const rulesStr = rules.length > 0
        ? rules.map((r: any, rIdx: number) => {
            const min = rIdx === 0 ? 0 : r.minWeight;
            const priceFormatted = new Intl.NumberFormat('vi-VN').format(r.price || 0);
            return `• ${min}-${r.maxWeight}kg: ${priceFormatted} đ`;
          }).join('\n')
        : 'Chưa cài đặt';

      let returnFeeStr = 'Miễn phí hoàn (0 đ)';
      if (plan.returnFeeType === 'fixed' || (plan.returnFeeFixed && plan.returnFeeFixed > 0 && plan.returnFeeType !== 'percent')) {
        returnFeeStr = `Cố định: ${new Intl.NumberFormat('vi-VN').format(plan.returnFeeFixed || 0)} đ/đơn`;
      } else if (plan.returnFeeType === 'percent' || (plan.returnFeePercent && plan.returnFeePercent > 0)) {
        returnFeeStr = `${plan.returnFeePercent}% cước gửi`;
      } else if (plan.returnFeeType === 'free') {
        returnFeeStr = 'Miễn phí hoàn (0 đ)';
      }

      const insuranceStr = (plan.insuranceFeePercent || plan.declaredFeePercent)
        ? `${plan.insuranceFeePercent || plan.declaredFeePercent}%`
        : '0%';

      const surchargeStr = plan.fixedSurcharge
        ? `${new Intl.NumberFormat('vi-VN').format(plan.fixedSurcharge)} đ`
        : '0 đ';

      const row = wsPricing.addRow([
        idx + 1,
        shop.code || '',
        shop.name || '',
        plan.name || 'Bảng giá tùy chỉnh',
        rulesStr,
        `+${plan.extraStepWeight || 0.5} kg`,
        plan.extraStepPrice || 0,
        returnFeeStr,
        insuranceStr,
        surchargeStr
      ]);

      row.height = Math.max(24, Math.max(1, rules.length) * 16);
      row.eachCell((cell, colNumber) => {
        cell.border = borderThin;
        cell.font = { name: 'Arial', size: 10 };
        if (colNumber === 1 || colNumber === 2) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNumber === 5) {
          cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        } else if (colNumber === 6 || colNumber === 8 || colNumber === 9 || colNumber === 10) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (colNumber === 7) {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFmt = '#,##0';
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }
      });

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } };
        });
      }
    });

    wsPricing.columns = [
      { width: 7 },
      { width: 14 },
      { width: 28 },
      { width: 24 },
      { width: 34 },
      { width: 16 },
      { width: 18 },
      { width: 22 },
      { width: 18 },
      { width: 16 },
    ];

    // ──────────────────────────────────────────
    // SHEET 3: MA TRẬN BẬC THANG CÂN NẶNG (DỄ ĐỐI CHIẾU DẠNG CỘT)
    // ──────────────────────────────────────────
    const wsMatrix = workbook.addWorksheet('Ma Trận Bậc Cân', {
      views: [{ showGridLines: true, state: 'frozen', ySplit: 4 }]
    });

    const titleRow3 = wsMatrix.addRow(['MA TRẬN BIỂU PHÍ BẬC THANG CÂN NẶNG TỪNG SHOP']);
    titleRow3.font = { name: 'Arial', size: 15, bold: true, color: { argb: 'FF1E293B' } };
    wsMatrix.mergeCells('A1:I1');

    const subTitleRow3 = wsMatrix.addRow([
      `Đơn vị vận chuyển: ${carrierName || 'Tất cả'} | Tổng số shop: ${shops.length} | Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}`
    ]);
    subTitleRow3.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF64748B' } };
    wsMatrix.mergeCells('A2:I2');
    wsMatrix.addRow([]);

    const headers3 = wsMatrix.addRow([
      'STT',
      'Mã Shop',
      'Tên Shop',
      'Mức 1 (≤ Max 1)',
      'Mức 2 (≤ Max 2)',
      'Mức 3 (≤ Max 3)',
      'Mức 4 (≤ Max 4)',
      'Vượt Cân (Mỗi +kg)',
      'Phí Vượt Cân (VNĐ)'
    ]);

    headers3.height = 26;
    headers3.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
      cell.font = { name: 'Arial', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = borderThin;
    });

    shops.forEach((shop, idx) => {
      const plan = shop.pricingPlan || {};
      const rules = plan.weightRules || [];

      const getTierText = (ruleIdx: number) => {
        const r = rules[ruleIdx];
        if (!r) return '-';
        const priceFmt = new Intl.NumberFormat('vi-VN').format(r.price || 0);
        return `≤ ${r.maxWeight}kg: ${priceFmt} đ`;
      };

      const row = wsMatrix.addRow([
        idx + 1,
        shop.code || '',
        shop.name || '',
        getTierText(0),
        getTierText(1),
        getTierText(2),
        getTierText(3),
        `+${plan.extraStepWeight || 0.5} kg`,
        plan.extraStepPrice || 0
      ]);

      row.height = 22;
      row.eachCell((cell, colNumber) => {
        cell.border = borderThin;
        cell.font = { name: 'Arial', size: 10 };
        if (colNumber === 1 || colNumber === 2 || colNumber >= 4) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }
        if (colNumber === 9) {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFmt = '#,##0';
        }
      });

      if (idx % 2 === 1) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F3FF' } };
        });
      }
    });

    wsMatrix.columns = [
      { width: 7 },
      { width: 14 },
      { width: 28 },
      { width: 22 },
      { width: 22 },
      { width: 22 },
      { width: 22 },
      { width: 18 },
      { width: 18 },
    ];

    const buffer = await workbook.xlsx.writeBuffer();
    const carrierTag = carrierName ? carrierName.replace(/[^a-zA-Z0-9]/g, '_') : 'Tat_Ca';
    const filename = `Bang_Gia_Va_Thong_Tin_Shop_${carrierTag}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveBlobFile(blob, filename);
  },
};
