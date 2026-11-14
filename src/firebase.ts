// src/firebase.ts
// ============================================================================
// Firebase 核心設定與統一資料庫路徑模組
// 統一後唯一路徑架構：
// 1. 使用者主檔：artifacts/mobile-mo/users/{uid}
// 2. 工令主檔：  artifacts/mobile-mo/users/{uid}/workOrders/{workOrderId}
// 3. 工令明細：  artifacts/mobile-mo/users/{uid}/items/{itemId}
// 4. 自動遷移清理：登入時自動將根目錄殘留的 workOrders 搬移回上述統一路徑並刪除根目錄舊文件
// ============================================================================

import { initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import type { Auth } from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  writeBatch,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
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

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId
);

// 初始化 Firebase App 與服務實例（未設定環境變數時進入本地快取模式，避免啟動失敗）
let app: FirebaseApp | null = null;
export let auth: Auth | null = null;
export let db: Firestore | null = null;
export let provider: GoogleAuthProvider | null = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  provider = new GoogleAuthProvider();
} else {
  console.warn(
    '[Mobile-MO] Firebase 環境變數尚未設定，系統將以本地儲存 (localStorage) 模式運作。'
  );
}

export interface AuthUserInfo {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
}

const localAuthListeners = new Set<(user: AuthUserInfo | null) => void>();
const localOrderListeners = new Map<string, Set<(orders: WorkOrder[]) => void>>();

const readLocalAuthUser = (): AuthUserInfo | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      uid?: string;
      displayName?: string;
      email?: string;
    };
    if (!parsed?.uid) return null;
    return {
      uid: parsed.uid,
      displayName: parsed.displayName || '本地測試使用者',
      email: parsed.email || 'local@mobile-mo.local',
      photoURL: null,
    };
  } catch {
    return null;
  }
};

const notifyLocalAuthListeners = (user: AuthUserInfo | null) => {
  localAuthListeners.forEach((cb) => cb(user));
};

const notifyLocalOrderListeners = (ownerId: string, orders: WorkOrder[]) => {
  const listeners = localOrderListeners.get(ownerId);
  if (!listeners) return;
  listeners.forEach((cb) => cb(orders));
};

export const subscribeAuthState = (
  onUserChanged: (user: AuthUserInfo | null) => void
): (() => void) => {
  if (auth) {
    return onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        onUserChanged({
          uid: firebaseUser.uid,
          displayName: firebaseUser.displayName,
          email: firebaseUser.email,
          photoURL: firebaseUser.photoURL,
        });
      } else {
        onUserChanged(null);
      }
    });
  }

  localAuthListeners.add(onUserChanged);
  onUserChanged(readLocalAuthUser());
  return () => {
    localAuthListeners.delete(onUserChanged);
  };
};

export const signInWithGoogle = async (): Promise<void> => {
  if (auth && provider) {
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
    return;
  }

  const demoUser: AuthUserInfo = {
    uid: 'local-demo-user',
    displayName: '本地測試使用者',
    email: 'local@mobile-mo.local',
    photoURL: null,
  };
  localStorage.setItem(
    STORAGE_KEYS.CURRENT_USER,
    JSON.stringify({ uid: demoUser.uid, displayName: demoUser.displayName })
  );
  notifyLocalAuthListeners(demoUser);
};

export const signOutUser = async (): Promise<void> => {
  localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
  if (auth) {
    await signOut(auth);
    return;
  }
  notifyLocalAuthListeners(null);
};

// 統一資料庫路徑常數 (artifacts/mobile-mo/users/{uid})
const ARTIFACTS_COLLECTION = 'artifacts';
const APP_ARTIFACT_ID = 'mobile-mo';
const USERS_COLLECTION = 'users';
const WORK_ORDERS_SUBCOLLECTION = 'workOrders';
const AGREEMENTS_SUBCOLLECTION = 'agreements';
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
  if (!db) return;
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
    return Number.isNaN(parsed)
      ? new Date().toISOString()
      : new Date(parsed).toISOString();
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
 * 判斷字串是否為系統自動產生的暫代編號
 */
