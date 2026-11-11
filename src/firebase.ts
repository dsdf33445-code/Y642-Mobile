// src/firebase.ts
// ============================================================================
// Firebase 核心設定與個人帳號資料隔離存取模組
// 1. 完整保留原始 firebaseConfig 環境變數名稱與 auth, db, provider 匯出
// 2. 使用 import type 通過 TypeScript verbatimModuleSyntax 嚴格編譯檢查
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
import type { WorkOrder } from './types';
import { STORAGE_KEYS } from './constants';

// 原始 Firebase 環境變數配置
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// 初始化 Firebase App 與各項服務實例
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const provider = new GoogleAuthProvider();

// Firestore 工令集合名稱
const WORK_ORDERS_COLLECTION = 'workOrders';

/**
 * 產生特定登入者專屬的 LocalStorage 快取鍵值
 */
const getLocalKeyForUser = (ownerId: string): string =>
  `${STORAGE_KEYS.WORK_ORDERS_PREFIX}${ownerId.trim()}`;

/**
 * 從本地儲存讀取該登入者個人建立的工令清單
 */
export const loadLocalWorkOrders = (ownerId: string): WorkOrder[] => {
  try {
    const raw = localStorage.getItem(getLocalKeyForUser(ownerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WorkOrder[];
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
 */
export const saveLocalWorkOrders = (
  ownerId: string,
  orders: WorkOrder[]
): void => {
  try {
    const filtered = orders.filter((wo) => wo.ownerId === ownerId);
    localStorage.setItem(getLocalKeyForUser(ownerId), JSON.stringify(filtered));
  } catch (error) {
    console.error('寫入個人本地工令快取失敗：', error);
  }
};

/**
 * 訂閱特定登入者 (ownerId) 建立的工令清單
 */
export const subscribeUserWorkOrders = (
  ownerId: string,
  onUpdate: (orders: WorkOrder[]) => void
): (() => void) => {
  const cachedOrders = loadLocalWorkOrders(ownerId);
  onUpdate(cachedOrders);

  const workOrdersQuery = query(
    collection(db, WORK_ORDERS_COLLECTION),
    where('ownerId', '==', ownerId)
  );

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

      orders.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
 * 新增或更新單筆個人工令
 */
export const saveUserWorkOrder = async (
  ownerId: string,
  workOrder: WorkOrder
): Promise<void> => {
  const securedOrder: WorkOrder = {
    ...workOrder,
    ownerId,
    updatedAt: new Date().toISOString(),
  };

  const currentOrders = loadLocalWorkOrders(ownerId);
  const existingIndex = currentOrders.findIndex((o) => o.id === securedOrder.id);
  if (existingIndex >= 0) {
    currentOrders[existingIndex] = securedOrder;
  } else {
    currentOrders.unshift(securedOrder);
  }
  saveLocalWorkOrders(ownerId, currentOrders);

  const docRef = doc(db, WORK_ORDERS_COLLECTION, securedOrder.id);
  await setDoc(docRef, securedOrder, { merge: true });
};

/**
 * 刪除單筆個人工令
 */
export const deleteUserWorkOrder = async (
  ownerId: string,
  workOrderId: string
): Promise<void> => {
  const currentOrders = loadLocalWorkOrders(ownerId);
  const nextOrders = currentOrders.filter(
    (o) => !(o.id === workOrderId && o.ownerId === ownerId)
  );
  saveLocalWorkOrders(ownerId, nextOrders);

  const docRef = doc(db, WORK_ORDERS_COLLECTION, workOrderId);
  await deleteDoc(docRef);
};