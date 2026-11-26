// src/components/SubstationView.tsx
// ============================================================================
// 變電站單線圖管理系統 (Vite + React + TypeScript PWA 版)
// 完整轉換自使用者上傳之變電站單線圖管理系統網頁：
// - 5 項統計指標卡（總納管變電站數、11 kV、3.3 kV、480 V、納管供電轄區 7 轄區）
// - 關鍵字搜尋、電壓等級篩選、轄區篩選與重設篩選
// - 每頁 20 站響應式資料表、分頁控制
// - 新增 / 編輯變電站 Modal（含最後更新日期格式過濾與 PDF 檔名防呆）
// - 單線圖 PDF 預覽 Modal（支援 Canvas 高解析度縮放 50%~300%、開啟原檔與下載 PDF）
// ============================================================================

import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from 'react';
import type { FC, FormEvent } from 'react';
import {
  Zap,
  Plus,
  Search,
  X,
  FileText,
  Edit3,
  Download,
  ExternalLink,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { SubstationItem, VoltageLevel } from '../types';
import {
  SUBSTATION_PAGE_SIZE,
  DEFAULT_DISTRICTS,
  VOLTAGE_OPTIONS,
  getDistrictBadgeClass,
  getVoltageBadgeClass,
  toSafePdfFileName,
  getPdfCandidateFileNames,
  sanitizeVersionInput,
  filterSubstations,
  generateSingleLinePdfBytes,
  drawSingleLineDiagramToCanvas,
  subscribeSubstations,
  upsertSubstation,
} from '../substationData';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface ToastNotice {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

export const SubstationView: FC = () => {
  // 1. 變電站資料清單
  const [stations, setStations] = useState<SubstationItem[]>([]);

  // 2. 搜尋與篩選條件
  const [keyword, setKeyword] = useState<string>('');
  const [voltageFilter, setVoltageFilter] = useState<string>('ALL');
  const [districtFilter, setDistrictFilter] = useState<string>('ALL');
  const [currentPage, setCurrentPage] = useState<number>(1);

  // 3. 新增 / 編輯 Modal 狀態
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);
  const [isAddingNew, setIsAddingNew] = useState<boolean>(false);
  const [editId, setEditId] = useState<string>('');
  const [editName, setEditName] = useState<string>('');
  const [editVoltage, setEditVoltage] = useState<VoltageLevel>('11 kV');
  const [editUpdatedAt, setEditUpdatedAt] = useState<string>('');
  const [editDistrict, setEditDistrict] = useState<string>(DEFAULT_DISTRICTS[0]);
  const [editLoad, setEditLoad] = useState<string>('');
  const [editPdfFileName, setEditPdfFileName] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // 4. PDF 單線圖預覽 Modal 狀態
  const [previewStation, setPreviewStation] = useState<SubstationItem | null>(
    null
  );
  const [pdfScale, setPdfScale] = useState<number>(1.0);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string>('#');
  const [pdfDownloadName, setPdfDownloadName] = useState<string>(
    'single-line-diagram.pdf'
  );
  const [isPdfLoading, setIsPdfLoading] = useState<boolean>(false);
  const [pdfRenderVersion, setPdfRenderVersion] = useState<number>(0);

  const pdfWrapperRef = useRef<HTMLDivElement>(null);
  const pdfCanvasContainerRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfLoadingTaskRef = useRef<ReturnType<
    typeof pdfjsLib.getDocument
  > | null>(null);
  const renderTaskIdRef = useRef<number>(0);

  // 5. Toast 訊息通知
  const [toasts, setToasts] = useState<ToastNotice[]>([]);

  const showToast = useCallback(
    (message: string, type: 'success' | 'error' | 'info' = 'info') => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3000);
    },
    []
  );

  // 訂閱變電站清單（本地快取 + Firestore 同步）
  useEffect(() => {
    const unsub = subscribeSubstations((loaded) => {
      setStations(loaded);
    });
    return () => unsub();
  }, []);

  // 篩選後變電站清單
  const filteredStations = useMemo(
    () =>
      filterSubstations(stations, {
        keyword,
        voltage: voltageFilter,
        district: districtFilter,
      }),
    [stations, keyword, voltageFilter, districtFilter]
  );

  // 統計數據
  const stats = useMemo(
    () => ({
      total: stations.length,
      count11kV: stations.filter((s) => s.voltage === '11 kV').length,
      count33kV: stations.filter((s) => s.voltage === '3.3 kV').length,
      count480V: stations.filter((s) => s.voltage === '480 V').length,
      districts: DEFAULT_DISTRICTS.length,
    }),
    [stations]
  );

  // 分頁計算
  const totalPages = Math.max(
    1,
    Math.ceil(filteredStations.length / SUBSTATION_PAGE_SIZE)
  );
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * SUBSTATION_PAGE_SIZE;
  const endIdx = Math.min(
    startIdx + SUBSTATION_PAGE_SIZE,
    filteredStations.length
  );
  const pageItems = useMemo(
    () => filteredStations.slice(startIdx, endIdx),
    [filteredStations, startIdx, endIdx]
  );

  // 重設篩選
  const handleResetFilters = () => {
    setKeyword('');
    setVoltageFilter('ALL');
    setDistrictFilter('ALL');
    setCurrentPage(1);
  };

  // 開啟新增變電站視窗
  const handleOpenAddModal = () => {
    setIsAddingNew(true);
    setEditId(`station_${Date.now()}`);
    setEditName('');
    setEditVoltage('11 kV');
    setEditUpdatedAt(new Date().toISOString().slice(0, 10));
    setEditDistrict(DEFAULT_DISTRICTS[0]);
    setEditLoad('');
    setEditPdfFileName('');
    setIsEditModalOpen(true);
  };

  // 開啟編輯變電站視窗（最後更新日期帶入 station.updatedAt）
  const handleOpenEditModal = (station: SubstationItem) => {
    setIsAddingNew(false);
    setEditId(station.id);
    setEditName(station.name);
    setEditVoltage(station.voltage);
    setEditUpdatedAt(sanitizeVersionInput(String(station.updatedAt || '')));
    setEditDistrict(
      DEFAULT_DISTRICTS.includes(station.district)
        ? station.district
        : DEFAULT_DISTRICTS[0]
    );
    setEditLoad(station.load && station.load !== '-' ? station.load : '');
    setEditPdfFileName(
      (station.pdfFileName || toSafePdfFileName(station.name)).replace(
        /\//g,
        '-'
      )
    );
    setIsEditModalOpen(true);
  };

  // 儲存新增或編輯變電站（將最後更新日期存入 updatedAt 欄位）
  const handleSaveStation = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = editName.trim();
    if (!trimmedName) return;

    const cleanUpdatedAt = sanitizeVersionInput(editUpdatedAt).trim();
    const cleanLoad = editLoad.trim() || '-';

    let pdfFileName =
      editPdfFileName.trim() || toSafePdfFileName(trimmedName);
    pdfFileName = pdfFileName.replace(/\//g, '-');
    if (!pdfFileName.toLowerCase().endsWith('.pdf')) {
      pdfFileName += '.pdf';
    }

    const existing = stations.find((s) => s.id === editId);
    const updatedStation: SubstationItem = {
      id: editId,
      order: existing ? existing.order : stations.length + 1,
      name: trimmedName,
      district: editDistrict,
      load: cleanLoad,
      voltage: editVoltage,
      version: existing?.version || '1.0',
      updatedAt: cleanUpdatedAt || new Date().toISOString().slice(0, 10),
      pdfFileName,
    };

    setIsSaving(true);
    try {
      const { nextList, syncedToCloud } = await upsertSubstation(
        stations,
        updatedStation
      );
      setStations(nextList);
      setIsEditModalOpen(false);
      showToast(
        syncedToCloud
          ? `已儲存「${trimmedName}」並同步更新！`
          : `已更新「${trimmedName}」`,
        syncedToCloud ? 'success' : 'info'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`儲存失敗：${msg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // 清理現有 PDF.js 資源
  const disposePdfResources = useCallback(() => {
    if (pdfLoadingTaskRef.current) {
      void pdfLoadingTaskRef.current.destroy();
      pdfLoadingTaskRef.current = null;
    }
    pdfDocRef.current = null;
  }, []);

  // 開啟單線圖 PDF 預覽（優先讀取 public/pdfs/ 內的真實 PDF 並使用 PDF.js 高解析度渲染）
  const handleOpenPreview = async (station: SubstationItem) => {
    setPreviewStation(station);
    setPdfScale(1.0);
    setIsPdfLoading(true);
    disposePdfResources();

    const candidates = getPdfCandidateFileNames(station);
    let matchedFileName =
      candidates[0] || toSafePdfFileName(station.name);
    let pdfBytes: Uint8Array | null = null;

    for (const candidate of candidates) {
      try {
        const resp = await fetch(`/pdfs/${encodeURIComponent(candidate)}`, {
          cache: 'no-store',
        });
        if (resp.ok) {
          const contentType = resp.headers.get('content-type') || '';
          if (!contentType.includes('text/html')) {
            const buf = await resp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            // 驗證 PDF 標頭 (%PDF) 避免誤載 SPA fallback HTML
            if (
              bytes.length >= 4 &&
              bytes[0] === 0x25 &&
              bytes[1] === 0x50 &&
              bytes[2] === 0x44 &&
              bytes[3] === 0x46
            ) {
              pdfBytes = bytes;
              matchedFileName = candidate;
              break;
            }
          }
        }
      } catch {
        // 繼續嘗試下一個檔名候選
      }
    }

    if (!pdfBytes) {
      pdfBytes = generateSingleLinePdfBytes(station);
    }

    setPdfDownloadName(matchedFileName);

    const blob = new Blob([new Uint8Array(pdfBytes)], {
      type: 'application/pdf',
    });
    const url = URL.createObjectURL(blob);
    setPdfBlobUrl((prevUrl) => {
      if (prevUrl && prevUrl.startsWith('blob:')) {
        URL.revokeObjectURL(prevUrl);
      }
      return url;
    });

    try {
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
      pdfLoadingTaskRef.current = loadingTask;
      pdfDocRef.current = await loadingTask.promise;
    } catch (err) {
      console.warn('PDF.js 載入失敗，改用內建單線圖畫布渲染：', err);
      disposePdfResources();
    }

    setPdfRenderVersion((v) => v + 1);
    setIsPdfLoading(false);
  };

  // 關閉單線圖預覽並釋放 PDF 資源與 Blob URL
  const handleClosePreview = () => {
    renderTaskIdRef.current += 1;
    setPreviewStation(null);
    disposePdfResources();
    if (pdfBlobUrl && pdfBlobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(pdfBlobUrl);
    }
    setPdfBlobUrl('#');
  };

  // 當預覽檔案載入完成或縮放比例改變時，使用 PDF.js 將每一頁繪製至高解析度 Canvas
  useEffect(() => {
    if (!previewStation || isPdfLoading || !pdfCanvasContainerRef.current) {
      return;
    }

    const taskId = ++renderTaskIdRef.current;
    const container = pdfCanvasContainerRef.current;
    const wrapperWidth = Math.max(
      280,
      (pdfWrapperRef.current?.clientWidth || 800) - 24
    );
    const dpr = window.devicePixelRatio || 1;
    const currentDoc = pdfDocRef.current;

    const renderAllPages = async () => {
      container.innerHTML = '';

      if (!currentDoc) {
        const fallbackCanvas = document.createElement('canvas');
        fallbackCanvas.className =
          'bg-white shadow-xl rounded border border-slate-700 max-w-none';
        container.appendChild(fallbackCanvas);
        drawSingleLineDiagramToCanvas(
          fallbackCanvas,
          previewStation,
          pdfScale,
          wrapperWidth + 24
        );
        return;
      }

      for (let pageNum = 1; pageNum <= currentDoc.numPages; pageNum++) {
        if (renderTaskIdRef.current !== taskId) return;
        const page = await currentDoc.getPage(pageNum);
        const unscaledViewport = page.getViewport({ scale: 1 });
        const fitScale = Math.min(
          1.5,
          Math.max(0.45, wrapperWidth / unscaledViewport.width)
        );
        const finalScale = fitScale * pdfScale;
        const viewport = page.getViewport({ scale: finalScale });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) continue;

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.className =
          'bg-white shadow-xl rounded border border-slate-700 max-w-none';

        if (renderTaskIdRef.current !== taskId) return;
        container.appendChild(canvas);

        await page
          .render({
            canvasContext: context,
            canvas,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
            viewport,
          })
          .promise.catch((err: unknown) => {
            const name =
              err && typeof err === 'object' && 'name' in err
                ? String((err as { name?: unknown }).name)
                : '';
            if (name !== 'RenderingCancelledException') {
              throw err;
            }
          });
      }
    };

    void renderAllPages().catch((err: unknown) => {
      const name =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: unknown }).name)
          : '';
      if (name !== 'RenderingCancelledException') {
        console.warn('PDF 渲染中斷：', err);
      }
    });
  }, [previewStation, pdfScale, isPdfLoading, pdfRenderVersion]);

  const handleChangeZoom = (delta: number) => {
    setPdfScale((prev) =>
      Math.min(3.0, Math.max(0.5, Number((prev + delta).toFixed(2))))
    );
  };

  return (
    <div className="pb-24 space-y-4">
      {/* 系統標題與新增按鈕列 */}
      <div className="bg-slate-900 text-white rounded-2xl px-4 sm:px-6 py-3.5 flex items-center justify-between gap-2 shadow-sm border border-slate-800">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 sm:w-10 sm:h-10 shrink-0 rounded-xl bg-amber-500/15 border border-amber-400/40 flex items-center justify-center text-amber-400">
            <Zap className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-bold tracking-wide truncate">
              變電站單線圖管理系統
            </h2>
            <p className="text-[11px] text-slate-400 truncate">
              納管變電站單線圖查詢、PDF 預覽與負載維護
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleOpenAddModal}
          className="inline-flex items-center gap-1.5 px-3 sm:px-3.5 py-2 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-slate-950 transition-colors shadow-xs cursor-pointer shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>新增變電站</span>
        </button>
      </div>

      {/* 5 項統計指標列 (支援 11 kV、3.3 kV、480 V 與響應式排版) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3.5">
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-200 shadow-xs col-span-2 sm:col-span-1">
          <div className="text-xs font-medium text-slate-500">
            總納管變電站數
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl sm:text-2xl font-bold text-slate-900 font-mono tabular-nums">
              {stats.total}
            </span>
            <span className="text-[11px] text-slate-400">
              每頁 {SUBSTATION_PAGE_SIZE} 站
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-200 shadow-xs">
          <div className="text-xs font-medium text-slate-500">
            11 kV 變電站
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl sm:text-2xl font-bold text-sky-600 font-mono tabular-nums">
              {stats.count11kV}
            </span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 font-medium font-mono">
              11 kV
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-200 shadow-xs">
          <div className="text-xs font-medium text-slate-500">
            3.3 kV 變電站
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl sm:text-2xl font-bold text-teal-600 font-mono tabular-nums">
              {stats.count33kV}
            </span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 font-medium font-mono">
              3.3 kV
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-200 shadow-xs">
          <div className="text-xs font-medium text-slate-500">
            480 V 變電站
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl sm:text-2xl font-bold text-amber-600 font-mono tabular-nums">
              {stats.count480V}
            </span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium font-mono">
              480 V
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-200 shadow-xs">
          <div className="text-xs font-medium text-slate-500">
            納管供電轄區
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl sm:text-2xl font-bold text-emerald-600 font-mono tabular-nums">
              {stats.districts}
            </span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">
              {stats.districts} 轄區
            </span>
          </div>
        </div>
      </div>

      {/* 搜尋與篩選控制列 */}
      <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-200 shadow-xs space-y-3 lg:space-y-0 lg:flex lg:items-center lg:justify-between lg:gap-3">
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2.5 sm:gap-3 flex-1">
          {/* 搜尋欄位 */}
          <div className="relative col-span-2 sm:flex-1 sm:min-w-[220px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="搜尋變電站名稱、轄區、負載或最後更新日期..."
              aria-label="搜尋變電站"
              className="w-full pl-9 pr-8 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
            />
            {keyword && (
              <button
                type="button"
                aria-label="清除搜尋"
                onClick={() => {
                  setKeyword('');
                  setCurrentPage(1);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* 電壓等級下拉篩選 */}
          <div className="col-span-1 flex items-center gap-1.5">
            <label
              htmlFor="substationVoltageSelect"
              className="hidden sm:inline text-xs font-semibold text-slate-600 whitespace-nowrap"
            >
              電壓等級：
            </label>
            <select
              id="substationVoltageSelect"
              value={voltageFilter}
              onChange={(e) => {
                setVoltageFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="w-full sm:w-auto py-2 pl-2.5 pr-7 text-xs sm:text-sm font-medium border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
            >
              <option value="ALL">全部電壓</option>
              {VOLTAGE_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          {/* 轄區下拉篩選 */}
          <div className="col-span-1 flex items-center gap-1.5">
            <label
              htmlFor="substationDistrictSelect"
              className="hidden sm:inline text-xs font-semibold text-slate-600 whitespace-nowrap"
            >
              轄區：
            </label>
            <select
              id="substationDistrictSelect"
              value={districtFilter}
              onChange={(e) => {
                setDistrictFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="w-full sm:w-auto py-2 pl-2.5 pr-7 text-xs sm:text-sm font-medium border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
            >
              <option value="ALL">
                全部轄區 ({DEFAULT_DISTRICTS.length} 區)
              </option>
              {DEFAULT_DISTRICTS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between lg:justify-end gap-2 text-xs text-slate-500 pt-1 lg:pt-0 border-t border-slate-100 lg:border-0">
          <span>
            {filteredStations.length === 0
              ? '查無符合條件的變電站'
              : `顯示第 ${startIdx + 1}–${endIdx} 站，共 ${filteredStations.length} 站`}
          </span>
          <button
            type="button"
            onClick={handleResetFilters}
            className="text-sky-600 hover:text-sky-700 font-medium underline ml-2 cursor-pointer"
          >
            重設篩選
          </button>
        </div>
      </div>

      {/* 變電站單線圖清單（手機版：免橫向滾輪卡片式列表；桌面版：完整表格） */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        {/* 手機 / 平板版卡片列表 (零橫向滾動) */}
        <div className="lg:hidden divide-y divide-slate-200">
          {pageItems.length === 0 ? (
            <div className="py-12 px-4 text-center text-slate-400 text-sm">
              目前沒有符合篩選條件的變電站資料
            </div>
          ) : (
            pageItems.map((st, idx) => {
              const displayIndex = startIdx + idx + 1;
              const displayLoad =
                st.load && st.load.trim() !== '' ? st.load : '-';
              const displayUpdatedAt =
                st.updatedAt && String(st.updatedAt).trim() !== ''
                  ? st.updatedAt
                  : '-';

              return (
                <div
                  key={st.id}
                  className="p-3.5 space-y-2.5 active:bg-slate-50/80 transition-colors"
                >
                  {/* 第一列：序號 + 電壓 + 變電站名稱 | 右側轄區標籤 */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-slate-400 font-mono tabular-nums shrink-0">
                        {String(displayIndex).padStart(2, '0')}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold font-mono shrink-0 ${getVoltageBadgeClass(
                          st.voltage
                        )}`}
                      >
                        {st.voltage}
                      </span>
                      <span className="font-bold text-slate-900 text-sm truncate">
                        {st.name}
                      </span>
                    </div>

                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold shrink-0 ${getDistrictBadgeClass(
                        st.district
                      )}`}
                    >
                      {st.district}
                    </span>
                  </div>

                  {/* 第二列：負載與最後更新日期 (updatedAt) */}
                  <div className="bg-slate-50 rounded-lg px-3 py-2 text-xs space-y-1 border border-slate-100">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-slate-500 shrink-0">負載</span>
                      <span className="text-slate-700 text-right wrap-break-word min-w-0">
                        {displayLoad}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-slate-500 shrink-0">
                        最後更新日期
                      </span>
                      <span className="font-semibold text-slate-800 font-mono tabular-nums">
                        {displayUpdatedAt}
                      </span>
                    </div>
                  </div>

                  {/* 第三列：單線圖 PDF 預覽按鈕與編輯按鈕 */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleOpenPreview(st)}
                      className="flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-rose-50 hover:bg-rose-100 active:bg-rose-200 text-rose-700 border border-rose-200 transition-colors cursor-pointer touch-manipulation"
                    >
                      <FileText className="w-4 h-4 text-rose-600 shrink-0" />
                      <span className="font-mono truncate">
                        {st.pdfFileName}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenEditModal(st)}
                      className="shrink-0 inline-flex items-center justify-center gap-1 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-sky-600 active:bg-sky-700 text-white transition-colors shadow-xs cursor-pointer touch-manipulation"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>編輯</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 桌面版完整 7 欄表格 */}
        <div className="hidden lg:block overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-slate-800 text-slate-100 text-xs uppercase tracking-wider">
                <th className="py-3.5 px-3 font-semibold w-14 text-center whitespace-nowrap">
                  序號
                </th>
                <th className="py-3.5 px-4 font-semibold w-48 text-center whitespace-nowrap">
                  變電站名稱
                </th>
                <th className="py-3.5 px-3 font-semibold w-28 text-center whitespace-nowrap">
                  轄區
                </th>
                <th className="py-3.5 px-4 font-semibold min-w-[280px] w-1/3 text-center whitespace-nowrap">
                  負載
                </th>
                <th className="py-3.5 px-3 font-semibold text-center whitespace-nowrap">
                  單線圖 (點擊預覽 PDF)
                </th>
                <th className="py-3.5 px-3 font-semibold text-center whitespace-nowrap">
                  最後更新日期
                </th>
                <th className="py-3.5 px-3 font-semibold text-center whitespace-nowrap w-24">
                  編輯
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {pageItems.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-12 text-center text-slate-400 text-sm"
                  >
                    目前沒有符合篩選條件的變電站資料
                  </td>
                </tr>
              ) : (
                pageItems.map((st, idx) => {
                  const displayIndex = startIdx + idx + 1;
                  const displayLoad =
                    st.load && st.load.trim() !== '' ? st.load : '-';
                  const displayUpdatedAt =
                    st.updatedAt && String(st.updatedAt).trim() !== ''
                      ? st.updatedAt
                      : '-';

                  return (
                    <tr
                      key={st.id}
                      className="hover:bg-slate-50/90 transition-colors"
                    >
                      <td className="py-3 px-3 text-center font-semibold text-slate-500 font-mono tabular-nums whitespace-nowrap">
                        {String(displayIndex).padStart(2, '0')}
                      </td>
                      <td className="py-3 px-4 text-left whitespace-nowrap">
                        <div className="flex items-center justify-start gap-2">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold font-mono shrink-0 ${getVoltageBadgeClass(
                              st.voltage
                            )}`}
                          >
                            {st.voltage}
                          </span>
                          <span className="font-semibold text-slate-900">
                            {st.name}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold ${getDistrictBadgeClass(
                            st.district
                          )}`}
                        >
                          {st.district}
                        </span>
                      </td>
                      <td
                        className="py-3 px-4 text-left text-slate-700 min-w-[280px] w-1/3 wrap-break-word"
                        title={displayLoad}
                      >
                        {displayLoad}
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void handleOpenPreview(st)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-50 hover:bg-rose-100 active:bg-rose-200 text-rose-700 border border-rose-200 transition-colors cursor-pointer group"
                        >
                          <FileText className="w-4 h-4 text-rose-600 group-hover:scale-110 transition-transform shrink-0" />
                          <span className="font-mono">{st.pdfFileName}</span>
                        </button>
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        <span className="font-semibold text-slate-800 font-mono tabular-nums">
                          {displayUpdatedAt}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleOpenEditModal(st)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-sky-600 active:bg-sky-700 text-white transition-colors shadow-xs cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>編輯</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分頁控制列 (固定每頁 20 站) */}
        <div className="bg-slate-50 px-3 sm:px-4 py-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-slate-600">
            每頁 <span className="font-bold text-slate-900">20</span> 站 · 第{' '}
            <span className="font-bold text-slate-900 tabular-nums">
              {safePage}
            </span>{' '}
            /{' '}
            <span className="font-bold text-slate-900 tabular-nums">
              {totalPages}
            </span>{' '}
            頁
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={safePage === 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className="px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              上一頁
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setCurrentPage(p)}
                className={`w-8 h-8 rounded-lg text-xs font-bold font-mono transition-colors cursor-pointer ${
                  p === safePage
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-100'
                }`}
              >
                {p}
              </button>
            ))}
            <button
              type="button"
              disabled={safePage === totalPages}
              onClick={() =>
                setCurrentPage((p) => Math.min(totalPages, p + 1))
              }
              className="px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              下一頁
            </button>
          </div>
        </div>
      </div>

      {/* 視窗 1：PDF 單線圖預覽 Modal */}
      {previewStation && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-xs z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden">
            {/* 頂部標題與操作列 */}
            <div className="bg-slate-900 text-white px-3.5 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="shrink-0 px-2 py-0.5 rounded text-xs font-bold font-mono bg-sky-500/20 text-sky-300 border border-sky-400/30">
                  {previewStation.voltage}
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm sm:text-base font-bold truncate">
                    {previewStation.name} — 單線圖預覽
                  </h3>
                  <p className="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                    轄區：{previewStation.district} | 負載：
                    {previewStation.load || '-'} | 最後更新日期：
                    {previewStation.updatedAt || '-'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 sm:gap-2 ml-auto">
                {/* 縮放控制按鈕 */}
                <div className="inline-flex items-center bg-slate-800 rounded-lg border border-slate-700 p-0.5">
                  <button
                    type="button"
                    onClick={() => handleChangeZoom(-0.25)}
                    className="px-2 py-1 text-xs font-bold text-slate-200 hover:bg-slate-700 rounded cursor-pointer"
                    title="縮小"
                    aria-label="縮小"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span className="px-2 text-[11px] font-mono tabular-nums text-slate-300">
                    {Math.round(pdfScale * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => handleChangeZoom(0.25)}
                    className="px-2 py-1 text-xs font-bold text-slate-200 hover:bg-slate-700 rounded cursor-pointer"
                    title="放大"
                    aria-label="放大"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                </div>

                <a
                  href={pdfBlobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>開啟原檔</span>
                </a>
                <a
                  href={pdfBlobUrl}
                  download={pdfDownloadName}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">下載 PDF</span>
                </a>
                <button
                  type="button"
                  aria-label="關閉預覽"
                  onClick={handleClosePreview}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* PDF 畫布檢視容器 */}
            <div
              ref={pdfWrapperRef}
              className="flex-1 bg-slate-800 relative overflow-auto"
            >
              {isPdfLoading && (
                <div className="absolute inset-0 bg-slate-900/80 z-10 flex flex-col items-center justify-center text-white gap-3">
                  <div className="w-9 h-9 border-4 border-sky-400 border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs sm:text-sm font-medium">
                    正在載入單線圖 PDF...
                  </p>
                </div>
              )}
              <div
                ref={pdfCanvasContainerRef}
                className="min-h-full p-2 sm:p-6 flex flex-col items-center gap-4"
              />
            </div>
          </div>
        </div>
      )}

      {/* 視窗 2：新增 / 編輯變電站 Modal */}
      {isEditModalOpen && (
        <div className="fixed inset-0 bg-slate-900/75 backdrop-blur-xs z-50 flex items-center justify-center p-2.5 sm:p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden">
            <div className="bg-slate-900 text-white px-4 sm:px-5 py-3.5 flex items-center justify-between">
              <h3 className="text-sm sm:text-base font-bold">
                {isAddingNew
                  ? '新增變電站'
                  : `編輯變電站資訊 — ${editName || ''}`}
              </h3>
              <button
                type="button"
                aria-label="關閉編輯視窗"
                onClick={() => setIsEditModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => void handleSaveStation(e)}
              className="p-4 sm:p-5 space-y-4"
            >
              {/* 第一列：變電站名稱、電壓等級、最後更新日期 (updatedAt) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label
                    htmlFor="editStationNameInput"
                    className="block text-xs font-semibold text-slate-700 mb-1 truncate"
                  >
                    變電站名稱 *
                  </label>
                  <input
                    id="editStationNameInput"
                    type="text"
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="例如：2KB 1/2"
                    className="w-full px-2.5 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  />
                </div>
                <div className="col-span-1">
                  <label
                    htmlFor="editVoltageInput"
                    className="block text-xs font-semibold text-slate-700 mb-1 truncate"
                  >
                    電壓等級 *
                  </label>
                  <select
                    id="editVoltageInput"
                    value={editVoltage}
                    onChange={(e) =>
                      setEditVoltage(e.target.value as VoltageLevel)
                    }
                    className="w-full px-2 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  >
                    {VOLTAGE_OPTIONS.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-1">
                  <label
                    htmlFor="editUpdatedAtInput"
                    className="block text-xs font-semibold text-slate-700 mb-1 truncate"
                  >
                    最後更新日期 *
                  </label>
                  <input
                    id="editUpdatedAtInput"
                    type="text"
                    inputMode="numeric"
                    required
                    value={editUpdatedAt}
                    onChange={(e) =>
                      setEditUpdatedAt(sanitizeVersionInput(e.target.value))
                    }
                    placeholder="例如：2026-11-25"
                    title="僅限輸入日期數字與符號"
                    className="w-full px-2.5 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* 第二列：轄區 (1格寬)、負載 (2格寬) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label
                    htmlFor="editDistrictInput"
                    className="block text-xs font-semibold text-slate-700 mb-1 truncate"
                  >
                    轄區 *
                  </label>
                  <select
                    id="editDistrictInput"
                    required
                    value={editDistrict}
                    onChange={(e) => setEditDistrict(e.target.value)}
                    className="w-full px-2 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  >
                    {DEFAULT_DISTRICTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label
                    htmlFor="editLoadInput"
                    className="block text-xs font-semibold text-slate-700 mb-1 truncate"
                  >
                    負載
                  </label>
                  <input
                    id="editLoadInput"
                    type="text"
                    value={editLoad}
                    onChange={(e) => setEditLoad(e.target.value)}
                    placeholder="請輸入供電負載設備或饋線範圍..."
                    className="w-full px-2.5 py-2 text-xs sm:text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* 第三列：單線圖 PDF 檔案名稱 */}
              <div>
                <label
                  htmlFor="editPdfFileNameInput"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  單線圖 PDF 檔案名稱 *
                </label>
                <div className="flex items-center">
                  <span className="px-2.5 py-2 text-xs font-mono bg-slate-100 border border-r-0 border-slate-300 rounded-l-lg text-slate-500">
                    ./pdfs/
                  </span>
                  <input
                    id="editPdfFileNameInput"
                    type="text"
                    required
                    value={editPdfFileName}
                    onChange={(e) => setEditPdfFileName(e.target.value)}
                    placeholder="2KB 1-2.pdf"
                    className="w-full px-2.5 py-2 text-xs sm:text-sm border border-slate-300 rounded-r-lg font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                  />
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  注意：PDF 檔案名稱請勿包含斜線「/」，建議以「-」代替（例如：2KB 1-2.pdf）。
                </p>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(false)}
                  className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {isSaving ? '儲存中...' : '儲存變更'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast 提示訊息容器 */}
      {toasts.length > 0 && (
        <div className="fixed bottom-20 right-4 left-4 sm:left-auto z-50 space-y-2 flex flex-col items-end pointer-events-none">
          {toasts.map((t) => {
            const colorClass =
              t.type === 'success'
                ? 'bg-emerald-900 text-white border-emerald-700'
                : t.type === 'error'
                ? 'bg-rose-900 text-white border-rose-700'
                : 'bg-slate-900 text-white border-slate-700';
            return (
              <div
                key={t.id}
                className={`px-4 py-2.5 rounded-xl shadow-lg border text-xs font-medium flex items-center gap-2 pointer-events-auto ${colorClass}`}
              >
                <span>{t.message}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
