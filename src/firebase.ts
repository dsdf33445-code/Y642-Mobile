// src/firebase.ts
// ============================================================================
// Firebase 核心設定與 Google 帳號資料隔離 + 改版前歷史資料庫自動相容模組
// 1. 支援讀取改版前綁定 Google UID / Email 的所有可能路徑：
//    - collection(db, 'workOrders') (相容 userId, uid, ownerId, createdBy, userEmail)
//    - doc(db, 'users', uid) (相容存放於使用者文件內的 workOrders / orders 陣列)
//    - collection(db, 'users', uid, 'workOrders') (相容存放於使用者子集合的工令)
//    - doc(db, 'workOrders', uid)
// 2. 自動正規化舊版欄位名稱、修復 Timestamp 排序錯誤、自動依項目編號排序明細
// ============================================================================

import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';
import type { WorkOrder, MoLineItem } from './types';
import { STORAGE_KEYS, CONTRACT_DATABASES } from './constants';

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

// 初始化 Firebase App 與服務實例
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const provider = new GoogleAuthProvider();

const WORK_ORDERS_COLLECTION = 'workOrders';

/**
 * 將任意時間格式（Firestore Timestamp、毫秒數字、日期字串）安全轉為 ISO 字串
 * 避免舊資料呼叫 localeCompare 時發生崩潰導致畫面空白
 */
const toSafeIsoString = (val: unknown): string => {
  if (!val) return new Date(0).toISOString();
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isNaN(parsed) ? val : new Date(parsed).toISOString();
  }
  if (typeof val === 'number') {
    return new Date(val).toISOString();
  }
  if (typeof val === 'object' && val !== null) {
    const maybeTs = val as { seconds?: number; toDate?: () => Date };
    if (typeof maybeTs.toDate === 'function') {
      return maybeTs.toDate().toISOString();
    }
    if (typeof maybeTs.seconds === 'number') {
      return new Date(maybeTs.seconds * 1000).toISOString();
    }
  }
  return new Date().toISOString();
};

/**
 * 將 MO 明細項目陣列依照「項目編號 (code)」由小到大自然排序
 */
export const sortMoItemsByCode = (items: MoLineItem[]): MoLineItem[] => {
  return [...items].sort((a, b) =>
    String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );
};

/**
 * 正規化單筆 MO 明細（相容改版前舊欄位名稱，並強制限制數量 1 ~ 999）
 */
const normalizeLegacyMoItem = (
  raw: Record<string, unknown>,
  idx: number
): MoLineItem => {
  const code = String(
    raw.code ??
      raw.itemCode ??
      raw.productId ??
      raw.productCode ??
      raw.no ??
      raw.itemNo ??
      raw['項目編號'] ??
      raw['料號'] ??
      idx + 1
  ).trim();

  const name = String(
    raw.name ??
      raw.itemName ??
      raw.productName ??
      raw.title ??
      raw.description ??
      raw['項目名稱'] ??
      raw['工項名稱'] ??
      raw['品名'] ??
      ''
  ).trim();

  const spec = String(
    raw.spec ?? raw.specification ?? raw.model ?? raw['規格'] ?? ''
  ).trim();

  const unit = String(raw.unit ?? raw.uom ?? raw['單位'] ?? '式').trim();

  const rawPrice = Number(
    raw.unitPrice ?? raw.price ?? raw.cost ?? raw['單價'] ?? 0
  );
  const unitPrice = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;

  const rawQty = Number(
    raw.quantity ?? raw.qty ?? raw.count ?? raw['數量'] ?? 1
  );
  // 強制限制數量最低為 1，最高為 999
  const quantity = Number.isFinite(rawQty)
    ? Math.min(999, Math.max(1, Math.round(rawQty)))
    : 1;

  const subtotal = Math.round(unitPrice * quantity);

  return {
    id: String(raw.id ?? `item-${idx}-${code}`),
    code,
    name: name || `工項 ${code}`,
    spec,
    unit,
    unitPrice,
    quantity,
    subtotal,
    remark: String(raw.remark ?? raw.note ?? ''),
  };
};

/**
 * 正規化單筆工令資料（自動相容改版前與改版後的所有欄位名稱）
 */
