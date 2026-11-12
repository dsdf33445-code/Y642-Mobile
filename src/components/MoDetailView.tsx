// src/components/MoDetailView.tsx
// ============================================================================
// 工令明細 (MO 明細) 視圖組件
// 升級項目：
// 1. 加入「刪除明細確認視窗 Modal」
// 2. 全面刪除「單位」顯示與輸入框
// 3. 已加入明細自動按照「項目編號 (code)」自然排列
// 4. 已加入項目限制最低數量：1，最高數量：999
// ============================================================================

import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import type { FC, FormEvent } from 'react';
import {
  Database,
  RefreshCw,
  Search,
  Plus,
  Minus,
  Trash2,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  Sparkles,
  FileDown,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import type {
  WorkOrder,
  ContractConfig,
  ContractProductItem,
  MoLineItem,
} from '../types';
import {
  MO_SYSTEM_URL,
  fetchContractProducts,
  exportMoSpecificExcel,
} from '../constants';
import { sortMoItemsByCode } from '../firebase';

interface MoDetailViewProps {
  /** 目前檢視/編輯中的工令（若未選取則為 null） */
  workOrder: WorkOrder | null;
  /** 所有可用的個人工令（供頂部快速切換不同工令） */
  allWorkOrders: WorkOrder[];
  /** 可選擇的多重合約清單 */
  contracts: ContractConfig[];
  /** 切換目前工令的回呼 */
  onSelectOrder: (orderId: string) => void;
  /** 更新工令內容的回呼 */
  onUpdateWorkOrder: (updatedOrder: WorkOrder) => void;
  /** 返回工令列表分頁的回呼 */
  onBackToList: () => void;
}

/**
 * 模組層級記憶體快取
 */
const contractProductsCache = new Map<string, ContractProductItem[]>();

/**
 * 將數量嚴格限制在 1 ~ 999 整數之間
 */
const clampQuantity = (val: number): number => {
  if (!Number.isFinite(val)) return 1;
  return Math.min(999, Math.max(1, Math.round(val)));
};

export const MoDetailView: FC<MoDetailViewProps> = memo(
  ({
    workOrder,
    allWorkOrders,
    contracts,
    onSelectOrder,
    onUpdateWorkOrder,
    onBackToList,
  }) => {
    // 合約資料庫商品清單狀態
    const [catalogItems, setCatalogItems] = useState<ContractProductItem[]>([]);
    const [isLoadingCatalog, setIsLoadingCatalog] = useState<boolean>(false);
    const [catalogError, setCatalogError] = useState<string | null>(null);
    const [usingFallbackNotice, setUsingFallbackNotice] =
      useState<boolean>(false);
    const [resolvedSourceUrl, setResolvedSourceUrl] = useState<string>('');

    // 資料庫工項搜尋與分類過濾狀態
    const [catalogSearch, setCatalogSearch] = useState<string>('');
    const [selectedCategory, setSelectedCategory] = useState<string>('ALL');

    // 手動自訂新增 MO 工項表單狀態（已移除單位欄位）
    const [showCustomForm, setShowCustomForm] = useState<boolean>(false);
    const [customCode, setCustomCode] = useState('');
    const [customName, setCustomName] = useState('');
    const [customSpec, setCustomSpec] = useState('');
    const [customPrice, setCustomPrice] = useState('');

    // 刪除單筆 MO 明細確認視窗狀態
    const [deletingItem, setDeletingItem] = useState<MoLineItem | null>(null);

    // 目前工令選用的合約設定物件
    const activeContract = useMemo(() => {
      const targetId = workOrder?.contractId || contracts[0]?.id;
      return contracts.find((c) => c.id === targetId) || contracts[0];
    }, [workOrder?.contractId, contracts]);

    // 已加入工令之 MO 明細：自動按照「項目編號 (code)」由小到大排列
    const sortedOrderItems = useMemo(() => {
      if (!workOrder) return [];
      return sortMoItemsByCode(workOrder.items);
    }, [workOrder]);

    // 載入指定合約資料庫
    const loadContractDatabase = useCallback(
      async (contract: ContractConfig, forceRefresh = false) => {
        if (!contract) return;

        if (!forceRefresh && contractProductsCache.has(contract.id)) {
          const cached = contractProductsCache.get(contract.id)!;
          if (cached.length > 0) {
            setCatalogItems(cached);
            setCatalogError(null);
            setResolvedSourceUrl(contract.githubExcelUrl);
            return;
          }
        }

        setIsLoadingCatalog(true);
        setCatalogError(null);
        setUsingFallbackNotice(false);

        try {
          const { items, isFallback, loadedUrl } =
            await fetchContractProducts(contract);
          contractProductsCache.set(contract.id, items);
          setCatalogItems(items);
          setUsingFallbackNotice(isFallback);
          setResolvedSourceUrl(loadedUrl);
        } catch (error) {
          console.error('載入合約資料庫失敗：', error);
          setCatalogError(
            error instanceof Error ? error.message : '無法讀取合約單價資料庫'
          );
          setCatalogItems([]);
        } finally {
          setIsLoadingCatalog(false);
        }
      },
      []
    );

    // 當工令選用的合約改變時，自動載入對應資料庫
    useEffect(() => {
      if (activeContract) {
        loadContractDatabase(activeContract, false);
        setSelectedCategory('ALL');
      }
    }, [activeContract, loadContractDatabase]);

    // 彙整目前合約資料庫的所有分類標籤
    const categories = useMemo(() => {
      const set = new Set<string>();
      catalogItems.forEach((item) => {
        if (item.category) set.add(item.category);
      });
      return ['ALL', ...Array.from(set)];
    }, [catalogItems]);

    // 高速過濾合約資料庫中的工項（預設顯示前 100 筆）
    const filteredCatalog = useMemo(() => {
      const kw = catalogSearch.trim().toLowerCase();
      return catalogItems
        .filter((item) => {
          const matchCat =
            selectedCategory === 'ALL' || item.category === selectedCategory;
          if (!matchCat) return false;
          if (!kw) return true;
          return (
            item.code.toLowerCase().includes(kw) ||
            item.name.toLowerCase().includes(kw) ||
            item.spec.toLowerCase().includes(kw)
          );
        })
        .slice(0, 100);
    }, [catalogItems, catalogSearch, selectedCategory]);

    // 自動依編號排序明細、重新計算工令總金額並觸發更新
    const commitOrderItems = useCallback(
      (nextItems: MoLineItem[], nextContractId?: string) => {
        if (!workOrder) return;
        const sorted = sortMoItemsByCode(
          nextItems.map((item) => {
            const safeQty = clampQuantity(item.quantity);
            return {
              ...item,
              quantity: safeQty,
              subtotal: Math.round(item.unitPrice * safeQty),
            };
          })
        );
        const totalAmount = sorted.reduce(
          (sum, item) => sum + item.subtotal,
          0
        );
        onUpdateWorkOrder({
          ...workOrder,
          contractId: nextContractId ?? workOrder.contractId,
          items: sorted,
          totalAmount,
        });
      },
      [workOrder, onUpdateWorkOrder]
    );

    // 切換合約下拉選單（自動比對新合約單價並重算小計）
    const handleContractChange = async (newContractId: string) => {
      if (!workOrder || newContractId === workOrder.contractId) return;
      const targetContract = contracts.find((c) => c.id === newContractId);
      if (!targetContract) return;

      let newCatalog = contractProductsCache.get(targetContract.id);
      if (!newCatalog || newCatalog.length === 0) {
        try {
          setIsLoadingCatalog(true);
          const fetched = await fetchContractProducts(targetContract);
          newCatalog = fetched.items;
          contractProductsCache.set(targetContract.id, newCatalog);
          setCatalogItems(newCatalog);
          setUsingFallbackNotice(fetched.isFallback);
          setResolvedSourceUrl(fetched.loadedUrl);
        } catch {
          newCatalog = [];
        } finally {
          setIsLoadingCatalog(false);
        }
      }

      const priceMapByCode = new Map<string, ContractProductItem>();
      (newCatalog || []).forEach((p) => priceMapByCode.set(p.code, p));

      const updatedItems = workOrder.items.map((line) => {
        const matched = priceMapByCode.get(line.code);
        if (matched) {
          const nextPrice = matched.unitPrice;
          const safeQty = clampQuantity(line.quantity);
          return {
            ...line,
            unitPrice: nextPrice,
            quantity: safeQty,
            subtotal: Math.round(nextPrice * safeQty),
          };
        }
        return line;
      });

      commitOrderItems(updatedItems, newContractId);
    };

    // 從合約資料庫點擊「+ 加入」帶入 MO 明細（最高數量限制 999，並自動按編號排序）
    const handleAddFromCatalog = (product: ContractProductItem) => {
      if (!workOrder) return;
      const existingIndex = workOrder.items.findIndex(
        (i) => i.code === product.code && i.name === product.name
      );

      let nextItems: MoLineItem[];
      if (existingIndex >= 0) {
        nextItems = workOrder.items.map((item, idx) => {
          if (idx !== existingIndex) return item;
          const nextQty = clampQuantity(item.quantity + 1);
          return {
            ...item,
            quantity: nextQty,
            subtotal: Math.round(item.unitPrice * nextQty),
          };
        });
      } else {
        const newItem: MoLineItem = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          code: product.code,
          name: product.name,
          spec: product.spec,
          unit: product.unit || '式',
          unitPrice: product.unitPrice,
          quantity: 1,
          subtotal: Math.round(product.unitPrice),
        };
        nextItems = [...workOrder.items, newItem];
      }

      commitOrderItems(nextItems);
    };

    // 確認刪除單筆 MO 明細
    const handleConfirmRemoveItem = () => {
      if (!workOrder || !deletingItem) return;
      const nextItems = workOrder.items.filter(
        (item) => item.id !== deletingItem.id
      );
      commitOrderItems(nextItems);
      setDeletingItem(null);
    };

    // 修改既有 MO 明細的數量（限制最低 1、最高 999）
    const handleQuantityChange = (itemId: string, rawQty: number) => {
      if (!workOrder) return;
      const safeQty = clampQuantity(rawQty);
      const nextItems = workOrder.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              quantity: safeQty,
              subtotal: Math.round(item.unitPrice * safeQty),
            }
          : item
      );
      commitOrderItems(nextItems);
    };

    // 新增自訂工項送出
    const handleAddCustomItem = (e: FormEvent) => {
      e.preventDefault();
      if (!workOrder || !customName.trim()) return;
      const priceNum = Math.max(0, Number(customPrice) || 0);

      const newItem: MoLineItem = {
        id: `custom-${Date.now()}`,
        code: customCode.trim() || 'CUSTOM',
        name: customName.trim(),
        spec: customSpec.trim(),
        unit: '式',
        unitPrice: priceNum,
        quantity: 1,
        subtotal: Math.round(priceNum),
      };

      commitOrderItems([...workOrder.items, newItem]);
      setCustomCode('');
      setCustomName('');
      setCustomSpec('');
      setCustomPrice('');
      setShowCustomForm(false);
    };

    if (!workOrder) {
      return (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-3">
          <FileSpreadsheet className="w-12 h-12 text-blue-500 mx-auto" />
          <h3 className="text-base font-bold text-slate-800">
            尚未選擇要編輯的工令
          </h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            請先從「工令管理」點選一筆工令，或直接從下方下拉選單挑選屬於您的工令。
          </p>
          {allWorkOrders.length > 0 ? (
            <div className="max-w-xs mx-auto pt-2">
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) onSelectOrder(e.target.value);
                }}
                className="w-full px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm bg-white"
              >
                <option value="" disabled>
                  -- 請選擇您的工令 --
                </option>
                {allWorkOrders.map((wo) => (
                  <option key={wo.id} value={wo.id}>
                    {wo.woNumber} - {wo.title}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <button
              type="button"
              onClick={onBackToList}
              className="inline-flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-semibold cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              前往建立工令
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4 pb-24">
        {/* 頂部工令資訊、「前往 MO」連結、「匯出 Excel」與「選擇合約」 */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-2xs space-y-3.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={onBackToList}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-blue-600 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              返回工令列表
            </button>

            <div className="flex items-center gap-2 flex-wrap">
              {/* 快速切換其他工令 */}
              <select
                value={workOrder.id}
                onChange={(e) => onSelectOrder(e.target.value)}
                className="text-xs bg-slate-100 border border-slate-200 rounded-lg px-2.5 py-1.5 font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {allWorkOrders.map((wo) => (
                  <option key={wo.id} value={wo.id}>
                    工令：{wo.woNumber} - {wo.title}
                  </option>
                ))}
              </select>

              {/* 匯出特定 Excel 檔案按鈕 */}
              <button
                type="button"
                onClick={() => exportMoSpecificExcel(workOrder)}
                className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
              >
                <FileDown className="w-3.5 h-3.5" />
                <span>匯出 Excel</span>
              </button>

              {/* 前往 MO 外部連結按鈕 */}
              <a
                href={MO_SYSTEM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow-2xs transition-colors"
              >
                <span>前往 MO</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-slate-100">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold px-2 py-0.5 bg-blue-50 text-blue-700 rounded-md border border-blue-200">
                  {workOrder.woNumber}
                </span>
                <h2 className="text-base font-bold text-slate-800">
                  {workOrder.title}
                </h2>
              </div>
            </div>

            <div className="text-left sm:text-right bg-slate-50 px-3.5 py-2 rounded-xl border border-slate-200/80">
              <div className="text-[11px] text-slate-500">
                MO 明細共 {sortedOrderItems.length} 項｜總金額
              </div>
              <div className="text-lg font-extrabold text-blue-600 font-mono">
                ${(workOrder.totalAmount || 0).toLocaleString()}
              </div>
            </div>
          </div>

          {/* 選擇合約 */}
          <div className="bg-blue-50/60 border border-blue-200/80 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs font-bold text-blue-900">
                <Database className="w-4 h-4 text-blue-600" />
                <span>選擇合約</span>
              </label>

              {/* 純圖示按鈕：重新載入資料 */}
              <button
                type="button"
                onClick={() => loadContractDatabase(activeContract, true)}
                disabled={isLoadingCatalog}
                title="重新載入資料"
                aria-label="重新載入資料"
                className="p-1.5 text-blue-700 hover:text-blue-900 bg-white hover:bg-blue-50 rounded-lg border border-blue-200 shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-4 h-4 ${
                    isLoadingCatalog ? 'animate-spin' : ''
                  }`}
                />
              </button>
            </div>

            <select
              value={workOrder.contractId}
              onChange={(e) => handleContractChange(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-blue-300 rounded-lg text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div className="flex items-center justify-between text-[11px] text-slate-600 flex-wrap gap-1">
              <span className="truncate max-w-full font-mono text-[10px] text-slate-500">
                資料來源：{resolvedSourceUrl || activeContract?.githubExcelUrl}
              </span>
              <span className="font-semibold text-blue-700">
                已載入 {catalogItems.length} 筆合約工項
              </span>
            </div>

            {usingFallbackNotice && (
              <div className="flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50/90 px-2.5 py-1.5 rounded-lg border border-amber-200">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>遠端檔案無法連線，已自動載入本地備援單價表。</span>
              </div>
            )}

            {catalogError && (
              <div className="flex items-center gap-1.5 text-[11px] text-red-700 bg-red-50 px-2.5 py-1.5 rounded-lg border border-red-200">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{catalogError}</span>
              </div>
            )}
          </div>
        </div>

        {/* 已選入此工令的 MO 明細清單（自動依項目編號排列、無單位顯示、數量限制 1~999） */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-2xs space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>已選入工令之 MO 明細 ({sortedOrderItems.length})</span>
            </h3>

            <button
              type="button"
              onClick={() => setShowCustomForm((prev) => !prev)}
              className="text-xs font-semibold text-blue-600 hover:text-blue-800 cursor-pointer"
            >
              {showCustomForm ? '收起自訂工項' : '+ 手動新增非合約工項'}
            </button>
          </div>

          {/* 手動新增表單（已移除單位輸入框） */}
          {showCustomForm && (
            <form
              onSubmit={handleAddCustomItem}
              className="bg-slate-50 p-3 rounded-xl border border-slate-200 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs"
            >
              <input
                type="text"
                placeholder="項目編號"
                value={customCode}
                onChange={(e) => setCustomCode(e.target.value)}
                className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg"
              />
              <input
                type="text"
                required
                placeholder="項目名稱 *"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg"
              />
              <input
                type="text"
                placeholder="規格說明"
                value={customSpec}
                onChange={(e) => setCustomSpec(e.target.value)}
                className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg"
              />
              <input
                type="number"
                min="0"
                step="any"
                placeholder="單價"
                value={customPrice}
                onChange={(e) => setCustomPrice(e.target.value)}
                className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg"
              />
              <button
                type="submit"
                className="col-span-2 sm:col-span-1 bg-blue-600 text-white font-semibold rounded-lg px-3 py-1.5 hover:bg-blue-700 cursor-pointer"
              >
                加入明細
              </button>
            </form>
          )}

          {sortedOrderItems.length === 0 ? (
            <div className="text-center py-6 text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl">
              尚未加入任何 MO 明細，請從下方「合約工項資料庫」搜尋並點擊加入。
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {sortedOrderItems.map((item, idx) => (
                <div
                  key={item.id}
                  className="py-3 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                >
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-slate-400">
                        #{idx + 1}
                      </span>
                      <span className="font-mono text-xs font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200/60">
                        {item.code}
                      </span>
                      <span className="font-bold text-sm text-slate-800 truncate">
                        {item.name}
                      </span>
                    </div>
                    {/* 已刪除單位顯示，僅顯示規格與單價 */}
                    <div className="text-xs text-slate-500 flex items-center gap-3 flex-wrap">
                      {item.spec && <span>規格：{item.spec}</span>}
                      <span>單價：${item.unitPrice.toLocaleString()}</span>
                    </div>
                  </div>

                  {/* 數量控制器（最低 1，最高 999）與刪除按鈕 */}
                  <div className="flex items-center justify-between sm:justify-end gap-3">
                    <div className="flex items-center border border-slate-200 rounded-lg bg-slate-50">
                      <button
                        type="button"
                        disabled={item.quantity <= 1}
                        onClick={() =>
                          handleQuantityChange(item.id, item.quantity - 1)
                        }
                        className="p-1.5 text-slate-600 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={999}
                        step={1}
                        value={item.quantity}
                        onChange={(e) => {
                          const rawVal = e.target.value;
                          if (rawVal === '') return;
                          const val = parseInt(rawVal, 10);
                          if (!Number.isNaN(val)) {
                            handleQuantityChange(item.id, val);
                          }
                        }}
                        onBlur={(e) => {
                          const val = parseInt(e.target.value, 10);
                          handleQuantityChange(
                            item.id,
                            Number.isNaN(val) ? 1 : val
                          );
                        }}
                        className="w-14 text-center text-xs font-bold bg-white border-x border-slate-200 py-1 focus:outline-none font-mono"
                      />
                      <button
                        type="button"
                        disabled={item.quantity >= 999}
                        onClick={() =>
                          handleQuantityChange(item.id, item.quantity + 1)
                        }
                        className="p-1.5 text-slate-600 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="text-right min-w-[80px]">
                      <div className="text-xs font-bold text-slate-800 font-mono">
                        ${item.subtotal.toLocaleString()}
                      </div>
                    </div>

                    {/* 點擊垃圾桶開啟刪除確認視窗 */}
                    <button
                      type="button"
                      title="刪除此明細項目"
                      onClick={() => setDeletingItem(item)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 下方：合約資料庫搜尋與快速選取區（已刪除單位顯示） */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-2xs space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-blue-600" />
              <span>
                合約工項資料庫搜尋（共 {catalogItems.length} 筆，點擊「+ 加入」帶入明細）
              </span>
            </h3>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder="輸入項目編號、名稱或規格快速檢索..."
                className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {categories.length > 2 && (
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-700"
              >
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat === 'ALL' ? '全部工作表 / 分類' : cat}
                  </option>
                ))}
              </select>
            )}
          </div>

          {isLoadingCatalog ? (
            <div className="py-10 text-center text-xs text-slate-500">
              正在讀取並解析合約單價資料庫...
            </div>
          ) : filteredCatalog.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              {catalogItems.length === 0
                ? '目前資料庫尚無工項，請點擊上方重新載入圖示按鈕。'
                : `找不到符合「${catalogSearch}」的合約工項`}
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto divide-y divide-slate-100 pr-1">
              {filteredCatalog.map((prod, idx) => (
                <div
                  key={`${prod.code}-${idx}`}
                  className="py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50/80 px-2 rounded-lg transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                        {prod.code}
                      </span>
                      <span className="text-sm font-medium text-slate-800 truncate">
                        {prod.name}
                      </span>
                    </div>
                    {/* 已刪除單位顯示 */}
                    <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                      {prod.spec && (
                        <span className="truncate">規格：{prod.spec}</span>
                      )}
                      <span className="font-mono font-semibold text-slate-700">
                        單價：${prod.unitPrice.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleAddFromCatalog(prod)}
                    className="shrink-0 inline-flex items-center gap-1 bg-blue-50 hover:bg-blue-600 text-blue-700 hover:text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>加入</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 美化版：刪除 MO 明細項目確認視窗 (Delete Item Confirmation Modal) */}
        {deletingItem && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-slate-200 space-y-4 text-center">
              <div className="w-12 h-12 rounded-full bg-red-50 border border-red-100 flex items-center justify-center mx-auto text-red-600">
                <AlertTriangle className="w-6 h-6" />
              </div>

              <div className="space-y-1">
                <h3 className="text-base font-extrabold text-slate-800">
                  確定要刪除此明細項目嗎？
                </h3>
                <p className="text-xs text-slate-500">
                  此項目將從目前工令的 MO 明細中移除：
                </p>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-left space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                    {deletingItem.code}
                  </span>
                  <span className="text-slate-600 font-semibold">
                    數量：{deletingItem.quantity}
                  </span>
                </div>
                <div className="text-sm font-bold text-slate-800 truncate pt-0.5">
                  {deletingItem.name}
                </div>
                <div className="text-xs font-mono font-semibold text-emerald-700">
                  小計：${deletingItem.subtotal.toLocaleString()}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setDeletingItem(null)}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRemoveItem}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 shadow-xs transition-colors cursor-pointer"
                >
                  確認刪除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);
