import React from 'react';
import { LogIn, LogOut } from 'lucide-react';
import { View } from '../types';
import { useI18n } from '../context/I18nContext';

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  user?: { username: string; isAdmin?: boolean; avatar_url?: string } | null;
  onLogin?: () => void;
  onLogout?: () => void;
  onOpenSettings?: () => void;
  isOpen?: boolean;
  onToggle?: () => void;
  width?: number;
  isResizing?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onNavigate,
  theme,
  onToggleTheme,
  user,
  onLogin,
  onLogout,
  onOpenSettings,
  isOpen = true,
  onToggle,
  width,
  isResizing = false,
}) => {
  const { t } = useI18n();

  const openWidthStyle =
    isOpen && typeof width === 'number'
      ? ({ width: `${width}px` } as React.CSSProperties)
      : undefined;

  return (
    <>
      {/* Backdrop for mobile - only when expanded */}
      {isOpen && onToggle && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
          onClick={onToggle}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
        flex flex-col h-full bg-white dark:bg-suno-sidebar border-r border-zinc-200 dark:border-white/5 flex-shrink-0 py-4 overflow-y-auto scrollbar-hide
        fixed left-0 top-0 z-50 md:relative
        ${isResizing ? '' : 'transition-all duration-300'}
        ${isOpen ? (typeof width === 'number' ? '' : 'w-[200px]') : 'w-[72px]'}
      `}
        style={openWidthStyle}
      >
      {/* Logo & Brand */}
      <div className="px-3 mb-8 flex items-start justify-between gap-2">
        <button
          type="button"
          className="flex flex-col items-center gap-1 cursor-pointer hover:scale-105 transition-transform flex-shrink-0 p-0 border-0 bg-transparent"
          onClick={() => onNavigate('create')}
          title={t('phoenixMusicMaker')}
          aria-label={t('phoenixMusicMaker')}
        >
          <span className="w-14 h-14 rounded-full overflow-hidden shadow-lg ring-1 ring-emerald-700/40 block">
            <img
              src="/phoenix-mark.gif"
              alt=""
              width={56}
              height={56}
              className="w-14 h-14 block"
              draggable={false}
            />
          </span>
          <span className="text-[11px] font-extrabold tracking-[0.22em] leading-none bg-gradient-to-r from-amber-300 via-orange-400 to-rose-500 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(251,146,60,0.35)]">PMM</span>
        </button>
        {/* Collapse/Expand Button */}
        {onToggle && (
          <button
            onClick={onToggle}
            className="w-8 h-8 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/10 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-black dark:hover:text-white transition-colors flex-shrink-0"
            title={isOpen ? t('collapseSidebar') : t('expandSidebar')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              )}
            </svg>
          </button>
        )}
      </div>

      <nav className="flex-1 flex flex-col gap-2 w-full px-3">
        <NavItem
          icon={<img src="/icons/icon-create.svg" alt="" className="w-6 h-6" draggable={false} />}
          label={t('create')}
          active={currentView === 'create'}
          onClick={() => onNavigate('create')}
          isExpanded={isOpen}
        />
        <NavItem
          icon={<img src="/icons/icon-library.svg" alt="" className="w-6 h-6" draggable={false} />}
          label={t('library')}
          active={currentView === 'library'}
          onClick={() => onNavigate('library')}
          isExpanded={isOpen}
        />
        <NavItem
          icon={<img src="/icons/icon-search.svg" alt="" className="w-6 h-6" draggable={false} />}
          label={t('search')}
          active={currentView === 'search'}
          onClick={() => onNavigate('search')}
          isExpanded={isOpen}
        />
        <NavItem
          icon={<img src="/icons/icon-training.svg" alt="" className="w-6 h-6" draggable={false} />}
          label={t('training')}
          active={currentView === 'training'}
          onClick={() => onNavigate('training')}
          isExpanded={isOpen}
        />
        <NavItem
          icon={<img src="/icons/icon-news.svg" alt="" className="w-6 h-6" draggable={false} />}
          label={t('news')}
          active={currentView === 'news'}
          onClick={() => onNavigate('news')}
          isExpanded={isOpen}
        />

        <div className="mt-auto flex flex-col gap-2">
          {/* Theme Toggle */}
          <button
            onClick={onToggleTheme}
            className={`
              w-full rounded-xl flex items-center gap-3 transition-all duration-200 text-zinc-500 dark:text-zinc-400 hover:text-black dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/5
              ${isOpen ? 'px-3 py-2.5 justify-start' : 'aspect-square justify-center'}
            `}
            title={theme === 'dark' ? t('lightMode') : t('darkMode')}
          >
            <div className="flex-shrink-0">{theme === 'dark' ? <img src="/icons/icon-sun.svg" alt="" className="w-6 h-6" draggable={false} /> : <img src="/icons/icon-moon.svg" alt="" className="w-6 h-6" draggable={false} />}</div>
            {isOpen && (
              <span className="text-sm font-medium whitespace-nowrap">
                {theme === 'dark' ? t('lightMode') : t('darkMode')}
              </span>
            )}
          </button>

          {user ? (
            <>
              {/* User Settings */}
              <button
                onClick={onOpenSettings}
                className={`
                  w-full rounded-xl flex items-center gap-3 transition-all duration-200 text-zinc-500 dark:text-zinc-400 hover:text-black dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/5
                  ${isOpen ? 'px-3 py-2.5 justify-start' : 'aspect-square justify-center'}
                `}
                title={`${user.username} - ${t('settings')}`}
              >
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#2F6B52] to-[#1B4D3E] flex items-center justify-center text-white text-xs font-bold border border-emerald-700/40 overflow-hidden flex-shrink-0">
                  {user.avatar_url ? (
                    <img src={user.avatar_url} alt={user.username} className="w-full h-full object-cover" />
                  ) : (
                    user.username.charAt(0).toUpperCase()
                  )}
                </div>
                {isOpen && (
                  <span className="text-sm font-medium whitespace-nowrap truncate flex-1 text-left">
                    {user.username}
                  </span>
                )}
              </button>
              {/* Logout */}
              <button
                onClick={onLogout}
                className={`
                  w-full rounded-xl flex items-center gap-3 transition-all duration-200 text-zinc-500 hover:text-red-500 hover:bg-red-500/10
                  ${isOpen ? 'px-3 py-2.5 justify-start' : 'aspect-square justify-center'}
                `}
                title={t('signOut')}
              >
                <div className="flex-shrink-0"><LogOut size={20} /></div>
                {isOpen && (
                  <span className="text-sm font-medium whitespace-nowrap">{t('signOut')}</span>
                )}
              </button>
            </>
          ) : (
            <button
              onClick={onLogin}
              className={`
                w-full rounded-xl flex items-center gap-3 transition-all duration-200 text-zinc-500 dark:text-zinc-400 hover:text-emerald-500 hover:bg-zinc-100 dark:hover:bg-white/5
                ${isOpen ? 'px-3 py-2.5 justify-start' : 'aspect-square justify-center'}
              `}
              title={t('signIn')}
            >
              <div className="flex-shrink-0"><LogIn size={20} /></div>
              {isOpen && (
                <span className="text-sm font-medium whitespace-nowrap">{t('signIn')}</span>
              )}
            </button>
          )}
        </div>
      </nav>
      </div>
    </>
  );
};

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  isExpanded?: boolean;
}

const NavItem: React.FC<NavItemProps> = ({ icon, label, active, onClick, isExpanded }) => (
  <button
    onClick={onClick}
    className={`
      w-full rounded-xl flex items-center gap-3 transition-all duration-200 group relative overflow-hidden
      ${isExpanded ? 'px-3 py-2.5 justify-start' : 'aspect-square justify-center'}
      ${active ? 'bg-zinc-100 dark:bg-white/10 text-black dark:text-white' : 'text-zinc-500 hover:text-black dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/5'}
    `}
    title={label}
  >
    {active && <div className="absolute left-0 top-1/2 -translate-y-1/2 h-8 w-1 bg-emerald-600 rounded-r-full"></div>}
    <div className="flex-shrink-0">{icon}</div>
    {isExpanded && (
      <span className="text-sm font-medium whitespace-nowrap">{label}</span>
    )}
  </button>
);
