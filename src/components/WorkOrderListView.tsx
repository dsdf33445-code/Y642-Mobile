// src/components/WorkOrderListView.tsx
// ============================================================================
// 工令管理列表視圖組件
// 升級項目：
// 1. 刪除確認視窗美化（自訂高質感 Modal 取代 window.confirm）
// 2. 刪除「全部、進行中、已完成」篩選與卡片狀態顯示
// 3. 工令卡片版面與視覺層次優化
// 4. 「勾選工令」按鈕文字改為「全選」
// 5. 建立/編輯/合併工令時，工令編號限制英文數字，最少 8 碼、最多 10 碼
// ============================================================================

import { useState, useMemo, memo } from 'react';
import type { FC, FormEvent } from 'react';
import {
  Plus,
  Search,
  Trash2,
  Pencil,
  FolderOpen,
  Database,
  GitMerge,
  CheckSquare,
  Square,
  AlertTriangle,
  Calendar,
  Layers,
} from 'lucide-react';
import type { WorkOrder, ContractConfig } from '../types';

interface WorkOrderListViewProps {
  /** 目前登入者專屬的工令清單 */
  workOrders: WorkOrder[];
  /** 目前選取中的工令 ID */
  selectedOrderId: string | null;
  /** 可選用的合約清單 */
  contracts: ContractConfig[];
  /** 點擊工令卡片進入工令明細的回呼 */
  onSelectOrder: (orderId: string) => void;
  /** 新增工令的回呼 */
  onCreateOrder: (newOrderData: {
    woNumber: string;
    title: string;
    contractId: string;
  }) => void;
  /** 編輯既有工令的回呼 */
  onEditOrder: (updatedOrderData: {
    id: string;
    woNumber: string;
    title: string;
    contractId: string;
  }) => void;
  /** 合併多筆工令的回呼 */
  onMergeOrders: (params: {
    sourceOrderIds: string[];
    mergedWoNumber: string;
    mergedTitle: string;
    deleteSources: boolean;
  }) => void;
  /** 刪除工令的回呼 */
  onDeleteOrder: (orderId: string) => void;
}

/**
 * 驗證工令編號是否為 8 ~ 10 碼英文字母或數字
 */
const WORK_ORDER_NO_REGEX = /^[A-Z0-9]{8,10}$/;

/**
 * 清理工令編號輸入值（僅保留英數、轉大寫、最多 10 碼）
 */
const sanitizeWoNumberInput = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10);

