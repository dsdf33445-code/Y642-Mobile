// src/substationData.ts
// ============================================================================
// 變電站單線圖管理系統 — 核心資料模型、篩選邏輯、PDF 生成與雲端/本地同步模組
// ============================================================================

import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  onSnapshot,
  query,
  orderBy,
  writeBatch,
} from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import type { SubstationItem, VoltageLevel } from './types';
import { db as primaryDb } from './firebase';

export const SUBSTATION_PAGE_SIZE = 20;
export const SUBSTATION_STORAGE_KEY = 'sld_stations_v8';

export const DEFAULT_DISTRICTS: readonly string[] = [
  '既設供電區',
  '第二供電區',
  'C3',
  'F3',
  'T2',
  'W6',
  'Y6',
];

export const VOLTAGE_OPTIONS: readonly VoltageLevel[] = [
  '11 kV',
  '3.3 kV',
  '480 V',
];

export const DISTRICT_COLOR_MAP: Record<string, string> = {
  既設供電區: 'bg-indigo-100 text-indigo-800 border border-indigo-200',
  第二供電區: 'bg-purple-100 text-purple-800 border border-purple-200',
  C3: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
  F3: 'bg-cyan-100 text-cyan-800 border border-cyan-200',
  T2: 'bg-rose-100 text-rose-800 border border-rose-200',
  W6: 'bg-amber-100 text-amber-800 border border-amber-200',
  Y6: 'bg-blue-100 text-blue-800 border border-blue-200',
};

export const getDistrictBadgeClass = (district: string): string => {
  return (
    DISTRICT_COLOR_MAP[district] ||
    'bg-slate-100 text-slate-700 border border-slate-200'
  );
};

export const getVoltageBadgeClass = (voltage: string): string => {
  if (voltage === '11 kV') {
    return 'bg-sky-100 text-sky-800 border border-sky-200';
  }
  if (voltage === '3.3 kV') {
    return 'bg-teal-100 text-teal-800 border border-teal-200';
  }
  return 'bg-amber-100 text-amber-800 border border-amber-200';
};

