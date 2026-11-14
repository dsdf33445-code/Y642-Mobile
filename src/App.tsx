// src/App.tsx
// ============================================================================
// Mobile-MO 行動工令管理系統主程式
// 修改重點：
// 1. 點擊右上角登入人員膠囊按鈕，下拉顯示「登出」按鈕，點擊後立即登出並回到登入畫面
// 2. 串接 artifacts/mobile-mo/users/{uid} 雙層集合架構，完整還原 Google 帳號歷史工令與明細
// ============================================================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { FC } from 'react';
import {
  Wrench,
  UserCheck,
  LogIn,
  LogOut,
  ChevronDown,
} from 'lucide-react';
import type { ActiveTab, UserProfile, WorkOrder } from './types';
import {
  CONTRACT_DATABASES,
  STORAGE_KEYS,
  mergeMoLineItems,
} from './constants';
import {
  subscribeAuthState,
  signInWithGoogle,
  signOutUser,
  subscribeUserWorkOrders,
  saveUserWorkOrder,
  deleteUserWorkOrder,
  updateUserLoginProfile,
} from './firebase';
import { WorkOrderListView } from './components/WorkOrderListView';
import { MoDetailView } from './components/MoDetailView';
import { BottomNavigation } from './components/BottomNavigation';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';

