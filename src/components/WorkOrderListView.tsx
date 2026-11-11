// src/components/WorkOrderListView.tsx
// ============================================================================
// 工令管理列表視圖組件
// 功能：顯示登入者個人的工令清單、快速搜尋、建立新工令、切換狀態、進入工令明細
// ============================================================================

import { useState, useMemo, memo } from 'react';
import type { FC, FormEvent } from 'react';
import {
  Plus,
  Search,
  Trash2,
  ChevronRight,
  FolderOpen,
  CheckCircle2,
  Clock,
  Database,
  MapPin,
} from 'lucide-react';
import type { WorkOrder, ContractConfig } from '../types';

interface WorkOrderListViewProps {
  /** 目前登入者專屬的工令清單 */
  workOrders: WorkOrder[];
  /** 目前選取中的工令 ID */
  selectedOrderId: string | null;
  /** 可選用的合約清單 */
  contracts: ContractConfig[];
  /** 點擊工令進入「工令明細」的回呼 */
  onSelectOrder: (orderId: string) => void;
  /** 新增工令的回呼 */
  onCreateOrder: (newOrderData: {
    woNumber: string;
    title: string;
    location: string;
    contractId: string;
  }) => void;
  /** 刪除工令的回呼 */
  onDeleteOrder: (orderId: string) => void;
  /** 切換工令完成/進行中狀態的回呼 */
  onToggleStatus: (order: WorkOrder) => void;
}

