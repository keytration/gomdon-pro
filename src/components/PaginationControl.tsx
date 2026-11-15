import React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

export interface PaginationControlProps {
  currentPage: number;
  totalItems: number;
  pageSize: number; // 50, 100, 200, or 0 for "All"
  onPageChange: (newPage: number) => void;
  onPageSizeChange: (newSize: number) => void;
  pageSizeOptions?: number[];
  itemName?: string;
}

export const PaginationControl: React.FC<PaginationControlProps> = ({
  currentPage,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [50, 100, 200],
  itemName = 'đơn',
}) => {
  const isAll = pageSize <= 0;
  const effPageSize = isAll ? Math.max(1, totalItems) : pageSize;
  const totalPages = isAll ? 1 : Math.max(1, Math.ceil(totalItems / effPageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  const startItem = totalItems === 0 ? 0 : isAll ? 1 : (safePage - 1) * effPageSize + 1;
  const endItem = totalItems === 0 ? 0 : isAll ? totalItems : Math.min(safePage * effPageSize, totalItems);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        padding: '10px 16px',
        background: 'var(--bg-secondary, #f8fafc)',
        borderTop: '1px solid var(--border-color, #e2e8f0)',
        fontSize: 12.5,
        color: 'var(--text-main, #334155)',
      }}
    >
      {/* Summary left */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted, #64748b)' }}>
        {totalItems === 0 ? (
          <span>Không có {itemName} nào</span>
        ) : (
          <span>
            Hiển thị <strong>{startItem}</strong> - <strong>{endItem}</strong> trên tổng{' '}
            <strong style={{ color: 'var(--primary, #4f46e5)' }}>{totalItems.toLocaleString('vi-VN')}</strong> {itemName}
          </span>
        )}
      </div>

      {/* Controls right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* Page size selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted, #64748b)' }}>Số {itemName}/trang:</span>
          <select
            value={pageSize}
            onChange={(e) => {
              const val = Number(e.target.value);
              onPageSizeChange(val);
            }}
            className="select-field"
            style={{
              padding: '3px 8px',
              fontSize: 12,
              borderRadius: 6,
              border: '1px solid var(--border-color, #cbd5e1)',
              background: 'var(--bg-primary, #ffffff)',
              color: 'var(--text-main, #1e293b)',
              cursor: 'pointer',
            }}
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt} {itemName}/trang
              </option>
            ))}
            <option value={0}>Tất cả ({totalItems.toLocaleString('vi-VN')})</option>
          </select>
        </div>

        {/* Navigation buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            title="Trang đầu"
            disabled={safePage <= 1 || isAll || totalItems === 0}
            onClick={() => onPageChange(1)}
            className="btn btn-secondary btn-sm"
            style={{
              padding: '4px 6px',
              fontSize: 11,
              borderRadius: 6,
              opacity: safePage <= 1 || isAll || totalItems === 0 ? 0.45 : 1,
              cursor: safePage <= 1 || isAll || totalItems === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <ChevronsLeft size={13} />
          </button>

          <button
            type="button"
            title="Trang trước"
            disabled={safePage <= 1 || isAll || totalItems === 0}
            onClick={() => onPageChange(Math.max(1, safePage - 1))}
            className="btn btn-secondary btn-sm"
            style={{
              padding: '4px 8px',
              fontSize: 11.5,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              opacity: safePage <= 1 || isAll || totalItems === 0 ? 0.45 : 1,
              cursor: safePage <= 1 || isAll || totalItems === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <ChevronLeft size={13} />
            <span>Trước</span>
          </button>

          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: '0 8px',
              color: 'var(--text-main, #1e293b)',
              minWidth: 80,
              textAlign: 'center',
            }}
          >
            Trang {safePage} / {totalPages}
          </span>

          <button
            type="button"
            title="Trang sau"
            disabled={safePage >= totalPages || isAll || totalItems === 0}
            onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
            className="btn btn-secondary btn-sm"
            style={{
              padding: '4px 8px',
              fontSize: 11.5,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              opacity: safePage >= totalPages || isAll || totalItems === 0 ? 0.45 : 1,
              cursor: safePage >= totalPages || isAll || totalItems === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <span>Sau</span>
            <ChevronRight size={13} />
          </button>

          <button
            type="button"
            title="Trang cuối"
            disabled={safePage >= totalPages || isAll || totalItems === 0}
            onClick={() => onPageChange(totalPages)}
            className="btn btn-secondary btn-sm"
            style={{
              padding: '4px 6px',
              fontSize: 11,
              borderRadius: 6,
              opacity: safePage >= totalPages || isAll || totalItems === 0 ? 0.45 : 1,
              cursor: safePage >= totalPages || isAll || totalItems === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <ChevronsRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
