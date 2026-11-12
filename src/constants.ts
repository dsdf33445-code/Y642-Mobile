// src/constants.ts
// ============================================================================
// 系統常數、多合約資料庫設定、CSV 雙編碼解析引擎與特定格式 Excel 匯出工具
// ============================================================================

import type {
  ContractConfig,
  ContractProductItem,
  WorkOrder,
  MoLineItem,
} from './types';

/**
 * 1. 「前往 MO」按鈕點擊後跳轉的目標網址
 */
export const MO_SYSTEM_URL: string =
  import.meta.env.VITE_MO_SYSTEM_URL || 'https://mwweb.csc.com.tw/MIS/MO/MO_W6X_WebSite/MOXD/MOAUXD.aspx';

/**
 * 2. 「選擇合約」下拉選單清單（對應 public/products_01.csv 與 public/products_02.csv）
 */
export const CONTRACT_DATABASES: ContractConfig[] = [
  {
    id: 'contract-1',
    name: '協茂',
    contractCode: 'C01',
    githubExcelUrl: '/products_01.csv',
    fallbackLocalUrl: '/products_01.csv',
  },
  {
    id: 'contract-2',
    name: '總部大樓低壓設備電氣維修保養',
    contractCode: 'C02',
    githubExcelUrl: '/products_02.csv',
    fallbackLocalUrl: '/products_02.csv',
  },
];

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
 * 本地儲存 (LocalStorage) 的 Key 常數定義
 */
export const STORAGE_KEYS = {
  CURRENT_USER: 'mobile_mo_google_user_v3',
  WORK_ORDERS_PREFIX: 'mobile_mo_work_orders_v3_',
};

/**
 * 動態載入之 SheetJS 介面定義
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
 * 將 ArrayBuffer 自動識別編碼（UTF-8 或 Big5）並轉為字串
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
 * 判斷字串是否為純數值
 */