const isPlaceholderWoNumber = (val: string, docId: string): boolean => {
  const clean = val.trim();
  if (!clean || clean === '未編號') return true;
  const upperId = docId.trim().toUpperCase();
  if (upperId.length >= 8) {
    if (
      clean.toUpperCase() === upperId.slice(0, 8) ||
      clean.toUpperCase() === upperId.slice(0, 10) ||
      clean === docId.trim()
    ) {
      return true;
    }
  }
  return false;
};

/**
 * 判斷字串是否為系統自動產生的暫代工令名稱
 */
const isPlaceholderWoTitle = (val: string): boolean => {
  const clean = val.trim();
  if (!clean || clean === '未命名工令') return true;
  if (clean.startsWith('還原工令')) return true;
  return false;
};

/**
 * 從多個候選欄位名稱中，依序挑出第一個「非空白且非暫代值」的真實字串
 */
const pickFirstValidField = (
  raw: Record<string, unknown>,
  candidateKeys: string[],
  isPlaceholderFn?: (val: string) => boolean
): string => {
  for (const key of candidateKeys) {
    const val = raw[key];
    if (val !== undefined && val !== null) {
      const str = String(val).trim();
      if (str !== '' && (!isPlaceholderFn || !isPlaceholderFn(str))) {
        return str;
      }
    }
  }
  for (const key of candidateKeys) {
    const val = raw[key];
    if (val !== undefined && val !== null) {
      const str = String(val).trim();
      if (str !== '') {
        return str;
      }
    }
  }
  return '';
};

/**
 * 智慧提取工令的「原始工令編號」
 */
const extractOriginalWoNumber = (
  raw: Record<string, unknown>,
  docId: string
): string => {
  const numberKeys = [
    'no',
    'orderNo',
    'workOrderNo',
    'workOrderNumber',
    'woNo',
    'woNumber',
    'orderNumber',
    'moNo',
    'moNumber',
    'agreementNo',
    'contractNo',
    'code',
    'number',
    'serialNo',
    'sn',
    '工令編號',
    '編號',
  ];

  const found = pickFirstValidField(raw, numberKeys, (val) =>
    isPlaceholderWoNumber(val, docId)
  );
  if (found && !isPlaceholderWoNumber(found, docId)) {
    return found;
  }

  const excludedKeys = new Set([
    'id',
    'uid',
    'userid',
    'ownerid',
    'contractid',
    'workorderid',
    'photourl',
  ]);
  for (const [k, v] of Object.entries(raw)) {
    const lowerK = k.toLowerCase();
    if (excludedKeys.has(lowerK)) continue;
    if (
      (lowerK.includes('no') ||
        lowerK.includes('num') ||
        lowerK.includes('code') ||
        lowerK.includes('編號')) &&
      (typeof v === 'string' || typeof v === 'number')
    ) {
      const str = String(v).trim();
      if (str !== '' && !isPlaceholderWoNumber(str, docId)) {
        return str;
      }
    }
  }

  return found;
};

/**
 * 智慧提取工令的「原始工令名稱」
 */