export const normalizeLegacyWorkOrder = (
  raw: Record<string, unknown>,
  fallbackId: string,
  currentUid: string
): WorkOrder | null => {
  if (!raw || typeof raw !== 'object') return null;

  // 擷取工令編號（相容改版前可能使用的各種屬性名稱）
  const woNumber = String(
    raw.woNumber ??
      raw.workOrderNumber ??
      raw.workOrderNo ??
      raw.orderNumber ??
      raw.orderNo ??
      raw.moNumber ??
      raw.moNo ??
      raw.number ??
      raw.code ??
      raw.no ??
      raw['工令編號'] ??
      ''
  ).trim();

  // 擷取工令名稱
  const title = String(
    raw.title ??
      raw.name ??
      raw.workOrderName ??
      raw.orderName ??
      raw.projectName ??
      raw.description ??
      raw['工令名稱'] ??
      raw['案名'] ??
      ''
  ).trim();

  // 若連工令編號與名稱都沒有，視為非工令文件（例如純簽章或設定文件）並略過
  if (!woNumber && !title) return null;

  // 擷取明細陣列（相容 items, moItems, details, products, list）
  const rawItemsArray =
    (Array.isArray(raw.items) && raw.items) ||
    (Array.isArray(raw.moItems) && raw.moItems) ||
    (Array.isArray(raw.details) && raw.details) ||
    (Array.isArray(raw.moDetails) && raw.moDetails) ||
    (Array.isArray(raw.products) && raw.products) ||
    (Array.isArray(raw.list) && raw.list) ||
    [];

  const normalizedItems = sortMoItemsByCode(
    rawItemsArray.map((item, idx) =>
      normalizeLegacyMoItem((item as Record<string, unknown>) || {}, idx)
    )
  );

  const calculatedTotal = normalizedItems.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );

  const ownerId = String(
    raw.ownerId ??
      raw.userId ??
      raw.uid ??
      raw.createdBy ??
      raw.authorId ??
      currentUid
  ).trim();

  const createdAt = toSafeIsoString(
    raw.createdAt ?? raw.createTime ?? raw.date ?? raw.timestamp ?? Date.now()
  );
  const updatedAt = toSafeIsoString(
    raw.updatedAt ??
      raw.updateTime ??
      raw.lastModified ??
      raw.createdAt ??
      raw.timestamp ??
      createdAt
  );

  return {
    id: String(raw.id ?? fallbackId),
    woNumber: woNumber || '未編號',
    title: title || '未命名工令',
    ownerId,
    ownerName: String(
      raw.ownerName ?? raw.userName ?? raw.displayName ?? ''
    ).trim(),
    contractId: String(
      raw.contractId ?? raw.databaseId ?? CONTRACT_DATABASES[0]?.id ?? 'contract-1'
    ),
    status: raw.status === '已完成' ? '已完成' : '進行中',
    items: normalizedItems,
    totalAmount: calculatedTotal,
    createdAt,
    updatedAt,
  };
};

/**
 * 判斷某筆 Firestore 原始工令資料是否屬於目前登入的 Google 帳號
 */
const isOrderOwnedByUser = (
  raw: Record<string, unknown>,
  uid: string,
  email?: string
): boolean => {
  const docOwner = String(
    raw.ownerId ??
      raw.userId ??
      raw.uid ??
      raw.createdBy ??
      raw.authorId ??
      raw.user ??
      ''
  ).trim();

  if (docOwner && docOwner === uid) return true;

  if (email) {
    const cleanEmail = email.trim().toLowerCase();
    const docEmail = String(
      raw.email ?? raw.userEmail ?? raw.ownerEmail ?? ''
    )
      .trim()
      .toLowerCase();
    if (docEmail && docEmail === cleanEmail) return true;
  }

  return false;
};

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
    const parsed = JSON.parse(raw) as Record<string, unknown>[];
    const normalized: WorkOrder[] = [];
    parsed.forEach((item, idx) => {
      const wo = normalizeLegacyWorkOrder(item, `local-${idx}`, ownerId);
      if (wo && wo.ownerId === ownerId) {
        normalized.push(wo);
      }
    });
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    localStorage.setItem(getLocalKeyForUser(ownerId), JSON.stringify(orders));
  } catch (error) {
    console.error('寫入個人本地工令快取失敗：', error);
  }
};

/**
 * 訂閱特定 Google 登入者 (uid / email) 的所有工令清單（含改版前舊資料自動探索與合併）
 */
