// src/constants.ts
// ============================================================================
// 系統常數與多合約資料庫設定檔
// 使用 import type 符合 tsconfig.app.json 的 verbatimModuleSyntax 嚴格規範
// ============================================================================

import type { ContractConfig } from './types';

/**
 * 多重合約資料庫清單
 * 說明：
 * 1. 可將 GitHub 儲存庫內的 Excel (.xlsx) 或 CSV 原始檔案網址 (Raw URL) 填入 githubExcelUrl
 * 2. 若遠端網址尚未設定或無法連線，系統會自動退回讀取 /products.csv 備援
 */
export const CONTRACT_DATABASES: ContractConfig[] = [
  {
    id: 'contract-default',
    name: '預設標準合約 (主資料庫)',
    contractCode: 'STD-01',
    githubExcelUrl: '/products.csv',
    fallbackLocalUrl: '/products.csv',
  },
  {
    id: 'contract-electrical-2026',
    name: '機電暨儀控設備維護合約 (GitHub Excel A)',
    contractCode: 'ELEC-115',
    githubExcelUrl:
      import.meta.env.VITE_GITHUB_EXCEL_URL_A || '/products.csv',
    fallbackLocalUrl: '/products.csv',
  },
  {
    id: 'contract-piping-2026',
    name: '管線與零星修繕工程合約 (GitHub Excel B)',
    contractCode: 'PIPE-115',
    githubExcelUrl:
      import.meta.env.VITE_GITHUB_EXCEL_URL_B || '/products.csv',
    fallbackLocalUrl: '/products.csv',
  },
  {
    id: 'contract-civil-2026',
    name: '廠務空調與土木修繕合約 (GitHub Excel C)',
    contractCode: 'CIVIL-115',
    githubExcelUrl:
      import.meta.env.VITE_GITHUB_EXCEL_URL_C || '/products.csv',
    fallbackLocalUrl: '/products.csv',
  },
];

/**
 * 本地儲存 (LocalStorage) 的 Key 常數定義
 */
export const STORAGE_KEYS = {
  /** 儲存目前登入者資訊 */
  CURRENT_USER: 'mobile_mo_current_user_v2',
  /** 本地端工令備援快取前綴（依 ownerId 隔離） */
  WORK_ORDERS_PREFIX: 'mobile_mo_work_orders_v2_',
};