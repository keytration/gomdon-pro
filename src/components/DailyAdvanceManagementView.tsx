import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Banknote,
  Upload,
  FileSpreadsheet,
  Store,
  History,
  QrCode,
  Plus,
  Trash2,
  Edit2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Download,
  Search,
  Eye,
  X,
  Copy,
  Check,
  ArrowRight,
  Scale,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { useToast, useConfirm } from './UIFeedback';
import { BANK_CODES } from '../constants/banks';
import type { Shop, UserAccount } from '../types';
import type {
  AdvanceShopProfile,
  AdvanceSession,
  AdvanceOrderNew,
  AdvanceOrderReturned,
  AdvanceWeightAdjustment,
  AdvanceWeightRule,
} from '../types/codAdvance';
import { CodAdvanceService } from '../services/codAdvanceService';
import { OrderLossTrackingTab } from './OrderLossTrackingTab';

interface DailyAdvanceManagementViewProps {
  currentUser: UserAccount;
  shops: Shop[];
  onSaveShops?: (shops: Shop[]) => void;
  activeCarrierId?: string | null;
  activeCarrierName?: string;
}

type SubTabType = 'daily_settlement' | 'shops_config' | 'ledger_history' | 'payout_export' | 'loss_tracking';

export const DailyAdvanceManagementView: React.FC<DailyAdvanceManagementViewProps> = ({
  currentUser,
  shops: mainSystemShops,
  activeCarrierId,
  activeCarrierName,
}) => {
  const { showToast } = useToast();
  const { showConfirm } = useConfirm();

  const [activeSubTab, setActiveSubTab] = useState<SubTabType>('daily_settlement');
  const [advanceShops, setAdvanceShops] = useState<AdvanceShopProfile[]>([]);
  const [sessions, setSessions] = useState<AdvanceSession[]>([]);
  const [isLoadingData, setIsLoadingData] = useState<boolean>(false);

  // ──────────────────────────────────────────────────────────────────────────
  // SUB-TAB 2 STATE: DAILY SETTLEMENT WIZARD (R2)
  // ──────────────────────────────────────────────────────────────────────────
  const [selectedShopId, setSelectedShopId] = useState<string>('');
  const [advanceDate, setAdvanceDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [previousDebt, setPreviousDebt] = useState<number>(0);

  // Outbound (New Orders)
  const [newOrders, setNewOrders] = useState<AdvanceOrderNew[]>([]);
  const [outboundFileName, setOutboundFileName] = useState<string>('');
  const outboundInputRef = useRef<HTMLInputElement>(null);

  // Return Orders
  const [returnedOrders, setReturnedOrders] = useState<AdvanceOrderReturned[]>([]);
  const [returnFileName, setReturnFileName] = useState<string>('');
  const [manualReturnText, setManualReturnText] = useState<string>('');
  const returnInputRef = useRef<HTMLInputElement>(null);

  // Carrier Weight Discrepancy (Vượt cân NVC)
  const [discrepancyMode, setDiscrepancyMode] = useState<'manual' | 'nvc_file'>('manual');
  const [weightAdjustments, setWeightAdjustments] = useState<AdvanceWeightAdjustment[]>([]);
  const [nvcFileName, setNvcFileName] = useState<string>('');
  const [manualAdjustmentAmount, setManualAdjustmentAmount] = useState<number>(0);
  const [manualAdjustmentNote, setManualAdjustmentNote] = useState<string>('');
  const nvcInputRef = useRef<HTMLInputElement>(null);

  // Preview Table Tab inside Daily Settlement
  const [previewListTab, setPreviewListTab] = useState<'outbound' | 'returns' | 'discrepancy'>('outbound');
  const [isSavingSession, setIsSavingSession] = useState<boolean>(false);

  // ──────────────────────────────────────────────────────────────────────────
  // SUB-TAB 1 STATE: SHOP & PRICING CONFIG MODAL (R1)
  // ──────────────────────────────────────────────────────────────────────────
  const [shopSearchQuery, setShopSearchQuery] = useState<string>('');
  const [isShopModalOpen, setIsShopModalOpen] = useState<boolean>(false);
  const [editingShop, setEditingShop] = useState<Partial<AdvanceShopProfile> | null>(null);

  // ──────────────────────────────────────────────────────────────────────────
  // SUB-TAB 3 & MODALS STATE: LEDGER, DETAIL & VIETQR (R3)
  // ──────────────────────────────────────────────────────────────────────────
  const [ledgerFilterShopId, setLedgerFilterShopId] = useState<string>('ALL');
  const [detailModalSession, setDetailModalSession] = useState<AdvanceSession | null>(null);
  const [qrModalSession, setQrModalSession] = useState<AdvanceSession | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Manual Debt Adjust Modal
  const [isDebtAdjustModalOpen, setIsDebtAdjustModalOpen] = useState<boolean>(false);
  const [adjustShopId, setAdjustShopId] = useState<string>('');
  const [adjustAmount, setAdjustAmount] = useState<string>('');
  const [adjustNote, setAdjustNote] = useState<string>('');

  const formatMoney = (val: number) =>
    `${new Intl.NumberFormat('vi-VN').format(Math.round(val || 0))} đ`;

  // ──────────────────────────────────────────────────────────────────────────
  // INITIAL DATA LOAD & AUTO-SEEDING
  // ──────────────────────────────────────────────────────────────────────────
  const loadAllAdvanceData = async () => {
    setIsLoadingData(true);
    try {
      let loadedShops = await CodAdvanceService.fetchAdvanceShops();

      // Auto-sync from existing system shops if advance_shops is empty
      if (loadedShops.length === 0 && mainSystemShops.length > 0) {
        const seeded: AdvanceShopProfile[] = [];
        for (const s of mainSystemShops) {
          const shopRules = s.pricingPlan?.weightRules;
          const rules: AdvanceWeightRule[] =
            shopRules && shopRules.length > 0
              ? shopRules.map((r: any) => ({
                  minWeight: Number(r.minWeight) || 0,
                  maxWeight: Number(r.maxWeight) || 1,
                  price: Number(r.price) || 20000,
                }))
              : [
                  { minWeight: 0, maxWeight: 1, price: 20000 },
                  { minWeight: 1, maxWeight: 2, price: 25000 },
                ];

          const created = await CodAdvanceService.saveAdvanceShopApi({
            id: `adv_${s.id}`,
            linkedShopId: s.id,
            code: s.code || s.name,
            name: s.name,
            phone: s.phone || '',
            address: s.address || '',
            bankAccount: {
              bankName: s.bankAccount?.bankName || 'MB Bank',
              accountNumber: s.bankAccount?.accountNumber || '',
              accountHolder: s.bankAccount?.accountHolder || s.name.toUpperCase(),
            },
            pricingPlan: {
              id: `plan_${s.id}`,
              name: `Bảng giá Ứng COD - ${s.name}`,
              weightRules: rules,
              extraStepWeight: 0.5,
              extraStepPrice: 5000,
              returnFeePercent: 0,
              returnFeeFixed: 0,
              returnFeeType: 'free',
            },
            currentDebt: 0,
            active: true,
          });
          if (created) seeded.push(created);
        }
        if (seeded.length > 0) {
          loadedShops = await CodAdvanceService.fetchAdvanceShops();
        }
      }

      setAdvanceShops(loadedShops);
      if (loadedShops.length > 0 && !selectedShopId) {
        setSelectedShopId(loadedShops[0].id);
      }

      const loadedSessions = await CodAdvanceService.fetchAdvanceSessions();
      setSessions(loadedSessions);
    } finally {
      setIsLoadingData(false);
    }
  };

  useEffect(() => {
    loadAllAdvanceData();
  }, []);

  // Selected Shop Object
  const selectedShop = useMemo(
    () => advanceShops.find((s) => s.id === selectedShopId) || null,
    [advanceShops, selectedShopId]
  );

  // Refresh shop's current rolling debt when selectedShopId changes
  useEffect(() => {
    if (!selectedShopId) {
      setPreviousDebt(0);
      return;
    }
    const shopObj = advanceShops.find((s) => s.id === selectedShopId);
    if (shopObj && typeof shopObj.currentDebt === 'number') {
      setPreviousDebt(shopObj.currentDebt);
    }
    CodAdvanceService.fetchAdvanceShopDebt(selectedShopId).then((debt) => {
      setPreviousDebt(debt);
    });
  }, [selectedShopId, advanceShops]);

  // Recalculate outbound fees if user switches shop while orders are loaded
  useEffect(() => {
    if (!selectedShop || newOrders.length === 0) return;
    const plan = selectedShop.pricingPlan;
    setNewOrders((prev) =>
      prev.map((o) => {
        const fee = CodAdvanceService.calculateWeightFee(o.weight, plan);
        return {
          ...o,
          appliedFee: fee,
          netAdvance: Math.round(o.codAmount - fee),
        };
      })
    );
  }, [selectedShopId]);

  // ──────────────────────────────────────────────────────────────────────────
  // LIVE ROLLING SETTLEMENT COMPUTATION (R2.4)
  // ──────────────────────────────────────────────────────────────────────────
  const settlementMetrics = useMemo(() => {
    const totalNewOrdersCount = newOrders.length;
    const totalNewCod = newOrders.reduce((s, o) => s + (Number(o.codAmount) || 0), 0);
    const totalNewFee = newOrders.reduce((s, o) => s + (Number(o.appliedFee) || 0), 0);
    const netNewAdvance = totalNewCod - totalNewFee;

    const totalReturnedOrdersCount = returnedOrders.length;
    const totalReturnedCodRecall = returnedOrders.reduce((s, o) => s + (Number(o.codAmount) || 0), 0);
    const historyMatchedCount = returnedOrders.filter((o) => o.isFromHistory).length;
    const excelFallbackCount = returnedOrders.length - historyMatchedCount;

    const fileDiscrepancyTotal = weightAdjustments.reduce(
      (s, a) => s + (Number(a.feeDifference) || 0),
      0
    );
    const manualAdj = Number(manualAdjustmentAmount) || 0;
    const totalWeightAdjustment = fileDiscrepancyTotal + manualAdj;

    // Công thức quyết toán chuẩn:
    // Thực chuyển hôm nay = (Tổng COD mới - Tổng cước mới) - Thu hồi COD hoàn - Chênh lệch cước NVC + Dư/Nợ lũy kế ngày trước
    const rawBalance =
      netNewAdvance - totalReturnedCodRecall - totalWeightAdjustment + previousDebt;
    const isNegativeDebt = rawBalance < 0;
    const netAdvancePayout = rawBalance;
    const closingDebt = rawBalance < 0 ? rawBalance : 0;

    return {
      totalNewOrdersCount,
      totalNewCod,
      totalNewFee,
      netNewAdvance,
      totalReturnedOrdersCount,
      totalReturnedCodRecall,
      historyMatchedCount,
      excelFallbackCount,
      fileDiscrepancyTotal,
      manualAdj,
      totalWeightAdjustment,
      previousDebt,
      rawBalance,
      netAdvancePayout,
      closingDebt,
      isNegativeDebt,
    };
  }, [newOrders, returnedOrders, weightAdjustments, manualAdjustmentAmount, previousDebt]);

  // ──────────────────────────────────────────────────────────────────────────
  // HANDLERS: EXCEL UPLOAD & QUICK DEMO DATA (R2.1, R2.2, R2.3)
  // ──────────────────────────────────────────────────────────────────────────
  const handleOutboundFileUpload = async (file: File) => {
    if (!selectedShop) {
      showToast('Vui lòng chọn Shop trước khi tải file Đơn Đi!', 'warning');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const rawRows = await CodAdvanceService.parseOutboundExcel(buffer);
      const result = CodAdvanceService.processOutboundOrders(rawRows, selectedShop.pricingPlan);
      if (result.orders.length === 0) {
        showToast('Không tìm thấy dòng vận đơn hợp lệ trong file Excel Đơn Đi.', 'warning');
        return;
      }
      const mapped: AdvanceOrderNew[] = result.orders.map((o, idx) => ({
        id: `out_${Date.now()}_${idx}`,
        waybill: o.waybill,
        weight: o.weightKg,
        codAmount: o.codAmount,
        appliedFee: o.fee,
        netAdvance: o.netAdvance,
        receiverName: o.receiverName,
        receiverPhone: o.receiverPhone,
        receiverAddress: o.receiverAddress,
        note: o.note,
      }));
      setNewOrders(mapped);
      setOutboundFileName(file.name);
      setPreviewListTab('outbound');
      showToast(
        `Đã nạp ${mapped.length} đơn đi mới! Tổng COD: ${formatMoney(result.totalNewCod)} - Cước: ${formatMoney(result.totalNewFee)}`,
        'success'
      );
    } catch (err: any) {
      showToast(`Lỗi đọc file Đơn Đi: ${err?.message || 'Định dạng không hợp lệ'}`, 'error');
    }
  };

  const handleReturnFileUpload = async (file: File) => {
    if (!selectedShop) {
      showToast('Vui lòng chọn Shop trước khi tải file Đơn Hoàn!', 'warning');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const rawRows = await CodAdvanceService.parseReturnExcel(buffer);
      if (rawRows.length === 0) {
        showToast('Không tìm thấy mã vận đơn hoàn nào trong file.', 'warning');
        return;
      }
      const waybills = rawRows.map((o) => o.waybill);
      const historyMap = await CodAdvanceService.lookupHistoricalOrdersApi(
        waybills,
        selectedShop.id
      );
      const finalParse = CodAdvanceService.processReturnOrders(rawRows, historyMap);

      const mapped: AdvanceOrderReturned[] = finalParse.orders.map((o, idx) => ({
        id: `ret_${Date.now()}_${idx}`,
        waybill: o.waybill,
        codAmount: o.recoveredCod,
        returnFee: 0,
        isFromHistory: o.lookupSource === 'history',
        originalAdvanceDate: historyMap[o.waybill]?.advanceDate,
        originalAdvanceSessionId: o.historySessionId,
      }));

      setReturnedOrders(mapped);
      setReturnFileName(file.name);
      setPreviewListTab('returns');
      showToast(
        `Đã nạp ${mapped.length} đơn hoàn (Thu hồi COD: ${formatMoney(finalParse.totalReturnedCodRecall)}, Cước hoàn: 0đ)`,
        'success'
      );
    } catch (err: any) {
      showToast(`Lỗi đọc file Đơn Hoàn: ${err?.message || 'Định dạng không hợp lệ'}`, 'error');
    }
  };

  const handleAddManualReturnWaybills = async () => {
    if (!manualReturnText.trim()) return;
    const lines = manualReturnText
      .split(/[\r\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    const parsedRows = lines.map((line) => {
      const parts = line.split(/[\t|:]+/).map((p) => p.trim());
      const wb = parts[0].toUpperCase();
      const codFallback = parts[1] ? Number(parts[1].replace(/[^0-9]/g, '')) || 200000 : 200000;
      return { waybill: wb, codAmount: codFallback };
    });

    const waybills = parsedRows.map((r) => r.waybill);
    const historyMap = await CodAdvanceService.lookupHistoricalOrdersApi(
      waybills,
      selectedShop?.id
    );
    const processed = CodAdvanceService.processReturnOrders(parsedRows, historyMap);

    const mapped: AdvanceOrderReturned[] = processed.orders.map((o, idx) => ({
      id: `ret_m_${Date.now()}_${idx}`,
      waybill: o.waybill,
      codAmount: o.recoveredCod,
      returnFee: 0,
      isFromHistory: o.lookupSource === 'history',
      originalAdvanceDate: historyMap[o.waybill]?.advanceDate,
      originalAdvanceSessionId: o.historySessionId,
    }));

    setReturnedOrders((prev) => [...prev, ...mapped]);
    setManualReturnText('');
    setPreviewListTab('returns');
    showToast(`Đã thêm ${mapped.length} đơn hoàn cần thu hồi COD (Cước hoàn: 0đ).`, 'success');
  };

  const handleNvcDiscrepancyFileUpload = async (file: File) => {
    if (!selectedShop) {
      showToast('Vui lòng chọn Shop trước khi tải file đối soát NVC!', 'warning');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const rawRows = await CodAdvanceService.parseCarrierDiscrepancyExcel(buffer);
      const waybills = rawRows.map((o) => o.waybill);
      const historyMap = await CodAdvanceService.lookupHistoricalOrdersApi(
        waybills,
        selectedShop.id
      );

      const enrichedRows = rawRows.map((r) => ({
        ...r,
        provWeight: historyMap[r.waybill]?.weight || r.provWeight,
      }));

      const discResult = CodAdvanceService.processCarrierWeightDiscrepancies(
        enrichedRows,
        selectedShop.pricingPlan,
        0
      );

      const mapped: AdvanceWeightAdjustment[] = discResult.items
        .filter((item) => item.discrepancyFee > 0)
        .map((item, idx) => ({
          id: `disc_${Date.now()}_${idx}`,
          waybill: item.waybill,
          advanceWeight: item.provWeight,
          actualWeight: item.actualWeight,
          advanceFee: item.provFee,
          actualFee: item.actualFee,
          feeDifference: item.discrepancyFee,
          source: 'nvc_file',
          note: item.note,
        }));

      setWeightAdjustments(mapped);
      setNvcFileName(file.name);
      setPreviewListTab('discrepancy');
      showToast(
        `Đã đối chiếu file NVC: phát hiện ${mapped.length} đơn lệch cân, phụ thu: ${formatMoney(discResult.totalDiscrepancyFromRows)}`,
        'success'
      );
    } catch (err: any) {
      showToast(`Lỗi đọc file đối soát NVC: ${err?.message || 'Định dạng không hợp lệ'}`, 'error');
    }
  };

  // Load Quick Example Scenarios (Day 1 = 18M, Day 2 = 16M)
  const handleLoadQuickDemo = async (scenario: 'day1' | 'day2') => {
    if (!selectedShop) {
      showToast('Vui lòng chọn hoặc tạo 1 Shop trước!', 'warning');
      return;
    }
    // Generate 100 new orders x 200,000 COD, 0.5kg (20,000 fee)
    const demoNewOrders: AdvanceOrderNew[] = Array.from({ length: 100 }, (_, i) => {
      const wb = `VD_${scenario.toUpperCase()}_${String(i + 1).padStart(3, '0')}`;
      const cod = 200000;
      const fee = 20000;
      return {
        id: `demo_new_${i + 1}`,
        waybill: wb,
        weight: 0.5,
        codAmount: cod,
        appliedFee: fee,
        netAdvance: cod - fee,
        receiverName: `Khách hàng #${i + 1}`,
        note: 'Đơn mẫu kiểm thử công thức chuẩn',
      };
    });

    setNewOrders(demoNewOrders);
    setOutboundFileName(`Mau_100_Don_Di_${scenario.toUpperCase()}.xlsx`);

    if (scenario === 'day1') {
      setReturnedOrders([]);
      setReturnFileName('');
      setWeightAdjustments([]);
      setManualAdjustmentAmount(0);
      setPreviewListTab('outbound');
      showToast(
        'Đã nạp Kịch Bản Ngày 1: 100 đơn đi × 200k COD (= 20tr) - 20k cước (= 2tr) ➔ Thực ứng = 18.000.000 đ!',
        'success'
      );
    } else {
      const demoReturns: AdvanceOrderReturned[] = Array.from({ length: 10 }, (_, i) => ({
        id: `demo_ret_${i + 1}`,
        waybill: `VD_DAY1_${String(i + 1).padStart(3, '0')}`,
        codAmount: 200000,
        returnFee: 0,
        isFromHistory: true,
        originalAdvanceDate: advanceDate,
        note: 'Thu hồi COD đơn hoàn (Cước hoàn 0đ)',
      }));
      setReturnedOrders(demoReturns);
      setReturnFileName('Mau_10_Don_Hoan_Ngay_2.xlsx');
      setWeightAdjustments([]);
      setManualAdjustmentAmount(0);
      setPreviewListTab('returns');
      showToast(
        'Đã nạp Kịch Bản Ngày 2: 100 đơn mới (18tr) - 10 đơn hoàn × 200k (2tr) ➔ Thực ứng = 16.000.000 đ!',
        'success'
      );
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SAVE & FINALIZE ADVANCE SESSION (R2.4 & R3)
  // ──────────────────────────────────────────────────────────────────────────
  const buildCurrentSessionObject = (): AdvanceSession => {
    const allWeightAdjustments: AdvanceWeightAdjustment[] = [...weightAdjustments];
    if (Number(manualAdjustmentAmount) > 0) {
      allWeightAdjustments.push({
        id: `manual_adj_${Date.now()}`,
        feeDifference: Number(manualAdjustmentAmount),
        source: 'manual',
        note: manualAdjustmentNote || 'Phụ thu chênh lệch cước/cân nặng nhập tay',
      });
    }

    return {
      id: `adv_${selectedShop?.id || 'shop'}_${advanceDate.replace(/-/g, '')}_${Date.now()}`,
      shopId: selectedShop?.id || '',
      shopCode: selectedShop?.code || '',
      shopName: selectedShop?.name || '',
      advanceDate,
      createdAt: new Date().toISOString(),
      createdByName: currentUser.fullName || currentUser.username,
      totalNewOrdersCount: settlementMetrics.totalNewOrdersCount,
      totalNewCod: settlementMetrics.totalNewCod,
      totalNewFee: settlementMetrics.totalNewFee,
      netNewAdvance: settlementMetrics.netNewAdvance,
      totalReturnedOrdersCount: settlementMetrics.totalReturnedOrdersCount,
      totalReturnedCodRecall: settlementMetrics.totalReturnedCodRecall,
      totalWeightAdjustment: settlementMetrics.totalWeightAdjustment,
      manualAdjustmentAmount: settlementMetrics.manualAdj,
      manualAdjustmentNote,
      previousDebt: settlementMetrics.previousDebt,
      netAdvancePayout: settlementMetrics.netAdvancePayout,
      closingDebt: settlementMetrics.closingDebt,
      payoutStatus: settlementMetrics.isNegativeDebt ? 'NEGATIVE_DEBT' : 'PAID',
      bankInfo: {
        bankName: selectedShop?.bankAccount?.bankName || '',
        accountNumber: selectedShop?.bankAccount?.accountNumber || '',
        accountHolder: selectedShop?.bankAccount?.accountHolder || '',
      },
      newOrders,
      returnedOrders,
      weightAdjustments: allWeightAdjustments,
    };
  };

  const handleSaveAdvanceSession = async () => {
    if (!selectedShop) {
      showToast('Vui lòng chọn Shop trước khi lưu kỳ ứng!', 'warning');
      return;
    }
    if (
      newOrders.length === 0 &&
      returnedOrders.length === 0 &&
      weightAdjustments.length === 0 &&
      !manualAdjustmentAmount
    ) {
      showToast('Chưa có dữ liệu đơn đi, đơn hoàn hoặc điều chỉnh cước nào trong kỳ này.', 'warning');
      return;
    }

    setIsSavingSession(true);
    try {
      const sessionPayload = buildCurrentSessionObject();
      const res = await CodAdvanceService.saveAdvanceSessionApi(sessionPayload);
      if (res.success && res.session) {
        showToast(
          settlementMetrics.isNegativeDebt
            ? `Đã lưu kỳ ứng! Số âm ${formatMoney(settlementMetrics.closingDebt)} đã tự động ghi vào Nợ Lũy Kế kỳ sau.`
            : `Đã chốt kỳ ứng COD ngày ${advanceDate} cho ${selectedShop.name}: Thực chuyển ${formatMoney(settlementMetrics.netAdvancePayout)}!`,
          'success'
        );
        await loadAllAdvanceData();
        // Reset current form after save
        setNewOrders([]);
        setReturnedOrders([]);
        setWeightAdjustments([]);
        setManualAdjustmentAmount(0);
        setManualAdjustmentNote('');
        setOutboundFileName('');
        setReturnFileName('');
        setNvcFileName('');
      } else {
        showToast(res.error || 'Lỗi khi lưu kỳ ứng COD', 'error');
      }
    } finally {
      setIsSavingSession(false);
    }
  };

  const handleExportCurrentExcel = async () => {
    if (!selectedShop) {
      showToast('Vui lòng chọn Shop để xuất bảng kê!', 'warning');
      return;
    }
    try {
      const sessionObj = buildCurrentSessionObject();
      await CodAdvanceService.exportAndDownloadStatementExcel(sessionObj);
      showToast('Đã xuất file Excel Bảng Kê Tạm Ứng COD (4 Sheet) thành công!', 'success');
    } catch (err: any) {
      showToast(`Lỗi xuất Excel: ${err?.message || 'Không xác định'}`, 'error');
    }
  };

  const handleDeleteSession = async (session: AdvanceSession) => {
    const ok = await showConfirm({
      title: 'Xác nhận xóa & hoàn tác kỳ ứng COD',
      message: `Bạn có chắc chắn muốn xóa kỳ ứng ngày ${session.advanceDate} của "${session.shopName}"? Hệ thống sẽ tự động hoàn tác chỉ mục vận đơn và khôi phục lại số dư công nợ trước đó.`,
      confirmText: 'Xóa & Hoàn Tác',
      danger: true,
    });
    if (!ok) return;

    const res = await CodAdvanceService.deleteAdvanceSessionApi(session.id);
    if (res.success) {
      showToast('Đã xóa và hoàn tác kỳ ứng COD thành công!', 'success');
      await loadAllAdvanceData();
    } else {
      showToast(res.error || 'Không thể xóa kỳ ứng COD', 'error');
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SHOP CONFIG MODAL HANDLERS (R1)
  // ──────────────────────────────────────────────────────────────────────────
  const handleOpenCreateShop = () => {
    setEditingShop({
      code: '',
      name: '',
      phone: '',
      bankAccount: { bankName: 'MB Bank', accountNumber: '', accountHolder: '' },
      pricingPlan: {
        id: `plan_${Date.now()}`,
        name: 'Biểu phí Ứng COD chuẩn',
        weightRules: [
          { minWeight: 0, maxWeight: 1, price: 20000 },
          { minWeight: 1, maxWeight: 2, price: 25000 },
        ],
        extraStepWeight: 0.5,
        extraStepPrice: 5000,
        returnFeePercent: 0,
        returnFeeFixed: 0,
        returnFeeType: 'free',
      },
      currentDebt: 0,
      active: true,
    });
    setIsShopModalOpen(true);
  };

  const handleSaveShopModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingShop?.name?.trim()) {
      showToast('Vui lòng nhập tên Shop!', 'warning');
      return;
    }
    const saved = await CodAdvanceService.saveAdvanceShopApi(editingShop);
    if (saved) {
      showToast(`Đã lưu cấu hình Shop Ứng COD "${saved.name}" (Cước hoàn: 0đ)!`, 'success');
      setIsShopModalOpen(false);
      setEditingShop(null);
      await loadAllAdvanceData();
      if (!selectedShopId) setSelectedShopId(saved.id);
    } else {
      showToast('Không thể lưu cấu hình Shop', 'error');
    }
  };

  const handleCopyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(label);
    showToast(`Đã sao chép ${label}!`, 'success');
    setTimeout(() => setCopiedField(null), 1500);
  };

  // Filtered Lists
  const filteredShops = useMemo(() => {
    const q = shopSearchQuery.trim().toLowerCase();
    if (!q) return advanceShops;
    return advanceShops.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        (s.phone || '').toLowerCase().includes(q)
    );
  }, [advanceShops, shopSearchQuery]);

  const filteredSessions = useMemo(() => {
    if (ledgerFilterShopId === 'ALL') return sessions;
    return sessions.filter((s) => s.shopId === ledgerFilterShopId);
  }, [sessions, ledgerFilterShopId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ══════════════════════════════════════════════════════════════════════
          TOP HEADER & SUB-TABS NAVIGATION BAR
      ══════════════════════════════════════════════════════════════════════ */}
      <div
        className="glass-panel"
        style={{
          padding: '16px 22px',
          borderRadius: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 14,
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          border: '1.5px solid #dbe6f2',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              background: 'linear-gradient(135deg, #4f46e5 0%, #059669 100%)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(79, 70, 229, 0.25)',
            }}
          >
            <Banknote size={22} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h1 style={{ fontSize: 18, fontWeight: 900, color: 'var(--text-main)', margin: 0 }}>
                QUẢN LÝ ỨNG COD HÀNG NGÀY (T+0)
              </h1>
              <span className="badge badge-success" style={{ fontSize: 10.5, fontWeight: 800 }}>
                ĐỘC LẬP • MIỄN CƯỚC HOÀN 0Đ
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '2px 0 0' }}>
              Quyết toán cuốn chiếu theo ngày: (COD đơn mới - Cước đơn mới) - Thu hồi COD đơn hoàn - Lệch cân NVC + Dư/Nợ kỳ trước
            </p>
          </div>
        </div>

        {/* 4 SUB-TABS */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: '#f1f5f9',
            padding: 5,
            borderRadius: 12,
            border: '1px solid #cbd5e1',
            flexWrap: 'wrap',
          }}
        >
          {[
            { id: 'daily_settlement', label: '1. Tính Ứng Trong Ngày', icon: Upload },
            { id: 'shops_config', label: `2. Khách Hàng & Bảng Giá (${advanceShops.length})`, icon: Store },
            { id: 'ledger_history', label: `3. Sổ Cái & Lịch Sử (${sessions.length})`, icon: History },
            { id: 'payout_export', label: '4. VietQR & Xuất Bảng Kê', icon: QrCode },
            { id: 'loss_tracking', label: '5. 🛡️ Quản Lý Đơn Hàng', icon: ShieldCheck },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSubTab(tab.id as SubTabType)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 13px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 800,
                  background: active ? 'var(--primary)' : 'transparent',
                  color: active ? '#ffffff' : '#334155',
                  boxShadow: active ? '0 2px 8px rgba(79, 70, 229, 0.25)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                <Icon size={14} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SUB-TAB 1: QUYẾT TOÁN ỨNG TRONG NGÀY (R2)
      ══════════════════════════════════════════════════════════════════════ */}
      {activeSubTab === 'daily_settlement' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* STEP 1: CHỌN SHOP, NGÀY ỨNG & NÚT NẠP MẪU NHANH */}
          <div
            className="glass-panel"
            style={{
              padding: '16px 20px',
              borderRadius: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 800, color: '#475569', display: 'block', marginBottom: 4 }}>
                  CHỌN KHÁCH HÀNG (SHOP ỨNG COD):
                </label>
                <select
                  value={selectedShopId}
                  onChange={(e) => setSelectedShopId(e.target.value)}
                  className="select-field"
                  style={{ minWidth: 260, fontWeight: 800, fontSize: 13 }}
                >
                  {advanceShops.length === 0 && <option value="">-- Chưa có Shop (Bấm tạo Shop) --</option>}
                  {advanceShops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code}) {s.currentDebt < 0 ? `• Nợ: ${formatMoney(s.currentDebt)}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: 11, fontWeight: 800, color: '#475569', display: 'block', marginBottom: 4 }}>
                  NGÀY TẠM ỨNG:
                </label>
                <input
                  type="date"
                  value={advanceDate}
                  onChange={(e) => setAdvanceDate(e.target.value)}
                  className="input-field"
                  style={{ fontWeight: 700, fontSize: 13 }}
                />
              </div>

              {/* Dư / Nợ Đầu Kỳ */}
              <div
                style={{
                  padding: '8px 14px',
                  borderRadius: 10,
                  background: previousDebt < 0 ? '#fef2f2' : '#f0fdf4',
                  border: `1.5px solid ${previousDebt < 0 ? '#fecaca' : '#bbf7d0'}`,
                }}
              >
                <div style={{ fontSize: 10.5, fontWeight: 700, color: previousDebt < 0 ? '#991b1b' : '#166534' }}>
                  DƯ / NỢ LŨY KẾ KỲ TRƯỚC:
                </div>
                <div style={{ fontSize: 15, fontWeight: 900, color: previousDebt < 0 ? '#dc2626' : '#059669' }}>
                  {formatMoney(previousDebt)}
                </div>
              </div>
            </div>

            {/* Quick Demo Buttons for instant verification */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => handleLoadQuickDemo('day1')}
                className="btn btn-secondary btn-sm"
                style={{ fontSize: 11.5, fontWeight: 700 }}
                title="Nạp nhanh ví dụ Ngày 1: 100 đơn × 200k COD - 20k cước = 18.000.000đ"
              >
                <Sparkles size={13} color="var(--primary)" />
                <span>Mẫu Ngày 1 (18tr)</span>
              </button>
              <button
                type="button"
                onClick={() => handleLoadQuickDemo('day2')}
                className="btn btn-secondary btn-sm"
                style={{ fontSize: 11.5, fontWeight: 700 }}
                title="Nạp nhanh ví dụ Ngày 2: 100 đơn mới (18tr) - 10 đơn hoàn (2tr) = 16.000.000đ"
              >
                <Sparkles size={13} color="#059669" />
                <span>Mẫu Ngày 2 (+10 đơn hoàn = 16tr)</span>
              </button>
              <button
                type="button"
                onClick={handleOpenCreateShop}
                className="btn btn-outline btn-sm"
                style={{ fontSize: 11.5, fontWeight: 700 }}
              >
                <Plus size={13} />
                <span>Thêm Shop</span>
              </button>
            </div>
          </div>

          {/* STEP 2: 3 UPLOAD & INPUT ZONES */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
              gap: 16,
            }}
          >
            {/* ZONE 1: ĐƠN ĐI MỚI TRONG NGÀY */}
            <div
              className="glass-panel"
              style={{
                padding: 18,
                borderRadius: 14,
                border: '1.5px solid #c7d2fe',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: '#e0e7ff',
                      color: '#4338ca',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 900,
                      fontSize: 12,
                    }}
                  >
                    1
                  </span>
                  <h3 style={{ fontSize: 14, fontWeight: 800, margin: 0, color: '#1e1b4b' }}>
                    FILE ĐƠN ĐI (ĐƠN MỚI GỬI)
                  </h3>
                </div>
                {newOrders.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setNewOrders([]);
                      setOutboundFileName('');
                    }}
                    className="btn btn-sm"
                    style={{ padding: '2px 8px', fontSize: 11, color: '#dc2626', background: '#fef2f2' }}
                  >
                    Xóa ({newOrders.length})
                  </button>
                )}
              </div>

              <input
                ref={outboundInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleOutboundFileUpload(f);
                  e.target.value = '';
                }}
              />

              <div
                onClick={() => outboundInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleOutboundFileUpload(f);
                }}
                style={{
                  border: '2px dashed #818cf8',
                  borderRadius: 12,
                  padding: '18px 14px',
                  textAlign: 'center',
                  background: '#f5f7ff',
                  cursor: 'pointer',
                }}
              >
                <Upload size={22} color="#4f46e5" style={{ margin: '0 auto 6px' }} />
                <div style={{ fontSize: 12.5, fontWeight: 800, color: '#312e81' }}>
                  {outboundFileName || 'Bấm hoặc kéo thả File Excel Đơn Đi (.xlsx)'}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  Tự động đọc: Mã vận đơn, Cân nặng, Tiền COD & nhân bảng giá riêng của Shop
                </div>
              </div>

              <div
                style={{
                  background: '#f8fafc',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  fontSize: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Tổng số đơn mới:</span>
                  <strong>{settlementMetrics.totalNewOrdersCount} đơn</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Tổng COD đơn mới:</span>
                  <strong style={{ color: '#0f172a' }}>{formatMoney(settlementMetrics.totalNewCod)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Trừ cước gửi hàng:</span>
                  <strong style={{ color: '#dc2626' }}>- {formatMoney(settlementMetrics.totalNewFee)}</strong>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    borderTop: '1px dashed #cbd5e1',
                    paddingTop: 5,
                    marginTop: 2,
                  }}
                >
                  <span style={{ fontWeight: 800, color: '#1e40af' }}>Tiền ứng đơn mới (A):</span>
                  <strong style={{ fontSize: 13.5, color: '#2563eb' }}>
                    {formatMoney(settlementMetrics.netNewAdvance)}
                  </strong>
                </div>
              </div>
            </div>

            {/* ZONE 2: ĐƠN HOÀN TRONG NGÀY (MIỄN CƯỚC HOÀN 0Đ) */}
            <div
              className="glass-panel"
              style={{
                padding: 18,
                borderRadius: 14,
                border: '1.5px solid #fed7aa',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: '#ffedd5',
                      color: '#c2410c',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 900,
                      fontSize: 12,
                    }}
                  >
                    2
                  </span>
                  <h3 style={{ fontSize: 14, fontWeight: 800, margin: 0, color: '#7c2d12' }}>
                    FILE ĐƠN HOÀN (THU HỒI COD ĐÃ ỨNG)
                  </h3>
                </div>
                <span className="badge badge-success" style={{ fontSize: 10 }}>
                  Cước hoàn: 0đ
                </span>
              </div>

              <input
                ref={returnInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleReturnFileUpload(f);
                  e.target.value = '';
                }}
              />

              <div
                onClick={() => returnInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleReturnFileUpload(f);
                }}
                style={{
                  border: '2px dashed #fb923c',
                  borderRadius: 12,
                  padding: '14px 12px',
                  textAlign: 'center',
                  background: '#fff7ed',
                  cursor: 'pointer',
                }}
              >
                <Upload size={20} color="#ea580c" style={{ margin: '0 auto 4px' }} />
                <div style={{ fontSize: 12.5, fontWeight: 800, color: '#9a3412' }}>
                  {returnFileName || 'Tải File Excel Đơn Hoàn (.xlsx)'}
                </div>
                <div style={{ fontSize: 11, color: '#78716c' }}>
                  Tự động tra lịch sử lấy đúng COD đã ứng (hoặc cột COD trong file)
                </div>
              </div>

              {/* Nhập nhanh mã đơn hoàn */}
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={manualReturnText}
                  onChange={(e) => setManualReturnText(e.target.value)}
                  placeholder="Hoặc dán nhanh mã đơn hoàn (VD: VD001, VD002)..."
                  className="input-field"
                  style={{ fontSize: 11.5, padding: '6px 10px' }}
                />
                <button
                  type="button"
                  onClick={handleAddManualReturnWaybills}
                  className="btn btn-secondary btn-sm"
                  style={{ whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 700 }}
                >
                  + Thêm
                </button>
              </div>

              <div
                style={{
                  background: '#f8fafc',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  fontSize: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Số đơn hoàn về:</span>
                  <strong>
                    {settlementMetrics.totalReturnedOrdersCount} đơn (Khớp lịch sử: {settlementMetrics.historyMatchedCount})
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748b' }}>Cước phí hoàn:</span>
                  <strong style={{ color: '#059669' }}>0 đ (Miễn cước hoàn)</strong>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    borderTop: '1px dashed #cbd5e1',
                    paddingTop: 5,
                    marginTop: 2,
                  }}
                >
                  <span style={{ fontWeight: 800, color: '#9a3412' }}>Thu hồi COD đơn hoàn (B):</span>
                  <strong style={{ fontSize: 13.5, color: '#dc2626' }}>
                    - {formatMoney(settlementMetrics.totalReturnedCodRecall)}
                  </strong>
                </div>
              </div>
            </div>

            {/* ZONE 3: CHÊNH LỆCH CƯỚC / VƯỢT CÂN THỰC TẾ NVC */}
            <div
              className="glass-panel"
              style={{
                padding: 18,
                borderRadius: 14,
                border: '1.5px solid #cbd5e1',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: '#f1f5f9',
                      color: '#334155',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 900,
                      fontSize: 12,
                    }}
                  >
                    3
                  </span>
                  <h3 style={{ fontSize: 14, fontWeight: 800, margin: 0, color: '#1e293b' }}>
                    LỆCH CÂN / PHỤ THU CƯỚC NVC
                  </h3>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => setDiscrepancyMode('manual')}
                    className={`btn btn-sm ${discrepancyMode === 'manual' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ padding: '3px 8px', fontSize: 10.5 }}
                  >
                    Nhập tay
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiscrepancyMode('nvc_file')}
                    className={`btn btn-sm ${discrepancyMode === 'nvc_file' ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ padding: '3px 8px', fontSize: 10.5 }}
                  >
                    File NVC
                  </button>
                </div>
              </div>

              {discrepancyMode === 'manual' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>
                      Số tiền phụ thu chênh lệch cước/vượt cân (VNĐ):
                    </label>
                    <input
                      type="number"
                      value={manualAdjustmentAmount || ''}
                      onChange={(e) => setManualAdjustmentAmount(Number(e.target.value) || 0)}
                      placeholder="Ví dụ: 50000 (nếu không có để trống)"
                      className="input-field"
                      style={{ marginTop: 4, fontWeight: 700 }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>
                      Ghi chú điều chỉnh:
                    </label>
                    <input
                      type="text"
                      value={manualAdjustmentNote}
                      onChange={(e) => setManualAdjustmentNote(e.target.value)}
                      placeholder="VD: Phụ thu vượt cân 5 đơn kỳ đối soát NVC..."
                      className="input-field"
                      style={{ marginTop: 4, fontSize: 12 }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <input
                    ref={nvcInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleNvcDiscrepancyFileUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <div
                    onClick={() => nvcInputRef.current?.click()}
                    style={{
                      border: '2px dashed #64748b',
                      borderRadius: 12,
                      padding: '16px 12px',
                      textAlign: 'center',
                      background: '#f8fafc',
                      cursor: 'pointer',
                    }}
                  >
                    <Scale size={20} color="#475569" style={{ margin: '0 auto 4px' }} />
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: '#334155' }}>
                      {nvcFileName || 'Tải File Đối Soát Thực Tế Từ NVC (.xlsx)'}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>
                      Tự động so sánh cân nặng thực tế NVC với cân nặng lúc tạm ứng
                    </div>
                  </div>
                </>
              )}

              <div
                style={{
                  background: '#f8fafc',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  fontSize: 12,
                  marginTop: 'auto',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 800, color: '#334155' }}>Tổng trừ lệch cân NVC (C):</span>
                  <strong style={{ fontSize: 13.5, color: '#dc2626' }}>
                    - {formatMoney(settlementMetrics.totalWeightAdjustment)}
                  </strong>
                </div>
              </div>
            </div>
          </div>

          {/* STEP 3: BẢNG QUYẾT TOÁN CUỐN CHIẾU & CHUYỂN KHOẢN TỨC THÌ */}
          <div
            style={{
              borderRadius: 16,
              padding: '20px 24px',
              background: settlementMetrics.isNegativeDebt
                ? 'linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%)'
                : 'linear-gradient(135deg, #ecfdf5 0%, #f0f9ff 100%)',
              border: `2px solid ${settlementMetrics.isNegativeDebt ? '#fda4af' : '#6ee7b7'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 18,
            }}
          >
            <div style={{ flex: 1, minWidth: 300 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: '#475569', textTransform: 'uppercase' }}>
                CÔNG THỨC QUYẾT TOÁN ỨNG COD CUỐN CHIẾU NGÀY {advanceDate}:
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 10,
                  marginTop: 8,
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                <span style={{ background: '#fff', padding: '5px 10px', borderRadius: 8, border: '1px solid #cbd5e1' }}>
                  Ứng đơn mới: <strong style={{ color: '#2563eb' }}>{formatMoney(settlementMetrics.netNewAdvance)}</strong>
                </span>
                <span>-</span>
                <span style={{ background: '#fff', padding: '5px 10px', borderRadius: 8, border: '1px solid #cbd5e1' }}>
                  Thu hồi hoàn: <strong style={{ color: '#dc2626' }}>{formatMoney(settlementMetrics.totalReturnedCodRecall)}</strong>
                </span>
                <span>-</span>
                <span style={{ background: '#fff', padding: '5px 10px', borderRadius: 8, border: '1px solid #cbd5e1' }}>
                  Lệch cân NVC: <strong style={{ color: '#dc2626' }}>{formatMoney(settlementMetrics.totalWeightAdjustment)}</strong>
                </span>
                <span>+</span>
                <span style={{ background: '#fff', padding: '5px 10px', borderRadius: 8, border: '1px solid #cbd5e1' }}>
                  Nợ kỳ trước: <strong style={{ color: previousDebt < 0 ? '#dc2626' : '#059669' }}>{formatMoney(previousDebt)}</strong>
                </span>
              </div>

              {settlementMetrics.isNegativeDebt && (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: '#be123c',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <AlertTriangle size={16} />
                  <span>
                    Tiền thu hồi đơn hoàn lớn hơn tiền ứng đơn mới! Số âm{' '}
                    <strong>{formatMoney(settlementMetrics.closingDebt)}</strong> sẽ tự động kết chuyển vào Nợ Đầu Kỳ của đợt ứng tiếp theo.
                  </span>
                </div>
              )}
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, color: '#334155' }}>
                {settlementMetrics.isNegativeDebt ? 'SỐ ÂM KẾT CHUYỂN NỢ KỲ SAU:' : 'SỐ TIỀN THỰC CHUYỂN ỨNG HÔM NAY:'}
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 900,
                  color: settlementMetrics.isNegativeDebt ? '#dc2626' : '#059669',
                  fontFamily: 'JetBrains Mono, monospace',
                  margin: '2px 0 10px',
                }}
              >
                {formatMoney(settlementMetrics.netAdvancePayout)}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleExportCurrentExcel}
                  className="btn btn-secondary btn-sm"
                  style={{ fontWeight: 800, padding: '8px 14px' }}
                >
                  <Download size={15} />
                  <span>Xuất Excel (4 Sheet)</span>
                </button>

                {!settlementMetrics.isNegativeDebt && settlementMetrics.netAdvancePayout > 0 && (
                  <button
                    type="button"
                    onClick={() => setQrModalSession(buildCurrentSessionObject())}
                    className="btn btn-secondary btn-sm"
                    style={{ fontWeight: 800, padding: '8px 14px', background: '#fff', color: '#4f46e5', border: '1.5px solid #4f46e5' }}
                  >
                    <QrCode size={15} />
                    <span>Quét VietQR Chuyển Tiền</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleSaveAdvanceSession}
                  disabled={isSavingSession}
                  className="btn btn-primary btn-sm"
                  style={{ fontWeight: 800, padding: '8px 18px', fontSize: 13 }}
                >
                  <CheckCircle2 size={15} />
                  <span>
                    {isSavingSession
                      ? 'Đang lưu...'
                      : settlementMetrics.isNegativeDebt
                      ? 'Lưu Ghi Nhận Nợ Âm'
                      : 'Chốt & Lưu Kỳ Ứng COD'}
                  </span>
                </button>
              </div>
            </div>
          </div>

          {/* STEP 4: BẢNG XEM TRƯỚC CHI TIẾT ĐƠN ĐI / ĐƠN HOÀN */}
          {(newOrders.length > 0 || returnedOrders.length > 0 || weightAdjustments.length > 0) && (
            <div className="glass-panel" style={{ padding: 18, borderRadius: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setPreviewListTab('outbound')}
                    className={`btn btn-sm ${previewListTab === 'outbound' ? 'btn-primary' : 'btn-secondary'}`}
                  >
                    Đơn Đi Mới ({newOrders.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewListTab('returns')}
                    className={`btn btn-sm ${previewListTab === 'returns' ? 'btn-primary' : 'btn-secondary'}`}
                  >
                    Đơn Hoàn Thu Hồi ({returnedOrders.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewListTab('discrepancy')}
                    className={`btn btn-sm ${previewListTab === 'discrepancy' ? 'btn-primary' : 'btn-secondary'}`}
                  >
                    Lệch Cân NVC ({weightAdjustments.length})
                  </button>
                </div>
              </div>

              {previewListTab === 'outbound' && (
                <div className="table-container" style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>STT</th>
                        <th>Mã Vận Đơn</th>
                        <th>Cân Nặng (kg)</th>
                        <th>Tiền Thu Hộ COD</th>
                        <th>Cước Tạm Tính (Theo Bảng Giá Shop)</th>
                        <th>Tiền Ứng Đơn Mới</th>
                      </tr>
                    </thead>
                    <tbody>
                      {newOrders.map((ord, i) => (
                        <tr key={ord.id || i}>
                          <td>{i + 1}</td>
                          <td style={{ fontWeight: 800, fontFamily: 'monospace' }}>{ord.waybill}</td>
                          <td>{ord.weight} kg</td>
                          <td style={{ fontWeight: 700 }}>{formatMoney(ord.codAmount)}</td>
                          <td style={{ color: '#dc2626', fontWeight: 700 }}>- {formatMoney(ord.appliedFee)}</td>
                          <td style={{ color: '#059669', fontWeight: 800 }}>{formatMoney(ord.netAdvance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {previewListTab === 'returns' && (
                <div className="table-container" style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>STT</th>
                        <th>Mã Vận Đơn Hoàn</th>
                        <th>Nguồn Tra Cứu COD</th>
                        <th>Cước Hoàn</th>
                        <th>Số Tiền COD Thu Hồi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {returnedOrders.map((ord, i) => (
                        <tr key={ord.id || i}>
                          <td>{i + 1}</td>
                          <td style={{ fontWeight: 800, fontFamily: 'monospace' }}>{ord.waybill}</td>
                          <td>
                            {ord.isFromHistory ? (
                              <span className="badge badge-success">
                                Khớp lịch sử ứng ({ord.originalAdvanceDate || 'Trước đó'})
                              </span>
                            ) : (
                              <span className="badge badge-warning">Lấy từ cột COD file đơn hoàn</span>
                            )}
                          </td>
                          <td>
                            <span className="badge badge-info">0 đ (Miễn phí)</span>
                          </td>
                          <td style={{ color: '#dc2626', fontWeight: 800 }}>- {formatMoney(ord.codAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {previewListTab === 'discrepancy' && (
                <div className="table-container" style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>STT</th>
                        <th>Mã Vận Đơn</th>
                        <th>Cân Tạm Tính</th>
                        <th>Cân Thực Tế NVC</th>
                        <th>Cước Đã Thu</th>
                        <th>Cước Thực Tế</th>
                        <th>Phụ Thu Lệch Cân</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weightAdjustments.map((adj, i) => (
                        <tr key={adj.id || i}>
                          <td>{i + 1}</td>
                          <td style={{ fontWeight: 800, fontFamily: 'monospace' }}>{adj.waybill || 'Điều chỉnh tay'}</td>
                          <td>{adj.advanceWeight ?? '—'} kg</td>
                          <td>{adj.actualWeight ?? '—'} kg</td>
                          <td>{formatMoney(adj.advanceFee || 0)}</td>
                          <td>{formatMoney(adj.actualFee || 0)}</td>
                          <td style={{ color: '#dc2626', fontWeight: 800 }}>- {formatMoney(adj.feeDifference)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SUB-TAB 2: QUẢN LÝ KHÁCH HÀNG & BẢNG GIÁ RIÊNG (R1)
      ══════════════════════════════════════════════════════════════════════ */}
      {activeSubTab === 'shops_config' && (
        <div className="glass-panel" style={{ padding: 20, borderRadius: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ position: 'relative', minWidth: 280 }}>
                <Search
                  size={15}
                  style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }}
                />
                <input
                  type="text"
                  value={shopSearchQuery}
                  onChange={(e) => setShopSearchQuery(e.target.value)}
                  placeholder="Tìm theo tên Shop, mã Shop, SĐT..."
                  className="input-field"
                  style={{ paddingLeft: 32, fontSize: 12.5 }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={handleOpenCreateShop}
                className="btn btn-primary btn-sm"
                style={{ fontWeight: 800 }}
              >
                <Plus size={15} />
                <span>Thêm Shop Ứng COD Mới</span>
              </button>
            </div>
          </div>

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Mã Shop</th>
                  <th>Tên Khách Hàng (Shop)</th>
                  <th>Tài Khoản Ngân Hàng Nhận Ứng</th>
                  <th>Bảng Giá Cước Riêng Theo Nấc Cân</th>
                  <th>Chính Sách Hoàn</th>
                  <th>Công Nợ Lũy Kế</th>
                  <th>Thao Tác</th>
                </tr>
              </thead>
              <tbody>
                {filteredShops.map((shop) => (
                  <tr key={shop.id}>
                    <td style={{ fontWeight: 800, fontFamily: 'monospace', color: 'var(--primary)' }}>{shop.code}</td>
                    <td>
                      <div style={{ fontWeight: 800, color: '#0f172a' }}>{shop.name}</div>
                      {shop.phone && <div style={{ fontSize: 11, color: '#64748b' }}>📞 {shop.phone}</div>}
                    </td>
                    <td>
                      {shop.bankAccount?.accountNumber ? (
                        <div style={{ fontSize: 11.5 }}>
                          <strong>{shop.bankAccount.bankName}</strong> •{' '}
                          <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                            {shop.bankAccount.accountNumber}
                          </span>
                          <div style={{ color: '#64748b', fontSize: 11 }}>{shop.bankAccount.accountHolder}</div>
                        </div>
                      ) : (
                        <span style={{ color: '#94a3b8', fontSize: 11.5 }}>Chưa cập nhật STK</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(shop.pricingPlan?.weightRules || []).map((r, idx) => (
                          <span
                            key={idx}
                            style={{
                              background: '#f1f5f9',
                              padding: '2px 7px',
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 700,
                              border: '1px solid #cbd5e1',
                            }}
                          >
                            {r.minWeight}-{r.maxWeight}kg: {formatMoney(r.price)}
                          </span>
                        ))}
                        <span
                          style={{
                            background: '#eef2ff',
                            color: '#4338ca',
                            padding: '2px 7px',
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          +{shop.pricingPlan?.extraStepWeight || 0.5}kg: +{formatMoney(shop.pricingPlan?.extraStepPrice || 5000)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="badge badge-success">Miễn cước hoàn (0đ)</span>
                    </td>
                    <td>
                      {shop.currentDebt < 0 ? (
                        <span className="badge badge-danger" style={{ fontSize: 12, fontWeight: 800 }}>
                          Nợ: {formatMoney(shop.currentDebt)}
                        </span>
                      ) : (
                        <span className="badge badge-neutral" style={{ fontSize: 11.5 }}>
                          0 đ
                        </span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingShop({ ...shop });
                            setIsShopModalOpen(true);
                          }}
                          className="btn btn-secondary btn-sm"
                          style={{ padding: '4px 8px', fontSize: 11 }}
                        >
                          <Edit2 size={12} />
                          <span>Sửa Giá</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedShopId(shop.id);
                            setActiveSubTab('daily_settlement');
                          }}
                          className="btn btn-primary btn-sm"
                          style={{ padding: '4px 10px', fontSize: 11 }}
                        >
                          <span>Tính Ứng</span>
                          <ArrowRight size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SUB-TAB 3: SỔ CÁI CÔNG NỢ CUỐN CHIẾU & LỊCH SỬ KỲ ỨNG (R3)
      ══════════════════════════════════════════════════════════════════════ */}
      {activeSubTab === 'ledger_history' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* KPI Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            <div className="kpi-card">
              <div className="kpi-title">TỔNG SỐ KỲ ĐÃ ỨNG COD</div>
              <div className="kpi-value">{sessions.length} kỳ</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-title">TỔNG TIỀN ỨNG ĐƠN MỚI</div>
              <div className="kpi-value" style={{ color: '#2563eb' }}>
                {formatMoney(sessions.reduce((s, x) => s + (x.netNewAdvance || 0), 0))}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-title">TỔNG COD ĐƠN HOÀN ĐÃ THU HỒI</div>
              <div className="kpi-value" style={{ color: '#d97706' }}>
                {formatMoney(sessions.reduce((s, x) => s + (x.totalReturnedCodRecall || 0), 0))}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-title">TỔNG NỢ ÂM ĐANG TỒN ĐỌNG</div>
              <div className="kpi-value" style={{ color: '#dc2626' }}>
                {formatMoney(advanceShops.reduce((s, x) => s + (x.currentDebt < 0 ? x.currentDebt : 0), 0))}
              </div>
            </div>
          </div>

          <div className="glass-panel" style={{ padding: 20, borderRadius: 16 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
                marginBottom: 14,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12.5, fontWeight: 800 }}>Lọc theo Shop:</span>
                <select
                  value={ledgerFilterShopId}
                  onChange={(e) => setLedgerFilterShopId(e.target.value)}
                  className="select-field"
                  style={{ minWidth: 220, fontSize: 12.5, fontWeight: 700 }}
                >
                  <option value="ALL">Tất cả khách hàng ({advanceShops.length} Shop)</option>
                  {advanceShops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setAdjustShopId(advanceShops[0]?.id || '');
                    setAdjustAmount('');
                    setAdjustNote('');
                    setIsDebtAdjustModalOpen(true);
                  }}
                  className="btn btn-secondary btn-sm"
                  style={{ fontWeight: 700 }}
                >
                  <Scale size={14} />
                  <span>Điều Chỉnh Công Nợ Thủ Công</span>
                </button>
                <button
                  type="button"
                  onClick={loadAllAdvanceData}
                  className="btn btn-secondary btn-sm"
                  disabled={isLoadingData}
                >
                  <RefreshCw size={14} className={isLoadingData ? 'animate-spin' : ''} />
                  <span>Làm mới</span>
                </button>
              </div>
            </div>

            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ngày Ứng</th>
                    <th>Khách Hàng (Shop)</th>
                    <th>Đơn Đi Mới (COD - Cước)</th>
                    <th>Thu Hồi Đơn Hoàn</th>
                    <th>Lệch Cân NVC</th>
                    <th>Nợ Kỳ Trước</th>
                    <th>Thực Chuyển / Kết Chuyển</th>
                    <th>Trạng Thái</th>
                    <th>Thao Tác</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>
                        Chưa có kỳ ứng COD nào được lưu.
                      </td>
                    </tr>
                  ) : (
                    filteredSessions.map((ses) => (
                      <tr key={ses.id}>
                        <td style={{ fontWeight: 800 }}>{ses.advanceDate}</td>
                        <td>
                          <div style={{ fontWeight: 800 }}>{ses.shopName}</div>
                          <div style={{ fontSize: 11, color: '#64748b' }}>{ses.shopCode}</div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 700, color: '#2563eb' }}>{formatMoney(ses.netNewAdvance)}</div>
                          <div style={{ fontSize: 10.5, color: '#64748b' }}>
                            {ses.totalNewOrdersCount} đơn (COD: {formatMoney(ses.totalNewCod)})
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 700, color: '#dc2626' }}>
                            - {formatMoney(ses.totalReturnedCodRecall)}
                          </div>
                          <div style={{ fontSize: 10.5, color: '#64748b' }}>{ses.totalReturnedOrdersCount} đơn hoàn</div>
                        </td>
                        <td style={{ color: '#dc2626', fontWeight: 700 }}>
                          - {formatMoney(ses.totalWeightAdjustment || 0)}
                        </td>
                        <td style={{ fontWeight: 700, color: ses.previousDebt < 0 ? '#dc2626' : '#475569' }}>
                          {formatMoney(ses.previousDebt || 0)}
                        </td>
                        <td
                          style={{
                            fontWeight: 900,
                            fontSize: 13.5,
                            color: ses.netAdvancePayout < 0 ? '#dc2626' : '#059669',
                          }}
                        >
                          {formatMoney(ses.netAdvancePayout)}
                        </td>
                        <td>
                          {ses.netAdvancePayout < 0 ? (
                            <span className="badge badge-danger">Âm • Chuyển nợ kỳ sau</span>
                          ) : (
                            <span className="badge badge-success">Đã chốt ứng T+0</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 5 }}>
                            <button
                              type="button"
                              onClick={async () => {
                                const full = await CodAdvanceService.fetchAdvanceSessionDetail(ses.id);
                                setDetailModalSession(full || ses);
                              }}
                              className="btn btn-secondary btn-sm"
                              style={{ padding: '4px 7px' }}
                              title="Xem chi tiết kỳ ứng"
                            >
                              <Eye size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                const full = await CodAdvanceService.fetchAdvanceSessionDetail(ses.id);
                                await CodAdvanceService.exportAndDownloadStatementExcel(full || ses);
                                showToast('Đã tải file Excel Bảng Kê Ứng COD!', 'success');
                              }}
                              className="btn btn-secondary btn-sm"
                              style={{ padding: '4px 7px' }}
                              title="Tải bảng kê Excel 4 Sheet"
                            >
                              <FileSpreadsheet size={13} color="#059669" />
                            </button>
                            {ses.netAdvancePayout > 0 && (
                              <button
                                type="button"
                                onClick={async () => {
                                  const full = await CodAdvanceService.fetchAdvanceSessionDetail(ses.id);
                                  setQrModalSession(full || ses);
                                }}
                                className="btn btn-secondary btn-sm"
                                style={{ padding: '4px 7px' }}
                                title="Mở mã VietQR chuyển khoản"
                              >
                                <QrCode size={13} color="#4f46e5" />
                              </button>
                            )}
                            {currentUser.role === 'ADMIN' && (
                              <button
                                type="button"
                                onClick={() => handleDeleteSession(ses)}
                                className="btn btn-secondary btn-sm"
                                style={{ padding: '4px 7px', color: '#dc2626' }}
                                title="Xóa & Hoàn tác kỳ ứng"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SUB-TAB 4: THANH TOÁN VIETQR & XUẤT BẢNG KÊ EXCEL (R3)
      ══════════════════════════════════════════════════════════════════════ */}
      {activeSubTab === 'payout_export' && (
        <div className="glass-panel" style={{ padding: 22, borderRadius: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 800, margin: '0 0 12px' }}>
            Danh Sách Phiếu Chi Chuyển Khoản VietQR & Bảng Kê Tạm Ứng COD
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
            {sessions.map((ses) => {
              const memo = CodAdvanceService.toVietQrMemo(ses.shopCode || ses.shopName, ses.advanceDate);
              return (
                <div
                  key={ses.id}
                  style={{
                    border: '1.5px solid #e2e8f0',
                    borderRadius: 14,
                    padding: 16,
                    background: '#fff',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>{ses.shopName}</div>
                      <div style={{ fontSize: 11.5, color: '#64748b' }}>Ngày ứng: {ses.advanceDate}</div>
                    </div>
                    <span className={`badge ${ses.netAdvancePayout < 0 ? 'badge-danger' : 'badge-success'}`}>
                      {ses.netAdvancePayout < 0 ? 'Kết chuyển nợ âm' : 'Thực chuyển'}
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 900,
                      color: ses.netAdvancePayout < 0 ? '#dc2626' : '#059669',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    {formatMoney(ses.netAdvancePayout)}
                  </div>

                  <div style={{ fontSize: 11.5, color: '#475569' }}>
                    <div>• NH: {ses.bankInfo?.bankName || '—'} - {ses.bankInfo?.accountNumber || '—'}</div>
                    <div>• Nội dung CK: <code>{memo}</code></div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                    <button
                      type="button"
                      onClick={async () => {
                        const full = await CodAdvanceService.fetchAdvanceSessionDetail(ses.id);
                        await CodAdvanceService.exportAndDownloadStatementExcel(full || ses);
                      }}
                      className="btn btn-secondary btn-sm"
                      style={{ flex: 1, fontWeight: 700 }}
                    >
                      <Download size={13} />
                      <span>Tải Excel</span>
                    </button>
                    {ses.netAdvancePayout > 0 && (
                      <button
                        type="button"
                        onClick={async () => {
                          const full = await CodAdvanceService.fetchAdvanceSessionDetail(ses.id);
                          setQrModalSession(full || ses);
                        }}
                        className="btn btn-primary btn-sm"
                        style={{ flex: 1, fontWeight: 700 }}
                      >
                        <QrCode size={13} />
                        <span>Mã VietQR</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SUB-TAB 5: KIỂM SOÁT HÀNG HOÀN & CẢNH BÁO ĐƠN MẤT (J&T)
      ══════════════════════════════════════════════════════════════════════ */}
      {activeSubTab === 'loss_tracking' && (
        <OrderLossTrackingTab
          currentUser={currentUser}
          shops={mainSystemShops}
          activeCarrierId={activeCarrierId}
          activeCarrierName={activeCarrierName}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MODAL 1: CHỈNH SỬA SHOP & BẢNG GIÁ NẤC CÂN RIÊNG (R1)
      ══════════════════════════════════════════════════════════════════════ */}
      {isShopModalOpen && editingShop && (
        <div className="modal-overlay" onClick={() => setIsShopModalOpen(false)}>
          <div
            className="modal-content"
            style={{ maxWidth: 640, width: '100%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
                Cấu Hình Khách Hàng Ứng COD (T+0) & Biểu Phí Riêng
              </h3>
              <button
                type="button"
                onClick={() => setIsShopModalOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveShopModal} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label className="input-label">Mã Shop *</label>
                  <input
                    type="text"
                    required
                    value={editingShop.code || ''}
                    onChange={(e) => setEditingShop({ ...editingShop, code: e.target.value })}
                    className="input-field"
                    placeholder="VD: SHOP_VIETM"
                  />
                </div>
                <div>
                  <label className="input-label">Tên Shop *</label>
                  <input
                    type="text"
                    required
                    value={editingShop.name || ''}
                    onChange={(e) => setEditingShop({ ...editingShop, name: e.target.value })}
                    className="input-field"
                    placeholder="VD: Shop VietM"
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div>
                  <label className="input-label">Ngân hàng</label>
                  <select
                    value={editingShop.bankAccount?.bankName || 'MB Bank'}
                    onChange={(e) =>
                      setEditingShop({
                        ...editingShop,
                        bankAccount: { ...editingShop.bankAccount!, bankName: e.target.value },
                      })
                    }
                    className="select-field"
                  >
                    {Object.keys(BANK_CODES).map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="input-label">Số tài khoản</label>
                  <input
                    type="text"
                    value={editingShop.bankAccount?.accountNumber || ''}
                    onChange={(e) =>
                      setEditingShop({
                        ...editingShop,
                        bankAccount: { ...editingShop.bankAccount!, accountNumber: e.target.value },
                      })
                    }
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="input-label">Chủ tài khoản</label>
                  <input
                    type="text"
                    value={editingShop.bankAccount?.accountHolder || ''}
                    onChange={(e) =>
                      setEditingShop({
                        ...editingShop,
                        bankAccount: { ...editingShop.bankAccount!, accountHolder: e.target.value.toUpperCase() },
                      })
                    }
                    className="input-field"
                  />
                </div>
              </div>

              {/* Weight Pricing Rules */}
              <div style={{ background: '#f8fafc', padding: 12, borderRadius: 10, border: '1px solid #cbd5e1' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 800 }}>BẢNG GIÁ THEO NẤC CÂN NẶNG (VNĐ):</span>
                  <button
                    type="button"
                    onClick={() => {
                      const rules = editingShop.pricingPlan?.weightRules || [];
                      const lastMax = rules.length > 0 ? rules[rules.length - 1].maxWeight : 0;
                      setEditingShop({
                        ...editingShop,
                        pricingPlan: {
                          ...editingShop.pricingPlan!,
                          weightRules: [...rules, { minWeight: lastMax, maxWeight: lastMax + 1, price: 25000 }],
                        },
                      });
                    }}
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: 11, padding: '3px 8px' }}
                  >
                    + Thêm nấc cân
                  </button>
                </div>

                {(editingShop.pricingPlan?.weightRules || []).map((rule, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12 }}>Từ</span>
                    <input
                      type="number"
                      step="0.1"
                      value={rule.minWeight}
                      onChange={(e) => {
                        const next = [...(editingShop.pricingPlan?.weightRules || [])];
                        next[idx] = { ...next[idx], minWeight: Number(e.target.value) };
                        setEditingShop({
                          ...editingShop,
                          pricingPlan: { ...editingShop.pricingPlan!, weightRules: next },
                        });
                      }}
                      className="input-field"
                      style={{ width: 75 }}
                    />
                    <span style={{ fontSize: 12 }}>đến</span>
                    <input
                      type="number"
                      step="0.1"
                      value={rule.maxWeight}
                      onChange={(e) => {
                        const next = [...(editingShop.pricingPlan?.weightRules || [])];
                        next[idx] = { ...next[idx], maxWeight: Number(e.target.value) };
                        setEditingShop({
                          ...editingShop,
                          pricingPlan: { ...editingShop.pricingPlan!, weightRules: next },
                        });
                      }}
                      className="input-field"
                      style={{ width: 75 }}
                    />
                    <span style={{ fontSize: 12 }}>kg =</span>
                    <input
                      type="number"
                      value={rule.price}
                      onChange={(e) => {
                        const next = [...(editingShop.pricingPlan?.weightRules || [])];
                        next[idx] = { ...next[idx], price: Number(e.target.value) };
                        setEditingShop({
                          ...editingShop,
                          pricingPlan: { ...editingShop.pricingPlan!, weightRules: next },
                        });
                      }}
                      className="input-field"
                      style={{ flex: 1, fontWeight: 700 }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = (editingShop.pricingPlan?.weightRules || []).filter((_, i) => i !== idx);
                        setEditingShop({
                          ...editingShop,
                          pricingPlan: { ...editingShop.pricingPlan!, weightRules: next },
                        });
                      }}
                      className="btn btn-secondary btn-sm"
                      style={{ color: '#dc2626', padding: '4px 7px' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700 }}>Mỗi bước cân vượt tiếp theo (kg):</label>
                    <input
                      type="number"
                      step="0.1"
                      value={editingShop.pricingPlan?.extraStepWeight ?? 0.5}
                      onChange={(e) =>
                        setEditingShop({
                          ...editingShop,
                          pricingPlan: {
                            ...editingShop.pricingPlan!,
                            extraStepWeight: Number(e.target.value) || 0.5,
                          },
                        })
                      }
                      className="input-field"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700 }}>Cộng thêm (VNĐ / bước):</label>
                    <input
                      type="number"
                      value={editingShop.pricingPlan?.extraStepPrice ?? 5000}
                      onChange={(e) =>
                        setEditingShop({
                          ...editingShop,
                          pricingPlan: {
                            ...editingShop.pricingPlan!,
                            extraStepPrice: Number(e.target.value) || 0,
                          },
                        })
                      }
                      className="input-field"
                    />
                  </div>
                </div>

                <div style={{ marginTop: 10, fontSize: 12, color: '#059669', fontWeight: 800 }}>
                  ✓ Chính sách Cước hoàn: Khóa cố định 0 đ (Miễn phí cước hoàn theo quy định)
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                <button type="button" onClick={() => setIsShopModalOpen(false)} className="btn btn-secondary">
                  Hủy
                </button>
                <button type="submit" className="btn btn-primary" style={{ fontWeight: 800 }}>
                  Lưu Cấu Hình Shop
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MODAL 2: VIETQR CHUYỂN KHOẢN T+0 (R3)
      ══════════════════════════════════════════════════════════════════════ */}
      {qrModalSession && (
        <div className="modal-overlay" onClick={() => setQrModalSession(null)}>
          <div
            className="modal-content"
            style={{ maxWidth: 440, width: '100%', textAlign: 'center' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>Mã VietQR Chuyển Tiền Ứng COD</h3>
              <button
                type="button"
                onClick={() => setQrModalSession(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            {(() => {
              const memo = CodAdvanceService.toVietQrMemo(
                qrModalSession.shopCode || qrModalSession.shopName,
                qrModalSession.advanceDate
              );
              const qrUrl = CodAdvanceService.generateVietQrUrl(
                {
                  bankName: qrModalSession.bankInfo?.bankName || 'MB Bank',
                  accountNumber: qrModalSession.bankInfo?.accountNumber || '',
                  accountHolder: qrModalSession.bankInfo?.accountHolder || '',
                },
                qrModalSession.netAdvancePayout,
                memo
              );
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#059669' }}>
                    {formatMoney(qrModalSession.netAdvancePayout)}
                  </div>
                  {qrUrl ? (
                    <img
                      src={qrUrl}
                      alt="VietQR"
                      style={{ width: 250, height: 250, margin: '0 auto', borderRadius: 12, border: '1px solid #e2e8f0' }}
                    />
                  ) : (
                    <div style={{ padding: 20, background: '#fef2f2', color: '#dc2626', borderRadius: 10, fontSize: 12.5 }}>
                      Shop chưa cấu hình Số tài khoản ngân hàng hoặc số tiền thực chuyển ≤ 0đ.
                    </div>
                  )}

                  <div style={{ background: '#f8fafc', padding: 12, borderRadius: 10, textAlign: 'left', fontSize: 12.5 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span>Ngân hàng:</span>
                      <strong>{qrModalSession.bankInfo?.bankName || '—'}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span>Số tài khoản:</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <strong style={{ fontFamily: 'monospace' }}>{qrModalSession.bankInfo?.accountNumber || '—'}</strong>
                        {qrModalSession.bankInfo?.accountNumber && (
                          <button
                            type="button"
                            onClick={() => handleCopyText(qrModalSession.bankInfo.accountNumber, 'Số tài khoản')}
                            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--primary)' }}
                          >
                            {copiedField === 'Số tài khoản' ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Nội dung CK:</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <code>{memo}</code>
                        <button
                          type="button"
                          onClick={() => handleCopyText(memo, 'Nội dung CK')}
                          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--primary)' }}
                        >
                          {copiedField === 'Nội dung CK' ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MODAL 3: XEM CHI TIẾT KỲ ỨNG COD
      ══════════════════════════════════════════════════════════════════════ */}
      {detailModalSession && (
        <div className="modal-overlay" onClick={() => setDetailModalSession(null)}>
          <div
            className="modal-content"
            style={{ maxWidth: 880, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
                  Chi Tiết Kỳ Ứng COD: {detailModalSession.shopName} (Ngày {detailModalSession.advanceDate})
                </h3>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  Đơn đi: {detailModalSession.totalNewOrdersCount} đơn • Đơn hoàn: {detailModalSession.totalReturnedOrdersCount} đơn • Thực chuyển: {formatMoney(detailModalSession.netAdvancePayout)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDetailModalSession(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
              <button
                type="button"
                onClick={() => CodAdvanceService.exportAndDownloadStatementExcel(detailModalSession)}
                className="btn btn-primary btn-sm"
              >
                <Download size={14} />
                <span>Tải Bảng Kê Excel (4 Sheet)</span>
              </button>
            </div>

            {detailModalSession.newOrders && detailModalSession.newOrders.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <h4 style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>
                  1. Danh sách Đơn Đi Mới ({detailModalSession.newOrders.length} đơn)
                </h4>
                <div className="table-container" style={{ maxHeight: 220, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>STT</th>
                        <th>Mã Vận Đơn</th>
                        <th>Cân Nặng</th>
                        <th>COD</th>
                        <th>Cước Tính</th>
                        <th>Tiền Ứng</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailModalSession.newOrders.map((o, i) => (
                        <tr key={o.id || i}>
                          <td>{i + 1}</td>
                          <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{o.waybill}</td>
                          <td>{o.weight} kg</td>
                          <td>{formatMoney(o.codAmount)}</td>
                          <td style={{ color: '#dc2626' }}>- {formatMoney(o.appliedFee)}</td>
                          <td style={{ color: '#059669', fontWeight: 800 }}>{formatMoney(o.netAdvance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detailModalSession.returnedOrders && detailModalSession.returnedOrders.length > 0 && (
              <div>
                <h4 style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>
                  2. Danh sách Đơn Hoàn Thu Hồi COD ({detailModalSession.returnedOrders.length} đơn • Cước hoàn 0đ)
                </h4>
                <div className="table-container" style={{ maxHeight: 200, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>STT</th>
                        <th>Mã Vận Đơn Hoàn</th>
                        <th>Nguồn Đối Chiếu</th>
                        <th>Cước Hoàn</th>
                        <th>COD Thu Hồi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailModalSession.returnedOrders.map((o, i) => (
                        <tr key={o.id || i}>
                          <td>{i + 1}</td>
                          <td style={{ fontFamily: 'monospace', fontWeight: 700 }}>{o.waybill}</td>
                          <td>{o.isFromHistory ? 'Khớp lịch sử đã ứng' : 'Từ cột COD file hoàn'}</td>
                          <td>0 đ</td>
                          <td style={{ color: '#dc2626', fontWeight: 800 }}>- {formatMoney(o.codAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MODAL 4: ĐIỀU CHỈNH CÔNG NỢ THỦ CÔNG
      ══════════════════════════════════════════════════════════════════════ */}
      {isDebtAdjustModalOpen && (
        <div className="modal-overlay" onClick={() => setIsDebtAdjustModalOpen(false)}>
          <div className="modal-content" style={{ maxWidth: 440, width: '100%' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 12px' }}>Điều Chỉnh Công Nợ Ứng COD Thủ Công</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label className="input-label">Chọn Shop</label>
                <select
                  value={adjustShopId}
                  onChange={(e) => setAdjustShopId(e.target.value)}
                  className="select-field"
                >
                  {advanceShops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} (Hiện tại: {formatMoney(s.currentDebt)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="input-label">Số tiền điều chỉnh (Nhập số âm nếu tăng nợ, số dương nếu xóa nợ)</label>
                <input
                  type="number"
                  value={adjustAmount}
                  onChange={(e) => setAdjustAmount(e.target.value)}
                  placeholder="VD: -500000 hoặc 500000"
                  className="input-field"
                />
              </div>
              <div>
                <label className="input-label">Lý do / Ghi chú</label>
                <input
                  type="text"
                  value={adjustNote}
                  onChange={(e) => setAdjustNote(e.target.value)}
                  placeholder="VD: Khách chuyển khoản trả nợ ứng COD..."
                  className="input-field"
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
                <button type="button" onClick={() => setIsDebtAdjustModalOpen(false)} className="btn btn-secondary">
                  Hủy
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const amt = Number(adjustAmount);
                    if (!adjustShopId || !amt) return;
                    const res = await CodAdvanceService.adjustAdvanceDebtApi(adjustShopId, amt, adjustNote);
                    if (res.success) {
                      showToast('Đã cập nhật công nợ thành công!', 'success');
                      setIsDebtAdjustModalOpen(false);
                      await loadAllAdvanceData();
                    } else {
                      showToast(res.error || 'Lỗi điều chỉnh công nợ', 'error');
                    }
                  }}
                  className="btn btn-primary"
                >
                  Xác Nhận
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