export const subscribeUserWorkOrders = (
  ownerId: string,
  onUpdate: (orders: WorkOrder[]) => void,
  userEmail?: string
): (() => void) => {
  // 1. 先立即回傳本地快取
  const cachedOrders = loadLocalWorkOrders(ownerId);
  if (cachedOrders.length > 0) {
    onUpdate(cachedOrders);
  }

  // 儲存來自不同路徑（主集合 vs 改版前舊路徑）的工令 Map
  const mainCollectionMap = new Map<string, WorkOrder>();
  const legacyPathsMap = new Map<string, WorkOrder>();

  const emitCombinedOrders = () => {
    const mergedMap = new Map<string, WorkOrder>();
    // 先放入舊路徑資料，再放入主集合資料（以最新更新者為準）
    legacyPathsMap.forEach((wo, id) => mergedMap.set(id, wo));
    mainCollectionMap.forEach((wo, id) => mergedMap.set(id, wo));

    const combined = Array.from(mergedMap.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
    saveLocalWorkOrders(ownerId, combined);
    onUpdate(combined);
  };

  // 2. 一次性掃描改版前可能存放於 users/{uid} 或其子集合的舊資料庫資料，並自動遷移回主集合
  const scanLegacyUserLocations = async () => {
    try {
      // (A) 檢查 doc(db, 'users', ownerId) 內嵌的 workOrders / orders 陣列
      const userDocRef = doc(db, 'users', ownerId);
      const userDocSnap = await getDoc(userDocRef);
      if (userDocSnap.exists()) {
        const userData = userDocSnap.data() as Record<string, unknown>;
        const embeddedList =
          (Array.isArray(userData.workOrders) && userData.workOrders) ||
          (Array.isArray(userData.orders) && userData.orders) ||
          (Array.isArray(userData.mos) && userData.mos) ||
          [];

        embeddedList.forEach((rawItem, idx) => {
          const wo = normalizeLegacyWorkOrder(
            (rawItem as Record<string, unknown>) || {},
            `legacy-user-${idx}`,
            ownerId
          );
          if (wo) {
            legacyPathsMap.set(wo.id, wo);
          }
        });
      }

      // (B) 檢查 collection(db, 'users', ownerId, 'workOrders') 子集合
      const subColRef = collection(db, 'users', ownerId, 'workOrders');
      const subColSnap = await getDocs(subColRef);
      subColSnap.forEach((docSnap) => {
        const raw = docSnap.data() as Record<string, unknown>;
        const wo = normalizeLegacyWorkOrder(raw, docSnap.id, ownerId);
        if (wo) {
          legacyPathsMap.set(wo.id, wo);
        }
      });

      // (C) 檢查 doc(db, 'workOrders', ownerId) 單一使用者工令打包文件
      const userWoDocRef = doc(db, WORK_ORDERS_COLLECTION, ownerId);
      const userWoDocSnap = await getDoc(userWoDocRef);
      if (userWoDocSnap.exists()) {
        const rawData = userWoDocSnap.data() as Record<string, unknown>;
        const packedList =
          (Array.isArray(rawData.workOrders) && rawData.workOrders) ||
          (Array.isArray(rawData.orders) && rawData.orders) ||
          [];
        packedList.forEach((rawItem, idx) => {
          const wo = normalizeLegacyWorkOrder(
            (rawItem as Record<string, unknown>) || {},
            `legacy-wo-${idx}`,
            ownerId
          );
          if (wo) {
            legacyPathsMap.set(wo.id, wo);
          }
        });
      }

      if (legacyPathsMap.size > 0) {
        emitCombinedOrders();
      }
    } catch (err) {
      console.warn('掃描改版前歷史路徑時略過：', err);
    }
  };

  void scanLegacyUserLocations();

  // 3. 即時監聽 workOrders 集合，自動比對 ownerId / userId / uid / createdBy / email
  const unsubscribe = onSnapshot(
    collection(db, WORK_ORDERS_COLLECTION),
    (snapshot) => {
      mainCollectionMap.clear();
      snapshot.forEach((docSnap) => {
        // 略過以 uid 為 ID 的打包容器文件（已在上方處理）
        if (docSnap.id === ownerId) return;

        const raw = docSnap.data() as Record<string, unknown>;
        if (isOrderOwnedByUser(raw, ownerId, userEmail)) {
          const wo = normalizeLegacyWorkOrder(raw, docSnap.id, ownerId);
          if (wo) {
            mainCollectionMap.set(wo.id, wo);
          }
        }
      });

      emitCombinedOrders();
    },
    (error) => {
      console.error('Firestore 即時同步發生錯誤，使用個人本地快取：', error);
      onUpdate(loadLocalWorkOrders(ownerId));
    }
  );

  return unsubscribe;
};

/**
 * 新增或更新單筆個人工令（同時寫入 ownerId 與 userId / uid 以相容新舊查詢）
 */
export const saveUserWorkOrder = async (
  ownerId: string,
  workOrder: WorkOrder
): Promise<void> => {
  const sortedItems = sortMoItemsByCode(
    workOrder.items.map((item, idx) =>
      normalizeLegacyMoItem(
        item as unknown as Record<string, unknown>,
        idx
      )
    )
  );
  const totalAmount = sortedItems.reduce((sum, i) => sum + i.subtotal, 0);

  const securedOrder: WorkOrder & { userId: string; uid: string } = {
    ...workOrder,
    ownerId,
    userId: ownerId,
    uid: ownerId,
    items: sortedItems,
    totalAmount,
    updatedAt: new Date().toISOString(),
  };

  const currentOrders = loadLocalWorkOrders(ownerId);
  const existingIndex = currentOrders.findIndex(
    (o) => o.id === securedOrder.id
  );
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
 * 刪除單筆個人工令（同時清理主集合與可能殘留的舊子集合文件）
 */
export const deleteUserWorkOrder = async (
  ownerId: string,
  workOrderId: string
): Promise<void> => {
  const currentOrders = loadLocalWorkOrders(ownerId);
  const nextOrders = currentOrders.filter((o) => o.id !== workOrderId);
  saveLocalWorkOrders(ownerId, nextOrders);

  const docRef = doc(db, WORK_ORDERS_COLLECTION, workOrderId);
  await deleteDoc(docRef);

  try {
    const legacySubDocRef = doc(
      db,
      'users',
      ownerId,
      'workOrders',
      workOrderId
    );
    await deleteDoc(legacySubDocRef);
  } catch {
    // 忽略子集合不存在之情況
  }
};