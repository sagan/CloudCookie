import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { COOKIE_EXPORT_FORMATS, type CookieExportFormat } from '../../../lib/cookieExport';

interface CopyCookieButtonProps {
  menuId: string;
  openMenuId: string | null;
  onToggleMenu: (menuId: string | null) => void;
  onSelectFormat: (format: CookieExportFormat) => void | Promise<void>;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  label?: string;
}

interface MenuPosition {
  top?: number;
  bottom?: number;
  right: number;
}

const ESTIMATED_MENU_HEIGHT = 112;

export const CopyCookieButton: React.FC<CopyCookieButtonProps> = ({
  menuId,
  openMenuId,
  onToggleMenu,
  onSelectFormat,
  disabled = false,
  variant = 'secondary',
  label = 'Copy',
}) => {
  const isOpen = openMenuId === menuId;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!isOpen || !buttonRef.current) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      if (!buttonRef.current) return;
      const rect = buttonRef.current.getBoundingClientRect();
      const right = Math.max(8, window.innerWidth - rect.right);
      const openAbove =
        rect.bottom + ESTIMATED_MENU_HEIGHT > window.innerHeight &&
        rect.top > ESTIMATED_MENU_HEIGHT;

      if (openAbove) {
        setPosition({
          bottom: window.innerHeight - rect.top + 4,
          right,
        });
      } else {
        setPosition({
          top: rect.bottom + 4,
          right,
        });
      }
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        onToggleMenu(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onToggleMenu(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onToggleMenu]);

  const buttonClasses =
    variant === 'primary'
      ? 'shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-md bg-slate-200 hover:bg-slate-300 text-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100 transition-colors disabled:opacity-50'
      : 'shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-slate-200 hover:bg-slate-300 text-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100 transition-colors disabled:opacity-60';

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => onToggleMenu(isOpen ? null : menuId)}
        className={buttonClasses}
      >
        <span>{label}</span>
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {isOpen && position && (
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: 'fixed',
            top: position.top,
            bottom: position.bottom,
            right: position.right,
          }}
          className="z-50 min-w-[136px] py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg"
        >
          {COOKIE_EXPORT_FORMATS.map((fmt) => (
            <button
              key={fmt.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onToggleMenu(null);
                void onSelectFormat(fmt.id);
              }}
              className="w-full text-left px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-blue-50 hover:text-blue-700 dark:hover:bg-slate-700 dark:hover:text-blue-300 transition-colors"
            >
              {fmt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
