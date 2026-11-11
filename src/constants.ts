// src/constants.ts
// ============================================================================
// 系統常數與多合約資料庫設定檔
// 可在此新增或修改不同合約對應的 GitHub Excel 檔案網址 (Raw URL)
// ============================================================================

import { ContractConfig } from './types';

/**
 * 多重合約資料庫清單
 * 說明：
 * 1. 將 Excel (.xlsx) 或 CSV 上傳至 GitHub 儲存庫後，複製其 Raw 網址填入 githubExcelUrl。
 * 2. 轉換公式：https://raw.githubusercontent.com/<GitHub帳號>/<Repo名稱>/<分支名稱>/<檔案路徑>.xlsx
 * 3. 若處於離線或尚未替換網址時，系統會自動退回讀取 public/products.csv 作為備援資料。
 */
export const CONTRACT_DATABASES: ContractConfig[] = [
  {
    id: 'contract-default',
    name: '協茂',
    contractCode: 'STD-01',
    // 可替換為您的 GitHub Excel Raw URL，未設定遠端網址時預設讀取 public/products.csv
    githubExcelUrl: '/products.csv',
    fallbackLocalUrl: '/products.csv',
  },
  {
    id: 'contract-electrical-2026',
    name: '機電暨儀控設備維護合約 (GitHub Excel A)',
    contractCode: 'ELEC-115',
    // 請將下方網址改為您 GitHub 儲存庫中對應合約 A 的 .xlsx Raw 網址
    githubExcelUrl:
      import.meta.env.VITE_GITHUB_EXCEL_URL_A ||
      'https://raw.githubusercontent.com/your-org/mobile-mo-data/main/contracts/electrical_contract.xlsx',
    fallbackLocalUrl: '/products.csv',
  },
  {
    id: 'contract-piping-2026',
    name: '管線與零星修繕工程合約 (GitHub Excel B)',
    contractCode: 'PIPE-115',
    // 請將下方網址改為您 GitHub 儲存庫中對應合約 B 的 .xlsx Raw 網址
    githubExcelUrl:
      import.meta.env.VITE_GITHUB_EXCEL_URL_B ||
      'https://raw.githubusercontent.com/your-org/mobile-mo-data/main/contracts/piping_contract.xlsx',
    fallbackLocalUrl: '/products.csv',
  },
  {
    id: 'contract-civil-2026',
    name: '廠務空調與土木修繕合約 (GitHub Excel C)',
    contractCode: 'CIVIL-115',
    // 請將下方網址改為您 GitHub 儲存庫中對應合約 C 的 .xlsx Raw 網址
    githubExcelUrl:
      import.meta.env.VITE_GITHUB_EXCEL_URL_C ||
      'https://raw.githubusercontent.com/your-org/mobile-mo-data/main/contracts/civil_contract.xlsx',
    fallbackLocalUrl: '/products.csv',
  },
];

/**
 * 本地儲存 (LocalStorage) 的 Key 常數定義
 */
export const STORAGE_KEYS = {
  /** 儲存目前登入者資訊 */
  CURRENT_USER: 'mobile_mo_current_user_v2',
  /** 本地端工令備援快取（依 ownerId 隔離） */
  WORK_ORDERS_PREFIX: 'mobile_mo_work_orders_v2_',
};