export const toSafePdfFileName = (stationName: string): string => {
  const cleaned = stationName.trim().replace(/\//g, '-');
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
};

export const toCompactPdfFileName = (rawName: string): string => {
  const withoutExt = rawName.trim().replace(/\.pdf$/i, '');
  const compact = withoutExt.replace(/[\s/-]+/g, '');
  return `${compact}.pdf`;
};

export const getPdfCandidateFileNames = (station: SubstationItem): string[] => {
  const candidates: string[] = [];
  const pushUnique = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  if (station.pdfFileName) {
    const safeFromField = station.pdfFileName.trim().replace(/\//g, '-');
    pushUnique(
      safeFromField.toLowerCase().endsWith('.pdf')
        ? safeFromField
        : `${safeFromField}.pdf`
    );
    pushUnique(toCompactPdfFileName(station.pdfFileName));
  }

  pushUnique(toCompactPdfFileName(station.name));
  pushUnique(toSafePdfFileName(station.name));

  return candidates;
};

export const sanitizeVersionInput = (raw: string): string => {
  return raw.replace(/[^0-9\-/.: ]/g, '');
};

/**
 * 產生 42 筆變電站資料（對應 public/pdfs/ 內來自 substation-sld 儲存庫之 42 份單線圖 PDF）
 */
export const createDefaultStations = (): SubstationItem[] => {
  const baseNames = [
    // 原始 20 站
    '2KB 1/2',
    '3KA 1/2',
    '6KB 1/2',
    '9KB 1/2',
    'AKB 1/2',
    'GKB 5/6',
    'PKA 1/2',
    '2NT 5/6',
    '6NN 1/2',
    '6NW 3/4',
    '7NE 3/4',
    '9NV 1/2',
    '9NW 1/2',
    'ANR 1/2',
    'ANZ 6',
    'CND 3/4',
    'GNA 9/A',
    'GND 9/A',
    'GNH 1/2',
    'L2 MS',
    // substation-sld 儲存庫其餘 22 份單線圖 PDF
    '3NA 1/2',
    '3NB',
    '6NF',
    '7NE 1/2',
    '9NS 1/2',
    '9NU 1/2',
    '9NZ 1/2',
    'ANP 1/2',
    'ANS 3/4',
    'CMA 2',
    'CNC 3',
    'CND 2',
    'CND 5/6',
    'GNC 1/2',
    'GNF 3/4',
    'GNP 1/2',
    'LNA 1/2',
    'LNA 3/4',
    'LNA 5',
    'PNA 5/6',
    'PNB 5/6',
    'PNB 7/8',
  ];

  return baseNames.map((name, idx) => {
    const num = idx + 1;
    const voltage: VoltageLevel = idx % 2 === 0 ? '11 kV' : '480 V';
    const district = DEFAULT_DISTRICTS[idx % DEFAULT_DISTRICTS.length];
    const revMajor = 1 + (idx % 3);
    const revMinor = idx % 5;
    return {
      id: `station_${String(num).padStart(3, '0')}`,
      order: num,
      name,
      district,
      load: '-',
      voltage,
      version: `${revMajor}.${revMinor}`,
      updatedAt: `2026-11-${String(1 + (idx % 20)).padStart(2, '0')}`,
      pdfFileName: toCompactPdfFileName(name),
    };
  });
};

export interface SubstationFilterCriteria {
  keyword: string;
  voltage: string;
  district: string;
}

/**
 * 依據關鍵字、電壓等級與轄區篩選變電站清單
 */
export const filterSubstations = (
  stations: SubstationItem[],
  criteria: SubstationFilterCriteria
): SubstationItem[] => {
  const kw = criteria.keyword.trim().toLowerCase();
  const { voltage, district } = criteria;

  return stations.filter((st) => {
    const loadStr = (st.load || '').toLowerCase();
    const versionStr = String(st.version || '').toLowerCase();
    const pdfStr = (st.pdfFileName || '').toLowerCase();
    const matchKeyword =
      !kw ||
      st.name.toLowerCase().includes(kw) ||
      st.district.toLowerCase().includes(kw) ||
      loadStr.includes(kw) ||
      pdfStr.includes(kw) ||
      versionStr.includes(kw);

    const matchVoltage =
      !voltage || voltage === 'ALL' || st.voltage === voltage;
    const matchDistrict =
      !district || district === 'ALL' || st.district === district;

    return matchKeyword && matchVoltage && matchDistrict;
  });
};

/**
 * 動態生成標準單線圖 PDF Bytes（當 ./pdfs/ 資料夾尚無該檔案時的備援預覽與下載）
 */
export const generateSingleLinePdfBytes = (
  station: SubstationItem
): Uint8Array => {
  const pdfUpdateDate = station.version || '-';
  const streamLines = [
    'BT',
    '/F1 16 Tf',
    '50 770 Td',
    `(${station.name} - Single Line Diagram [${station.voltage}]) Tj`,
    '/F1 11 Tf',
    '0 -24 Td',
    `(PDF Last Updated: ${pdfUpdateDate}) Tj`,
    '0 -20 Td',
    `(PDF Path: ./pdfs/${station.pdfFileName}) Tj`,
    'ET',
    '1.5 w',
    '50 705 m 545 705 l S',
    '2.5 w',
    '100 650 m 500 650 l S',
    `BT /F1 11 Tf 100 660 Td (Main Busbar: ${station.voltage} 3P3W 60Hz) Tj ET`,
    '1.5 w',
    '160 650 m 160 550 l S',
    '145 550 m 175 550 l 175 520 l 145 520 l h S',
    'BT /F1 10 Tf 150 532 Td (VCB-1) Tj ET',
    '160 520 m 160 440 l S',
    '300 650 m 300 550 l S',
    '285 550 m 315 550 l 315 520 l 285 520 l h S',
    'BT /F1 10 Tf 290 532 Td (VCB-2) Tj ET',
    '300 520 m 300 440 l S',
    '440 650 m 440 550 l S',
    '425 550 m 455 550 l 455 520 l 425 520 l h S',
    'BT /F1 10 Tf 430 532 Td (TIE-CB) Tj ET',
    '440 520 m 440 440 l S',
    '50 390 m 545 390 l S',
  ].join('\n');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamLines.length} >>\nstream\n${streamLines}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(pdf);
};

/**
 * 將單線圖直接以高解析度 2D Canvas 繪製（支援 PWA 完全離線與手機/桌面無縫縮放）
 */
export const drawSingleLineDiagramToCanvas = (
  canvas: HTMLCanvasElement,
  station: SubstationItem,
  scale: number,
  containerWidth: number
): void => {
  const baseWidth = 595;
  const baseHeight = 842;
  const safeContainerWidth = Math.max(280, containerWidth - 24);
  const fitScale = Math.min(
    1.5,
    Math.max(0.55, safeContainerWidth / baseWidth)
  );
  const finalScale = fitScale * scale;
  const dpr =
    typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  const displayWidth = Math.floor(baseWidth * finalScale);
  const displayHeight = Math.floor(baseHeight * finalScale);

  canvas.width = Math.floor(displayWidth * dpr);
  canvas.height = Math.floor(displayHeight * dpr);
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.scale(finalScale * dpr, finalScale * dpr);

  // 白底圖紙背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, baseWidth, baseHeight);

  // 外框工程圖紙邊框
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.strokeRect(28, 28, baseWidth - 56, baseHeight - 56);

  // 標題與資訊區
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 16px Inter, "Noto Sans TC", sans-serif';
  ctx.fillText(
    `${station.name} - Single Line Diagram [${station.voltage}]`,
    50,
    72
  );

  ctx.fillStyle = '#334155';
  ctx.font = '11px "JetBrains Mono", monospace';
  ctx.fillText(`PDF Last Updated: ${station.version || '-'}`, 50, 96);
  ctx.fillText(`PDF Path: ./pdfs/${station.pdfFileName}`, 50, 116);
  ctx.fillText(
    `District: ${station.district}   |   Load: ${station.load || '-'}`,
    50,
    136
  );

  // 上分隔線
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(50, 155);
  ctx.lineTo(545, 155);
  ctx.stroke();

  // 主匯流排 (Main Busbar)
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.fillText(`Main Busbar: ${station.voltage} 3P3W 60Hz`, 100, 198);

  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(100, 210);
  ctx.lineTo(500, 210);
  ctx.stroke();

  // 三組斷路器支路 (VCB-1, VCB-2, TIE-CB)
  const branches = [
    { x: 160, label: 'VCB-1', feeder: 'Feeder #1' },
    { x: 300, label: 'VCB-2', feeder: 'Feeder #2' },
    { x: 440, label: 'TIE-CB', feeder: 'Bus Tie' },
  ];

  ctx.strokeStyle = '#0f172a';
  ctx.fillStyle = '#0f172a';
  ctx.lineWidth = 1.5;

  branches.forEach((b) => {
    // 匯流排至斷路器上段垂直線
    ctx.beginPath();
    ctx.moveTo(b.x, 210);
    ctx.lineTo(b.x, 300);
    ctx.stroke();

    // 斷路器方框
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(b.x - 22, 300, 44, 32);
    ctx.strokeRect(b.x - 22, 300, 44, 32);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(b.label, b.x, 320);

    // 斷路器下段饋線與箭頭
    ctx.beginPath();
    ctx.moveTo(b.x, 332);
    ctx.lineTo(b.x, 420);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(b.x - 5, 412);
    ctx.lineTo(b.x, 422);
    ctx.lineTo(b.x + 5, 412);
    ctx.stroke();

    ctx.fillStyle = '#475569';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillText(b.feeder, b.x, 438);
  });

  ctx.textAlign = 'left';

  // 下分隔線
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(50, 470);
  ctx.lineTo(545, 470);
  ctx.stroke();

  // 圖面右下角工程圖框資訊欄
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1;
  ctx.strokeRect(310, 720, 235, 70);
  ctx.fillStyle = '#475569';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillText(`STATION : ${station.name}`, 322, 740);
  ctx.fillText(`VOLTAGE : ${station.voltage}`, 322, 756);
  ctx.fillText(`UPDATED : ${station.version || '-'}`, 322, 772);

  ctx.restore();
};

/**
 * 從 localStorage 讀取變電站資料（若無則初始化 20 筆預設資料）
 */
export const loadLocalSubstations = (): SubstationItem[] => {
  try {
    if (typeof localStorage === 'undefined') {
      return createDefaultStations();
    }
    const saved = localStorage.getItem(SUBSTATION_STORAGE_KEY);
    if (!saved) {
      const defaults = createDefaultStations();
      localStorage.setItem(SUBSTATION_STORAGE_KEY, JSON.stringify(defaults));
      return defaults;
    }
    const parsed = JSON.parse(saved) as SubstationItem[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return createDefaultStations();
    }
    return parsed.map((st, idx) => ({
      id: st.id || `station_${String(idx + 1).padStart(3, '0')}`,
      order: typeof st.order === 'number' ? st.order : idx + 1,
      name: st.name || `Station ${idx + 1}`,
      district: st.district || DEFAULT_DISTRICTS[0],
      load: st.load !== undefined && st.load !== '' ? st.load : '-',
      voltage: (st.voltage as VoltageLevel) || '11 kV',
      version: st.version !== undefined ? String(st.version) : '1.0',
      updatedAt: st.updatedAt || '',
      pdfFileName: st.pdfFileName || toSafePdfFileName(st.name || 'station'),
    }));
  } catch {
    return createDefaultStations();
  }
};

/**
 * 儲存變電站清單至 localStorage
 */
export const saveLocalSubstations = (stations: SubstationItem[]): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SUBSTATION_STORAGE_KEY, JSON.stringify(stations));
    }
  } catch (err) {
    console.warn('儲存變電站本地快取略過：', err);
  }
};