export const App: FC = () => {
  // 1. Google 登入使用者狀態
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string>('');
  const [authInitializing, setAuthInitializing] = useState<boolean>(true);
  const [loginError, setLoginError] = useState<string | null>(null);

  // 右上角登入人員下拉選單開關狀態与點擊外部偵測 Ref
  const [isUserMenuOpen, setIsUserMenuOpen] = useState<boolean>(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // 2. 導覽分頁狀態（'list' 工令管理 與 'detail' 工令明細）
  const [activeTab, setActiveTab] = useState<ActiveTab>('list');

  // 3. 目前 Google 帳號專屬的工令清單與選取中的工令 ID
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  // 點擊下拉選單外部時自動收起選單
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 監聽 Firebase Google 登入狀態
  useEffect(() => {
    const unsubscribeAuth = subscribeAuthState((firebaseUser) => {
      if (firebaseUser) {
        const profile: UserProfile = {
          uid: firebaseUser.uid,
          displayName:
            firebaseUser.displayName ||
            firebaseUser.email?.split('@')[0] ||
            'Google 使用者',
        };
        setCurrentUser(profile);
        setCurrentUserEmail(firebaseUser.email || '');
        localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(profile));

        // 同步更新 artifacts/mobile-mo/users/{uid} 的登入時間紀錄
        void updateUserLoginProfile({
          uid: firebaseUser.uid,
          displayName: firebaseUser.displayName,
          email: firebaseUser.email,
          photoURL: firebaseUser.photoURL,
        });
      } else {
        setCurrentUser(null);
        setCurrentUserEmail('');
        setWorkOrders([]);
        setSelectedOrderId(null);
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
      }
      setAuthInitializing(false);
    });

    return () => unsubscribeAuth();
  }, []);

  // 訂閱該 Google 登入者專屬的工令與明細（對應 artifacts/mobile-mo/users/{uid}）
  useEffect(() => {
    if (!currentUser) {
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

  // 使用 Google 帳號登入（每次點擊皆顯示帳號選擇器，方便切換帳號）
  const handleGoogleLogin = async () => {
    setLoginError(null);
    try {
      await signInWithGoogle();
    } catch (error) {
      console.error('Google 登入失敗：', error);
      setLoginError('Google 登入未完成，請確認網路連線或彈出視窗權限後重試。');
    }
  };

  // 點擊右上角下拉選單的「登出」按鈕，登出並回到登入畫面
  const handleLogout = async () => {
    setIsUserMenuOpen(false);
    try {
      await signOutUser();
      setCurrentUser(null);
      setCurrentUserEmail('');
      setWorkOrders([]);
      setSelectedOrderId(null);
      setActiveTab('list');
    } catch (error) {
      console.error('登出時發生錯誤：', error);
    }
  };

  // 建立新工令
  const handleCreateOrder = useCallback(
    async (data: {
      woNumber: string;
      title: string;
      contractId: string;
    }) => {
      if (!currentUser) return;
      const now = new Date().toISOString();
      const newOrder: WorkOrder = {
        id: `wo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        woNumber: data.woNumber,
        title: data.title,
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

  // 編輯既有工令
  const handleEditOrder = useCallback(
    async (data: {
      id: string;
      woNumber: string;
      title: string;
      contractId: string;
    }) => {
      if (!currentUser) return;
      const target = workOrders.find((o) => o.id === data.id);
      if (!target) return;

      await saveUserWorkOrder(currentUser.uid, {
        ...target,
        woNumber: data.woNumber,
        title: data.title,
        contractId: data.contractId,
      });
    },
    [currentUser, workOrders]
  );

  // 合併多筆工令並自動前往合併後的工令明細
  const handleMergeOrders = useCallback(
    async (params: {
      sourceOrderIds: string[];
      mergedWoNumber: string;
      mergedTitle: string;
      deleteSources: boolean;
    }) => {
      if (!currentUser) return;
      const sourceOrders = workOrders.filter((o) =>
        params.sourceOrderIds.includes(o.id)
      );
      if (sourceOrders.length < 2) return;

      const mergedItems = mergeMoLineItems(sourceOrders);
      const totalAmount = mergedItems.reduce((sum, i) => sum + i.subtotal, 0);

      const now = new Date().toISOString();
      const mergedOrder: WorkOrder = {
        id: `wo-merged-${Date.now()}`,
        woNumber: params.mergedWoNumber,
        title: params.mergedTitle,
        ownerId: currentUser.uid,
        ownerName: currentUser.displayName,
        contractId: sourceOrders[0].contractId || CONTRACT_DATABASES[0].id,
        status: '進行中',
        items: mergedItems,
        totalAmount,
        createdAt: now,
        updatedAt: now,
      };

      await saveUserWorkOrder(currentUser.uid, mergedOrder);

      if (params.deleteSources) {
        for (const src of sourceOrders) {
          await deleteUserWorkOrder(currentUser.uid, src.id);
        }
      }

      setSelectedOrderId(mergedOrder.id);
      setActiveTab('detail');
    },
    [currentUser, workOrders]
  );

  // 更新工令（含 MO 明細變動或切換合約資料庫）
  const handleUpdateWorkOrder = useCallback(
    async (updatedOrder: WorkOrder) => {
      if (!currentUser) return;
      await saveUserWorkOrder(currentUser.uid, updatedOrder);
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

  // 點選工令卡片切換至工令明細分頁
  const handleSelectOrderAndGoDetail = useCallback((orderId: string) => {
    setSelectedOrderId(orderId);
    setActiveTab('detail');
  }, []);

  if (authInitializing) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="text-sm font-medium text-slate-500">
          正在同步 Google 帳號與雲端工令資料庫...
        </div>
      </div>
    );
  }

  // 尚未登入（或點擊登出後）顯示 Google 帳號登入畫面
  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-md border border-slate-200 space-y-5 text-center">
          <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-xs mx-auto">
            <Wrench className="w-6 h-6" />
          </div>

          <div className="space-y-1">
            <h1 className="text-lg font-extrabold text-slate-800">
              工令管理系統
            </h1>
            <p className="text-xs text-slate-500">
              請使用您的 Google 帳號登入以載入個人工令資料庫
            </p>
          </div>

          <button
            type="button"
            onClick={handleGoogleLogin}
            className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-sm shadow-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <LogIn className="w-4 h-4" />
            <span>使用 Google 帳號登入</span>
          </button>

          <PWAInstallButton />

          {loginError && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-left">
              {loginError}
            </div>
          )}
        </div>
        <OfflineIndicator />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      {/* 頂部標題列 */}
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
                {activeTab === 'list' ? '工令管理' : '工令明細'}
              </p>
            </div>
          </div>

          {/* 右上角安裝按鈕、登入人員按鈕與下拉登出選單 */}
          <div className="flex items-center gap-2">
            <PWAInstallButton compact />

            <div className="relative" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setIsUserMenuOpen((prev) => !prev)}
                className="inline-flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200/80 px-3 py-1.5 rounded-full text-xs font-medium text-slate-700 border border-slate-200 transition-colors cursor-pointer"
              >
                <UserCheck className="w-3.5 h-3.5 text-blue-600" />
                <span>{currentUser.displayName}</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-slate-500 transition-transform duration-200 ${
                    isUserMenuOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {/* 點擊後展開的下拉選單 */}
              {isUserMenuOpen && (
                <div className="absolute right-0 mt-2 w-48 bg-white rounded-xl shadow-lg border border-slate-200 py-1.5 z-50">
                  {currentUserEmail && (
                    <div className="px-3.5 py-2 border-b border-slate-100">
                      <div className="text-xs font-bold text-slate-800 truncate">
                        {currentUser.displayName}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate">
                        {currentUserEmail}
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full px-3.5 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>登出</span>
                  </button>
                </div>
              )}
            </div>
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
            onEditOrder={handleEditOrder}
            onMergeOrders={handleMergeOrders}
            onDeleteOrder={handleDeleteOrder}
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

      {/* 底部導覽列 */}
      <BottomNavigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        currentMoCount={selectedWorkOrder?.items.length || 0}
      />

      {/* 離線狀態提示 */}
      <OfflineIndicator />
    </div>
  );
};

export default App;
