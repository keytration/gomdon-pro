import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  UploadCloud,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Search,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  PackageCheck,
  PackageX,
  Truck,
  Info,
  ChevronDown,
  ChevronUp,
  PieChart,
  BarChart3,
  AlertTriangle,
  ShieldAlert,
  Layers,
  Store,
} from 'lucide-react';
import { useToast, useConfirm } from './UIFeedback';
import { PaginationControl } from './PaginationControl';
import type { Shop, UserAccount } from '../types';
import type {
  OrderLifecycleItem,
  OrderTrackingConfig,
  OrderTrackingStats,
  OrderLifecycleStatus,
} from '../types/codAdvance';
import { CodAdvanceService } from '../services/codAdvanceService';

export const PROCESS_STATUS_MAP: Record<
  string,
  { label: string; shortLabel: string; color: string; bg: string; border: string; desc: string }
> = {
  unprocessed: {
    label: 'Chưa xử lý',
    shortLabel: 'Chưa xử lý',
    color: '#b91c1c',
    bg: '#fee2e2',
    border: '#fca5a5',
    desc: 'Mặc định khi hệ thống phát hiện đơn trễ hạn. Đơn cần phân công / kiểm tra.',
  },
  expediting: {
    label: 'Đang giục phát / Chờ bưu cục kiểm tra',
    shortLabel: 'Đang giục phát',
    color: '#b45309',
    bg: '#fef3c7',
    border: '#fcd34d',
    desc: 'Kế toán đã liên hệ J&T, đang theo dõi phản hồi hành trình từ bưu cục.',
  },
  claimed: {
    label: 'Đã gửi khiếu nại đòi đền bù',
    shortLabel: 'Đã khiếu nại NVC',
    color: '#1d4ed8',
    bg: '#dbeafe',
    border: '#93c5fd',
    desc: 'Đã xuất biên bản, gửi email/Zalo bưu cục J&T yêu cầu bồi hoàn.',
  },
  compensated: {
    label: 'Bưu cục đã đền bù tiền',
    shortLabel: 'Bưu cục đã đền bù',
    color: '#7e22ce',
    bg: '#f3e8ff',
    border: '#d8b4fe',
    desc: 'Bưu cục đã bồi thường tiền hàng hoặc cấn trừ COD xong.',
  },
  resolved: {
    label: 'Đã giải quyết xong',
    shortLabel: 'Đã giải quyết xong',
    color: '#15803d',
    bg: '#dcfce7',
    border: '#86efac',
    desc: 'Hoàn tất xử lý, đơn sẽ tự động thoát khỏi danh sách cảnh báo rủi ro.',
  },
};

export const getProcessStatusInfo = (status?: string) => {
  if (!status || status === 'unclaimed') return PROCESS_STATUS_MAP.unprocessed;
  return PROCESS_STATUS_MAP[status] || PROCESS_STATUS_MAP.unprocessed;
};

interface OrderLossTrackingTabProps {
  currentUser?: UserAccount;
  shops?: Shop[];
  activeCarrierId?: string | null;
  activeCarrierName?: string;
  onOpenSettings?: () => void;
}

