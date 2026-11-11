// src/App.tsx
// ============================================================================
// Mobile-MO 行動工令管理系統主程式
// 修復重點：
// 1. 移除未在執行期呼叫的預設 import React，改用 import type { FC, FormEvent }，
//    解決 tsconfig.app.json 的 TS6133 / TS1484 編譯錯誤
// 2. 保留工令管理、工令明細與個人帳號資料隔離；移除協議書分頁與右上角設定按鈕
// ============================================================================

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { FC, FormEvent } from 'react';
import { onAuthStateChanged, signInWithPopup } from 'firebase/auth';
import { Wrench, UserCheck, LogIn } from 'lucide-react';
import type { ActiveTab, UserProfile, WorkOrder } from './types';
import { CONTRACT_DATABASES, STORAGE_KEYS } from './constants';
import {
  auth,
  provider,
  subscribeUserWorkOrders,
  saveUserWorkOrder,
  deleteUserWorkOrder,
} from './firebase';
import { WorkOrderListView } from './components/WorkOrderListView';
import { MoDetailView } from './components/MoDetailView';
import { BottomNavigation } from './components/BottomNavigation';

export const App: FC = () => {
  // 1. 登入者狀態：優先讀取本地儲存或由 Firebase Auth onAuthStateChanged 自動帶入
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
      return saved ? (JSON.parse(saved) as UserProfile) : null;
    } catch {
      return null;
    }
  });
  const [authInitializing, setAuthInitializing] = useState<boolean>(true);
  const [loginError, setLoginError] = useState<string | null>(null);

  // 工號/帳號快速登入表單狀態
  const [loginUid, setLoginUid] = useState('');
  const [loginName, setLoginName] = useState('');

  // 2. 導覽分頁狀態（僅保留 'list' 工令管理 與 'detail' 工令明細）
  const [activeTab, setActiveTab] = useState<ActiveTab>('list');

  // 3. 目前登入者專屬的工令清單與選取中的工令 ID
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  // 監聽 Firebase Google 登入狀態
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        const profile: UserProfile = {
          uid: firebaseUser.uid,
          displayName:
            firebaseUser.displayName ||
            firebaseUser.email?.split('@')[0] ||
            '使用者',
        };
        localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(profile));
        setCurrentUser(profile);
      }
      setAuthInitializing(false);
    });

    return () => unsubscribeAuth();
  }, []);

  // 當 currentUser 確定後，訂閱該登入者專屬的工令清單（依 ownerId 隔離資料）
  useEffect(() => {
    if (!currentUser) {
      setWorkOrders([]);
      setSelectedOrderId(null);
      return;
    }

    const unsubscribeOrders = subscribeUserWorkOrders(
      currentUser.uid,
      (orders) => {
        setWorkOrders(orders);
        setSelectedOrderId((prevId) => {
          if (prevId && orders.some((o) => o.id === prevId)) {
            return prevId;
          }
          return orders[0]?.id || null;
        });
      }
    );

    return () => unsubscribeOrders();
  }, [currentUser]);

  // 目前選取中的工令物件
  const selectedWorkOrder = useMemo(
    () => workOrders.find((o) => o.id === selectedOrderId) || null,
    [workOrders, selectedOrderId]
  );

  // 使用 Google 帳號登入
  const handleGoogleLogin = async () => {
    setLoginError(null);
    try {
      const result = await signInWithPopup(auth, provider);
      const user = result.user;
      const profile: UserProfile = {
        uid: user.uid,
        displayName: user.displayName || user.email?.split('@')[0] || '使用者',
      };
      localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(profile));
      setCurrentUser(profile);
    } catch (error) {
      console.error('Google 登入失敗：', error);
      setLoginError('Google 登入未完成，請重試或使用下方員工編號直接進入。');
    }
  };

  // 使用員工編號/專屬帳號登入
  const handleManualLoginSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cleanUid = loginUid.trim().toUpperCase();
    if (!cleanUid) return;

    const profile: UserProfile = {
      uid: cleanUid,
      displayName: loginName.trim() || cleanUid,
    };
    localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(profile));
    setCurrentUser(profile);
  };

  // 建立新工令（自動綁定目前登入者的 ownerId）
  const handleCreateOrder = useCallback(
    async (data: {
      woNumber: string;
      title: string;
      location: string;
      contractId: string;
    }) => {
      if (!currentUser) return;
      const now = new Date().toISOString();
      const newOrder: WorkOrder = {
        id: `wo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        woNumber: data.woNumber,
        title: data.title,
        location: data.location,
        ownerId: currentUser.uid,
        ownerName: currentUser.displayName,
        contractId: data.contractId,
        status: '進行中',
        items: [],
        totalAmount: 0,
        createdAt: now,
        updatedAt: now,
      };

      await saveUserWorkOrder(currentUser.uid, newOrder);
      setSelectedOrderId(newOrder.id);
      setActiveTab('detail');
    },
    [currentUser]
  );

  // 更新工令（含 MO 明細變動或切換合約資料庫）
  const handleUpdateWorkOrder = useCallback(
    async (updatedOrder: WorkOrder) => {
      if (!currentUser) return;
      await saveUserWorkOrder(currentUser.uid, updatedOrder);
    },
    [currentUser]
  );

  // 切換工令狀態（進行中 <-> 已完成）
  const handleToggleStatus = useCallback(
    async (order: WorkOrder) => {
      if (!currentUser) return;
      const nextStatus = order.status === '已完成' ? '進行中' : '已完成';
      await saveUserWorkOrder(currentUser.uid, {
        ...order,
        status: nextStatus,
      });
    },
    [currentUser]
  );

  // 刪除工令
  const handleDeleteOrder = useCallback(
    async (orderId: string) => {
      if (!currentUser) return;
      await deleteUserWorkOrder(currentUser.uid, orderId);
    },
    [currentUser]
  );

  // 點選工令並切換至「工令明細」分頁
  const handleSelectOrderAndGoDetail = useCallback((orderId: string) => {
    setSelectedOrderId(orderId);
    setActiveTab('detail');
  }, []);

  if (authInitializing && !currentUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="text-sm font-medium text-slate-500">系統載入中...</div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-md border border-slate-200 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-xs">
              <Wrench className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-slate-800">
                工令管理系統 (Mobile-MO)
              </h1>
              <p className="text-xs text-slate-500">
                個人帳號資料隔離・多合約雲端單價表
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleGoogleLogin}
            className="w-full py-2.5 px-4 bg-white hover:bg-slate-50 text-slate-700 font-semibold rounded-xl text-sm border border-slate-300 shadow-2xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <LogIn className="w-4 h-4 text-blue-600" />
            <span>使用 Google 帳號登入</span>
          </button>

          {loginError && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
              {loginError}
            </div>
          )}

          <div className="relative flex py-1 items-center">
            <div className="grow border-t border-slate-200"></div>
            <span className="shrink mx-3 text-[11px] text-slate-400">
              或使用員工編號登入
            </span>
            <div className="grow border-t border-slate-200"></div>
          </div>

          <form onSubmit={handleManualLoginSubmit} className="space-y-3.5">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                員工編號 / 專屬帳號 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                required
                value={loginUid}
                onChange={(e) => setLoginUid(e.target.value)}
                placeholder="請輸入您的員工編號或帳號"
                className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                顯示姓名（選填）
              </label>
              <input
                type="text"
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                placeholder="例如：工程師姓名"
                className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-sm shadow-xs transition-colors cursor-pointer"
            >
              進入個人工令工作區
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      {/* 頂部標題列（無右上角設定齒輪按鈕） */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-slate-200">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white">
              <Wrench className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-sm font-extrabold text-slate-800 leading-tight">
                工令管理系統
              </h1>
              <p className="text-[11px] text-slate-500">
                {activeTab === 'list'
                  ? '工令管理列表'
                  : 'MO 工令明細與合約資料庫'}
              </p>
            </div>
          </div>

          <div className="inline-flex items-center gap-1.5 bg-slate-100 px-3 py-1 rounded-full text-xs font-medium text-slate-700 border border-slate-200">
            <UserCheck className="w-3.5 h-3.5 text-blue-600" />
            <span>{currentUser.displayName}</span>
          </div>
        </div>
      </header>

      {/* 主內容區 */}
      <main className="max-w-3xl mx-auto px-4 pt-4">
        {activeTab === 'list' ? (
          <WorkOrderListView
            workOrders={workOrders}
            selectedOrderId={selectedOrderId}
            contracts={CONTRACT_DATABASES}
            onSelectOrder={handleSelectOrderAndGoDetail}
            onCreateOrder={handleCreateOrder}
            onDeleteOrder={handleDeleteOrder}
            onToggleStatus={handleToggleStatus}
          />
        ) : (
          <MoDetailView
            workOrder={selectedWorkOrder}
            allWorkOrders={workOrders}
            contracts={CONTRACT_DATABASES}
            onSelectOrder={setSelectedOrderId}
            onUpdateWorkOrder={handleUpdateWorkOrder}
            onBackToList={() => setActiveTab('list')}
          />
        )}
      </main>

      {/* 底部導覽列（僅保留「工令管理」與「工令明細」） */}
      <BottomNavigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        currentMoCount={selectedWorkOrder?.items.length || 0}
      />
    </div>
  );
};

export default App;