export const WorkOrderListView: FC<WorkOrderListViewProps> = memo(
  ({
    workOrders,
    selectedOrderId,
    contracts,
    onSelectOrder,
    onCreateOrder,
    onDeleteOrder,
    onToggleStatus,
  }) => {
    // 搜尋關鍵字與狀態篩選
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<'ALL' | '進行中' | '已完成'>('ALL');

    // 新增工令表單開關與欄位狀態
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [woNumber, setWoNumber] = useState('');
    const [title, setTitle] = useState('');
    const [location, setLocation] = useState('');
    const [contractId, setContractId] = useState(
      contracts[0]?.id || 'contract-default'
    );

    // 建立合約 ID 對照表，加速列表渲染時的名稱查詢
    const contractMap = useMemo(() => {
      const map = new Map<string, ContractConfig>();
      contracts.forEach((c) => map.set(c.id, c));
      return map;
    }, [contracts]);

    // 使用 useMemo 快取篩選後的工令列表
    const filteredOrders = useMemo(() => {
      const kw = searchTerm.trim().toLowerCase();
      return workOrders.filter((order) => {
        const matchStatus =
          statusFilter === 'ALL' || order.status === statusFilter;
        if (!matchStatus) return false;
        if (!kw) return true;
        return (
          order.woNumber.toLowerCase().includes(kw) ||
          order.title.toLowerCase().includes(kw) ||
          (order.location && order.location.toLowerCase().includes(kw))
        );
      });
    }, [workOrders, searchTerm, statusFilter]);

    // 計算統計摘要數據
    const stats = useMemo(() => {
      let activeCount = 0;
      let totalAmountSum = 0;
      workOrders.forEach((o) => {
        if (o.status === '進行中') activeCount += 1;
        totalAmountSum += o.totalAmount || 0;
      });
      return {
        totalCount: workOrders.length,
        activeCount,
        totalAmountSum,
      };
    }, [workOrders]);

    // 處理建立新工令表單送出
    const handleCreateSubmit = (e: FormEvent) => {
      e.preventDefault();
      if (!woNumber.trim() || !title.trim()) return;

      onCreateOrder({
        woNumber: woNumber.trim().toUpperCase(),
        title: title.trim(),
        location: location.trim(),
        contractId,
      });

      setWoNumber('');
      setTitle('');
      setLocation('');
      setIsCreateModalOpen(false);
    };

    return (
      <div className="space-y-4 pb-20">
        {/* 頂部個人工令統計卡片 */}
        <div className="grid grid-cols-3 gap-2.5 bg-white p-3.5 rounded-xl shadow-xs border border-slate-200">
          <div className="bg-slate-50 p-2.5 rounded-lg text-center">
            <div className="text-[11px] text-slate-500">個人工令總數</div>
            <div className="text-lg font-bold text-slate-800">{stats.totalCount}</div>
          </div>
          <div className="bg-blue-50/70 p-2.5 rounded-lg text-center">
            <div className="text-[11px] text-blue-600">進行中工令</div>
            <div className="text-lg font-bold text-blue-700">{stats.activeCount}</div>
          </div>
          <div className="bg-emerald-50/70 p-2.5 rounded-lg text-center">
            <div className="text-[11px] text-emerald-600">累計總金額</div>
            <div className="text-sm sm:text-base font-bold text-emerald-700 truncate">
              ${stats.totalAmountSum.toLocaleString()}
            </div>
          </div>
        </div>

        {/* 搜尋列與新增工令按鈕 */}
        <div className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜尋工令編號、案名或施工區域..."
              className="w-full pl-9 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-2">
            {/* 狀態篩選按鈕群 */}
            <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs">
              {(['ALL', '進行中', '已完成'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer ${
                    statusFilter === st
                      ? 'bg-white text-blue-600 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'ALL' ? '全部' : st}
                </button>
              ))}
            </div>

            {/* 新增工令按鈕 */}
            <button
              type="button"
              onClick={() => setIsCreateModalOpen(true)}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold shadow-xs transition-colors cursor-pointer shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>新增工令</span>
            </button>
          </div>
        </div>

        {/* 工令列表 */}
        {filteredOrders.length === 0 ? (
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-2">
            <FolderOpen className="w-10 h-10 text-slate-300 mx-auto" />
            <p className="text-slate-600 font-medium text-sm">
              目前尚無符合條件的個人工令紀錄
            </p>
            <p className="text-slate-400 text-xs">
              點擊右上方「新增工令」建立您的第一筆工令，系統會自動依您的帳號隔離保存。
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filteredOrders.map((order) => {
              const contractInfo = contractMap.get(order.contractId);
              const isSelected = order.id === selectedOrderId;

              return (
                <div
                  key={order.id}
                  onClick={() => onSelectOrder(order.id)}
                  className={`group bg-white rounded-xl p-4 border transition-all cursor-pointer ${
                    isSelected
                      ? 'border-blue-500 ring-2 ring-blue-500/15 shadow-xs'
                      : 'border-slate-200 hover:border-blue-300 shadow-2xs'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-bold px-2 py-0.5 bg-slate-100 text-slate-800 rounded-md border border-slate-200">
                          {order.woNumber}
                        </span>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleStatus(order);
                          }}
                          className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full cursor-pointer ${
                            order.status === '已完成'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-amber-50 text-amber-700 border border-amber-200'
                          }`}
                        >
                          {order.status === '已完成' ? (
                            <CheckCircle2 className="w-3 h-3" />
                          ) : (
                            <Clock className="w-3 h-3" />
                          )}
                          {order.status}
                        </button>

                        <span className="inline-flex items-center gap-1 text-[11px] text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md">
                          <Database className="w-3 h-3" />
                          {contractInfo ? contractInfo.name : '預設合約'}
                        </span>
                      </div>

                      <h3 className="font-bold text-slate-800 text-base truncate pt-0.5">
                        {order.title}
                      </h3>

                      <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
                        {order.location && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 text-slate-400" />
                            {order.location}
                          </span>
                        )}
                        <span>明細：{order.items.length} 項</span>
                        <span>
                          更新：{new Date(order.updatedAt).toLocaleDateString('zh-TW')}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end justify-between self-stretch shrink-0">
                      <div className="text-right">
                        <div className="text-[11px] text-slate-400">工令總額</div>
                        <div className="text-base font-bold text-blue-600 font-mono">
                          ${(order.totalAmount || 0).toLocaleString()}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 mt-2">
                        <button
                          type="button"
                          title="刪除此工令"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (
                              window.confirm(
                                `確定要刪除工令「${order.woNumber} - ${order.title}」嗎？`
                              )
                            ) {
                              onDeleteOrder(order.id);
                            }
                          }}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <span className="p-1 text-slate-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all">
                          <ChevronRight className="w-5 h-5" />
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 新增工令彈出視窗 (Modal) */}
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
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    工令編號 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={woNumber}
                    onChange={(e) => setWoNumber(e.target.value)}
                    placeholder="例如：W622008A 或 Y630000H"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    工令案名 / 說明 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="請輸入工程名稱或維修項目"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    施工區域 / 設備位置（選填）
                  </label>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="例如：第二供電區 / Y6 現場"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    預設適用合約（進入 MO 明細後仍可隨時切換）
                  </label>
                  <select
                    value={contractId}
                    onChange={(e) => setContractId(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {contracts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.contractCode})
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
                    建立並進入明細
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