export const OrderLossTrackingTab: React.FC<OrderLossTrackingTabProps> = ({
  currentUser: _currentUser,
  shops: _shops,
  activeCarrierId = 'jnt',
  activeCarrierName = 'J&T Express',
  onOpenSettings: _onOpenSettings,
}) => {
  const { showToast } = useToast();
  const { showConfirm } = useConfirm();

  const [orders, setOrders] = useState<OrderLifecycleItem[]>([]);
  const [config, setConfig] = useState<OrderTrackingConfig>({
    riskDaysThreshold: 13,
    lostDaysThreshold: 20,
  });
  const [stats, setStats] = useState<OrderTrackingStats>({
    totalTracked: 0,
    inTransitCount: 0,
    riskDelayedCount: 0,
    suspectedLostCount: 0,
    deliveredCount: 0,
    returnedCount: 0,
    partialReturnedCount: 0,
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [copiedWb, setCopiedWb] = useState<string | null>(null);

  // 2 Sub-Tabs: 1. Nạp File & Tổng Quan vs 2. Danh Sách Đơn Hàng
  const [activeViewTab, setActiveViewTab] = useState<'overview' | 'orders'>('overview');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedShopFilter, setSelectedShopFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | OrderLifecycleStatus | 'partial_return' | 'safe'>('ALL');

  // Collapsible Upload Dropzones state (Mặc định thu gọn thành 1 nút theo yêu cầu người dùng)
  const [isUploadPanelOpen, setIsUploadPanelOpen] = useState<boolean>(false);

  // Processing status & modal states (5 trạng thái xử lý đơn rủi ro)
  const [processingModalOrder, setProcessingModalOrder] = useState<OrderLifecycleItem | null>(null);
  const [selectedProcessStatus, setSelectedProcessStatus] = useState<'unprocessed' | 'expediting' | 'claimed' | 'compensated' | 'resolved'>('unprocessed');
  const [processNoteInput, setProcessNoteInput] = useState<string>('');
  const [isSavingProcess, setIsSavingProcess] = useState<boolean>(false);

  // Bulk selection states
  const [selectedWbs, setSelectedWbs] = useState<string[]>([]);
  const [isBulkModalOpen, setIsBulkModalOpen] = useState<boolean>(false);

  // Non-intrusive reminder state
  const [isReminderDismissed, setIsReminderDismissed] = useState<boolean>(false);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedShopFilter, statusFilter]);

  // Hidden file inputs
  const sentFileInputRef = useRef<HTMLInputElement>(null);
  const deliveredFileInputRef = useRef<HTMLInputElement>(null);
  const returnedFileInputRef = useRef<HTMLInputElement>(null);

  // Active hover popover state
  const [activePopoverWb, setActivePopoverWb] = useState<string | null>(null);
  const popoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // ──────────────────────────────────────────────────────────────────────────
  // LOAD DATA & CONFIG
  // ──────────────────────────────────────────────────────────────────────────
  const loadData = async () => {
    setIsLoading(true);
    try {
      const res = await CodAdvanceService.fetchOrderLifecycleApi();
      setOrders(res.orders || []);
      setConfig(res.config || { riskDaysThreshold: 13, lostDaysThreshold: 20 });
      setStats(res.stats || {
        totalTracked: 0,
        inTransitCount: 0,
        riskDelayedCount: 0,
        suspectedLostCount: 0,
        deliveredCount: 0,
        returnedCount: 0,
        partialReturnedCount: 0,
      });
    } catch (err: any) {
      showToast('Không thể tải dữ liệu kiểm soát đơn hàng', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // FILE UPLOAD HANDLERS
  // ──────────────────────────────────────────────────────────────────────────
  const handleFileUpload = async (type: 'sent' | 'delivered' | 'returned', file: File) => {
    setIsUploading(true);
    try {
      showToast(`Đang đọc và phân tích file ${type === 'sent' ? 'đơn gửi mới' : type === 'delivered' ? 'giao thành công' : 'đơn hoàn'}...`, 'info');
      const parsedOrders = await CodAdvanceService.parseLifecycleExcelFile(file);
      if (parsedOrders.length === 0) {
        showToast('Không tìm thấy dòng vận đơn hợp lệ nào trong file Excel.', 'warning');
        return;
      }

      const res = await CodAdvanceService.syncOrderLifecycleApi(type, parsedOrders, activeCarrierId || 'jnt');
      if (res.success) {
        showToast(res.message || 'Đồng bộ dữ liệu thành công!', 'success');
        if (res.orders) setOrders(res.orders);
        if (res.stats) setStats(res.stats);
      } else {
        showToast(res.error || 'Đồng bộ thất bại', 'error');
      }
    } catch (err: any) {
      showToast(`Lỗi khi xử lý file: ${err?.message || 'Không thể đọc file Excel'}`, 'error');
    } finally {
      setIsUploading(false);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // EXPORT CLAIM REPORT (.XLSX)
  // ──────────────────────────────────────────────────────────────────────────
  const handleExportClaimReport = async () => {
    const targetOrders = orders.filter(
      (o) => o.status === 'suspected_lost' || o.status === 'risk_delayed'
    );
    if (targetOrders.length === 0) {
      showToast('Hiện không có đơn nào trong diện rủi ro hoặc nghi ngờ thất lạc để xuất biên bản khiếu nại.', 'info');
      return;
    }
    try {
      await CodAdvanceService.exportClaimReportExcel(
        targetOrders,
        `Bien_Ban_Khieu_Nai_JnT_${new Date().toISOString().slice(0, 10)}.xlsx`
      );
      showToast(`Đã xuất biên bản khiếu nại cho ${targetOrders.length} đơn thành công!`, 'success');
    } catch (err: any) {
      showToast('Lỗi khi xuất file khiếu nại Excel', 'error');
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // PROCESSING STATUS (5 TRẠNG THÁI XỬ LÝ ĐƠN RỦI RO / THẤT LẠC)
  // ──────────────────────────────────────────────────────────────────────────
  const unprocessedRiskCount = useMemo(() => {
    return orders.filter(
      (o) =>
        (o.status === 'suspected_lost' || o.status === 'risk_delayed') &&
        (!o.claimStatus || o.claimStatus === 'unprocessed' || (o.claimStatus as string) === 'unclaimed')
    ).length;
  }, [orders]);

  const openProcessModal = (order: OrderLifecycleItem) => {
    setProcessingModalOrder(order);
    const cur = (!order.claimStatus || (order.claimStatus as string) === 'unclaimed') ? 'unprocessed' : order.claimStatus;
    setSelectedProcessStatus(cur as any);
    setProcessNoteInput(order.claimNote || '');
  };

  const openBulkProcessModal = () => {
    if (selectedWbs.length === 0) return;
    setIsBulkModalOpen(true);
    setSelectedProcessStatus('expediting');
    setProcessNoteInput('');
  };

  const handleSaveProcess = async () => {
    setIsSavingProcess(true);
    try {
      const targetWbs = isBulkModalOpen ? selectedWbs : processingModalOrder ? [processingModalOrder.waybill] : [];
      if (targetWbs.length === 0) return;

      const ok = await CodAdvanceService.updateOrderClaimStatusApi(
        targetWbs,
        selectedProcessStatus,
        processNoteInput.trim() || undefined
      );
      if (ok) {
        showToast(
          `Đã cập nhật tiến độ (${PROCESS_STATUS_MAP[selectedProcessStatus].shortLabel}) cho ${targetWbs.length} đơn!`,
          'success'
        );
        setProcessingModalOrder(null);
        setIsBulkModalOpen(false);
        setSelectedWbs([]);
        await loadData();
      } else {
        showToast('Không thể cập nhật tiến độ xử lý. Vui lòng thử lại.', 'error');
      }
    } catch (err: any) {
      showToast(`Lỗi: ${err?.message || 'Không thể lưu'}`, 'error');
    } finally {
      setIsSavingProcess(false);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // CLEAR TRACKING LIST
  // ──────────────────────────────────────────────────────────────────────────
  const handleClearAll = async () => {
    const ok = await showConfirm({
      title: 'Xóa Danh Sách Theo Dõi Toàn Trình Đơn Hàng',
      message: 'Hành động này sẽ xóa toàn bộ danh sách đơn đang theo dõi hiện tại trên hệ thống. Bạn có chắc chắn muốn xóa không?',
      warning: true,
    });
    if (!ok) return;

    const success = await CodAdvanceService.clearOrderLifecycleApi(undefined, true);
    if (success) {
      setOrders([]);
      setStats({
        totalTracked: 0,
        inTransitCount: 0,
        riskDelayedCount: 0,
        suspectedLostCount: 0,
        deliveredCount: 0,
        returnedCount: 0,
        partialReturnedCount: 0,
      });
      showToast('Đã dọn sạch danh sách theo dõi thành công.', 'info');
    }
  };

  // Copy waybill helper
  const handleCopy = (wb: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(wb);
    setCopiedWb(wb);
    showToast(`Đã sao chép: ${wb}`, 'info');
    setTimeout(() => setCopiedWb(null), 1500);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // FILTERED LIST
  // ──────────────────────────────────────────────────────────────────────────
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      // 1. Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchWb = o.waybill.toLowerCase().includes(q) || (o.originalWaybill && o.originalWaybill.toLowerCase().includes(q));
        const matchShop = o.shopName?.toLowerCase().includes(q) || o.shopPhone?.includes(q);
        const matchRecv = o.receiverName?.toLowerCase().includes(q) || o.receiverPhone?.includes(q) || o.receiverAddress?.toLowerCase().includes(q);
        if (!matchWb && !matchShop && !matchRecv) return false;
      }

      // 2. Shop Filter
      if (selectedShopFilter !== 'ALL') {
        if (o.shopName !== selectedShopFilter && o.shopId !== selectedShopFilter) return false;
      }

      // 3. Status Filter
      if (statusFilter === 'partial_return') {
        if (!o.isPartialReturn) return false;
      } else if (statusFilter === 'safe') {
        if (o.status !== 'delivered' && o.status !== 'returned' && o.status !== 'partial_returned') return false;
      } else if (statusFilter !== 'ALL') {
        if (o.status !== statusFilter) return false;
      }

      return true;
    });
  }, [orders, searchQuery, selectedShopFilter, statusFilter]);

  // Unique shop names for dropdown
  const uniqueShopNames = useMemo(() => {
    const set = new Set<string>();
    orders.forEach((o) => {
      if (o.shopName) set.add(o.shopName);
    });
    return Array.from(set).sort();
  }, [orders]);

  // Paginated orders for the table view
  const paginatedOrders = useMemo(() => {
    if (pageSize <= 0) return filteredOrders;
    const start = (currentPage - 1) * pageSize;
    return filteredOrders.slice(start, start + pageSize);
  }, [filteredOrders, currentPage, pageSize]);

  // Bulk selection helpers
  const isAllSelected = useMemo(() => {
    return paginatedOrders.length > 0 && paginatedOrders.every((o) => selectedWbs.includes(o.waybill));
  }, [paginatedOrders, selectedWbs]);

  const toggleSelectAll = () => {
    if (isAllSelected) {
      const pageWbs = new Set(paginatedOrders.map((o) => o.waybill));
      setSelectedWbs((prev) => prev.filter((w) => !pageWbs.has(w)));
    } else {
      const pageWbs = paginatedOrders.map((o) => o.waybill);
      setSelectedWbs((prev) => Array.from(new Set([...prev, ...pageWbs])));
    }
  };

  const toggleSelectOne = (wb: string) => {
    setSelectedWbs((prev) => (prev.includes(wb) ? prev.filter((w) => w !== wb) : [...prev, wb]));
  };

  // ──────────────────────────────────────────────────────────────────────────
  // DASHBOARD & ANALYTICS DATA (TRANG TỔNG HỢP BÁO CÁO CHUYÊN NGHIỆP)
  // ──────────────────────────────────────────────────────────────────────────
  const analyticsData = useMemo(() => {
    let totalCod = 0;
    let suspectedLostCod = 0;
    let riskDelayedCod = 0;
    let deliveredCod = 0;
    let returnedCod = 0;

    // Aging breakdown for tracked orders
    let daysUnder3 = 0;   // <= 3 ngày (Mới gửi)
    let days4To7 = 0;     // 4 - 7 ngày (Giao tiêu chuẩn)
    let days8To12 = 0;    // 8 - 12 ngày (Lưu kho)
    let days13To19 = 0;   // 13 - 19 ngày (Cảnh báo rủi ro)
    let daysOver20 = 0;   // >= 20 ngày (Nghi ngờ mất)

    const shopMap: Record<
      string,
      {
        shopName: string;
        shopPhone?: string;
        total: number;
        riskDelayed: number;
        suspectedLost: number;
        delivered: number;
        returned: number;
        riskCod: number;
        lostCod: number;
      }
    > = {};

    orders.forEach((o) => {
      const cod = Number(o.codAmount || 0);
      totalCod += cod;

      if (o.status === 'suspected_lost') {
        suspectedLostCod += cod;
      } else if (o.status === 'risk_delayed') {
        riskDelayedCod += cod;
      } else if (o.status === 'delivered') {
        deliveredCod += cod;
      } else if (o.status === 'returned' || o.status === 'partial_returned') {
        returnedCod += cod;
      }

      const days = Number(o.totalDays || 0);
      if (days <= 3) {
        daysUnder3++;
      } else if (days <= 7) {
        days4To7++;
      } else if (days <= 12) {
        days8To12++;
      } else if (days <= 19) {
        days13To19++;
      } else {
        daysOver20++;
      }

      const sName = o.shopName?.trim() || 'Chưa định danh Shop';
      if (!shopMap[sName]) {
        shopMap[sName] = {
          shopName: sName,
          shopPhone: o.shopPhone,
          total: 0,
          riskDelayed: 0,
          suspectedLost: 0,
          delivered: 0,
          returned: 0,
          riskCod: 0,
          lostCod: 0,
        };
      }
      shopMap[sName].total++;
      if (o.status === 'risk_delayed') {
        shopMap[sName].riskDelayed++;
        shopMap[sName].riskCod += cod;
      } else if (o.status === 'suspected_lost') {
        shopMap[sName].suspectedLost++;
        shopMap[sName].lostCod += cod;
      } else if (o.status === 'delivered') {
        shopMap[sName].delivered++;
      } else if (o.status === 'returned' || o.status === 'partial_returned') {
        shopMap[sName].returned++;
      }
    });

    const shopLeaderboard = Object.values(shopMap)
      .filter((s) => s.suspectedLost > 0 || s.riskDelayed > 0)
      .sort(
        (a, b) =>
          b.suspectedLost * 10 + b.riskDelayed - (a.suspectedLost * 10 + a.riskDelayed) ||
          b.lostCod + b.riskCod - (a.lostCod + a.riskCod)
      )
      .slice(0, 5);

    const safeCount = stats.deliveredCount + stats.returnedCount + stats.partialReturnedCount;
    const safeRate = stats.totalTracked > 0 ? ((safeCount / stats.totalTracked) * 100).toFixed(1) : '100.0';

    return {
      totalCod,
      suspectedLostCod,
      riskDelayedCod,
      deliveredCod,
      returnedCod,
      daysUnder3,
      days4To7,
      days8To12,
      days13To19,
      daysOver20,
      shopLeaderboard,
      safeCount,
      safeRate,
    };
  }, [orders, stats]);

  // Donut chart segments for Lifecycle Breakdown
  const donutSegments = useMemo(() => {
    const total = stats.totalTracked;
    if (total === 0) return [];

    const items = [
      { key: 'delivered', label: 'Giao thành công', count: stats.deliveredCount, color: '#10b981', filter: 'delivered' as const },
      { key: 'in_transit', label: 'Đang giao (<13 ngày)', count: stats.inTransitCount, color: '#4f46e5', filter: 'in_transit' as const },
      { key: 'returned', label: 'Đã hoàn về kho', count: stats.returnedCount, color: '#f59e0b', filter: 'returned' as const },
      { key: 'partial_returned', label: 'Hoàn 1 phần (-001)', count: stats.partialReturnedCount, color: '#8b5cf6', filter: 'partial_return' as const },
      { key: 'risk_delayed', label: 'Cảnh báo rủi ro (13-20 ngày)', count: stats.riskDelayedCount, color: '#ea580c', filter: 'risk_delayed' as const },
      { key: 'suspected_lost', label: 'Nghi ngờ thất lạc (>20 ngày)', count: stats.suspectedLostCount, color: '#ef4444', filter: 'suspected_lost' as const },
    ].filter((it) => it.count > 0);

    const r = 62;
    const C = 2 * Math.PI * r;
    let currentOffset = 0;

    return items.map((it) => {
      const pct = (it.count / total) * 100;
      const strokeDasharray = `${(it.count / total) * C} ${C}`;
      const strokeDashoffset = -currentOffset;
      currentOffset += (it.count / total) * C;
      return {
        ...it,
        pct: pct.toFixed(1),
        strokeDasharray,
        strokeDashoffset,
      };
    });
  }, [stats]);

  // SLA Aging Distribution Brackets
  const ageingBrackets = useMemo(() => {
    const total = stats.totalTracked || 1;
    const maxVal = Math.max(
      analyticsData.daysUnder3,
      analyticsData.days4To7,
      analyticsData.days8To12,
      analyticsData.days13To19,
      analyticsData.daysOver20,
      1
    );

    return [
      {
        range: '≤ 3 ngày',
        label: 'Mới gửi - Chặng đầu',
        count: analyticsData.daysUnder3,
        pct: ((analyticsData.daysUnder3 / total) * 100).toFixed(1),
        barWidth: Math.max((analyticsData.daysUnder3 / maxVal) * 100, analyticsData.daysUnder3 > 0 ? 5 : 0),
        color: '#3b82f6',
        gradient: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
        slaDesc: 'Đang vận chuyển liên tỉnh trong hạn tiêu chuẩn',
        filterStatus: 'in_transit' as const,
      },
      {
        range: '4 - 7 ngày',
        label: 'Phát hàng tiêu chuẩn J&T',
        count: analyticsData.days4To7,
        pct: ((analyticsData.days4To7 / total) * 100).toFixed(1),
        barWidth: Math.max((analyticsData.days4To7 / maxVal) * 100, analyticsData.days4To7 > 0 ? 5 : 0),
        color: '#06b6d4',
        gradient: 'linear-gradient(90deg, #06b6d4, #22d3ee)',
        slaDesc: 'Bưu cục phát tiến hành giao hàng (tối đa 3 lần)',
        filterStatus: 'in_transit' as const,
      },
      {
        range: '8 - 12 ngày',
        label: 'Chạm ngưỡng lưu kho 7 ngày',
        count: analyticsData.days8To12,
        pct: ((analyticsData.days8To12 / total) * 100).toFixed(1),
        barWidth: Math.max((analyticsData.days8To12 / maxVal) * 100, analyticsData.days8To12 > 0 ? 5 : 0),
        color: '#eab308',
        gradient: 'linear-gradient(90deg, #eab308, #facc15)',
        slaDesc: 'J&T lưu kho tối đa 7 ngày, cần giục phát hoặc duyệt hoàn',
        filterStatus: 'in_transit' as const,
      },
      {
        range: '13 - 19 ngày',
        label: '⚠️ Cảnh báo rủi ro toàn trình',
        count: analyticsData.days13To19,
        pct: ((analyticsData.days13To19 / total) * 100).toFixed(1),
        barWidth: Math.max((analyticsData.days13To19 / maxVal) * 100, analyticsData.days13To19 > 0 ? 5 : 0),
        color: '#f97316',
        gradient: 'linear-gradient(90deg, #f97316, #fb923c)',
        slaDesc: 'Vượt mốc 13 ngày (3d phát + 7d lưu + 3d hoàn), rủi ro mất cao',
        filterStatus: 'risk_delayed' as const,
      },
      {
        range: '≥ 20 ngày',
        label: '🚨 Nghi ngờ thất lạc / Mất đơn',
        count: analyticsData.daysOver20,
        pct: ((analyticsData.daysOver20 / total) * 100).toFixed(1),
        barWidth: Math.max((analyticsData.daysOver20 / maxVal) * 100, analyticsData.daysOver20 > 0 ? 5 : 0),
        color: '#ef4444',
        gradient: 'linear-gradient(90deg, #ef4444, #f87171)',
        slaDesc: 'Quá 20 ngày chưa giao/hoàn. Cần xuất biên bản đòi bồi thường',
        filterStatus: 'suspected_lost' as const,
      },
    ];
  }, [stats.totalTracked, analyticsData]);

  const formatVND = (num: number) => {
    return (num || 0).toLocaleString('vi-VN') + ' đ';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ────────────────────────────────────────────────────────────────────
          NAVIGATION SUB-TABS (1. NẠP FILE & TỔNG QUAN vs 2. DANH SÁCH ĐƠN HÀNG)
      ──────────────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '2px solid var(--border-color)',
        paddingBottom: 10,
        gap: 12,
        flexWrap: 'wrap'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => setActiveViewTab('overview')}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 800,
              cursor: 'pointer',
              border: 'none',
              background: activeViewTab === 'overview' ? 'var(--primary)' : 'var(--bg-panel)',
              color: activeViewTab === 'overview' ? '#ffffff' : 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: activeViewTab === 'overview' ? '0 2px 8px rgba(79, 70, 229, 0.25)' : 'none',
              transition: 'all 0.15s ease',
            }}
          >
            <UploadCloud size={16} />
            <span>1. Nạp File & Thống Kê</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveViewTab('orders')}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 800,
              cursor: 'pointer',
              border: 'none',
              background: activeViewTab === 'orders' ? 'var(--primary)' : 'var(--bg-panel)',
              color: activeViewTab === 'orders' ? '#ffffff' : 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: activeViewTab === 'orders' ? '0 2px 8px rgba(79, 70, 229, 0.25)' : 'none',
              transition: 'all 0.15s ease',
            }}
          >
            <FileSpreadsheet size={16} />
            <span>2. Danh Sách Đơn Hàng</span>
            <span
              style={{
                fontSize: 11,
                padding: '1px 7px',
                borderRadius: 999,
                background: activeViewTab === 'orders' ? 'rgba(255, 255, 255, 0.25)' : 'var(--border-color)',
                color: activeViewTab === 'orders' ? '#ffffff' : 'var(--text-main)',
                fontWeight: 800,
              }}
            >
              {orders.length}
            </span>
            {stats.suspectedLostCount > 0 && (
              <span
                style={{
                  fontSize: 10.5,
                  padding: '2px 7px',
                  borderRadius: 999,
                  background: 'var(--danger)',
                  color: '#ffffff',
                  fontWeight: 800,
                  animation: 'pulse 2s infinite',
                }}
                title={`${stats.suspectedLostCount} đơn nghi ngờ mất`}
              >
                🚨 {stats.suspectedLostCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SUB-TAB 1: NẠP FILE & TỔNG QUAN BÁO CÁO CHUYÊN NGHIỆP
      ══════════════════════════════════════════════════════════════════════ */}
      {activeViewTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Hidden file inputs */}
          <input
            type="file"
            ref={sentFileInputRef}
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileUpload('sent', f);
              e.target.value = '';
            }}
          />
          <input
            type="file"
            ref={deliveredFileInputRef}
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileUpload('delivered', f);
              e.target.value = '';
            }}
          />
          <input
            type="file"
            ref={returnedFileInputRef}
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileUpload('returned', f);
              e.target.value = '';
            }}
          />

          {/* 5 KPI SUMMARY CARDS (CLICKABLE ĐỂ CHUYỂN TAB 2 VỚI BỘ LỌC) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <div
              onClick={() => {
                setStatusFilter('ALL');
                setActiveViewTab('orders');
              }}
              className="glass-panel"
              style={{
                padding: '14px 16px',
                borderRadius: 10,
                borderLeft: '4px solid #64748b',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
              title="Nhấn để xem toàn bộ danh sách đơn hàng"
            >
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>TỔNG ĐƠN ĐANG THEO DÕI</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-main)', marginTop: 4 }}>
                {stats.totalTracked.toLocaleString('vi-VN')}
              </div>
            </div>

            <div
              onClick={() => {
                setStatusFilter('in_transit');
                setActiveViewTab('orders');
              }}
              className="glass-panel"
              style={{
                padding: '14px 16px',
                borderRadius: 10,
                borderLeft: '4px solid var(--primary)',
                background: 'rgba(79, 70, 229, 0.03)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(79, 70, 229, 0.12)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
              title="Nhấn để lọc các đơn Đang giao"
            >
              <div style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 700 }}>ĐANG GIAO (&lt;{config.riskDaysThreshold} ngày)</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: 'var(--primary)', marginTop: 4 }}>
                {stats.inTransitCount.toLocaleString('vi-VN')}
              </div>
            </div>

            <div
              onClick={() => {
                setStatusFilter('risk_delayed');
                setActiveViewTab('orders');
              }}
              className="glass-panel"
              style={{
                padding: '14px 16px',
                borderRadius: 10,
                borderLeft: '4px solid #f59e0b',
                background: 'rgba(245, 158, 11, 0.03)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(245, 158, 11, 0.12)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
              title="Nhấn để lọc các đơn Cảnh báo rủi ro"
            >
              <div style={{ fontSize: 11, color: '#d97706', fontWeight: 700 }}>⚠️ CẢNH BÁO RỦI RO ({config.riskDaysThreshold}-{config.lostDaysThreshold} ngày)</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: '#d97706', marginTop: 4 }}>
                {stats.riskDelayedCount.toLocaleString('vi-VN')}
              </div>
            </div>

            <div
              onClick={() => {
                setStatusFilter('suspected_lost');
                setActiveViewTab('orders');
              }}
              className="glass-panel"
              style={{
                padding: '14px 16px',
                borderRadius: 10,
                borderLeft: '4px solid var(--danger)',
                background: 'rgba(239, 68, 68, 0.04)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(239, 68, 68, 0.12)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
              title="Nhấn để lọc các đơn Nghi ngờ thất lạc"
            >
              <div style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 700 }}>🚨 NGHI NGỜ THẤT LẠC (&gt;{config.lostDaysThreshold} ngày)</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: 'var(--danger)', marginTop: 4 }}>
                {stats.suspectedLostCount.toLocaleString('vi-VN')}
              </div>
            </div>

            <div
              onClick={() => {
                setStatusFilter('safe');
                setActiveViewTab('orders');
              }}
              className="glass-panel"
              style={{
                padding: '14px 16px',
                borderRadius: 10,
                borderLeft: '4px solid var(--success)',
                background: 'rgba(16, 185, 129, 0.03)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.12)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
              title="Nhấn để xem các đơn Đã giao / Đã hoàn"
            >
              <div style={{ fontSize: 11, color: 'var(--success)', fontWeight: 700 }}>✅ ĐÃ GIAO / ĐÃ HOÀN</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: 'var(--success)', marginTop: 4 }}>
                {(stats.deliveredCount + stats.returnedCount + stats.partialReturnedCount).toLocaleString('vi-VN')}
              </div>
            </div>
          </div>

          {/* ══════════════════════════════════════════════════════════════════
              BÁO CÁO TÀI CHÍNH & RỦI RO COD (EXECUTIVE FINANCIAL OVERVIEW)
          ══════════════════════════════════════════════════════════════════ */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {/* Card 1: COD Thất lạc - Nền màu nhẹ đậm ở trong mờ dần ra ngoài viền */}
            <div
              style={{
                padding: '16px 18px',
                borderRadius: 14,
                border: '1px solid rgba(239, 68, 68, 0.12)',
                background: 'radial-gradient(ellipse at 50% 50%, rgba(239, 68, 68, 0.14) 0%, rgba(239, 68, 68, 0.06) 55%, rgba(239, 68, 68, 0.005) 90%, transparent 100%)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 8,
                transition: 'all 0.25s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'radial-gradient(ellipse at 50% 50%, rgba(239, 68, 68, 0.20) 0%, rgba(239, 68, 68, 0.08) 60%, transparent 100%)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'radial-gradient(ellipse at 50% 50%, rgba(239, 68, 68, 0.14) 0%, rgba(239, 68, 68, 0.06) 55%, rgba(239, 68, 68, 0.005) 90%, transparent 100%)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <ShieldAlert size={17} /> COD NGUY CƠ THẤT LẠC
                </span>
              </div>
              <div className="mono" style={{ fontSize: 24, fontWeight: 900, color: 'var(--danger)', margin: '4px 0' }}>
                {formatVND(analyticsData.suspectedLostCod)}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                {stats.suspectedLostCount > 0 ? (
                  <span>⚠️ Gồm <strong>{stats.suspectedLostCount} đơn</strong> quá {config.lostDaysThreshold} ngày chưa phát</span>
                ) : (
                  <span>✅ Hiện tại không phát sinh đơn thất lạc</span>
                )}
              </div>
            </div>

            {/* Card 2: COD Cảnh báo trễ - Nền màu nhẹ đậm ở trong mờ dần ra ngoài viền */}
            <div
              style={{
                padding: '16px 18px',
                borderRadius: 14,
                border: '1px solid rgba(245, 158, 11, 0.14)',
                background: 'radial-gradient(ellipse at 50% 50%, rgba(245, 158, 11, 0.14) 0%, rgba(245, 158, 11, 0.06) 55%, rgba(245, 158, 11, 0.005) 90%, transparent 100%)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 8,
                transition: 'all 0.25s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'radial-gradient(ellipse at 50% 50%, rgba(245, 158, 11, 0.20) 0%, rgba(245, 158, 11, 0.08) 60%, transparent 100%)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'radial-gradient(ellipse at 50% 50%, rgba(245, 158, 11, 0.14) 0%, rgba(245, 158, 11, 0.06) 55%, rgba(245, 158, 11, 0.005) 90%, transparent 100%)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#d97706', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <AlertTriangle size={17} /> COD LƯU KHO RỦI RO
                </span>
              </div>
              <div className="mono" style={{ fontSize: 24, fontWeight: 900, color: '#d97706', margin: '4px 0' }}>
                {formatVND(analyticsData.riskDelayedCod)}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                <span>Có <strong>{stats.riskDelayedCount} đơn</strong> lưu kho {config.riskDaysThreshold}-{config.lostDaysThreshold} ngày</span>
              </div>
            </div>

            {/* Card 3: COD Đã ký - Nền màu nhẹ đậm ở trong mờ dần ra ngoài viền */}
            <div
              style={{
                padding: '16px 18px',
                borderRadius: 14,
                border: '1px solid rgba(16, 185, 129, 0.14)',
                background: 'radial-gradient(ellipse at 50% 50%, rgba(16, 185, 129, 0.14) 0%, rgba(16, 185, 129, 0.06) 55%, rgba(16, 185, 129, 0.005) 90%, transparent 100%)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 8,
                transition: 'all 0.25s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'radial-gradient(ellipse at 50% 50%, rgba(16, 185, 129, 0.20) 0%, rgba(16, 185, 129, 0.08) 60%, transparent 100%)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'radial-gradient(ellipse at 50% 50%, rgba(16, 185, 129, 0.14) 0%, rgba(16, 185, 129, 0.06) 55%, rgba(16, 185, 129, 0.005) 90%, transparent 100%)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <CheckCircle2 size={17} /> COD ĐÃ KÝ
                </span>
              </div>
              <div className="mono" style={{ fontSize: 24, fontWeight: 900, color: 'var(--success)', margin: '4px 0' }}>
                {formatVND(analyticsData.deliveredCod)}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                <span>Đã phát thành công <strong>{stats.deliveredCount.toLocaleString('vi-VN')} đơn</strong></span>
              </div>
            </div>

            {/* Card 4: Nút Mở nạp file */}
            <button
              type="button"
              onClick={() => setIsUploadPanelOpen((prev) => !prev)}
              style={{
                padding: '16px 18px',
                borderRadius: 14,
                border: isUploadPanelOpen ? '1px solid rgba(79, 70, 229, 0.35)' : '1px solid rgba(79, 70, 229, 0.14)',
                background: isUploadPanelOpen
                  ? 'radial-gradient(ellipse at 50% 50%, rgba(79, 70, 229, 0.18) 0%, rgba(79, 70, 229, 0.08) 60%, transparent 100%)'
                  : 'radial-gradient(ellipse at 50% 50%, rgba(79, 70, 229, 0.10) 0%, rgba(79, 70, 229, 0.04) 60%, transparent 100%)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                color: 'var(--primary)',
                transition: 'all 0.25s ease',
                minHeight: 90,
                width: '100%',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'radial-gradient(ellipse at 50% 50%, rgba(79, 70, 229, 0.20) 0%, rgba(79, 70, 229, 0.08) 60%, transparent 100%)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isUploadPanelOpen
                  ? 'radial-gradient(ellipse at 50% 50%, rgba(79, 70, 229, 0.18) 0%, rgba(79, 70, 229, 0.08) 60%, transparent 100%)'
                  : 'radial-gradient(ellipse at 50% 50%, rgba(79, 70, 229, 0.10) 0%, rgba(79, 70, 229, 0.04) 60%, transparent 100%)';
              }}
            >
              <UploadCloud size={20} />
              <span style={{ fontSize: 14, fontWeight: 800 }}>
                {isUploadPanelOpen ? 'Đóng nạp file' : 'Mở nạp file'}
              </span>
              {isUploadPanelOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>

          {/* KHUNG NẠP FILE MỞ RA KHI BẤM NÚT "MỞ NẠP FILE" */}
          {isUploadPanelOpen && (
            <div
              className="glass-panel"
              style={{
                padding: 16,
                borderRadius: 14,
                border: '1.5px dashed var(--primary)',
                background: 'linear-gradient(135deg, rgba(79, 70, 229, 0.03) 0%, rgba(59, 130, 246, 0.01) 100%)',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                {/* DROPZONE 1: FILE ĐƠN GỬI MỚI */}
                <div
                  onClick={() => sentFileInputRef.current?.click()}
                  className="glass-panel"
                  style={{
                    padding: 16,
                    borderRadius: 12,
                    border: '2px dashed rgba(79, 70, 229, 0.4)',
                    background: 'rgba(79, 70, 229, 0.03)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                  title="Nhấn để tải lên File Excel Đơn Đi Mới"
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Truck size={15} /> 1. FILE ĐƠN GỬI MỚI (ĐƠN ĐI)
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(79, 70, 229, 0.12)', color: 'var(--primary)' }}>
                      Khởi tạo toàn trình
                    </span>
                  </div>
                  <div style={{ textAlign: 'center', padding: '10px 0' }}>
                    <UploadCloud size={28} color="var(--primary)" style={{ margin: '0 auto 6px' }} />
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-main)' }}>
                      {isUploading ? 'Đang phân tích file Excel...' : 'Kéo thả hoặc Bấm nạp File Đơn Đi (.xlsx)'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Ghi nhận mã vận đơn, ngày gửi, người nhận, sđt</div>
                  </div>
                  <div style={{ borderTop: '1px solid rgba(79, 70, 229, 0.15)', paddingTop: 8, fontSize: 11, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Đang theo dõi: <strong style={{ color: 'var(--primary)' }}>{stats.totalTracked.toLocaleString('vi-VN')} đơn</strong></span>
                    <span>Trạng thái: <strong>Đang giao</strong></span>
                  </div>
                </div>

                {/* DROPZONE 2: FILE GIAO THÀNH CÔNG */}
                <div
                  onClick={() => deliveredFileInputRef.current?.click()}
                  className="glass-panel"
                  style={{
                    padding: 16,
                    borderRadius: 12,
                    border: '2px dashed rgba(16, 185, 129, 0.4)',
                    background: 'rgba(16, 185, 129, 0.03)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                  title="Nhấn để tải lên File Excel Đơn Giao Thành Công"
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <PackageCheck size={15} /> 2. FILE GIAO THÀNH CÔNG
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(16, 185, 129, 0.12)', color: 'var(--success)' }}>
                      Đóng an toàn
                    </span>
                  </div>
                  <div style={{ textAlign: 'center', padding: '10px 0' }}>
                    <CheckCircle2 size={28} color="var(--success)" style={{ margin: '0 auto 6px' }} />
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-main)' }}>Kéo thả File Giao Thành Công (.xlsx)</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Gạch mã đơn đã phát thành công, thoát cảnh báo</div>
                  </div>
                  <div style={{ borderTop: '1px solid rgba(16, 185, 129, 0.15)', paddingTop: 8, fontSize: 11, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Đã giao thành công: <strong style={{ color: 'var(--success)' }}>{stats.deliveredCount.toLocaleString('vi-VN')} đơn</strong></span>
                    <span>Khớp tự động</span>
                  </div>
                </div>

                {/* DROPZONE 3: FILE ĐƠN HOÀN & HOÀN 1 PHẦN */}
                <div
                  onClick={() => returnedFileInputRef.current?.click()}
                  className="glass-panel"
                  style={{
                    padding: 16,
                    borderRadius: 12,
                    border: '2px dashed rgba(245, 158, 11, 0.4)',
                    background: 'rgba(245, 158, 11, 0.03)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                  title="Nhấn để tải lên File Excel Đơn Hoàn / Ký 1 Phần"
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#d97706', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <PackageX size={15} /> 3. FILE ĐƠN HOÀN & HOÀN 1 PHẦN
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(245, 158, 11, 0.12)', color: '#d97706' }}>
                      Đã về kho
                    </span>
                  </div>
                  <div style={{ textAlign: 'center', padding: '10px 0' }}>
                    <RefreshCw size={28} color="#d97706" style={{ margin: '0 auto 6px' }} />
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-main)' }}>Kéo thả File Hoàn / Ký 1 phần (.xlsx)</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Tự động cắt đuôi <code style={{ color: '#d97706', fontWeight: 700 }}>-001</code> để khớp về mã gốc</div>
                  </div>
                  <div style={{ borderTop: '1px solid rgba(245, 158, 11, 0.15)', paddingTop: 8, fontSize: 11, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Đã về kho: <strong style={{ color: '#d97706' }}>{stats.returnedCount.toLocaleString('vi-VN')}</strong></span>
                    <span>Hoàn 1 phần (-001): <strong style={{ color: 'var(--primary)' }}>{stats.partialReturnedCount.toLocaleString('vi-VN')}</strong></span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              HAI BIỂU ĐỒ TRỰC QUAN CHUYÊN NGHIỆP (DONUT TOÀN TRÌNH & BAR SLA TOÀN TRÌNH)
          ══════════════════════════════════════════════════════════════════ */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
            {/* 1. BIỂU ĐỒ DONUT: PHÂN BỔ TRẠNG THÁI TOÀN TRÌNH */}
            <div
              className="glass-panel"
              style={{
                padding: '18px 20px',
                borderRadius: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                background: 'var(--bg-card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 7 }}>
                    <PieChart size={17} color="var(--primary)" />
                    Phân Bổ Trạng Thái Toàn Trình Đơn Hàng
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    Tỷ lệ hoàn thành, lưu kho và nguy cơ thất lạc của toàn bộ đơn
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {activeCarrierName}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', gap: 16, flexWrap: 'wrap', minHeight: 180 }}>
                {/* SVG DONUT CHART */}
                <div style={{ position: 'relative', width: 170, height: 170, flexShrink: 0 }}>
                  <svg viewBox="0 0 180 180" style={{ transform: 'rotate(-90deg)', width: '100%', height: '100%' }}>
                    {/* Background ring */}
                    <circle
                      cx="90"
                      cy="90"
                      r="62"
                      fill="transparent"
                      stroke="rgba(0,0,0,0.06)"
                      strokeWidth="20"
                    />
                    {/* Segment rings */}
                    {donutSegments.map((seg) => (
                      <circle
                        key={seg.key}
                        cx="90"
                        cy="90"
                        r="62"
                        fill="transparent"
                        stroke={seg.color}
                        strokeWidth="20"
                        strokeDasharray={seg.strokeDasharray}
                        strokeDashoffset={seg.strokeDashoffset}
                        style={{
                          transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease',
                          cursor: 'pointer',
                        }}
                        onClick={() => {
                          setStatusFilter(seg.filter);
                          setActiveViewTab('orders');
                        }}
                      />
                    ))}
                  </svg>

                  {/* Center Text */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                    }}
                  >
                    <span className="mono" style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-main)', lineHeight: 1 }}>
                      {stats.totalTracked.toLocaleString('vi-VN')}
                    </span>
                    <span style={{ fontSize: 9.5, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: 0.5, marginTop: 3 }}>
                      TỔNG ĐƠN
                    </span>
                  </div>
                </div>

                {/* LEGEND CHI TIẾT CÓ TƯƠNG TÁC LỌC */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 170 }}>
                  {[
                    { label: 'Giao thành công', count: stats.deliveredCount, color: '#10b981', filter: 'delivered' as const },
                    { label: 'Đang luân chuyển', count: stats.inTransitCount, color: '#4f46e5', filter: 'in_transit' as const },
                    { label: 'Đã hoàn về kho', count: stats.returnedCount, color: '#f59e0b', filter: 'returned' as const },
                    { label: 'Hoàn 1 phần (-001)', count: stats.partialReturnedCount, color: '#8b5cf6', filter: 'partial_return' as const },
                    { label: 'Cảnh báo rủi ro', count: stats.riskDelayedCount, color: '#ea580c', filter: 'risk_delayed' as const },
                    { label: 'Nghi ngờ thất lạc', count: stats.suspectedLostCount, color: '#ef4444', filter: 'suspected_lost' as const },
                  ].map((leg) => {
                    const pct = stats.totalTracked > 0 ? ((leg.count / stats.totalTracked) * 100).toFixed(1) : '0.0';
                    return (
                      <div
                        key={leg.label}
                        onClick={() => {
                          setStatusFilter(leg.filter);
                          setActiveViewTab('orders');
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '5px 8px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          background: 'rgba(0,0,0,0.02)',
                          transition: 'all 0.15s ease',
                          fontSize: 11,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(79, 70, 229, 0.08)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(0,0,0,0.02)';
                        }}
                        title={`Bấm để xem danh sách đơn ${leg.label}`}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: leg.color, flexShrink: 0 }} />
                          <span style={{ color: 'var(--text-main)', fontWeight: 600 }}>{leg.label}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <strong className="mono" style={{ color: leg.color, fontWeight: 800 }}>
                            {leg.count.toLocaleString('vi-VN')}
                          </strong>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({pct}%)</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 2. BIỂU ĐỒ BAR: PHÂN TÍCH TUỔI ĐƠN & TỒN LƯU KHO (SLA TOÀN TRÌNH) */}
            <div
              className="glass-panel"
              style={{
                padding: '18px 20px',
                borderRadius: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                background: 'var(--bg-card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 7 }}>
                    <BarChart3 size={17} color="var(--primary)" />
                    Phân Tích Toàn Trình & Tồn Đọng Đơn (SLA Toàn Trình)
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    Quy chuẩn J&T: 3 ngày gửi + tối đa 7 ngày lưu kho + 3 ngày chuyển hoàn
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: 'rgba(239, 68, 68, 0.1)',
                    color: 'var(--danger)',
                  }}
                >
                  Mất sau &gt;20 ngày
                </span>
              </div>

              {/* BẢNG THANH CỘT TIẾN ĐỘ THEO MỐC NGÀY */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {ageingBrackets.map((br) => (
                  <div
                    key={br.range}
                    onClick={() => {
                      setStatusFilter(br.filterStatus);
                      setActiveViewTab('orders');
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: 'rgba(0,0,0,0.02)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(79, 70, 229, 0.06)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0,0,0,0.02)';
                    }}
                    title={`Nhấp để lọc danh sách đơn ${br.label}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, fontSize: 11.5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span
                          className="mono"
                          style={{
                            fontWeight: 800,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: `${br.color}18`,
                            color: br.color,
                            fontSize: 11,
                          }}
                        >
                          {br.range}
                        </span>
                        <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>{br.label}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <strong className="mono" style={{ color: br.color, fontWeight: 800 }}>
                          {br.count.toLocaleString('vi-VN')} đơn
                        </strong>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({br.pct}%)</span>
                      </div>
                    </div>

                    {/* Progress Track */}
                    <div style={{ width: '100%', height: 7, borderRadius: 4, background: 'rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${br.barWidth}%`,
                          height: '100%',
                          borderRadius: 4,
                          background: br.gradient,
                          transition: 'width 0.5s ease',
                        }}
                      />
                    </div>

                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                      {br.slaDesc}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ══════════════════════════════════════════════════════════════════
              BẢNG XẾP HẠNG SHOP RỦI RO & INFOGRAPHIC QUY TRÌNH TOÀN TRÌNH J&T
          ══════════════════════════════════════════════════════════════════ */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
            {/* KHỐI 1: BẢNG XẾP HẠNG TOP SHOP CÓ ĐƠN RỦI RO / THẤT LẠC */}
            <div
              className="glass-panel"
              style={{
                padding: '18px 20px',
                borderRadius: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                background: 'var(--bg-card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Store size={17} color="var(--primary)" />
                    Top Shop Có Đơn Rủi Ro / Thất Lạc Cần Hỗ Trợ Gấp
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    Phát hiện sớm shop bị bưu cục giam hàng hoặc mất đơn để ưu tiên khiếu nại
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '2px 7px',
                    borderRadius: 6,
                    background: analyticsData.shopLeaderboard.length > 0 ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                    color: analyticsData.shopLeaderboard.length > 0 ? 'var(--danger)' : 'var(--success)',
                  }}
                >
                  {analyticsData.shopLeaderboard.length} Shop cần chú ý
                </span>
              </div>

              {analyticsData.shopLeaderboard.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)' }}>
                  <CheckCircle2 size={36} color="var(--success)" style={{ margin: '0 auto 8px' }} />
                  <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text-main)' }}>
                    Tất cả các Shop đều an toàn!
                  </div>
                  <div style={{ fontSize: 11.5, marginTop: 4 }}>
                    Hiện không có Shop nào phát sinh đơn hàng bị trễ hạn hoặc thất lạc tại J&T Express.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {analyticsData.shopLeaderboard.map((sh, idx) => (
                    <div
                      key={sh.shopName}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 10,
                        border: '1px solid var(--border-color)',
                        background: 'rgba(0,0,0,0.015)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 8,
                            background: idx === 0 ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-tertiary)',
                            color: idx === 0 ? 'var(--danger)' : 'var(--text-main)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 12,
                            fontWeight: 800,
                            flexShrink: 0,
                          }}
                        >
                          #{idx + 1}
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 12.5, color: 'var(--text-main)' }}>
                            {sh.shopName}
                          </div>
                          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>
                            Tổng gửi: <strong>{sh.total} đơn</strong> • COD nguy cơ: <strong style={{ color: 'var(--danger)' }}>{formatVND(sh.lostCod + sh.riskCod)}</strong>
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {sh.suspectedLost > 0 && (
                          <span
                            style={{
                              fontSize: 10.5,
                              padding: '2px 7px',
                              borderRadius: 4,
                              background: 'rgba(239, 68, 68, 0.12)',
                              color: 'var(--danger)',
                              fontWeight: 800,
                            }}
                          >
                            🚨 {sh.suspectedLost} mất
                          </span>
                        )}
                        {sh.riskDelayed > 0 && (
                          <span
                            style={{
                              fontSize: 10.5,
                              padding: '2px 7px',
                              borderRadius: 4,
                              background: 'rgba(245, 158, 11, 0.12)',
                              color: '#d97706',
                              fontWeight: 700,
                            }}
                          >
                            ⚠️ {sh.riskDelayed} trễ
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedShopFilter(sh.shopName);
                            setActiveViewTab('orders');
                          }}
                          className="btn btn-sm btn-secondary"
                          style={{
                            fontSize: 11,
                            padding: '3px 8px',
                            borderRadius: 6,
                            marginLeft: 4,
                          }}
                          title={`Xem chi tiết các đơn của ${sh.shopName}`}
                        >
                          <span>Lọc đơn →</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* KHỐI 2: INFOGRAPHIC QUY TRÌNH SLA TOÀN TRÌNH J&T EXPRESS */}
            <div
              className="glass-panel"
              style={{
                padding: '18px 20px',
                borderRadius: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                background: 'var(--bg-card)',
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Layers size={17} color="var(--primary)" />
                  Quy Trình Kiểm Soát Toàn Trình & Khiếu Nại Đơn Mất J&T
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  Cơ chế tự động phát hiện lệch hạn và đối chiếu mã hoàn -001
                </div>
              </div>

              {/* 4 BƯỚC QUY TRÌNH STEPPER */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Bước 1 */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: 'rgba(79, 70, 229, 0.12)',
                      color: 'var(--primary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  >
                    1
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-main)' }}>
                      🚚 Đơn Gửi Mới (Ngày 0 - 3)
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                      Nạp <strong>File Đơn Đi</strong> hàng ngày để ghi nhận mã vận đơn, số tiền COD và khởi động bộ đếm SLA ngày toàn trình.
                    </div>
                  </div>
                </div>

                {/* Bước 2 */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: 'rgba(6, 182, 212, 0.12)',
                      color: '#06b6d4',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  >
                    2
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-main)' }}>
                      📦 Giao Hàng & Lưu Kho Bưu Cục (Ngày 3 - 7)
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                      J&T quy định phát hàng tối đa 3 lần và <strong>lưu kho tối đa 7 ngày</strong>. Nếu khách hẹn giao lại quá 7 ngày, hệ thống sẽ đưa vào cảnh báo.
                    </div>
                  </div>
                </div>

                {/* Bước 3 */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: 'rgba(245, 158, 11, 0.12)',
                      color: '#d97706',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  >
                    3
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-main)' }}>
                      🔄 Đóng Thành Công Hoặc Hoàn Về Kho (Ngày 7 - 13)
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                      Nạp <strong>File Giao Thành Công</strong> (thoát cảnh báo) hoặc <strong>File Đơn Hoàn</strong> (thuật toán tự động cắt đuôi <code style={{ color: '#d97706', fontWeight: 700 }}>-001</code> / <code style={{ color: '#d97706', fontWeight: 700 }}>- 001</code> để khớp về mã gốc).
                    </div>
                  </div>
                </div>

                {/* Bước 4 */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: 'rgba(239, 68, 68, 0.15)',
                      color: 'var(--danger)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  >
                    4
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--danger)' }}>
                      🚨 Phát Hiện Đơn Mất & Xuất Hồ Sơ Bồi Thường (&gt;20 Ngày)
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                      Đơn quá <strong>{config.lostDaysThreshold} ngày</strong> chưa giao/hoàn sẽ tự động gắn cờ Thất lạc. Kế toán nhấn nút <strong>Xuất Biên Bản Khiếu Nại</strong> gửi bưu cục J&T đòi bồi hoàn 100% COD.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SUB-TAB 2: DANH SÁCH ĐƠN HÀNG & KHIẾU NẠI NVC (NHƯ ẢNH NGƯỜI DÙNG)
      ══════════════════════════════════════════════════════════════════════ */}
      {activeViewTab === 'orders' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* NON-INTRUSIVE REMINDER BANNER FOR UNPROCESSED RISK ORDERS */}
          {unprocessedRiskCount > 0 && !isReminderDismissed && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                background: 'linear-gradient(90deg, rgba(245, 158, 11, 0.08) 0%, rgba(239, 68, 68, 0.05) 100%)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    background: 'rgba(245, 158, 11, 0.15)',
                    color: '#d97706',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <AlertCircle size={16} />
                </div>
                <div>
                  <span style={{ fontWeight: 700, color: '#92400e' }}>Nhắc nhở xử lý đơn rủi ro: </span>
                  <span style={{ color: 'var(--text-main)' }}>
                    Hệ thống có <strong style={{ color: 'var(--danger)' }}>{unprocessedRiskCount} đơn hàng</strong> lưu kho hoặc nghi ngờ mất chưa được cập nhật tiến độ xử lý.
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setStatusFilter('risk_delayed')}
                  style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    padding: '4px 10px',
                    borderRadius: 6,
                    background: '#d97706',
                    color: '#ffffff',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  Lọc đơn cần xử lý
                </button>
                <button
                  type="button"
                  onClick={() => setIsReminderDismissed(true)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: 4,
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                  title="Đóng thông báo"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* BULK ACTION BAR */}
          {selectedWbs.length > 0 && (
            <div
              style={{
                padding: '8px 14px',
                borderRadius: 10,
                background: 'rgba(79, 70, 229, 0.08)',
                border: '1px solid rgba(79, 70, 229, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={16} color="var(--primary)" />
                <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>
                  Đã chọn <strong style={{ color: 'var(--primary)' }}>{selectedWbs.length}</strong> đơn hàng
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={openBulkProcessModal}
                  className="btn btn-sm btn-primary"
                  style={{ fontSize: 11.5, fontWeight: 700, padding: '5px 12px', borderRadius: 6 }}
                >
                  Cập nhật tiến độ hàng loạt ({selectedWbs.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedWbs([])}
                  className="btn btn-sm btn-secondary"
                  style={{ fontSize: 11.5, padding: '5px 10px', borderRadius: 6 }}
                >
                  Bỏ chọn
                </button>
              </div>
            </div>
          )}

          {/* TOOLBAR, FILTER & EXPORT ACTION */}
      <div
        className="glass-panel"
        style={{
          padding: '10px 14px',
          borderRadius: 12,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 280 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Tìm kiếm mã vận đơn, mã gốc (-001), người nhận, SĐT..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input-field"
              style={{
                padding: '6px 12px 6px 30px',
                fontSize: 12,
                height: 34,
                borderRadius: 8,
                boxSizing: 'border-box',
              }}
            />
          </div>

          <select
            value={selectedShopFilter}
            onChange={(e) => setSelectedShopFilter(e.target.value)}
            className="select-field"
            style={{
              padding: '4px 28px 4px 10px',
              fontSize: 12,
              height: 34,
              lineHeight: '24px',
              maxWidth: 220,
              borderRadius: 8,
              boxSizing: 'border-box',
            }}
          >
            <option value="ALL">Tất cả Shop ({uniqueShopNames.length})</option>
            {uniqueShopNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Status Quick Filter Buttons */}
          <div style={{ display: 'flex', background: 'var(--bg-panel)', padding: 3, borderRadius: 8, gap: 2 }}>
            <button
              type="button"
              onClick={() => setStatusFilter('ALL')}
              style={{
                border: 'none',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                background: statusFilter === 'ALL' ? 'var(--bg-card)' : 'transparent',
                color: statusFilter === 'ALL' ? 'var(--primary)' : 'var(--text-muted)',
                boxShadow: statusFilter === 'ALL' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              Tất cả ({orders.length})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('suspected_lost')}
              style={{
                border: 'none',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                background: statusFilter === 'suspected_lost' ? 'var(--bg-card)' : 'transparent',
                color: statusFilter === 'suspected_lost' ? 'var(--danger)' : 'var(--danger)',
                boxShadow: statusFilter === 'suspected_lost' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              🚨 Nghi ngờ mất ({stats.suspectedLostCount})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('risk_delayed')}
              style={{
                border: 'none',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                background: statusFilter === 'risk_delayed' ? 'var(--bg-card)' : 'transparent',
                color: statusFilter === 'risk_delayed' ? '#d97706' : '#d97706',
                boxShadow: statusFilter === 'risk_delayed' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              ⚠️ Rủi ro ({stats.riskDelayedCount})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('in_transit')}
              style={{
                border: 'none',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                background: statusFilter === 'in_transit' ? 'var(--bg-card)' : 'transparent',
                color: statusFilter === 'in_transit' ? 'var(--primary)' : 'var(--text-muted)',
                boxShadow: statusFilter === 'in_transit' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              Đang giao ({stats.inTransitCount})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('partial_return')}
              style={{
                border: 'none',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                background: statusFilter === 'partial_return' ? 'var(--bg-card)' : 'transparent',
                color: statusFilter === 'partial_return' ? 'var(--primary)' : 'var(--text-muted)',
                boxShadow: statusFilter === 'partial_return' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              Hoàn 1P (-001) ({stats.partialReturnedCount})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('safe')}
              style={{
                border: 'none',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                background: statusFilter === 'safe' ? 'var(--bg-card)' : 'transparent',
                color: statusFilter === 'safe' ? 'var(--success)' : 'var(--text-muted)',
                boxShadow: statusFilter === 'safe' ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              ✅ Đã giao/hoàn ({stats.deliveredCount + stats.returnedCount + stats.partialReturnedCount})
            </button>
          </div>

          {/* Action Export Claim */}
          <button
            type="button"
            onClick={handleExportClaimReport}
            className="btn btn-sm"
            style={{
              background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
              color: '#ffffff',
              border: 'none',
              borderRadius: 8,
              fontSize: 11.5,
              fontWeight: 800,
              padding: '6px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              boxShadow: '0 2px 6px rgba(239, 68, 68, 0.25)',
            }}
          >
            <FileSpreadsheet size={14} />
            <span>Xuất Biên Bản Khiếu Nại NVC (.xlsx)</span>
          </button>

          <button
            type="button"
            onClick={loadData}
            className="btn btn-sm btn-secondary"
            style={{ padding: '6px 10px', borderRadius: 8 }}
            title="Làm mới danh sách"
          >
            <RefreshCw size={13} className={isLoading ? 'spin' : ''} />
          </button>

          <button
            type="button"
            onClick={handleClearAll}
            className="btn btn-sm btn-secondary"
            style={{ padding: '6px 8px', borderRadius: 8, color: 'var(--text-muted)' }}
            title="Dọn sạch danh sách theo dõi"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────
          ORDERS TABLE WITH HOVER POPOVER PREVIEW
      ──────────────────────────────────────────────────────────────────── */}
      <div
        className="glass-panel"
        style={{
          borderRadius: 14,
          overflow: 'visible',
          border: '1.5px solid var(--border-color)',
        }}
      >
        <div style={{ overflowX: 'auto', maxHeight: 'min(620px, calc(100vh - 280px))', overflowY: 'auto' }}>
          <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-panel)' }}>
                <th style={{ width: 34, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={toggleSelectAll}
                    style={{ cursor: 'pointer', accentColor: 'var(--primary)' }}
                    title="Chọn tất cả trên trang"
                  />
                </th>
                <th style={{ width: 44, textAlign: 'center' }}>STT</th>
                <th>MÃ VẬN ĐƠN (RÊ CHUỘT XEM NHANH)</th>
                <th>LOẠI ĐƠN</th>
                <th>SHOP GỬI</th>
                <th>NGƯỜI NHẬN & ĐÍCH ĐẾN</th>
                <th>NGÀY GỬI</th>
                <th>TOÀN TRÌNH</th>
                <th>MỨC CẢNH BÁO</th>
                <th>TIẾN ĐỘ XỬ LÝ</th>
                <th style={{ textAlign: 'center' }}>THAO TÁC</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={11} style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--text-muted)' }}>
                    <AlertCircle size={32} style={{ margin: '0 auto 8px', opacity: 0.5 }} />
                    <div style={{ fontWeight: 700, fontSize: 13 }}>Không có đơn hàng nào khớp với điều kiện lọc</div>
                    <div style={{ fontSize: 11, marginTop: 4 }}>
                      Hãy kéo thả File Đơn Gửi Mới vào ô 1 bên trên để bắt đầu theo dõi hành trình!
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedOrders.map((order, idx) => {
                  const isLost = order.status === 'suspected_lost';
                  const isRisk = order.status === 'risk_delayed';
                  const isDelivered = order.status === 'delivered';
                  const isReturned = order.status === 'returned';
                  const isPartial = order.status === 'partial_returned' || order.isPartialReturn;

                  const rowBg = isLost
                    ? 'rgba(239, 68, 68, 0.07)'
                    : isRisk
                    ? 'rgba(245, 158, 11, 0.06)'
                    : isPartial
                    ? 'rgba(168, 85, 247, 0.05)'
                    : isDelivered
                    ? 'rgba(16, 185, 129, 0.03)'
                    : 'transparent';

                  return (
                    <tr
                      key={order.id || order.waybill}
                      style={{ background: rowBg, transition: 'background 0.15s ease' }}
                    >
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={selectedWbs.includes(order.waybill)}
                          onChange={() => toggleSelectOne(order.waybill)}
                          style={{ cursor: 'pointer', accentColor: 'var(--primary)' }}
                        />
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>
                        {(currentPage - 1) * (pageSize > 0 ? pageSize : 0) + idx + 1}
                      </td>

                      {/* WAYBILL WITH INTERACTIVE HOVER POPOVER */}
                      <td style={{ position: 'relative' }}>
                        <div
                          onMouseEnter={() => {
                            if (popoverTimeoutRef.current) clearTimeout(popoverTimeoutRef.current);
                            setActivePopoverWb(order.waybill);
                          }}
                          onMouseLeave={() => {
                            popoverTimeoutRef.current = setTimeout(() => {
                              setActivePopoverWb(null);
                            }, 200);
                          }}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'help' }}
                        >
                          <strong
                            className="mono"
                            style={{
                              color: isLost
                                ? 'var(--danger)'
                                : isRisk
                                ? '#d97706'
                                : isPartial
                                ? '#9333ea'
                                : 'var(--primary)',
                              borderBottom: '1px dashed currentColor',
                            }}
                          >
                            {order.waybill}
                          </strong>

                          <Info size={12} color="var(--text-muted)" style={{ opacity: 0.7 }} />

                          {/* 🌟 POPOVER BOX */}
                          {activePopoverWb === order.waybill && (
                            <div
                              style={{
                                position: 'absolute',
                                left: '100%',
                                top: '50%',
                                transform: 'translateY(-50%)',
                                marginLeft: 12,
                                width: 330,
                                zIndex: 9999,
                                background: '#ffffff',
                                border: '1.5px solid #cbd5e1',
                                borderRadius: 12,
                                padding: 14,
                                boxShadow: '0 12px 30px rgba(0, 0, 0, 0.18)',
                                fontSize: 11.5,
                                color: '#1e293b',
                                lineHeight: 1.5,
                                pointerEvents: 'auto',
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: 6, marginBottom: 8 }}>
                                <span style={{ fontWeight: 800, fontSize: 12, color: '#0f172a' }}>
                                  Chi Tiết Vận Đơn {activeCarrierName}
                                </span>
                                <span
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 800,
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    background: isLost ? '#fee2e2' : isRisk ? '#fef3c7' : isDelivered ? '#d1fae5' : '#ede9fe',
                                    color: isLost ? '#b91c1c' : isRisk ? '#b45309' : isDelivered ? '#047857' : '#6d28d9',
                                  }}
                                >
                                  {isLost ? 'NGHI NGỜ THẤT LẠC' : isRisk ? 'CẢNH BÁO RỦI RO' : isDelivered ? 'GIAO THÀNH CÔNG' : isPartial ? 'HOÀN 1 PHẦN' : 'ĐANG GIAO'}
                                </span>
                              </div>

                              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                <div>
                                  <strong>Mã vận đơn:</strong>{' '}
                                  <span className="mono" style={{ color: 'var(--primary)', fontWeight: 700 }}>
                                    {order.waybill}
                                  </span>
                                  {order.isPartialReturn && (
                                    <div style={{ color: '#7e22ce', fontSize: 10.5, fontWeight: 600 }}>
                                      (Mã gốc gửi ban đầu: <span className="mono">{order.originalWaybill}</span>)
                                    </div>
                                  )}
                                </div>

                                <div>
                                  <strong>Shop gửi:</strong> {order.shopName || 'Chưa có tên'} {order.shopPhone ? `(${order.shopPhone})` : ''}
                                </div>

                                <div>
                                  <strong>Người nhận:</strong> {order.receiverName || 'Khách nhận'}{' '}
                                  {order.receiverPhone ? `(${order.receiverPhone})` : ''}
                                </div>

                                {order.receiverAddress && (
                                  <div style={{ color: '#64748b', fontSize: 10.5 }}>
                                    <strong>Đích đến:</strong> {order.receiverAddress}
                                  </div>
                                )}

                                <div style={{ borderTop: '1px dashed #e2e8f0', paddingTop: 6, marginTop: 4 }}>
                                  <div>
                                    <strong>Ngày gửi hàng:</strong> {order.sentDate || 'Chưa ghi nhận'} (Đã trôi qua:{' '}
                                    <strong style={{ color: isLost ? 'var(--danger)' : isRisk ? '#d97706' : 'var(--primary)' }}>
                                      {order.totalDays} ngày
                                    </strong>
                                    )
                                  </div>

                                  {order.completedDate && (
                                    <div style={{ color: 'var(--success)' }}>
                                      <strong>Ngày ký nhận:</strong> {order.completedDate}
                                    </div>
                                  )}

                                  {order.returnedDate && (
                                    <div style={{ color: '#d97706' }}>
                                      <strong>Ngày hoàn về kho:</strong> {order.returnedDate}
                                    </div>
                                  )}
                                </div>

                                {/* Dynamic Warning Note */}
                                {isLost ? (
                                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', padding: '6px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 600, marginTop: 4 }}>
                                    ⚠️ Đã vượt ngưỡng thất lạc {config.lostDaysThreshold} ngày (+{order.totalDays - config.lostDaysThreshold} ngày). Đơn không có cập nhật mới, nguy cơ mất hàng tại bưu cục rất cao!
                                  </div>
                                ) : isRisk ? (
                                  <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#b45309', padding: '6px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 600, marginTop: 4 }}>
                                    ⚠️ Đã qua {order.totalDays} ngày chưa phát hoặc chưa hoàn (vượt ngưỡng {config.riskDaysThreshold} ngày). Cần liên hệ bưu tá kiểm tra!
                                  </div>
                                ) : isPartial ? (
                                  <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', color: '#6b21a8', padding: '6px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 600, marginTop: 4 }}>
                                    ✓ Đơn giao 1 phần / hoàn 1 phần: Đã tự động cắt đuôi "-001" khớp về mã gốc {order.originalWaybill}.
                                  </div>
                                ) : (
                                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#15803d', padding: '6px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 600, marginTop: 4 }}>
                                    ✓ Đang trong hạn vận chuyển an toàn (&lt; {config.riskDaysThreshold} ngày).
                                  </div>
                                )}
                              </div>

                              {/* Quick Action Buttons inside Popover */}
                              <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 8, borderTop: '1px solid #e2e8f0' }}>
                                <button
                                  type="button"
                                  onClick={(e) => handleCopy(order.waybill, e)}
                                  className="btn btn-sm btn-secondary"
                                  style={{ flex: 1, fontSize: 11, padding: '4px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                                >
                                  {copiedWb === order.waybill ? <Check size={12} color="var(--success)" /> : <Copy size={12} />}
                                  <span>{copiedWb === order.waybill ? 'Đã chép' : 'Chép mã'}</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => openProcessModal(order)}
                                  className="btn btn-sm"
                                  style={{
                                    flex: 1.2,
                                    fontSize: 11,
                                    padding: '4px 6px',
                                    background: 'var(--primary)',
                                    color: '#ffffff',
                                    fontWeight: 700,
                                    border: 'none',
                                    borderRadius: 6,
                                  }}
                                >
                                  Cập nhật tiến độ
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </td>

                      {/* LOẠI ĐƠN */}
                      <td>
                        {isPartial ? (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              padding: '3px 8px',
                              borderRadius: 4,
                              background: 'rgba(168, 85, 247, 0.12)',
                              color: '#7e22ce',
                              border: '1px solid rgba(168, 85, 247, 0.25)',
                            }}
                          >
                            Hoàn 1 phần (-001)
                          </span>
                        ) : isReturned ? (
                          <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: 'rgba(245, 158, 11, 0.12)', color: '#d97706' }}>
                            Đã hoàn về
                          </span>
                        ) : isDelivered ? (
                          <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: 'rgba(16, 185, 129, 0.12)', color: 'var(--success)' }}>
                            Giao thành công
                          </span>
                        ) : (
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Đơn gửi đi</span>
                        )}
                      </td>

                      {/* SHOP GỬI */}
                      <td>
                        <div style={{ fontWeight: 700, color: 'var(--text-main)', fontSize: 13 }}>{order.shopName || '--'}</div>
                        {order.shopPhone && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{order.shopPhone}</div>}
                      </td>

                      {/* NGƯỜI NHẬN */}
                      <td>
                        <div style={{ fontSize: 13 }}>
                          <strong>{order.receiverName || 'Khách nhận'}</strong>{' '}
                          {order.receiverPhone && <span style={{ color: 'var(--text-muted)' }}>({order.receiverPhone})</span>}
                        </div>
                        {order.receiverAddress && (
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={order.receiverAddress}>
                            {order.receiverAddress}
                          </div>
                        )}
                      </td>

                      {/* NGÀY GỬI */}
                      <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                        {order.sentDate || '--'}
                      </td>

                      {/* TOÀN TRÌNH */}
                      <td>
                        <strong
                          className="mono"
                          style={{
                            fontSize: 14,
                            color: isLost
                              ? 'var(--danger)'
                              : isRisk
                              ? '#d97706'
                              : isDelivered
                              ? 'var(--success)'
                              : 'var(--primary)',
                          }}
                        >
                          {order.totalDays} ngày
                        </strong>
                      </td>

                      {/* MỨC CẢNH BÁO */}
                      <td>
                        {isLost ? (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              padding: '3px 9px',
                              borderRadius: 999,
                              background: '#fee2e2',
                              color: '#b91c1c',
                              border: '1px solid #f87171',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            🚨 Nghi ngờ mất (&gt;{config.lostDaysThreshold}n)
                          </span>
                        ) : isRisk ? (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              padding: '3px 9px',
                              borderRadius: 999,
                              background: '#fef3c7',
                              color: '#b45309',
                              border: '1px solid #fbbf24',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            ⚠️ Rủi ro ({config.riskDaysThreshold}-{config.lostDaysThreshold}n)
                          </span>
                        ) : isDelivered ? (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              padding: '3px 9px',
                              borderRadius: 999,
                              background: '#dcfce7',
                              color: '#15803d',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            ✓ Giao thành công
                          </span>
                        ) : isPartial ? (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              padding: '3px 9px',
                              borderRadius: 999,
                              background: '#f3e8ff',
                              color: '#7e22ce',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            ✓ Đã về kho (1 phần)
                          </span>
                        ) : isReturned ? (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              padding: '3px 9px',
                              borderRadius: 999,
                              background: '#fef3c7',
                              color: '#92400e',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            ✓ Đã hoàn về kho
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              padding: '3px 9px',
                              borderRadius: 999,
                              background: 'rgba(79, 70, 229, 0.1)',
                              color: 'var(--primary)',
                            }}
                          >
                            Đang giao
                          </span>
                        )}
                      </td>

                      {/* TIẾN ĐỘ XỬ LÝ */}
                      <td>
                        {(() => {
                          const info = getProcessStatusInfo(order.claimStatus);
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              <span
                                style={{
                                  fontSize: 12,
                                  fontWeight: 800,
                                  padding: '3px 9px',
                                  borderRadius: 999,
                                  background: info.bg,
                                  color: info.color,
                                  border: `1px solid ${info.border}`,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  width: 'fit-content',
                                }}
                              >
                                {info.shortLabel}
                              </span>
                              {order.claimNote && (
                                <span
                                  style={{
                                    fontSize: 11.5,
                                    color: 'var(--text-muted)',
                                    maxWidth: 180,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                  title={order.claimNote}
                                >
                                  💬 {order.claimNote}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>

                      {/* THAO TÁC */}
                      <td style={{ textAlign: 'center' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => openProcessModal(order)}
                            className="btn btn-sm btn-secondary"
                            style={{
                              fontSize: 12,
                              padding: '4px 10px',
                              borderRadius: 6,
                              fontWeight: 700,
                              color: 'var(--primary)',
                              border: '1px solid var(--border-color)',
                            }}
                            title="Cập nhật tiến độ xử lý đơn hàng"
                          >
                            Cập nhật
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* PHÂN TRANG DANH SÁCH ĐƠN HÀNG */}
        <PaginationControl
          currentPage={currentPage}
          totalItems={filteredOrders.length}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={(newSize) => {
            setPageSize(newSize);
            setCurrentPage(1);
          }}
          pageSizeOptions={[50, 100, 200, 0]}
          itemName="đơn hàng"
        />
      </div>
    </div>
  )}

  {/* ────────────────────────────────────────────────────────────────────
      MODAL CẬP NHẬT TIẾN ĐỘ XỬ LÝ (5 TRẠNG THÁI CHO ĐƠN LẺ HOẶC HÀNG LOẠT)
  ──────────────────────────────────────────────────────────────────── */}
  {(processingModalOrder || isBulkModalOpen) && (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 99999,
        background: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={() => {
        if (!isSavingProcess) {
          setProcessingModalOrder(null);
          setIsBulkModalOpen(false);
        }
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: 540,
          borderRadius: 14,
          background: '#ffffff',
          border: '1.5px solid var(--border-color)',
          boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
          overflow: 'hidden',
          color: 'var(--text-main)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-panel)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertCircle size={18} color="var(--primary)" />
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>
              {isBulkModalOpen
                ? `Cập Nhật Tiến Độ Xử Lý (${selectedWbs.length} Đơn Hàng)`
                : `Cập Nhật Tiến Độ Xử Lý: ${processingModalOrder?.waybill}`}
            </h3>
          </div>
          <button
            type="button"
            disabled={isSavingProcess}
            onClick={() => {
              setProcessingModalOrder(null);
              setIsBulkModalOpen(false);
            }}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 18,
              color: 'var(--text-muted)',
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!isBulkModalOpen && processingModalOrder && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                background: 'var(--bg-panel)',
                fontSize: 12,
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 8,
              }}
            >
              <div><strong>Shop:</strong> {processingModalOrder.shopName || '--'}</div>
              <div><strong>Tiền COD:</strong> <span className="mono" style={{ color: 'var(--primary)', fontWeight: 700 }}>{formatVND(Number(processingModalOrder.codAmount || 0))}</span></div>
              <div><strong>Toàn trình:</strong> {processingModalOrder.totalDays} ngày</div>
              <div><strong>Cảnh báo:</strong> {processingModalOrder.status === 'suspected_lost' ? '🚨 Nghi ngờ thất lạc' : '⚠️ Cảnh báo rủi ro'}</div>
            </div>
          )}

          <div>
            <label style={{ fontSize: 12, fontWeight: 800, marginBottom: 8, display: 'block' }}>
              Chọn Trạng Thái Xử Lý:
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(['unprocessed', 'expediting', 'claimed', 'compensated', 'resolved'] as const).map((st) => {
                const info = PROCESS_STATUS_MAP[st];
                const isSelected = selectedProcessStatus === st;
                return (
                  <div
                    key={st}
                    onClick={() => setSelectedProcessStatus(st)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: isSelected ? `2px solid ${info.color}` : '1px solid var(--border-color)',
                      background: isSelected ? info.bg : 'var(--bg-card)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                    }}
                  >
                    <input
                      type="radio"
                      name="processStatus"
                      checked={isSelected}
                      onChange={() => setSelectedProcessStatus(st)}
                      style={{ marginTop: 3, accentColor: info.color }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 800,
                            padding: '1px 8px',
                            borderRadius: 999,
                            background: info.bg,
                            color: info.color,
                            border: `1px solid ${info.border}`,
                          }}
                        >
                          {info.label}
                        </span>
                        {st === 'resolved' && (
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--success)' }}>
                            (Tự động thoát cảnh báo rủi ro)
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: isSelected ? info.color : 'var(--text-muted)', marginTop: 4 }}>
                        {info.desc}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 800, marginBottom: 6, display: 'block' }}>
              Ghi Chú Tiến Độ / Mã Biên Bản J&T (Tùy chọn):
            </label>
            <textarea
              rows={3}
              value={processNoteInput}
              onChange={(e) => setProcessNoteInput(e.target.value)}
              placeholder="Ví dụ: Đã gửi email giục phát cho Quản lý bưu cục Tây Hồ lúc 10h; BB số 12938..."
              className="input-field"
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 12,
                borderRadius: 8,
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
          </div>
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            background: 'var(--bg-panel)',
          }}
        >
          <button
            type="button"
            disabled={isSavingProcess}
            onClick={() => {
              setProcessingModalOrder(null);
              setIsBulkModalOpen(false);
            }}
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: '7px 14px', borderRadius: 8 }}
          >
            Hủy bỏ
          </button>
          <button
            type="button"
            disabled={isSavingProcess}
            onClick={handleSaveProcess}
            className="btn btn-primary"
            style={{
              fontSize: 12,
              fontWeight: 800,
              padding: '7px 18px',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {isSavingProcess && <RefreshCw size={13} className="spin" />}
            <span>{isSavingProcess ? 'Đang lưu...' : 'Lưu tiến độ xử lý'}</span>
          </button>
        </div>
      </div>
    </div>
  )}
</div>
);
};
