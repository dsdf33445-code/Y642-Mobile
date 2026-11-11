// src/constants.ts
// ============================================================================
// 系統常數、多合約資料庫設定、/products.csv 雙編碼解析引擎與 Excel 匯出工具
// 1. 自動偵測 UTF-8 與 Big5 (CP950) 編碼，徹底解決 /products.csv 亂碼或載入 0 筆問題
// 2. 支援表頭關鍵字比對 + 位置自動推斷雙重機制，相容任何 CSV / Excel 欄位格式
// 3. 提供單筆工令與多筆合併工令的 Excel (.xlsx / .csv) 匯出功能
// ============================================================================

import type { ContractConfig, ContractProductItem, WorkOrder, MoLineItem } from './types';

/**
 * 動態解析靜態資源路徑（相容根目錄 / 與子路徑部署）
 */
export const resolveLocalAssetUrl = (path: string): string => {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const base = import.meta.env.BASE_URL || '/';
  const cleanBase = base.endsWith('/') ? base : `${base}/`;
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `${cleanBase}${cleanPath}`;
};

/**
 * 多重合約資料庫清單
 */
export const CONTRACT_DATABASES: ContractConfig[] = [
  {
    id: 'contract-default',
    name: '協茂',
    contractCode: 'STD-01',
    githubExcelUrl: '/products_01.csv',
    fallbackLocalUrl: '/products_01.csv',
  },
  {
    id: 'contract-electrical-2026',
    name: '總部大樓低壓電氣設備維修保養',
    contractCode: 'ELEC-115',
    githubExcelUrl: '/products_02.csv',
    fallbackLocalUrl: '/products_02.csv',
  },
];

/**
 * 本地儲存 (LocalStorage) 的 Key 常數定義
 */
export const STORAGE_KEYS = {
  CURRENT_USER: 'mobile_mo_current_user_v2',
  WORK_ORDERS_PREFIX: 'mobile_mo_work_orders_v2_',
};

/**
 * 動態載入之 SheetJS 介面定義（不需安裝於 package.json，直接於瀏覽器端載入）
 */
interface SheetJsRuntime {
  read: (
    data: ArrayBuffer,
    opts?: { type: string; codepage?: number }
  ) => {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_json: <T>(
      worksheet: unknown,
      opts?: { header?: number; defval?: string }
    ) => T[];
    json_to_sheet: (data: Record<string, unknown>[]) => unknown;
    aoa_to_sheet: (data: unknown[][]) => unknown;
    book_new: () => unknown;
    book_append_sheet: (wb: unknown, ws: unknown, name: string) => void;
  };
  writeFile: (wb: unknown, filename: string) => void;
}

/**
 * 載入瀏覽器端 SheetJS 模組
 */
export const loadSheetJs = async (): Promise<SheetJsRuntime> => {
  const sheetJsUrl = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
  return (await import(
    /* @vite-ignore */ sheetJsUrl
  )) as unknown as SheetJsRuntime;
};

/**
 * 將 ArrayBuffer 自動識別編碼（UTF-8 或台灣 Excel 預設的 Big5）並轉為字串
 * 徹底解決 /products.csv 因 Big5 編碼導致中文變亂碼而載入 0 筆的問題
 */