export const WorkOrderListView: FC<WorkOrderListViewProps> = memo(
  ({
    workOrders,
    selectedOrderId,
    contracts,
    onSelectOrder,
    onCreateOrder,
    onEditOrder,
    onMergeOrders,
    onDeleteOrder,
  }) => {
    // 搜尋關鍵字
    const [searchTerm, setSearchTerm] = useState('');

    // 多選勾選狀態
    const [checkedIds, setCheckedIds] = useState<string[]>([]);

    // 新增工令彈出視窗狀態
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [woNumber, setWoNumber] = useState('');
    const [title, setTitle] = useState('');
    const [contractId, setContractId] = useState(
      contracts[0]?.id || 'contract-1'
    );
    const [createError, setCreateError] = useState<string | null>(null);

    // 編輯工令彈出視窗狀態
    const [editingOrder, setEditingOrder] = useState<WorkOrder | null>(null);
    const [editWoNumber, setEditWoNumber] = useState('');
    const [editTitle, setEditTitle] = useState('');
    const [editContractId, setEditContractId] = useState('');
    const [editError, setEditError] = useState<string | null>(null);

    // 合併工令彈出視窗狀態
    const [isMergeModalOpen, setIsMergeModalOpen] = useState(false);
    const [mergedWoNumber, setMergedWoNumber] = useState('');
    const [mergedTitle, setMergedTitle] = useState('');
    const [deleteSourceAfterMerge, setDeleteSourceAfterMerge] = useState(false);
    const [mergeError, setMergeError] = useState<string | null>(null);

    // 美化版刪除確認視窗狀態
    const [deletingOrder, setDeletingOrder] = useState<WorkOrder | null>(null);

    // 合約 ID 對照表
    const contractMap = useMemo(() => {
      const map = new Map<string, ContractConfig>();
      contracts.forEach((c) => map.set(c.id, c));
      return map;
    }, [contracts]);

    // 篩選後的工令列表（已移除全部/進行中/已完成狀態過濾）
    const filteredOrders = useMemo(() => {
      const kw = searchTerm.trim().toLowerCase();
      if (!kw) return workOrders;
      return workOrders.filter(
        (order) =>
          order.woNumber.toLowerCase().includes(kw) ||
          order.title.toLowerCase().includes(kw)
      );
    }, [workOrders, searchTerm]);

    // 已勾選的工令物件陣列
    const checkedWorkOrders = useMemo(
      () => workOrders.filter((o) => checkedIds.includes(o.id)),
      [workOrders, checkedIds]
    );

    // 統計摘要數據（僅顯示個人工令總數與累計總金額）
    const stats = useMemo(() => {
      let totalAmountSum = 0;
      workOrders.forEach((o) => {
        totalAmountSum += o.totalAmount || 0;
      });
      return {
        totalCount: workOrders.length,
        totalAmountSum,
      };
    }, [workOrders]);

    // 切換單筆工令勾選狀態
    const toggleCheckOrder = (id: string) => {
      setCheckedIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
      );
    };

    // 全選 / 取消全選目前篩選列表
    const toggleSelectAll = () => {
      if (
        checkedIds.length === filteredOrders.length &&
        filteredOrders.length > 0
      ) {
        setCheckedIds([]);
      } else {
        setCheckedIds(filteredOrders.map((o) => o.id));
      }
    };

    // 開啟建立工令視窗
    const handleOpenCreateModal = () => {
      setWoNumber('');
      setTitle('');
      setContractId(contracts[0]?.id || 'contract-1');
      setCreateError(null);
      setIsCreateModalOpen(true);
    };

    // 處理建立新工令表單送出（嚴格驗證 8~10 碼英數）
    const handleCreateSubmit = (e: FormEvent) => {
      e.preventDefault();
      const cleanWo = sanitizeWoNumberInput(woNumber);
      if (!WORK_ORDER_NO_REGEX.test(cleanWo)) {
        setCreateError(
          `工令編號須為 8 至 10 碼英文或數字（目前已輸入 ${cleanWo.length} 碼）`
        );
        return;
      }
      if (!title.trim()) return;

      onCreateOrder({
        woNumber: cleanWo,
        title: title.trim(),
        contractId,
      });

      setWoNumber('');
      setTitle('');
      setCreateError(null);
      setIsCreateModalOpen(false);
    };

    // 開啟編輯工令視窗
    const handleOpenEditModal = (order: WorkOrder) => {
      setEditingOrder(order);
      setEditWoNumber(sanitizeWoNumberInput(order.woNumber));
      setEditTitle(order.title);
      setEditContractId(order.contractId || contracts[0]?.id || 'contract-1');
      setEditError(null);
    };

    // 儲存編輯後的工令（嚴格驗證 8~10 碼英數）
    const handleEditSubmit = (e: FormEvent) => {
      e.preventDefault();
      if (!editingOrder) return;
      const cleanWo = sanitizeWoNumberInput(editWoNumber);
      if (!WORK_ORDER_NO_REGEX.test(cleanWo)) {
        setEditError(
          `工令編號須為 8 至 10 碼英文或數字（目前已輸入 ${cleanWo.length} 碼）`
        );
        return;
      }
      if (!editTitle.trim()) return;

      onEditOrder({
        id: editingOrder.id,
        woNumber: cleanWo,
        title: editTitle.trim(),
        contractId: editContractId,
      });

      setEditingOrder(null);
      setEditError(null);
    };

    // 開啟合併工令確認視窗
    const handleOpenMergeModal = () => {
      if (checkedWorkOrders.length < 2) {
        window.alert('請先勾選至少 2 筆要合併的工令！');
        return;
      }
      const first = checkedWorkOrders[0];
      const defaultMergedNo = sanitizeWoNumberInput(first.woNumber);
      setMergedWoNumber(defaultMergedNo);
      setMergedTitle(
        `${first.title} (合併 ${checkedWorkOrders.map((o) => o.woNumber).join('+')})`
      );
      setDeleteSourceAfterMerge(false);
      setMergeError(null);
      setIsMergeModalOpen(true);
    };

    // 確認執行合併工令
    const handleConfirmMerge = (e: FormEvent) => {
      e.preventDefault();
      const cleanWo = sanitizeWoNumberInput(mergedWoNumber);
      if (!WORK_ORDER_NO_REGEX.test(cleanWo)) {
        setMergeError(
          `合併後工令編號須為 8 至 10 碼英文或數字（目前已輸入 ${cleanWo.length} 碼）`
        );
        return;
      }
      if (!mergedTitle.trim()) return;

      onMergeOrders({
        sourceOrderIds: checkedIds,
        mergedWoNumber: cleanWo,
        mergedTitle: mergedTitle.trim(),
        deleteSources: deleteSourceAfterMerge,
      });

      setCheckedIds([]);
      setMergeError(null);
      setIsMergeModalOpen(false);
    };

    // 確認刪除工令
    const handleConfirmDelete = () => {
      if (!deletingOrder) return;
      onDeleteOrder(deletingOrder.id);
      setCheckedIds((prev) => prev.filter((id) => id !== deletingOrder.id));
      setDeletingOrder(null);
    };

    const isAllSelected =
      filteredOrders.length > 0 && checkedIds.length === filteredOrders.length;

    return (
      <div className="space-y-4 pb-24">
        {/* 頂部個人工令統計卡片（已移除進行中狀態統計） */}
        <div className="grid grid-cols-2 gap-3 bg-white p-3.5 rounded-2xl shadow-xs border border-slate-200/90">
          <div className="bg-slate-50/90 px-4 py-3 rounded-xl flex items-center justify-between border border-slate-100">
            <span className="text-xs font-semibold text-slate-500">
              個人工令總數
            </span>
            <span className="text-xl font-extrabold text-slate-800 font-mono">
              {stats.totalCount}
            </span>
          </div>
          <div className="bg-emerald-50/70 px-4 py-3 rounded-xl flex items-center justify-between border border-emerald-100">
            <span className="text-xs font-semibold text-emerald-700">
              累計總金額
            </span>
            <span className="text-base sm:text-lg font-extrabold text-emerald-700 font-mono truncate ml-2">
              ${stats.totalAmountSum.toLocaleString()}
            </span>
          </div>
        </div>

        {/* 搜尋列與操作工具列 */}
        <div className="bg-white p-3.5 rounded-2xl border border-slate-200/90 shadow-2xs space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜尋工令編號或工令名稱..."
              className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
            />
          </div>

          {/* 功能按鈕列：全選、合併工令、新增工令 */}
          <div className="flex items-center justify-between gap-2 flex-wrap pt-1 border-t border-slate-100">
            <div className="flex items-center gap-2 flex-wrap">
              {/* 「勾選工令」已改為「全選」 */}
              <button
                type="button"
                onClick={toggleSelectAll}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer border ${
                  isAllSelected
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200/60'
                }`}
              >
                {isAllSelected ? (
                  <CheckSquare className="w-3.5 h-3.5 text-blue-600" />
                ) : (
                  <Square className="w-3.5 h-3.5 text-slate-400" />
                )}
                <span>
                  全選{checkedIds.length > 0 ? ` (${checkedIds.length})` : ''}
                </span>
              </button>

              {/* 合併工令按鈕 */}
              <button
                type="button"
                onClick={handleOpenMergeModal}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer ${
                  checkedIds.length >= 2
                    ? 'bg-purple-600 hover:bg-purple-700 text-white shadow-2xs'
                    : 'bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200'
                }`}
              >
                <GitMerge className="w-3.5 h-3.5" />
                <span>
                  合併工令{checkedIds.length >= 2 ? ` (${checkedIds.length})` : ''}
                </span>
              </button>
            </div>

            {/* 新增工令按鈕 */}
            <button
              type="button"
              onClick={handleOpenCreateModal}
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold shadow-xs transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>新增工令</span>
            </button>
          </div>
        </div>

        {/* 工令卡片列表（顯示優化版） */}
        {filteredOrders.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-2">
            <FolderOpen className="w-10 h-10 text-slate-300 mx-auto" />
            <p className="text-slate-600 font-medium text-sm">
              目前尚無符合條件的個人工令紀錄
            </p>
            <p className="text-slate-400 text-xs">
              點擊右上方「新增工令」建立工令，系統會自動綁定您的 Google 帳號保存。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredOrders.map((order) => {
              const contractInfo = contractMap.get(order.contractId);
              const isSelected = order.id === selectedOrderId;
              const isChecked = checkedIds.includes(order.id);

              return (
                <div
                  key={order.id}
                  onClick={() => onSelectOrder(order.id)}
                  className={`group relative bg-white rounded-2xl p-4 border transition-all cursor-pointer ${
                    isChecked
                      ? 'border-purple-400 ring-2 ring-purple-500/15 bg-purple-50/10'
                      : isSelected
                      ? 'border-blue-500 ring-2 ring-blue-500/15 shadow-sm'
                      : 'border-slate-200/90 hover:border-blue-300 hover:shadow-sm shadow-2xs'
                  }`}
                >
                  <div className="flex items-center gap-3.5">
                    {/* 左側：全選/多選勾選框 */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCheckOrder(order.id);
                      }}
                      title="勾選工令"
                      className="p-1 -ml-1 text-slate-400 hover:text-purple-600 cursor-pointer shrink-0 transition-colors"
                    >
                      {isChecked ? (
                        <CheckSquare className="w-5 h-5 text-purple-600" />
                      ) : (
                        <Square className="w-5 h-5" />
                      )}
                    </button>

                    {/* 中間：工令編號、合約標籤、工令名稱、明細數與日期 */}
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-extrabold px-2.5 py-0.5 bg-blue-50 text-blue-700 rounded-lg border border-blue-200/80 tracking-wide">
                          {order.woNumber}
                        </span>

                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200/60 truncate max-w-[180px]">
                          <Database className="w-3 h-3 text-blue-600 shrink-0" />
                          <span className="truncate">
                            {contractInfo ? contractInfo.name : '預設合約'}
                          </span>
                        </span>
                      </div>

                      <h3 className="font-bold text-slate-800 text-base leading-snug truncate group-hover:text-blue-600 transition-colors">
                        {order.title}
                      </h3>

                      <div className="flex items-center gap-3 text-xs text-slate-400">
                        <span className="inline-flex items-center gap-1 font-medium text-slate-500">
                          <Layers className="w-3.5 h-3.5 text-slate-400" />
                          {order.items.length} 項明細
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5 text-slate-400" />
                          {new Date(order.updatedAt).toLocaleDateString('zh-TW')}
                        </span>
                      </div>
                    </div>

                    {/* 右側：工令總額與編輯 / 刪除操作區 */}
                    <div className="flex flex-col items-end justify-between self-stretch shrink-0 pl-2 border-l border-slate-100">
                      <div className="text-right">
                        <div className="text-[10px] font-medium text-slate-400">
                          工令總額
                        </div>
                        <div className="text-base sm:text-lg font-extrabold text-blue-600 font-mono">
                          ${(order.totalAmount || 0).toLocaleString()}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 mt-2">
                        {/* 編輯工令按鈕 */}
                        <button
                          type="button"
                          title="編輯工令"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenEditModal(order);
                          }}
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-colors cursor-pointer"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>

                        {/* 刪除工令按鈕（開啟美化確認視窗） */}
                        <button
                          type="button"
                          title="刪除此工令"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeletingOrder(order);
                          }}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 美化版：刪除工令確認視窗 (Delete Confirmation Modal) */}
        {deletingOrder && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-slate-200 space-y-4 text-center">
              <div className="w-12 h-12 rounded-full bg-red-50 border border-red-100 flex items-center justify-center mx-auto text-red-600">
                <AlertTriangle className="w-6 h-6" />
              </div>

              <div className="space-y-1.5">
                <h3 className="text-base font-extrabold text-slate-800">
                  確定要刪除此工令嗎？
                </h3>
                <p className="text-xs text-slate-500">
                  刪除後將無法復原該工令及其所有 MO 明細紀錄：
                </p>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-left space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                    {deletingOrder.woNumber}
                  </span>
                  <span className="text-slate-500 font-medium">
                    共 {deletingOrder.items.length} 項明細
                  </span>
                </div>
                <div className="text-sm font-bold text-slate-800 truncate pt-0.5">
                  {deletingOrder.title}
                </div>
                <div className="text-xs font-mono font-semibold text-emerald-700">
                  總金額：${(deletingOrder.totalAmount || 0).toLocaleString()}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setDeletingOrder(null)}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 shadow-xs transition-colors cursor-pointer"
                >
                  確認刪除
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 建立新工令彈出視窗（工令編號限制 8~10 碼英數） */}
        {isCreateModalOpen && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-xl border border-slate-200 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="text-base font-bold text-slate-800">建立新工令</h2>
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 text-sm cursor-pointer"
                >
                  關閉
                </button>
              </div>

              <form onSubmit={handleCreateSubmit} className="space-y-3.5">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-slate-600">
                      工令編號 <span className="text-red-500">*</span>
                    </label>
                    <span
                      className={`text-[11px] font-mono ${
                        woNumber.length >= 8 && woNumber.length <= 10
                          ? 'text-emerald-600 font-semibold'
                          : 'text-slate-400'
                      }`}
                    >
                      {woNumber.length} / 10 碼 (限 8~10 碼英數)
                    </span>
                  </div>
                  <input
                    type="text"
                    required
                    minLength={8}
                    maxLength={10}
                    value={woNumber}
                    onChange={(e) => {
                      setWoNumber(sanitizeWoNumberInput(e.target.value));
                      if (createError) setCreateError(null);
                    }}
                    placeholder="請輸入 8~10 碼英數字（如：W622008A）"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {createError && (
                    <p className="text-xs text-red-600 font-medium mt-1">
                      {createError}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    工令名稱 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="請輸入工令名稱"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    選擇合約
                  </label>
                  <select
                    value={contractId}
                    onChange={(e) => setContractId(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {contracts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsCreateModalOpen(false)}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-xs cursor-pointer"
                  >
                    建立工令
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* 編輯工令彈出視窗（工令編號限制 8~10 碼英數） */}
        {editingOrder && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-xl border border-slate-200 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="text-base font-bold text-slate-800">編輯工令</h2>
                <button
                  type="button"
                  onClick={() => setEditingOrder(null)}
                  className="text-slate-400 hover:text-slate-600 text-sm cursor-pointer"
                >
                  關閉
                </button>
              </div>

              <form onSubmit={handleEditSubmit} className="space-y-3.5">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-slate-600">
                      工令編號 <span className="text-red-500">*</span>
                    </label>
                    <span
                      className={`text-[11px] font-mono ${
                        editWoNumber.length >= 8 && editWoNumber.length <= 10
                          ? 'text-emerald-600 font-semibold'
                          : 'text-slate-400'
                      }`}
                    >
                      {editWoNumber.length} / 10 碼 (限 8~10 碼英數)
                    </span>
                  </div>
                  <input
                    type="text"
                    required
                    minLength={8}
                    maxLength={10}
                    value={editWoNumber}
                    onChange={(e) => {
                      setEditWoNumber(sanitizeWoNumberInput(e.target.value));
                      if (editError) setEditError(null);
                    }}
                    placeholder="請輸入 8~10 碼英數字"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {editError && (
                    <p className="text-xs text-red-600 font-medium mt-1">
                      {editError}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    工令名稱 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    選擇合約
                  </label>
                  <select
                    value={editContractId}
                    onChange={(e) => setEditContractId(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {contracts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingOrder(null)}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-xs cursor-pointer"
                  >
                    儲存修改
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* 合併工令彈出視窗 */}
        {isMergeModalOpen && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-xl border border-slate-200 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="text-base font-bold text-slate-800 flex items-center gap-1.5">
                  <GitMerge className="w-5 h-5 text-purple-600" />
                  <span>合併工令（共選取 {checkedWorkOrders.length} 筆）</span>
                </h2>
                <button
                  type="button"
                  onClick={() => setIsMergeModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 text-sm cursor-pointer"
                >
                  關閉
                </button>
              </div>

              <div className="bg-purple-50/70 border border-purple-200 rounded-xl p-3 text-xs text-purple-900 space-y-1">
                <div className="font-semibold">即將合併以下工令之 MO 明細：</div>
                <ul className="list-disc list-inside text-purple-800 space-y-0.5">
                  {checkedWorkOrders.map((o) => (
                    <li key={o.id}>
                      <span className="font-mono font-bold">{o.woNumber}</span> -{' '}
                      {o.title}（{o.items.length} 項 / $
                      {o.totalAmount.toLocaleString()}）
                    </li>
                  ))}
                </ul>
              </div>

              <form onSubmit={handleConfirmMerge} className="space-y-3.5">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-slate-600">
                      合併後工令編號 <span className="text-red-500">*</span>
                    </label>
                    <span
                      className={`text-[11px] font-mono ${
                        mergedWoNumber.length >= 8 &&
                        mergedWoNumber.length <= 10
                          ? 'text-emerald-600 font-semibold'
                          : 'text-slate-400'
                      }`}
                    >
                      {mergedWoNumber.length} / 10 碼 (限 8~10 碼英數)
                    </span>
                  </div>
                  <input
                    type="text"
                    required
                    minLength={8}
                    maxLength={10}
                    value={mergedWoNumber}
                    onChange={(e) => {
                      setMergedWoNumber(sanitizeWoNumberInput(e.target.value));
                      if (mergeError) setMergeError(null);
                    }}
                    placeholder="請輸入 8~10 碼英數字"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  {mergeError && (
                    <p className="text-xs text-red-600 font-medium mt-1">
                      {mergeError}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    合併後工令名稱 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={mergedTitle}
                    onChange={(e) => setMergedTitle(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={deleteSourceAfterMerge}
                    onChange={(e) =>
                      setDeleteSourceAfterMerge(e.target.checked)
                    }
                    className="rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                  />
                  <span>
                    合併完成後，自動刪除原有的 {checkedWorkOrders.length} 筆來源工令
                  </span>
                </label>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsMergeModalOpen(false)}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white shadow-xs cursor-pointer"
                  >
                    確認合併
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }
);
