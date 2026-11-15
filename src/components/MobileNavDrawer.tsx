import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { SaqoLogo } from './SaqoLogo';

export interface MobileNavDrawerItem {
  id: string;
  label: string;
  active?: boolean;
  badge?: string | number;
  subtitle?: string;
  onSelect: () => void;
}

interface MobileNavDrawerProps {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  breakpoint?: 'md' | 'lg';
  headerAction?: React.ReactNode;
  items: MobileNavDrawerItem[];
  footerContent?: React.ReactNode;
}

export const MobileNavDrawer: React.FC<MobileNavDrawerProps> = ({
  open,
  onClose,
  ariaLabel = 'Mobile navigation',
  breakpoint = 'md',
  headerAction,
  items,
  footerContent,
}) => {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const hiddenDesktopClass = breakpoint === 'lg' ? 'lg:hidden' : 'md:hidden';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className={`${hiddenDesktopClass} fixed inset-0 z-50 bg-white text-black flex flex-col justify-between overflow-y-auto`}
    >
      {/* Top Bar matching Uber-inspired Mobile Menu */}
      <div>
        <div className="h-16 px-4 border-b border-neutral-200 flex items-center justify-between gap-3 sticky top-0 bg-white z-10">
          <div className="shrink-0">
            <SaqoLogo />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {headerAction}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close navigation menu"
              className="w-10 h-10 rounded-full hover:bg-neutral-100 active:bg-neutral-200 flex items-center justify-center text-black transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Bold Editorial Nav Links */}
        <nav aria-label={ariaLabel} className="px-6 py-7 space-y-5">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              aria-current={item.active ? 'page' : undefined}
              className="w-full text-left flex items-center justify-between gap-4 group cursor-pointer"
            >
              <span className="min-w-0">
                <span
                  className={`inline-flex items-center gap-3 font-display font-extrabold text-3xl tracking-tight leading-tight transition-colors ${
                    item.active ? 'text-black' : 'text-neutral-800 group-hover:text-black'
                  }`}
                >
                  <span>{item.label}</span>
                  {item.active && (
                    <span
                      aria-hidden="true"
                      className="w-2.5 h-2.5 rounded-full bg-black shrink-0"
                    />
                  )}
                </span>
                {item.subtitle && (
                  <span className="block text-xs font-medium text-neutral-500 mt-1">
                    {item.subtitle}
                  </span>
                )}
              </span>

              {item.badge !== undefined && item.badge !== null && item.badge !== '' && (
                <span className="px-3 py-1 rounded-full bg-black text-white text-xs font-mono font-bold tabular-nums shrink-0">
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {footerContent && (
        <div className="px-6 py-5 border-t border-neutral-200 bg-neutral-50 space-y-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {footerContent}
        </div>
      )}
    </div>
  );
};
