// src/firebase.ts
// ============================================================================
// Firebase 核心設定與個人帳號資料隔離存取模組
// 1. 完整保留原始 firebaseConfig 環境變數名稱與 auth, db, provider 匯出
// 2. 實作依登入者帳號 (ownerId) 嚴格隔離的 Firestore 即時同步與本地快取機制
// ============================================================================

import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';
import { WorkOrder } from './types';
import { STORAGE_KEYS } from './constants';

// 原始 Firebase 環境變數配置（完全對應您既有的 .env 變數名稱）
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// 初始化 Firebase App 與各項服務實例（保留原始匯出名稱）
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const provider = new GoogleAuthProvider();

// Firestore 工令集合名稱
const WORK_ORDERS_COLLECTION = 'workOrders';

/**
 * 產生特定登入者專屬的 LocalStorage 快取鍵值（確保本地快取同樣具備個人資料隔離）
 * @param ownerId 登入者唯一識別碼 (Firebase Auth UID 或員工帳號)
 */
const getLocalKeyForUser = (ownerId: string): string =>
  `${STORAGE_KEYS.WORK_ORDERS_PREFIX}${ownerId.trim()}`;

/**
 * 從本地儲存讀取該登入者個人建立的工令清單
 * @param ownerId 登入者唯一識別碼
 */
export const loadLocalWorkOrders = (ownerId: string): WorkOrder[] => {
  try {
    const raw = localStorage.getItem(getLocalKeyForUser(ownerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WorkOrder[];
    // 嚴格篩選：只回傳 ownerId 與目前登入者相符的工令，並依更新時間由新到舊排序
    return parsed
      .filter((wo) => wo.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (error) {
    console.error('讀取個人本地工令快取失敗：', error);
    return [];
  }
};

/**
 * 將該登入者個人的工令清單寫入本地快取
 * @param ownerId 登入者唯一識別碼
 * @param orders 工令陣列
 */
export const saveLocalWorkOrders = (ownerId: string, orders: WorkOrder[]): void => {
  try {
    const filtered = orders.filter((wo) => wo.ownerId === ownerId);
    localStorage.setItem(getLocalKeyForUser(ownerId), JSON.stringify(filtered));
  } catch (error) {
    console.error('寫入個人本地工令快取失敗：', error);
  }
};

/**
 * 訂閱特定登入者 (ownerId) 建立的工令清單
 * 透過 Firestore where('ownerId', '==', ownerId) 確保不同登入者只會看到自己建立的工令
 * @param ownerId 目前登入者的 UID
 * @param onUpdate 資料變更時的更新回呼函式
 */
export const subscribeUserWorkOrders = (
  ownerId: string,
  onUpdate: (orders: WorkOrder[]) => void
): (() => void) => {
  // 1. 先立即回傳本地快取資料，達成畫面 0 延遲載入
  const cachedOrders = loadLocalWorkOrders(ownerId);
  onUpdate(cachedOrders);

  // 2. 建立 Firestore 查詢：限定只讀取 ownerId 等於目前登入者的文件
  const workOrdersQuery = query(
    collection(db, WORK_ORDERS_COLLECTION),
    where('ownerId', '==', ownerId)
  );

  // 3. 啟動即時監聽器
  const unsubscribe = onSnapshot(
    workOrdersQuery,
    (snapshot) => {
      const orders: WorkOrder[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data() as WorkOrder;
        if (data.ownerId === ownerId) {
          orders.push(data);
        }
      });

      // 依最後更新時間降序排列（最新編輯的工令排在最上方）
      orders.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      // 同步更新本地快取並通知前端刷新
      saveLocalWorkOrders(ownerId, orders);
      onUpdate(orders);
    },
    (error) => {
      console.error('Firestore 即時同步發生錯誤，使用個人本地快取：', error);
      onUpdate(loadLocalWorkOrders(ownerId));
    }
  );

  return unsubscribe;
};

/**
 * 新增或更新單筆個人工令（自動綁定 ownerId 並同步寫入本地與 Firestore）
 * @param ownerId 目前登入者的 UID
 * @param workOrder 要儲存的工令資料
 */
export const saveUserWorkOrder = async (
  ownerId: string,
  workOrder: WorkOrder
): Promise<void> => {
  // 強制寫入目前登入者的 ownerId 與最新時間戳，確保個人資料歸屬正確
  const securedOrder: WorkOrder = {
    ...workOrder,
    ownerId,
    updatedAt: new Date().toISOString(),
  };

  // 1. 樂觀更新本地快取，確保操作立即反應於 UI
  const currentOrders = loadLocalWorkOrders(ownerId);
  const existingIndex = currentOrders.findIndex((o) => o.id === securedOrder.id);
  if (existingIndex >= 0) {
    currentOrders[existingIndex] = securedOrder;
  } else {
    currentOrders.unshift(securedOrder);
  }
  saveLocalWorkOrders(ownerId, currentOrders);

  // 2. 寫入雲端 Firestore
  const docRef = doc(db, WORK_ORDERS_COLLECTION, securedOrder.id);
  await setDoc(docRef, securedOrder, { merge: true });
};

/**
 * 刪除單筆個人工令（僅限刪除該登入者自己建立的工令）
 * @param ownerId 目前登入者的 UID
 * @param workOrderId 要刪除的工令 ID
 */
export const deleteUserWorkOrder = async (
  ownerId: string,
  workOrderId: string
): Promise<void> => {
  // 1. 從本地快取移除
  const currentOrders = loadLocalWorkOrders(ownerId);
  const nextOrders = currentOrders.filter(
    (o) => !(o.id === workOrderId && o.ownerId === ownerId)
  );
  saveLocalWorkOrders(ownerId, nextOrders);

  // 2. 從雲端 Firestore 移除
  const docRef = doc(db, WORK_ORDERS_COLLECTION, workOrderId);
  await deleteDoc(docRef);
};