// src/components/HomePortalView.tsx
// ============================================================================
// 手機版首頁圖示入口組件 (Minimal Mobile Home Launcher)
// 僅呈現應用程式圖示與名稱，簡潔直覺、點擊立即進入對應系統
// ============================================================================

import type { FC } from 'react';
import { ClipboardList, Zap } from 'lucide-react';
import type { ActiveTab } from '../types';

interface HomePortalViewProps {
  /** 切換至指定系統分頁 */
  onNavigate: (tab: ActiveTab) => void;
}

export const HomePortalView: FC<HomePortalViewProps> = ({ onNavigate }) => {
  return (
    <div className="pb-24 pt-4">
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-y-6 gap-x-4 px-2">
        {/* 入口 1：工令管理 */}
        <button
          type="button"
          onClick={() => onNavigate('list')}
          className="group flex flex-col items-center gap-2 focus:outline-none cursor-pointer touch-manipulation"
        >
          <div className="w-16 h-16 sm:w-18 sm:h-18 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-sm group-hover:bg-blue-700 group-active:scale-95 transition-all">
            <ClipboardList className="w-8 h-8" />
          </div>
          <span className="text-xs sm:text-sm font-semibold text-slate-800 text-center leading-tight">
            工令管理
          </span>
        </button>

        {/* 入口 2：變電站 */}
        <button
          type="button"
          onClick={() => onNavigate('substation')}
          className="group flex flex-col items-center gap-2 focus:outline-none cursor-pointer touch-manipulation"
        >
          <div className="w-16 h-16 sm:w-18 sm:h-18 rounded-2xl bg-slate-900 text-amber-400 border border-amber-400/30 flex items-center justify-center shadow-sm group-hover:bg-slate-800 group-active:scale-95 transition-all">
            <Zap className="w-8 h-8" />
          </div>
          <span className="text-xs sm:text-sm font-semibold text-slate-800 text-center leading-tight">
            變電站
          </span>
        </button>
      </div>
    </div>
  );
};