export const decodeArrayBufferAuto = (buffer: ArrayBuffer): string => {
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    return utf8Decoder.decode(buffer);
  } catch {
    try {
      const big5Decoder = new TextDecoder('big5');
      return big5Decoder.decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
};

/**
 * 判斷字串是否為純數值（允許千分位逗號、貨幣符號與小數點）
 */
const parseNumericValue = (val: string): number | null => {
  const cleaned = val.replace(/[$,，NT元\s]/g, '').trim();
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

/**
 * 常見工程計價單位集合（用於無標題或特殊標題時的欄位位置自動推斷）
 */
const COMMON_UNITS = new Set([
  '式', 'm', 'm2', 'm3', 'pc', 'pcs', 'set', 'ea', 'kg', 'ton', 'l',
  '組', '只', '具', '處', '公尺', '米', '平方公尺', '立方公尺', '公噸',
  '噸', '公斤', '公升', '套', '支', '塊', '盞', '台', '項', '天', '工',
  '車', '尺', '吋', '批', '點', '迴', '戶', '座', '扇', '片', '條', '卷', '箱',
]);

/**
 * 將二維陣列（來自 CSV 或 Excel 工作表）智慧轉換為合約工項陣列
 * 同時支援「標準表頭名稱對應」與「無表頭/特殊表頭位置自動推斷」
 */
export const convertMatrixToProducts = (
  rows: string[][],
  sourceCategory = '預設單價表'
): ContractProductItem[] => {
  const nonEmptyRows = rows
    .map((r) => r.map((cell) => String(cell ?? '').replace(/^\uFEFF/, '').trim()))
    .filter((r) => r.some((cell) => cell !== ''));

  if (nonEmptyRows.length === 0) return [];

  // 1. 尋找表頭列（掃描前 10 列，找出包含關鍵字或欄位數 >= 2 的第一列）
  let headerRowIndex = 0;
  const headerKeywords = [
    'code', 'id', 'item', 'no', '項次', '料號', '編號', '代號', '代碼', '工項編號',
    'name', 'title', 'description', 'product', '名稱', '品名', '工項', '項目', '內容', '說明',
    'spec', 'specification', 'model', '規格', '規範', '型號', '尺寸',
    'unit', 'uom', '單位',
    'price', 'cost', 'amount', '單價', '價格', '金額', '複價', '契約', '合約',
  ];

  for (let i = 0; i < Math.min(10, nonEmptyRows.length); i++) {
    const rowLower = nonEmptyRows[i].map((c) => c.toLowerCase());
    const matchCount = rowLower.filter((cell) =>
      headerKeywords.some((kw) => cell.includes(kw))
    ).length;
    if (matchCount >= 2) {
      headerRowIndex = i;
      break;
    }
  }

  const headerCells = nonEmptyRows[headerRowIndex].map((c) => c.toLowerCase());

  // 判斷第 headerRowIndex 列是否真的是表頭（若該列含有純數字單價，代表第 0 列直接就是資料列！）
  const isFirstRowActuallyData =
    headerRowIndex === 0 &&
    !headerCells.some((c) => headerKeywords.some((kw) => c.includes(kw))) &&
    headerCells.some((c) => parseNumericValue(c) !== null);

  const startDataIndex = isFirstRowActuallyData ? 0 : headerRowIndex + 1;

  // 2. 找出各欄位索引
  const findColIdx = (candidates: string[]): number => {
    if (isFirstRowActuallyData) return -1;
    // 先進行精準相等比對
    for (const cand of candidates) {
      const idx = headerCells.findIndex((h) => h === cand);
      if (idx !== -1) return idx;
    }
    // 再進行包含比對
    for (const cand of candidates) {
      const idx = headerCells.findIndex((h) => h.includes(cand));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const codeIdx = findColIdx(['料號', '工項編號', '代號', '編號', '代碼', '項次', 'code', 'id', 'no', 'item']);
  const nameIdx = findColIdx(['工項名稱', '項目名稱', '工作項目', '品名', '名稱', '工項', '項目', '內容', 'name', 'title', 'product', 'description']);
  const specIdx = findColIdx(['規格', '規範', '型號', '尺寸', '說明', '備註', 'spec', 'model', 'specification']);
  const unitIdx = findColIdx(['計價單位', '單位', 'unit', 'uom']);
  const priceIdx = findColIdx(['合約單價', '契約單價', '發包單價', '單價', '價格', '複價', '金額', 'unitprice', 'unit_price', 'price', 'cost', 'amount']);
  const catIdx = findColIdx(['分類', '類別', '群組', '分項', 'category', 'type', 'group']);

  const items: ContractProductItem[] = [];

  for (let r = startDataIndex; r < nonEmptyRows.length; r++) {
    const row = nonEmptyRows[r];
    if (row.every((c) => c === '')) continue;

    let code = codeIdx !== -1 ? row[codeIdx] || '' : '';
    let name = nameIdx !== -1 ? row[nameIdx] || '' : '';
    let spec = specIdx !== -1 ? row[specIdx] || '' : '';
    let unit = unitIdx !== -1 ? row[unitIdx] || '' : '';
    let priceVal: number | null =
      priceIdx !== -1 && row[priceIdx] ? parseNumericValue(row[priceIdx]) : null;
    const category =
      catIdx !== -1 && row[catIdx] ? row[catIdx] : sourceCategory;

    // 3. 【位置自動推斷保底機制】：若表頭未命中導致沒有名稱或單價，自動依儲存格特徵推斷
    if (!name || priceVal === null) {
      const usedIndices = new Set<number>();
      if (codeIdx !== -1) usedIndices.add(codeIdx);
      if (nameIdx !== -1) usedIndices.add(nameIdx);
      if (specIdx !== -1) usedIndices.add(specIdx);
      if (unitIdx !== -1) usedIndices.add(unitIdx);
      if (priceIdx !== -1) usedIndices.add(priceIdx);

      // (a) 推斷單價欄位（從右往左找第一個合理數值欄）
      if (priceVal === null) {
        for (let c = row.length - 1; c >= 0; c--) {
          if (usedIndices.has(c)) continue;
          const num = parseNumericValue(row[c]);
          if (num !== null && num >= 0) {
            // 若全列只有第 0 欄是數字，第 0 欄通常是項次而非單價
            if (c === 0 && row.length > 2) continue;
            priceVal = num;
            usedIndices.add(c);
            break;
          }
        }
      }

      // (b) 推斷單位欄位
      if (!unit) {
        for (let c = 0; c < row.length; c++) {
          if (usedIndices.has(c)) continue;
          const cellVal = row[c].toLowerCase();
          if (COMMON_UNITS.has(cellVal) || (row[c].length === 1 && /[\u4e00-\u9fa5]/.test(row[c]))) {
            unit = row[c];
            usedIndices.add(c);
            break;
          }
        }
      }

      // (c) 推斷代號/項次與工項名稱
      const remainingTextCols: { idx: number; text: string }[] = [];
      for (let c = 0; c < row.length; c++) {
        if (!usedIndices.has(c) && row[c] !== '') {
          remainingTextCols.push({ idx: c, text: row[c] });
        }
      }

      if (!code && remainingTextCols.length >= 2) {
        // 第一個較短的欄位視為項次/料號
        if (remainingTextCols[0].text.length <= 16) {
          code = remainingTextCols[0].text;
          remainingTextCols.shift();
        }
      }

      if (!name && remainingTextCols.length > 0) {
        name = remainingTextCols[0].text;
        remainingTextCols.shift();
      }

      if (!spec && remainingTextCols.length > 0) {
        spec = remainingTextCols.map((col) => col.text).join(' / ');
      }
    }

    // 過濾純表頭重複列或完全無效的空列
    if (!name && (priceVal === null || priceVal === 0)) {
      continue;
    }
    if (name === '名稱' || name === '品名' || name === '工項名稱' || name.toLowerCase() === 'name') {
      continue;
    }

    items.push({
      code: code || `${ r - startDataIndex + 1 }`,
      name: name || `工項 #${r - startDataIndex + 1}`,
      spec: spec || '',
      unit: unit || '式',
      unitPrice: priceVal !== null && priceVal >= 0 ? priceVal : 0,
      category,
    });
  }

  return items;
};

/**
 * 解析 CSV 字串為二維陣列（支援雙引號、換行與逗號/Tab 分隔）
 */
export const parseCsvToMatrix = (csvText: string): string[][] => {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  const cleanText = csvText.replace(/^\uFEFF/, '');

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    const nextCh = cleanText[i + 1];

    if (inQuotes) {
      if (ch === '"' && nextCh === '"') {
        currentCell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentCell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentCell.trim());
        currentCell = '';
      } else if (ch === '\r' && nextCh === '\n') {
        currentRow.push(currentCell.trim());
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        currentRow.push(currentCell.trim());
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
      } else {
        currentCell += ch;
      }
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }

  return rows;
};

/**
 * 從指定合約設定讀取並解析 GitHub Excel (.xlsx / .xls) 或本地 /products.csv
 */
export const fetchContractProducts = async (
  contract: ContractConfig
): Promise<{ items: ContractProductItem[]; isFallback: boolean; loadedUrl: string }> => {
  const tryFetchBuffer = async (rawUrl: string): Promise<{ buffer: ArrayBuffer; url: string }> => {
    const resolvedUrl = resolveLocalAssetUrl(rawUrl);
    const response = await fetch(resolvedUrl, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: 無法讀取 ${resolvedUrl}`);
    }
    const buffer = await response.arrayBuffer();
    return { buffer, url: resolvedUrl };
  };

  let buffer: ArrayBuffer;
  let loadedUrl: string;
  let isFallback = false;

  try {
    const res = await tryFetchBuffer(contract.githubExcelUrl);
    buffer = res.buffer;
    loadedUrl = res.url;
  } catch (err) {
    console.warn(`讀取 [${contract.githubExcelUrl}] 失敗，切換至備援 /products.csv：`, err);
    const fallbackPath = contract.fallbackLocalUrl || '/products.csv';
    const res = await tryFetchBuffer(fallbackPath);
    buffer = res.buffer;
    loadedUrl = res.url;
    isFallback = contract.githubExcelUrl !== fallbackPath;
  }

  // 檢查檔案前 4 個 Bytes 是否為 ZIP/XLSX 或 OLE/XLS 二進位檔頭
  const uint8 = new Uint8Array(buffer.slice(0, 4));
  const isZipXlsx = uint8[0] === 0x50 && uint8[1] === 0x4b; // 'PK' (.xlsx)
  const isOleXls = uint8[0] === 0xd0 && uint8[1] === 0xcf; // OLE2 (.xls)

  if (!isZipXlsx && !isOleXls) {
    // 為 CSV 純文字檔案（自動處理 UTF-8 與 Big5 編碼）
    const csvText = decodeArrayBufferAuto(buffer);
    // 防呆：若因為 SPA 路由回傳了 index.html，拋出錯誤提示
    if (csvText.trim().toLowerCase().startsWith('<!doctype html')) {
      throw new Error('讀取到 HTML 頁面而非 CSV 資料，請確認 public/products.csv 檔案是否存在。');
    }
    const matrix = parseCsvToMatrix(csvText);
    const items = convertMatrixToProducts(matrix, contract.contractCode);
    return { items, isFallback, loadedUrl };
  }

  // 為 .xlsx 或 .xls 二進位檔案，使用動態 SheetJS 解析所有工作表
  const XLSX = await loadSheetJs();
  const workbook = XLSX.read(buffer, { type: 'array', codepage: 65001 });
  const allItems: ContractProductItem[] = [];

  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) return;
    // 以 header: 1 取得原始二維陣列，交由智慧推斷引擎處理
    const matrix = XLSX.utils.sheet_to_json<string[]>(worksheet, {
      header: 1,
      defval: '',
    });
    const sheetItems = convertMatrixToProducts(matrix, sheetName);
    allItems.push(...sheetItems);
  });

  return { items: allItems, isFallback, loadedUrl };
};

/**
 * 合併多筆工令的 MO 明細項目（相同料號+名稱自動累加數量並重算小計）
 */
export const mergeMoLineItems = (orders: WorkOrder[]): MoLineItem[] => {
  const mergedMap = new Map<string, MoLineItem>();

  orders.forEach((order) => {
    order.items.forEach((item) => {
      const key = `${item.code.trim()}__${item.name.trim()}__${item.unitPrice}`;
      const existing = mergedMap.get(key);
      if (existing) {
        const nextQty = Number((existing.quantity + item.quantity).toFixed(2));
        mergedMap.set(key, {
          ...existing,
          quantity: nextQty,
          subtotal: Math.round(existing.unitPrice * nextQty),
        });
      } else {
        mergedMap.set(key, {
          ...item,
          id: `merged-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        });
      }
    });
  });

  return Array.from(mergedMap.values());
};