const parseNumericValue = (val: string): number | null => {
  const cleaned = val.replace(/[$,，NT元\s]/g, '').trim();
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

/**
 * 常見工程計價單位集合
 */
const COMMON_UNITS = new Set([
  '式', 'm', 'm2', 'm3', 'pc', 'pcs', 'set', 'ea', 'kg', 'ton', 'l',
  '組', '只', '具', '處', '公尺', '米', '平方公尺', '立方公尺', '公噸',
  '噸', '公斤', '公升', '套', '支', '塊', '盞', '台', '項', '天', '工',
  '車', '尺', '吋', '批', '點', '迴', '戶', '座', '扇', '片', '條', '卷', '箱',
]);

/**
 * 將二維陣列（來自 CSV 或 Excel 工作表）智慧轉換為合約工項陣列
 */
export const convertMatrixToProducts = (
  rows: string[][],
  sourceCategory = '預設單價表'
): ContractProductItem[] => {
  const nonEmptyRows = rows
    .map((r) =>
      r.map((cell) => String(cell ?? '').replace(/^\uFEFF/, '').trim())
    )
    .filter((r) => r.some((cell) => cell !== ''));

  if (nonEmptyRows.length === 0) return [];

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

  const isFirstRowActuallyData =
    headerRowIndex === 0 &&
    !headerCells.some((c) => headerKeywords.some((kw) => c.includes(kw))) &&
    headerCells.some((c) => parseNumericValue(c) !== null);

  const startDataIndex = isFirstRowActuallyData ? 0 : headerRowIndex + 1;

  const findColIdx = (candidates: string[]): number => {
    if (isFirstRowActuallyData) return -1;
    for (const cand of candidates) {
      const idx = headerCells.findIndex((h) => h === cand);
      if (idx !== -1) return idx;
    }
    for (const cand of candidates) {
      const idx = headerCells.findIndex((h) => h.includes(cand));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const codeIdx = findColIdx(['項目編號', '料號', '工項編號', '代號', '編號', '代碼', '項次', 'code', 'id', 'no', 'item']);
  const nameIdx = findColIdx(['項目名稱', '工項名稱', '工作項目', '品名', '名稱', '工項', '項目', '內容', 'name', 'title', 'product', 'description']);
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

    if (!name || priceVal === null) {
      const usedIndices = new Set<number>();
      if (codeIdx !== -1) usedIndices.add(codeIdx);
      if (nameIdx !== -1) usedIndices.add(nameIdx);
      if (specIdx !== -1) usedIndices.add(specIdx);
      if (unitIdx !== -1) usedIndices.add(unitIdx);
      if (priceIdx !== -1) usedIndices.add(priceIdx);

      if (priceVal === null) {
        for (let c = row.length - 1; c >= 0; c--) {
          if (usedIndices.has(c)) continue;
          const num = parseNumericValue(row[c]);
          if (num !== null && num >= 0) {
            if (c === 0 && row.length > 2) continue;
            priceVal = num;
            usedIndices.add(c);
            break;
          }
        }
      }

      if (!unit) {
        for (let c = 0; c < row.length; c++) {
          if (usedIndices.has(c)) continue;
          const cellVal = row[c].toLowerCase();
          if (
            COMMON_UNITS.has(cellVal) ||
            (row[c].length === 1 && /[\u4e00-\u9fa5]/.test(row[c]))
          ) {
            unit = row[c];
            usedIndices.add(c);
            break;
          }
        }
      }

      const remainingTextCols: { idx: number; text: string }[] = [];
      for (let c = 0; c < row.length; c++) {
        if (!usedIndices.has(c) && row[c] !== '') {
          remainingTextCols.push({ idx: c, text: row[c] });
        }
      }

      if (!code && remainingTextCols.length >= 2) {
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

    if (!name && (priceVal === null || priceVal === 0)) {
      continue;
    }
    if (
      name === '名稱' ||
      name === '品名' ||
      name === '工項名稱' ||
      name === '項目名稱' ||
      name.toLowerCase() === 'name'
    ) {
      continue;
    }

    items.push({
      code: code || `${r - startDataIndex + 1}`,
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
 * 解析 CSV 字串為二維陣列
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
 * 從指定合約設定讀取並解析 GitHub Excel (.xlsx / .xls) 或本地 CSV
 */
export const fetchContractProducts = async (
  contract: ContractConfig
): Promise<{
  items: ContractProductItem[];
  isFallback: boolean;
  loadedUrl: string;
}> => {
  const tryFetchBuffer = async (
    rawUrl: string
  ): Promise<{ buffer: ArrayBuffer; url: string }> => {
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
    console.warn(`讀取 [${contract.githubExcelUrl}] 失敗，切換至備援檔案：`, err);
    const fallbackPath = contract.fallbackLocalUrl || '/products_01.csv';
    const res = await tryFetchBuffer(fallbackPath);
    buffer = res.buffer;
    loadedUrl = res.url;
    isFallback = contract.githubExcelUrl !== fallbackPath;
  }

  const uint8 = new Uint8Array(buffer.slice(0, 4));
  const isZipXlsx = uint8[0] === 0x50 && uint8[1] === 0x4b;
  const isOleXls = uint8[0] === 0xd0 && uint8[1] === 0xcf;

  if (!isZipXlsx && !isOleXls) {
    const csvText = decodeArrayBufferAuto(buffer);
    if (csvText.trim().toLowerCase().startsWith('<!doctype html')) {
      throw new Error(
        '讀取到 HTML 頁面而非 CSV 資料，請確認 public 目錄下的 CSV 檔案是否存在。'
      );
    }
    const matrix = parseCsvToMatrix(csvText);
    const items = convertMatrixToProducts(matrix, contract.contractCode);
    return { items, isFallback, loadedUrl };
  }

  const XLSX = await loadSheetJs();
  const workbook = XLSX.read(buffer, { type: 'array', codepage: 65001 });
  const allItems: ContractProductItem[] = [];

  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) return;
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
 * 合併多筆工令的 MO 明細項目（相同料號+名稱自動累加數量，上限 999，並依項目編號排序）
 */
export const mergeMoLineItems = (orders: WorkOrder[]): MoLineItem[] => {
  const mergedMap = new Map<string, MoLineItem>();

  orders.forEach((order) => {
    order.items.forEach((item) => {
      const key = `${item.code.trim()}__${item.name.trim()}__${item.unitPrice}`;
      const existing = mergedMap.get(key);
      if (existing) {
        const nextQty = Math.min(
          999,
          Math.max(1, Math.round(existing.quantity + item.quantity))
        );
        mergedMap.set(key, {
          ...existing,
          quantity: nextQty,
          subtotal: Math.round(existing.unitPrice * nextQty),
        });
      } else {
        const safeQty = Math.min(999, Math.max(1, Math.round(item.quantity)));
        mergedMap.set(key, {
          ...item,
          id: `merged-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          quantity: safeQty,
          subtotal: Math.round(item.unitPrice * safeQty),
        });
      }
    });
  });

  return Array.from(mergedMap.values()).sort((a, b) =>
    a.code.localeCompare(b.code, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );
};

/**
 * 匯出 MO 專用特定格式 Excel 檔案
 * 欄位固定依序為：項目編號、項目名稱、數量、倍率(1)、加成(1)、備註(空白)
 */
export const exportMoSpecificExcel = async (
  workOrder: WorkOrder
): Promise<void> => {
  if (!workOrder || workOrder.items.length === 0) {
    window.alert('目前工令尚無 MO 明細項目可供匯出！');
    return;
  }

  const safeFilename = `${workOrder.woNumber}_${workOrder.title}`.replace(
    /[\\/:*?"<>|]/g,
    '_'
  );

  // 匯出前確保依照項目編號排列
  const sortedItems = [...workOrder.items].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );

  const sheetRows: (string | number)[][] = [
    ['項目編號', '項目名稱', '數量', '倍率', '加成', '備註'],
  ];

  sortedItems.forEach((item) => {
    sheetRows.push([item.code, item.name, item.quantity, 1, 1, '']);
  });

  try {
    const XLSX = await loadSheetJs();
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, `${safeFilename}.xlsx`);
  } catch (err) {
    console.warn('無法載入線上 SheetJS，自動以 UTF-8 BOM CSV 格式匯出：', err);
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