// Optional dedicated Substation Firestore instance (via VITE_SUBSTATION_FIREBASE_*) or primaryDb
let substationDb: Firestore | null = null;

const getSubstationFirestore = (): Firestore | null => {
  if (substationDb) return substationDb;
  const subApiKey = import.meta.env?.VITE_SUBSTATION_FIREBASE_API_KEY;
  const subProjectId = import.meta.env?.VITE_SUBSTATION_FIREBASE_PROJECT_ID;
  if (subApiKey && subProjectId) {
    try {
      const existingApp = getApps().find((a) => a.name === 'substation-sld');
      const subApp =
        existingApp ||
        initializeApp(
          {
            apiKey: subApiKey,
            authDomain: import.meta.env?.VITE_SUBSTATION_FIREBASE_AUTH_DOMAIN,
            projectId: subProjectId,
            storageBucket:
              import.meta.env?.VITE_SUBSTATION_FIREBASE_STORAGE_BUCKET,
            messagingSenderId:
              import.meta.env?.VITE_SUBSTATION_FIREBASE_MESSAGING_SENDER_ID,
            appId: import.meta.env?.VITE_SUBSTATION_FIREBASE_APP_ID,
          },
          'substation-sld'
        );
      substationDb = getFirestore(subApp);
      return substationDb;
    } catch {
      return primaryDb;
    }
  }
  return primaryDb;
};

