// src/firebase.ts
// ============================================================================
// Firebase 核心設定與 Firestore 雙層集合 (artifacts/mobile-mo/users/{uid}) 同步模組
// 1. 精準對應原始資料庫路徑：
//    - 使用者文件：artifacts/mobile-mo/users/{uid}
//    - 工令子集合：artifacts/mobile-mo/users/{uid}/workOrders
//    - 明細子集合：artifacts/mobile-mo/users/{uid}/items (含 id, name, no, price, qty, workOrderId)
// 2. 同時相容根目錄 workOrders 集合，自動依 workOrderId 關聯組裝並依項目編號排序
// ============================================================================

import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  serverTimestamp,
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

// 原始資料庫固定 App 路徑名稱 (對應 artifacts/mobile-mo/users/{uid})
const ARTIFACTS_COLLECTION = 'artifacts';
const APP_ARTIFACT_ID = 'mobile-mo';
const USERS_COLLECTION = 'users';
const WORK_ORDERS_SUBCOLLECTION = 'workOrders';
const ITEMS_SUBCOLLECTION = 'items';

/**
 * 更新 Google 登入使用者的基本資料至 artifacts/mobile-mo/users/{uid}
 */
export const updateUserLoginProfile = async (user: {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}): Promise<void> => {
  try {
    const userDocRef = doc(
      db,
      ARTIFACTS_COLLECTION,
      APP_ARTIFACT_ID,
      USERS_COLLECTION,
      user.uid
    );
    await setDoc(
      userDocRef,
      {
        uid: user.uid,
        displayName: user.displayName || user.email?.split('@')[0] || '使用者',
        email: user.email || '',
        photoURL: user.photoURL || '',
        lastLogin: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn('更新使用者登入紀錄時略過：', err);
  }
};

/**
 * 將任意時間格式（Firestore Timestamp、毫秒數字、日期字串）安全轉為 ISO 字串
 */
const toSafeIsoString = (val: unknown): string => {
  if (!val) return new Date().toISOString();
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
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
 * 正規化單筆 MO 明細（完整對應舊版 items 集合的 no, name, price, qty, workOrderId 欄位）
 */
const normalizeLegacyMoItem = (
  raw: Record<string, unknown>,
  fallbackId: string
): MoLineItem => {
  // 對應舊版欄位 no (如 "Y6N1OZ4903AO") 或新版 code
  const code = String(
    raw.code ??
      raw.no ??
      raw.itemCode ??
      raw.productId ??
      raw.productCode ??
      raw.itemNo ??
      raw['項目編號'] ??
      raw['料號'] ??
      'ITEM'
  ).trim();

  // 對應舊版欄位 name (如 "監火、警戒、急救人員(含扶梯人員)")
  const name = String(
    raw.name ??
      raw.itemName ??
      raw.productName ??
      raw.title ??
      raw.description ??
      raw['項目名稱'] ??
      raw['工項名稱'] ??
      ''
  ).trim();

  const spec = String(
    raw.spec ?? raw.specification ?? raw.model ?? raw['規格'] ?? ''
  ).trim();

  const unit = String(raw.unit ?? raw.uom ?? raw['單位'] ?? '式').trim();

  // 對應舊版欄位 price (如 262) 或新版 unitPrice
  const rawPrice = Number(
    raw.unitPrice ?? raw.price ?? raw.cost ?? raw['單價'] ?? 0
  );
  const unitPrice = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;

  // 對應舊版欄位 qty (如 8) 或新版 quantity，並限制範圍 1 ~ 999
  const rawQty = Number(
    raw.quantity ?? raw.qty ?? raw.count ?? raw['數量'] ?? 1
  );
  const quantity = Number.isFinite(rawQty)
    ? Math.min(999, Math.max(1, Math.round(rawQty)))
    : 1;

  const subtotal = Math.round(unitPrice * quantity);

  return {
    id: String(raw.id ?? fallbackId),
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
 * 正規化單筆工令主檔資料（同時支援內嵌 items 與外部 items 子集合組裝）
 */
export const normalizeLegacyWorkOrder = (
  raw: Record<string, unknown>,
  docId: string,
  currentUid: string,
  externalItems?: MoLineItem[]
): WorkOrder | null => {
  if (!raw || typeof raw !== 'object') return null;

  // 擷取工令編號（相容舊版 no, orderNo, woNumber, code 等欄位）
  const rawWoNumber = String(
    raw.woNumber ??
      raw.no ??
      raw.orderNo ??
      raw.workOrderNo ??
      raw.workOrderNumber ??
      raw.orderNumber ??
      raw.moNumber ??
      raw.moNo ??
      raw.number ??
      raw.code ??
      raw['工令編號'] ??
      ''
  ).trim();

  // 擷取工令名稱（相容舊版 name, title, workOrderName, orderName 等欄位）
  const rawTitle = String(
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

  if (!rawWoNumber && !rawTitle && (!externalItems || externalItems.length === 0)) {
    return null;
  }

  const woNumber = rawWoNumber || rawTitle || docId.slice(0, 8).toUpperCase();
  const title = rawTitle || rawWoNumber || '未命名工令';

  // 擷取內嵌明細陣列（若有）
  const embeddedRawArray =
    (Array.isArray(raw.items) && raw.items) ||
    (Array.isArray(raw.moItems) && raw.moItems) ||
    (Array.isArray(raw.details) && raw.details) ||
    [];

  const embeddedItems = embeddedRawArray.map((item, idx) =>
    normalizeLegacyMoItem(
      (item as Record<string, unknown>) || {},
      `${docId}-emb-${idx}`
    )
  );

  // 合併內嵌明細與來自 artifacts/mobile-mo/users/{uid}/items 子集合的明細
  let finalItems: MoLineItem[] = [];
  if (raw.itemsMigrated === true) {
    // 已由新版寫入完整明細陣列
    finalItems = embeddedItems;
  } else if (externalItems && externalItems.length > 0) {
    // 優先使用舊版 items 子集合透過 workOrderId 關聯的明細資料
    const itemMap = new Map<string, MoLineItem>();
    embeddedItems.forEach((it) => itemMap.set(`${it.code}__${it.name}`, it));
    externalItems.forEach((it) => itemMap.set(it.id, it));
    finalItems = Array.from(itemMap.values());
  } else {
    finalItems = embeddedItems;
  }

  const sortedItems = sortMoItemsByCode(finalItems);
  const calculatedTotal = sortedItems.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );

  const createdAt = toSafeIsoString(
    raw.createdAt ?? raw.createTime ?? raw.date ?? raw.timestamp
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
    id: String(raw.id ?? docId),
    woNumber,
    title,
    ownerId: currentUid,
    ownerName: String(raw.ownerName ?? raw.userName ?? raw.displayName ?? '').trim(),
    contractId: String(
      raw.contractId ??
        raw.contract ??
        raw.databaseId ??
        CONTRACT_DATABASES[0]?.id ??
        'contract-1'
    ),
    status: raw.status === '已完成' ? '已完成' : '進行中',
    items: sortedItems,
    totalAmount: calculatedTotal,
    createdAt,
    updatedAt,
  };
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
      if (wo) {
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
 * 訂閱特定 Google 登入者 (ownerId) 的所有工令與明細
 * 同時即時監聽：
 * 1. artifacts/mobile-mo/users/{uid}/workOrders (原版工令主檔集合)
 * 2. artifacts/mobile-mo/users/{uid}/items (原版工令明細集合，依 workOrderId 關聯)
 * 3. 根目錄 workOrders (相容改版過渡期建立之工令)
 */
export const subscribeUserWorkOrders = (
  ownerId: string,
  onUpdate: (orders: WorkOrder[]) => void
): (() => void) => {
  // 先載入本地快取提供 0 延遲畫面
  const cachedOrders = loadLocalWorkOrders(ownerId);
  if (cachedOrders.length > 0) {
    onUpdate(cachedOrders);
  }

  // 存放各來源原始資料
  const artifactRawWorkOrders = new Map<string, Record<string, unknown>>();
  const artifactItemsByWoId = new Map<string, MoLineItem[]>();
  const rootWorkOrdersMap = new Map<string, WorkOrder>();

  // 統整所有來源並組裝出最終的工令清單
  const rebuildAndEmitOrders = () => {
    const finalOrdersMap = new Map<string, WorkOrder>();

    // 1. 先放入根目錄 workOrders 的工令
    rootWorkOrdersMap.forEach((wo, id) => {
      finalOrdersMap.set(id, wo);
    });

    // 2. 組裝 artifacts/mobile-mo/users/{uid}/workOrders 與對應的 items
    const handledWoIds = new Set<string>();
    artifactRawWorkOrders.forEach((rawWo, woDocId) => {
      const targetWoId = String(rawWo.id ?? woDocId);
      handledWoIds.add(targetWoId);
      handledWoIds.add(woDocId);

      const linkedItems = [
        ...(artifactItemsByWoId.get(targetWoId) || []),
        ...(targetWoId !== woDocId ? artifactItemsByWoId.get(woDocId) || [] : []),
      ];

      const normalizedWo = normalizeLegacyWorkOrder(
        rawWo,
        targetWoId,
        ownerId,
        linkedItems
      );

      if (normalizedWo) {
        finalOrdersMap.set(normalizedWo.id, normalizedWo);
      }
    });

    // 3. 防呆還原：若 artifacts/mobile-mo/users/{uid}/items 中有某個 workOrderId，
    //    但其父工令不在 workOrders 子集合中，自動為該批明細重組建立工令卡片，確保資料 0 遺失
    artifactItemsByWoId.forEach((itemsList, orphanWoId) => {
      if (handledWoIds.has(orphanWoId) || itemsList.length === 0) return;

      const existingInRoot = finalOrdersMap.get(orphanWoId);
      if (existingInRoot) {
        // 若該工令主檔在根目錄，將子集合明細合併進去
        const mergedItems = sortMoItemsByCode(
          existingInRoot.items.length > 0 ? existingInRoot.items : itemsList
        );
        finalOrdersMap.set(orphanWoId, {
          ...existingInRoot,
          items: mergedItems,
          totalAmount: mergedItems.reduce((sum, i) => sum + i.subtotal, 0),
        });
      } else {
        // 自動為孤立的 workOrderId 建立還原工令卡片
        const sorted = sortMoItemsByCode(itemsList);
        const total = sorted.reduce((sum, i) => sum + i.subtotal, 0);
        finalOrdersMap.set(orphanWoId, {
          id: orphanWoId,
          woNumber: orphanWoId.slice(0, 10).toUpperCase(),
          title: `還原工令 (${sorted[0]?.name || orphanWoId.slice(0, 6)})`,
          ownerId,
          ownerName: '',
          contractId: CONTRACT_DATABASES[0]?.id || 'contract-1',
          status: '進行中',
          items: sorted,
          totalAmount: total,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    });

    const combined = Array.from(finalOrdersMap.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
    saveLocalWorkOrders(ownerId, combined);
    onUpdate(combined);
  };

  // 監聽 1：artifacts/mobile-mo/users/{uid}/workOrders (原版工令主檔子集合)
  const userWorkOrdersColRef = collection(
    db,
    ARTIFACTS_COLLECTION,
    APP_ARTIFACT_ID,
    USERS_COLLECTION,
    ownerId,
    WORK_ORDERS_SUBCOLLECTION
  );

  const unsubArtifactWorkOrders = onSnapshot(
    userWorkOrdersColRef,
    (snapshot) => {
      artifactRawWorkOrders.clear();
      snapshot.forEach((docSnap) => {
        artifactRawWorkOrders.set(
          docSnap.id,
          docSnap.data() as Record<string, unknown>
        );
      });
      rebuildAndEmitOrders();
    },
    (err) => {
      console.warn('讀取 artifacts workOrders 子集合時發生錯誤：', err);
    }
  );

  // 監聽 2：artifacts/mobile-mo/users/{uid}/items (原版工令明細子集合)
  const userItemsColRef = collection(
    db,
    ARTIFACTS_COLLECTION,
    APP_ARTIFACT_ID,
    USERS_COLLECTION,
    ownerId,
    ITEMS_SUBCOLLECTION
  );

  const unsubArtifactItems = onSnapshot(
    userItemsColRef,
    (snapshot) => {
      artifactItemsByWoId.clear();
      snapshot.forEach((docSnap) => {
        const raw = docSnap.data() as Record<string, unknown>;
        const woId = String(
          raw.workOrderId ?? raw.orderId ?? raw.moId ?? 'default-wo'
        ).trim();
        const normalizedItem = normalizeLegacyMoItem(raw, docSnap.id);
        const list = artifactItemsByWoId.get(woId) || [];
        list.push(normalizedItem);
        artifactItemsByWoId.set(woId, list);
      });
      rebuildAndEmitOrders();
    },
    (err) => {
      console.warn('讀取 artifacts items 子集合時發生錯誤：', err);
    }
  );

  // 監聽 3：根目錄 workOrders (相容改版過渡期建立之工令)
  const rootWoQuery = query(
    collection(db, WORK_ORDERS_SUBCOLLECTION),
    where('ownerId', '==', ownerId)
  );

  const unsubRootWorkOrders = onSnapshot(
    rootWoQuery,
    (snapshot) => {
      rootWorkOrdersMap.clear();
      snapshot.forEach((docSnap) => {
        const raw = docSnap.data() as Record<string, unknown>;
        const wo = normalizeLegacyWorkOrder(raw, docSnap.id, ownerId);
        if (wo) {
          rootWorkOrdersMap.set(wo.id, wo);
        }
      });
      rebuildAndEmitOrders();
    },
    () => {
      // 忽略根目錄權限或連線警告
    }
  );

  return () => {
    unsubArtifactWorkOrders();
    unsubArtifactItems();
    unsubRootWorkOrders();
  };
};

/**
 * 新增或更新單筆個人工令
 * 同步寫入 artifacts/mobile-mo/users/{uid}/workOrders 與 items 子集合
 */
export const saveUserWorkOrder = async (
  ownerId: string,
  workOrder: WorkOrder
): Promise<void> => {
  const sortedItems = sortMoItemsByCode(
    workOrder.items.map((item, idx) =>
      normalizeLegacyMoItem(
        item as unknown as Record<string, unknown>,
        item.id || `item-${idx}`
      )
    )
  );
  const totalAmount = sortedItems.reduce((sum, i) => sum + i.subtotal, 0);
  const nowIso = new Date().toISOString();

  const securedOrder: WorkOrder = {
    ...workOrder,
    ownerId,
    items: sortedItems,
    totalAmount,
    updatedAt: nowIso,
  };

  // 1. 樂觀更新本地快取
  const currentOrders = loadLocalWorkOrders(ownerId);
  const existingIndex = currentOrders.findIndex((o) => o.id === securedOrder.id);
  if (existingIndex >= 0) {
    currentOrders[existingIndex] = securedOrder;
  } else {
    currentOrders.unshift(securedOrder);
  }
  saveLocalWorkOrders(ownerId, currentOrders);

  // 2. 寫入 artifacts/mobile-mo/users/{uid}/workOrders/{workOrderId}（同時保留舊版欄位名稱 no, name）
  const artifactWoDocRef = doc(
    db,
    ARTIFACTS_COLLECTION,
    APP_ARTIFACT_ID,
    USERS_COLLECTION,
    ownerId,
    WORK_ORDERS_SUBCOLLECTION,
    securedOrder.id
  );

  await setDoc(
    artifactWoDocRef,
    {
      ...securedOrder,
      no: securedOrder.woNumber,
      name: securedOrder.title,
      itemsMigrated: true,
    },
    { merge: true }
  );

  // 3. 同步更新 artifacts/mobile-mo/users/{uid}/items 子集合內該工令的所有明細
  try {
    const userItemsColRef = collection(
      db,
      ARTIFACTS_COLLECTION,
      APP_ARTIFACT_ID,
      USERS_COLLECTION,
      ownerId,
      ITEMS_SUBCOLLECTION
    );
    const existingItemsSnap = await getDocs(
      query(userItemsColRef, where('workOrderId', '==', securedOrder.id))
    );

    const batch = writeBatch(db);
    const nextItemIds = new Set(sortedItems.map((i) => i.id));

    // 刪除已被移除的舊明細文件
    existingItemsSnap.forEach((docSnap) => {
      if (!nextItemIds.has(docSnap.id)) {
        batch.delete(docSnap.ref);
      }
    });

    // 新增或更新目前的明細文件（相容原版 id, name, no, price, qty, workOrderId 格式）
    sortedItems.forEach((item) => {
      const itemDocRef = doc(userItemsColRef, item.id);
      batch.set(itemDocRef, {
        id: item.id,
        no: item.code,
        name: item.name,
        spec: item.spec || '',
        price: item.unitPrice,
        qty: item.quantity,
        workOrderId: securedOrder.id,
      });
    });

    await batch.commit();
  } catch (err) {
    console.warn('同步寫入 items 子集合時略過：', err);
  }

  // 4. 若根目錄 workOrders 也有此工令，同步更新
  try {
    const rootDocRef = doc(db, WORK_ORDERS_SUBCOLLECTION, securedOrder.id);
    await setDoc(rootDocRef, securedOrder, { merge: true });
  } catch {
    // 忽略根目錄寫入限制
  }
};

/**
 * 刪除單筆個人工令（同步刪除 workOrders 主檔與 items 子集合中對應該 workOrderId 的所有明細）
 */
export const deleteUserWorkOrder = async (
  ownerId: string,
  workOrderId: string
): Promise<void> => {
  // 1. 移除本地快取
  const currentOrders = loadLocalWorkOrders(ownerId);
  const nextOrders = currentOrders.filter((o) => o.id !== workOrderId);
  saveLocalWorkOrders(ownerId, nextOrders);

  // 2. 刪除 artifacts/mobile-mo/users/{uid}/workOrders/{workOrderId}
  try {
    const artifactWoDocRef = doc(
      db,
      ARTIFACTS_COLLECTION,
      APP_ARTIFACT_ID,
      USERS_COLLECTION,
      ownerId,
      WORK_ORDERS_SUBCOLLECTION,
      workOrderId
    );
    await deleteDoc(artifactWoDocRef);
  } catch (err) {
    console.warn('刪除 artifacts workOrder 主檔時略過：', err);
  }

  // 3. 批次刪除 artifacts/mobile-mo/users/{uid}/items 中所有 workOrderId === 該工令的明細文件
  try {
    const userItemsColRef = collection(
      db,
      ARTIFACTS_COLLECTION,
      APP_ARTIFACT_ID,
      USERS_COLLECTION,
      ownerId,
      ITEMS_SUBCOLLECTION
    );
    const itemsSnap = await getDocs(
      query(userItemsColRef, where('workOrderId', '==', workOrderId))
    );
    if (!itemsSnap.empty) {
      const batch = writeBatch(db);
      itemsSnap.forEach((docSnap) => {
        batch.delete(docSnap.ref);
      });
      await batch.commit();
    }
  } catch (err) {
    console.warn('清理 artifacts items 明細子集合時略過：', err);
  }

  // 4. 同步刪除根目錄 workOrders 中的文件（若存在）
  try {
    const rootDocRef = doc(db, WORK_ORDERS_SUBCOLLECTION, workOrderId);
    await deleteDoc(rootDocRef);
  } catch {
    // 忽略根目錄不存在之情況
  }
};
