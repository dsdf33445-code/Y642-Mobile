// src/types.ts
// ============================================================================
// 系統核心型別定義檔
// 包含：使用者帳號、合約資料庫配置、GitHub Excel 工項資料、MO 明細與工令主檔
// ============================================================================

/**
 * 底部導覽列分頁類型（已移除 'agreement' 協議書分頁，僅保留工令管理與工令明細）
 */
export type ActiveTab = 'list' | 'detail';

/**
 * 登入使用者資料結構（用於區分個人帳號資料，確保不同登入者只看到自己建立的工令）
 */
export interface UserProfile {
  /** 使用者唯一識別碼（帳號或工號，作為資料隔離的 ownerId） */
  uid: string;
  /** 使用者顯示名稱 */
  displayName: string;
}

/**
 * 合約與對應 GitHub Excel 資料庫設定結構
 */
export interface ContractConfig {
  /** 合約唯一識別碼 */
  id: string;
  /** 合約顯示名稱（例如：115年度機電維護合約、115年度管線零星工程合約） */
  name: string;
  /** 合約編號或簡碼 */
  contractCode: string;
  /**
   * 對應 GitHub 儲存庫內的 Excel (.xlsx) 或 CSV 原始檔案網址 (Raw URL)
   * 範例：https://raw.githubusercontent.com/帳號/儲存庫/main/data/contract_a.xlsx
   */
  githubExcelUrl: string;
  /** 若遠端讀取失敗時的本地端備援檔案路徑（例如：/products.csv） */
  fallbackLocalUrl?: string;
}

/**
 * 從 GitHub Excel / 本地 CSV 解析出的合約單價工項結構
 */
export interface ContractProductItem {
  /** 項次或料號 (Item Code / ID) */
  code: string;
  /** 工項 / 材料名稱 */
  name: string;
  /** 規格說明 */
  spec: string;
  /** 計價單位（如：式、M、PC、組） */
  unit: string;
  /** 合約單價 */
  unitPrice: number;
  /** 分類名稱（選填，對應 Excel 工作表名稱或分類欄） */
  category?: string;
}

/**
 * 工令內的單筆 MO 明細項目
 */
export interface MoLineItem {
  /** 明細列唯一 ID */
  id: string;
  /** 對應合約工項代號/料號 */
  code: string;
  /** 工項名稱 */
  name: string;
  /** 規格 */
  spec: string;
  /** 單位 */
  unit: string;
  /** 單價 */
  unitPrice: number;
  /** 施作/請購數量 */
  quantity: number;
  /** 小計金額 (unitPrice * quantity) */
  subtotal: number;
  /** 備註說明 */
  remark?: string;
}

/**
 * 工令主檔資料結構（包含 ownerId 確保個人資料隔離）
 */
export interface WorkOrder {
  /** 工令唯一 ID */
  id: string;
  /** 工令編號（例如：W622008A、Y630000H） */
  woNumber: string;
  /** 工令名稱 / 工程案名 */
  title: string;
  /** 建立者帳號 ID（個人資料隔離核心欄位：不同登入者只會查詢到自己的 ownerId） */
  ownerId: string;
  /** 建立者姓名 */
  ownerName: string;
  /** 該工令選用的合約 ID（對應 ContractConfig.id） */
  contractId: string;
  /** 工令狀態 */
  status: '進行中' | '已完成';
  /** 施工地點或設備區域 */
  location?: string;
  /** MO 明細項目清單 */
  items: MoLineItem[];
  /** 工令總金額 */
  totalAmount: number;
  /** 建立時間 (ISO 字串或時間戳) */
  createdAt: string;
  /** 最後更新時間 (ISO 字串或時間戳) */
  updatedAt: string;
}