/**
 * 訂閱變電站清單（優先顯示本地快取，若 Firestore 已配置則自動同步 substations 集合）
 */
export const subscribeSubstations = (
  onUpdate: (stations: SubstationItem[]) => void
): (() => void) => {
  const initialLocal = loadLocalSubstations();
  onUpdate(initialLocal);

  const targetDb = getSubstationFirestore();
  if (!targetDb) {
    return () => {};
  }

  try {
    const colRef = collection(targetDb, 'substations');
    const q = query(colRef, orderBy('order', 'asc'));

    const unsub = onSnapshot(
      q,
      async (snapshot) => {
        if (snapshot.empty) {
          try {
            const seedList =
              initialLocal.length > 0 ? initialLocal : createDefaultStations();
            const batch = writeBatch(targetDb);
            seedList.forEach((st) => {
              batch.set(doc(targetDb, 'substations', st.id), st);
            });
            await batch.commit();
          } catch {
            // 若雲端規則限制寫入則維持本地快取運作
          }
        } else {
          const remoteStations: SubstationItem[] = snapshot.docs.map(
            (d, idx) => {
              const raw = d.data() as Partial<SubstationItem>;
              const name = raw.name || `Station ${idx + 1}`;
              return {
                id: raw.id || d.id,
                order: typeof raw.order === 'number' ? raw.order : idx + 1,
                name,
                district: raw.district || DEFAULT_DISTRICTS[0],
                load: raw.load !== undefined && raw.load !== '' ? raw.load : '-',
                voltage: (raw.voltage as VoltageLevel) || '11 kV',
                version: raw.version !== undefined ? String(raw.version) : '',
                updatedAt: raw.updatedAt || '',
                pdfFileName: raw.pdfFileName || toSafePdfFileName(name),
              };
            }
          );
          saveLocalSubstations(remoteStations);
          onUpdate(remoteStations);
        }
      },
      () => {
        // Firestore 權限或離線時自動使用本地快取
      }
    );

    return () => unsub();
  } catch {
    return () => {};
  }
};

/**
 * 新增或更新單筆變電站（即時寫入 localStorage 並嘗試同步至 Firestore）
 */
export const upsertSubstation = async (
  currentList: SubstationItem[],
  updated: SubstationItem
): Promise<{ nextList: SubstationItem[]; syncedToCloud: boolean }> => {
  const exists = currentList.some((s) => s.id === updated.id);
  const nextList = exists
    ? currentList.map((s) => (s.id === updated.id ? updated : s))
    : [...currentList, updated];

  saveLocalSubstations(nextList);

  const targetDb = getSubstationFirestore();
  if (targetDb) {
    try {
      await setDoc(doc(targetDb, 'substations', updated.id), updated);
      return { nextList, syncedToCloud: true };
    } catch {
      return { nextList, syncedToCloud: false };
    }
  }

  return { nextList, syncedToCloud: false };
};