const extractOriginalWoTitle = (raw: Record<string, unknown>): string => {
  const titleKeys = [
    'name',
    'orderName',
    'workOrderName',
    'woName',
    'moName',
    'projectName',
    'project',
    'agreementName',
    'subject',
    'title',
    'description',
    'desc',
    'note',
    '工令名稱',
    '工程名稱',
    '案名',
    '名稱',
  ];

  const found = pickFirstValidField(raw, titleKeys, isPlaceholderWoTitle);
  if (found && !isPlaceholderWoTitle(found)) {
    return found;
  }

  const excludedKeys = new Set([
    'ownername',
    'username',
    'displayname',
    'contractname',
  ]);
  for (const [k, v] of Object.entries(raw)) {
    const lowerK = k.toLowerCase();
    if (excludedKeys.has(lowerK)) continue;
    if (
      (lowerK.includes('name') ||
        lowerK.includes('title') ||
        lowerK.includes('project') ||
        lowerK.includes('名稱') ||
        lowerK.includes('案名') ||
        lowerK.includes('工程')) &&
      typeof v === 'string'
    ) {
      const str = v.trim();
      if (str !== '' && !isPlaceholderWoTitle(str)) {
        return str;
      }
    }
  }

  return found;
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
 * 正規化單筆 MO 明細（對應 items 子集合的 id, no, name, price, qty, workOrderId 欄位）
 */
const normalizeLegacyMoItem = (
  raw: Record<string, unknown>,
  fallbackId: string
): MoLineItem => {
  const code =
    pickFirstValidField(raw, [
      'no',
      'code',
      'itemCode',
      'productId',
      'productCode',
      'itemNo',
      '項目編號',
      '料號',
    ]) || 'ITEM';

  const name = pickFirstValidField(raw, [
    'name',
    'itemName',
    'productName',
    'title',
    'description',
    '項目名稱',
    '工項名稱',
    '品名',
  ]);

  const spec = pickFirstValidField(raw, [
    'spec',
    'specification',
    'model',
    '規格',
  ]);

  const unit = pickFirstValidField(raw, ['unit', 'uom', '單位']) || '式';

  const rawPrice = Number(
    raw.price ?? raw.unitPrice ?? raw.cost ?? raw['單價'] ?? 0
  );
  const unitPrice = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;

  const rawQty = Number(
    raw.qty ?? raw.quantity ?? raw.count ?? raw['數量'] ?? 1
  );
  const quantity = Number.isFinite(rawQty)
    ? Math.min(999, Math.max(1, Math.round(rawQty)))
    : 1;

  const subtotal = Math.round(unitPrice * quantity);

  return {
    id: String(raw.id || fallbackId),
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
 * 正規化單筆工令主檔資料（支援合併 workOrders、agreements 與 items 子集合）
 */
export const normalizeLegacyWorkOrder = (
  raw: Record<string, unknown>,
  docId: string,
  currentUid: string,
  externalItems?: MoLineItem[],
  supplementalMeta?: Record<string, unknown>
): WorkOrder | null => {
  if (!raw || typeof raw !== 'object') return null;

  const combinedRaw: Record<string, unknown> = supplementalMeta
    ? { ...supplementalMeta, ...raw }
    : raw;

  let rawWoNumber = extractOriginalWoNumber(raw, docId);
  if (
    (!rawWoNumber || isPlaceholderWoNumber(rawWoNumber, docId)) &&
    supplementalMeta
  ) {
    const metaNo = extractOriginalWoNumber(supplementalMeta, docId);
    if (metaNo) rawWoNumber = metaNo;
  }

  let rawTitle = extractOriginalWoTitle(raw);
  if ((!rawTitle || isPlaceholderWoTitle(rawTitle)) && supplementalMeta) {
    const metaTitle = extractOriginalWoTitle(supplementalMeta);
    if (metaTitle) rawTitle = metaTitle;
  }

  if (
    !rawWoNumber &&
    !rawTitle &&
    (!externalItems || externalItems.length === 0)
  ) {
    return null;
  }

  const woNumber =
    rawWoNumber || rawTitle || docId.slice(0, 8).toUpperCase();
  const title = rawTitle || rawWoNumber || '未命名工令';

  const embeddedRawArray =
    (Array.isArray(combinedRaw.items) && combinedRaw.items) ||
    (Array.isArray(combinedRaw.moItems) && combinedRaw.moItems) ||
    (Array.isArray(combinedRaw.details) && combinedRaw.details) ||
    [];

  const embeddedItems = embeddedRawArray.map((item, idx) =>
    normalizeLegacyMoItem(
      (item as Record<string, unknown>) || {},
      `${docId}-emb-${idx}`
    )
  );

  // 以 items 子集合 (externalItems) 為準，若子集合尚未同步該筆但主檔有內嵌明細則自動帶入
  let finalItems: MoLineItem[] = [];
  if (externalItems && externalItems.length > 0) {
    finalItems = externalItems;
  } else {
    finalItems = embeddedItems;
  }

  const sortedItems = sortMoItemsByCode(finalItems);
  const calculatedTotal = sortedItems.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );

  const createdAt = toSafeIsoString(
    combinedRaw.createdAt ??
      combinedRaw.createTime ??
      combinedRaw.date ??
      combinedRaw.timestamp
  );
  const updatedAt = toSafeIsoString(
    combinedRaw.updatedAt ??
      combinedRaw.updateTime ??
      combinedRaw.lastModified ??
      combinedRaw.createdAt ??
      combinedRaw.timestamp ??
      createdAt
  );

  return {
    id: String(combinedRaw.id || docId),
    woNumber,
    title,
    ownerId: currentUid,
    ownerName: pickFirstValidField(combinedRaw, [
      'ownerName',
      'userName',
      'displayName',
    ]),
    contractId:
      pickFirstValidField(combinedRaw, [
        'contractId',
        'contract',
        'databaseId',
      ]) ||
      CONTRACT_DATABASES[0]?.id ||
      'contract-1',
    status: combinedRaw.status === '已完成' ? '已完成' : '進行中',
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
  `${STORAGE_KEYS.WORK_ORDERS_PREFIX}unified_${ownerId.trim()}`;

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
 * 自動遷移並清除根目錄的 workOrders 集合
 * 將改版測試期間寫入根目錄 workOrders 的工令與明細，完整搬移至統一的
 * artifacts/mobile-mo/users/{uid}/workOrders 與 items，並刪除根目錄的舊文件
 */
const migrateAndCleanRootWorkOrders = async (ownerId: string): Promise<void> => {
  if (!db) return;
  try {
    const rootColRef = collection(db, WORK_ORDERS_SUBCOLLECTION);
    const rootSnap = await getDocs(
      query(rootColRef, where('ownerId', '==', ownerId))
    );

    if (rootSnap.empty) return;

    const batch = writeBatch(db);
    const userWorkOrdersColRef = collection(
      db,
      ARTIFACTS_COLLECTION,
      APP_ARTIFACT_ID,
      USERS_COLLECTION,
      ownerId,
      WORK_ORDERS_SUBCOLLECTION
    );
    const userItemsColRef = collection(
      db,
      ARTIFACTS_COLLECTION,
      APP_ARTIFACT_ID,
      USERS_COLLECTION,
      ownerId,
      ITEMS_SUBCOLLECTION
    );

    rootSnap.forEach((rootDocSnap) => {
      const raw = rootDocSnap.data() as Record<string, unknown>;
      const wo = normalizeLegacyWorkOrder(raw, rootDocSnap.id, ownerId);

      if (wo) {
        // 1. 寫入統一的 artifacts/mobile-mo/users/{uid}/workOrders/{wo.id}
        const targetWoRef = doc(userWorkOrdersColRef, wo.id);
        batch.set(
          targetWoRef,
          {
            id: wo.id,
            no: wo.woNumber,
            woNumber: wo.woNumber,
            name: wo.title,
            title: wo.title,
            contractId: wo.contractId,
            totalAmount: wo.totalAmount,
            ownerId,
            ownerName: wo.ownerName,
            status: wo.status,
            createdAt: wo.createdAt,
            updatedAt: wo.updatedAt,
          },
          { merge: true }
        );

        // 2. 將內嵌的 items 寫入統一的 artifacts/mobile-mo/users/{uid}/items/{item.id}
        wo.items.forEach((item) => {
          const targetItemRef = doc(userItemsColRef, item.id);
          batch.set(
            targetItemRef,
            {
              id: item.id,
              no: item.code,
              name: item.name,
              spec: item.spec || '',
              price: item.unitPrice,
              qty: item.quantity,
              workOrderId: wo.id,
              workOrderNo: wo.woNumber,
              workOrderName: wo.title,
            },
            { merge: true }
          );
        });
      }

      // 3. 刪除根目錄 workOrders 中的文件（清空後根目錄 workOrders 集合即自動消失）
      batch.delete(rootDocSnap.ref);
    });

    await batch.commit();
  } catch (err) {
    console.warn('遷移並清理根目錄 workOrders 時略過：', err);
  }
};

/**
 * 訂閱特定 Google 登入者 (ownerId) 的所有工令與明細
 * 統一監聽唯一路徑：artifacts/mobile-mo/users/{uid}/workOrders 與 items
 */
export const subscribeUserWorkOrders = (
  ownerId: string,
  onUpdate: (orders: WorkOrder[]) => void
): (() => void) => {
  const cachedOrders = loadLocalWorkOrders(ownerId);
  onUpdate(cachedOrders);

  if (!db) {
    const listeners = localOrderListeners.get(ownerId) || new Set();
    listeners.add(onUpdate);
    localOrderListeners.set(ownerId, listeners);
    return () => {
      const current = localOrderListeners.get(ownerId);
      if (current) {
        current.delete(onUpdate);
        if (current.size === 0) {
          localOrderListeners.delete(ownerId);
        }
      }
    };
  }

  const firestoreDb = db;

  // 啟動背景自動遷移與清除根目錄殘留的 workOrders
  void migrateAndCleanRootWorkOrders(ownerId);

  const artifactRawWorkOrders = new Map<string, Record<string, unknown>>();
  const artifactRawAgreements = new Map<string, Record<string, unknown>>();
  const artifactItemsByWoId = new Map<string, MoLineItem[]>();
  const itemRawMetaByWoId = new Map<string, Record<string, unknown>>();

  const initialSync = {
    workOrders: false,
    agreements: false,
    items: false,
  };

  const findSupplementalMeta = (
    targetWoId: string
  ): Record<string, unknown> | undefined => {
    if (artifactRawWorkOrders.has(targetWoId)) {
      return artifactRawWorkOrders.get(targetWoId);
    }
    if (artifactRawAgreements.has(targetWoId)) {
      return artifactRawAgreements.get(targetWoId);
    }
    for (const [, agData] of artifactRawAgreements.entries()) {
      const linkedId = String(
        agData.workOrderId ?? agData.orderId ?? agData.moId ?? ''
      ).trim();
      if (linkedId === targetWoId) {
        return agData;
      }
    }
    if (itemRawMetaByWoId.has(targetWoId)) {
      return itemRawMetaByWoId.get(targetWoId);
    }
    return undefined;
  };

  // 統整統一集合內的資料並通知 UI 更新
  const rebuildAndEmitOrders = () => {
    if (
      !initialSync.workOrders ||
      !initialSync.agreements ||
      !initialSync.items
    ) {
      return;
    }

    const finalOrdersMap = new Map<string, WorkOrder>();
    const handledWoIds = new Set<string>();

    // 1. 組裝 artifacts/mobile-mo/users/{uid}/workOrders 與對應的 items
    artifactRawWorkOrders.forEach((rawWo, woDocId) => {
      const targetWoId = String(rawWo.id || woDocId).trim();
      handledWoIds.add(targetWoId);
      handledWoIds.add(woDocId);

      const linkedItems = [
        ...(artifactItemsByWoId.get(targetWoId) || []),
        ...(targetWoId !== woDocId
          ? artifactItemsByWoId.get(woDocId) || []
          : []),
      ];

      const suppMeta =
        artifactRawAgreements.get(targetWoId) ||
        artifactRawAgreements.get(woDocId) ||
        itemRawMetaByWoId.get(targetWoId);

      const normalizedWo = normalizeLegacyWorkOrder(
        rawWo,
        targetWoId,
        ownerId,
        linkedItems,
        suppMeta
      );

      if (normalizedWo) {
        finalOrdersMap.set(normalizedWo.id, normalizedWo);
      }
    });

    // 2. 相容讀取 agreements 子集合中尚未轉入 workOrders 的舊工令主檔
    artifactRawAgreements.forEach((rawAg, agDocId) => {
      const targetWoId = String(
        rawAg.workOrderId ?? rawAg.orderId ?? rawAg.id ?? agDocId
      ).trim();
      if (handledWoIds.has(targetWoId) || handledWoIds.has(agDocId)) return;

      const linkedItems = [
        ...(artifactItemsByWoId.get(targetWoId) || []),
        ...(targetWoId !== agDocId
          ? artifactItemsByWoId.get(agDocId) || []
          : []),
      ];

      const normalizedAgWo = normalizeLegacyWorkOrder(
        rawAg,
        targetWoId,
        ownerId,
        linkedItems
      );
      if (normalizedAgWo) {
        handledWoIds.add(targetWoId);
        handledWoIds.add(agDocId);
        finalOrdersMap.set(normalizedAgWo.id, normalizedAgWo);
      }
    });

    // 3. 若 items 子集合有孤立的 workOrderId，自動還原為工令卡片
    artifactItemsByWoId.forEach((itemsList, orphanWoId) => {
      if (handledWoIds.has(orphanWoId) || itemsList.length === 0) return;

      const suppMeta = findSupplementalMeta(orphanWoId);
      if (suppMeta) {
        const recoveredWo = normalizeLegacyWorkOrder(
          suppMeta,
          orphanWoId,
          ownerId,
          itemsList
        );
        if (recoveredWo && !isPlaceholderWoTitle(recoveredWo.title)) {
          finalOrdersMap.set(orphanWoId, recoveredWo);
          return;
        }
      }

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
    });

    const combined = Array.from(finalOrdersMap.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
    saveLocalWorkOrders(ownerId, combined);
    onUpdate(combined);
  };

  // 檢查使用者文件本身是否內嵌舊工令陣列
  const checkUserDocEmbeddedOrders = async () => {
    try {
      const userDocRef = doc(
        firestoreDb,
        ARTIFACTS_COLLECTION,
        APP_ARTIFACT_ID,
        USERS_COLLECTION,
        ownerId
      );
      const userSnap = await getDoc(userDocRef);
      if (userSnap.exists()) {
        const data = userSnap.data() as Record<string, unknown>;
        const embeddedList =
          (Array.isArray(data.workOrders) && data.workOrders) ||
          (Array.isArray(data.orders) && data.orders) ||
          [];
        embeddedList.forEach((rawItem, idx) => {
          if (rawItem && typeof rawItem === 'object') {
            const obj = rawItem as Record<string, unknown>;
            const id = String(
              obj.id ?? obj.workOrderId ?? `user-emb-${idx}`
            ).trim();
            if (!artifactRawWorkOrders.has(id)) {
              artifactRawWorkOrders.set(id, obj);
            }
          }
        });
        rebuildAndEmitOrders();
      }
    } catch {
      // 忽略讀取限制
    }
  };
  void checkUserDocEmbeddedOrders();

  // 監聽 1：artifacts/mobile-mo/users/{uid}/workOrders
  const userWorkOrdersColRef = collection(
    firestoreDb,
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
      initialSync.workOrders = true;
      rebuildAndEmitOrders();
    },
    (err) => {
      console.warn('讀取 artifacts workOrders 子集合時發生錯誤：', err);
      initialSync.workOrders = true;
      rebuildAndEmitOrders();
    }
  );

  // 監聽 2：artifacts/mobile-mo/users/{uid}/agreements
  const userAgreementsColRef = collection(
    firestoreDb,
    ARTIFACTS_COLLECTION,
    APP_ARTIFACT_ID,
    USERS_COLLECTION,
    ownerId,
    AGREEMENTS_SUBCOLLECTION
  );

  const unsubArtifactAgreements = onSnapshot(
    userAgreementsColRef,
    (snapshot) => {
      artifactRawAgreements.clear();
      snapshot.forEach((docSnap) => {
        artifactRawAgreements.set(
          docSnap.id,
          docSnap.data() as Record<string, unknown>
        );
      });
      initialSync.agreements = true;
      rebuildAndEmitOrders();
    },
    (err) => {
      console.warn('讀取 artifacts agreements 子集合時略過：', err);
      initialSync.agreements = true;
      rebuildAndEmitOrders();
    }
  );

  // 監聽 3：artifacts/mobile-mo/users/{uid}/items
  const userItemsColRef = collection(
    firestoreDb,
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
      itemRawMetaByWoId.clear();
      snapshot.forEach((docSnap) => {
        const raw = docSnap.data() as Record<string, unknown>;
        const woId = String(
          raw.workOrderId ?? raw.orderId ?? raw.moId ?? 'default-wo'
        ).trim();
        const normalizedItem = normalizeLegacyMoItem(raw, docSnap.id);
        const list = artifactItemsByWoId.get(woId) || [];
        list.push(normalizedItem);
        artifactItemsByWoId.set(woId, list);

        if (
          raw.workOrderNo ||
          raw.workOrderName ||
          raw.orderNo ||
          raw.orderName ||
          raw.woNumber ||
          raw.woName
        ) {
          itemRawMetaByWoId.set(woId, {
            no: raw.workOrderNo ?? raw.orderNo ?? raw.woNumber,
            name: raw.workOrderName ?? raw.orderName ?? raw.woName,
          });
        }
      });
      initialSync.items = true;
      rebuildAndEmitOrders();
    },
    (err) => {
      console.warn('讀取 artifacts items 子集合時發生錯誤：', err);
      initialSync.items = true;
      rebuildAndEmitOrders();
    }
  );

  return () => {
    unsubArtifactWorkOrders();
    unsubArtifactAgreements();
    unsubArtifactItems();
  };
};

/**
 * 新增或更新單筆個人工令
 * 唯一寫入目標：artifacts/mobile-mo/users/{uid}/workOrders 與 items 子集合
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
  const existingIndex = currentOrders.findIndex(
    (o) => o.id === securedOrder.id
  );
  if (existingIndex >= 0) {
    currentOrders[existingIndex] = securedOrder;
  } else {
    currentOrders.unshift(securedOrder);
  }
  saveLocalWorkOrders(ownerId, currentOrders);
  notifyLocalOrderListeners(ownerId, currentOrders);

  if (!db) return;

  // 2. 使用單一 WriteBatch 原子化更新 workOrders 主檔與 items 明細子集合
  const userWorkOrdersColRef = collection(
    db,
    ARTIFACTS_COLLECTION,
    APP_ARTIFACT_ID,
    USERS_COLLECTION,
    ownerId,
    WORK_ORDERS_SUBCOLLECTION
  );
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

  // (a) 寫入工令主檔至 artifacts/mobile-mo/users/{uid}/workOrders/{id}
  const artifactWoDocRef = doc(userWorkOrdersColRef, securedOrder.id);
  batch.set(
    artifactWoDocRef,
    {
      id: securedOrder.id,
      no: securedOrder.woNumber,
      woNumber: securedOrder.woNumber,
      name: securedOrder.title,
      title: securedOrder.title,
      contractId: securedOrder.contractId,
      totalAmount: securedOrder.totalAmount,
      ownerId,
      ownerName: securedOrder.ownerName,
      status: securedOrder.status,
      createdAt: securedOrder.createdAt,
      updatedAt: securedOrder.updatedAt,
    },
    { merge: true }
  );

  // (b) 刪除該工令下已被移除的舊明細文件
  const nextItemIds = new Set(sortedItems.map((i) => i.id));
  existingItemsSnap.forEach((docSnap) => {
    if (!nextItemIds.has(docSnap.id)) {
      batch.delete(docSnap.ref);
    }
  });

  // (c) 寫入該工令目前的所有明細至 artifacts/mobile-mo/users/{uid}/items/{itemId}
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
      workOrderNo: securedOrder.woNumber,
      workOrderName: securedOrder.title,
    });
  });

  await batch.commit();
};

/**
 * 刪除單筆個人工令（同步刪除統一集合下的 workOrders 主檔、agreements 與 items 子集合明細）
 */
export const deleteUserWorkOrder = async (
  ownerId: string,
  workOrderId: string
): Promise<void> => {
  const currentOrders = loadLocalWorkOrders(ownerId);
  const nextOrders = currentOrders.filter((o) => o.id !== workOrderId);
  saveLocalWorkOrders(ownerId, nextOrders);
  notifyLocalOrderListeners(ownerId, nextOrders);

  if (!db) return;

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

  const batch = writeBatch(db);

  // 1. 刪除 artifacts/mobile-mo/users/{uid}/workOrders/{workOrderId}
  const artifactWoDocRef = doc(
    db,
    ARTIFACTS_COLLECTION,
    APP_ARTIFACT_ID,
    USERS_COLLECTION,
    ownerId,
    WORK_ORDERS_SUBCOLLECTION,
    workOrderId
  );
  batch.delete(artifactWoDocRef);

  // 2. 刪除 artifacts/mobile-mo/users/{uid}/agreements/{workOrderId}（若存在）
  const artifactAgDocRef = doc(
    db,
    ARTIFACTS_COLLECTION,
    APP_ARTIFACT_ID,
    USERS_COLLECTION,
    ownerId,
    AGREEMENTS_SUBCOLLECTION,
    workOrderId
  );
  batch.delete(artifactAgDocRef);

  // 3. 刪除 artifacts/mobile-mo/users/{uid}/items 中所有屬於該工令的明細
  itemsSnap.forEach((docSnap) => {
    batch.delete(docSnap.ref);
  });

  await batch.commit();
};