/**
 * 匯出單筆或多筆工令為 Excel (.xlsx)，若處於離線環境則自動匯出為含 UTF-8 BOM 的 Excel CSV
 */
export const exportWorkOrdersToExcel = async (
  orders: WorkOrder[],
  filenamePrefix = 'MO工令明細'
): Promise<void> => {
  if (orders.length === 0) return;

  const isSingle = orders.length === 1;
  const mergedItems = isSingle ? orders[0].items : mergeMoLineItems(orders);
  const totalSum = mergedItems.reduce((sum, i) => sum + i.subtotal, 0);
  const woTitle = isSingle
    ? `${orders[0].woNumber}_${orders[0].title}`
    : `合併工令(${orders.map((o) => o.woNumber).join('+')})`;

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeFilename = `${filenamePrefix}_${woTitle.replace(/[\\/:*?"<>|]/g, '_')}_${dateStr}`;

  // 組裝報表二維陣列資料
  const sheetRows: (string | number)[][] = [
    ['工令編號', orders.map((o) => o.woNumber).join(', '), '建立人員', orders[0].ownerName || orders[0].ownerId],
    ['工程案名', orders.map((o) => o.title).join(' / '), '匯出日期', new Date().toLocaleDateString('zh-TW')],
    ['施工位置', orders.map((o) => o.location || '-').join(', '), '總計金額', totalSum],
    [],
    ['項次', '料號 / 代號', '工項名稱', '規格說明', '單位', '單價', '數量', '複價 (小計)', '備註'],
  ];

  mergedItems.forEach((item, index) => {
    sheetRows.push([
      index + 1,
      item.code,
      item.name,
      item.spec || '',
      item.unit,
      item.unitPrice,
      item.quantity,
      item.subtotal,
      item.remark || '',
    ]);
  });

  sheetRows.push([]);
  sheetRows.push(['', '', '', '', '', '', '總計金額', totalSum, '']);

  try {
    const XLSX = await loadSheetJs();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    XLSX.utils.book_append_sheet(wb, ws, 'MO工令明細');

    // 若為多筆工令合併匯出，額外附上「各工令原始明細」分頁
    if (orders.length > 1) {
      const breakdownRows: (string | number)[][] = [
        ['來源工令編號', '來源工令案名', '料號 / 代號', '工項名稱', '規格', '單位', '單價', '數量', '小計'],
      ];
      orders.forEach((o) => {
        o.items.forEach((it) => {
          breakdownRows.push([
            o.woNumber,
            o.title,
            it.code,
            it.name,
            it.spec || '',
            it.unit,
            it.unitPrice,
            it.quantity,
            it.subtotal,
          ]);
        });
      });
      const wsBreakdown = XLSX.utils.aoa_to_sheet(breakdownRows);
      XLSX.utils.book_append_sheet(wb, wsBreakdown, '各工令原始明細');
    }

    XLSX.writeFile(wb, `${safeFilename}.xlsx`);
  } catch (err) {
    console.warn('無法載入線上 SheetJS，自動以 UTF-8 BOM CSV 格式匯出 Excel：', err);
    // 備援：輸出帶有 \uFEFF BOM 的 CSV，Excel 直接雙擊打開不會亂碼
    const csvContent =
      '\uFEFF' +
      sheetRows
        .map((row) =>
          row
            .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
            .join(',')
        )
        .join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFilename}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
};