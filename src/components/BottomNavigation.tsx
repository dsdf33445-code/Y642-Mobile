// src/components/BottomNavigation.tsx
// ============================================================================
// 底部導覽列組件
// 包含「首頁」（系統圖示入口）、「工令管理」、「工令明細」與「變電站」快捷導覽
// ============================================================================

import { memo } from 'react';
import type { FC } from 'react';
import { Home, ClipboardList, FileSpreadsheet, Zap } from 'lucide-react';
import type { ActiveTab } from '../types';

interface BottomNavigationProps {
  /** 目前啟用的分頁 */
  activeTab: ActiveTab;
  /** 切換分頁回呼函式 */
  onTabChange: (tab: ActiveTab) => void;
  /** 目前選取工令內的 MO 明細項目數量 */
  currentMoCount: number;
}

export const BottomNavigation: FC<BottomNavigationProps> = memo(
  ({ activeTab, onTabChange, currentMoCount }) => {
    return (
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-slate-200 shadow-[0_-2px_10px_rgba(0,0,0,0.04)] pb-safe">
        <div className="max-w-3xl mx-auto grid grid-cols-4 h-16">
          {/* 分頁 1：首頁 (系統圖示入口) */}
          <button
            type="button"
            onClick={() => onTabChange('home')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
              activeTab === 'home'
                ? 'text-blue-600 font-semibold bg-blue-50/50'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Home className="w-5 h-5" />
            <span className="text-xs">首頁</span>
          </button>

          {/* 分頁 2：工令管理 */}
          <button
            type="button"
            onClick={() => onTabChange('list')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
              activeTab === 'list'
                ? 'text-blue-600 font-semibold bg-blue-50/50'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <ClipboardList className="w-5 h-5" />
            <span className="text-xs">工令管理</span>
          </button>

          {/* 分頁 3：工令明細 (MO 明細) */}
          <button
            type="button"
            onClick={() => onTabChange('detail')}
            className={`relative flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
              activeTab === 'detail'
                ? 'text-blue-600 font-semibold bg-blue-50/50'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <div className="relative">
              <FileSpreadsheet className="w-5 h-5" />
              {currentMoCount > 0 && (
                <span className="absolute -top-1.5 -right-3 bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.2 rounded-full min-w-[18px] text-center">
                  {currentMoCount}
                </span>
              )}
            </div>
            <span className="text-xs">工令明細</span>
          </button>

          {/* 分頁 4：變電站 (變電站單線圖管理系統) */}
          <button
            type="button"
            onClick={() => onTabChange('substation')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
              activeTab === 'substation'
                ? 'text-amber-600 font-semibold bg-amber-50/60'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Zap className="w-5 h-5" />
            <span className="text-xs">變電站</span>
          </button>
        </div>
      </nav>
    );
  }
);