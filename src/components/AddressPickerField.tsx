import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LocateFixed, MapPin, Search, X } from 'lucide-react';
import { findNearestPlaceFromCoords, getLandmarksForState } from '../shared/nigeria';

interface AddressPickerFieldProps {
  id: string;
  label: string;
  stateName: string;
  value: string;
  placeholder?: string;
  required?: boolean;
  surfaceClassName?: string;
  onChange: (value: string) => void;
  onStateDetected?: (stateName: string) => void;
  onCommit?: (value: string) => void;
}

export const AddressPickerField: React.FC<AddressPickerFieldProps> = ({
  id,
  label,
  stateName,
  value,
  placeholder = 'Search street, area, or landmark',
  required = false,
  surfaceClassName = 'bg-white border border-neutral-300',
  onChange,
  onStateDetected,
  onCommit,
}) => {
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [mobileQuery, setMobileQuery] = useState(value);
  const [locating, setLocating] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerInputRef = useRef<HTMLInputElement | null>(null);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);

  const suggestions = useMemo(() => {
    const base = getLandmarksForState(stateName);
    const q = (mobileSheetOpen ? mobileQuery : value).trim().toLowerCase();
    if (!q) return base;
    const filtered = base.filter((item) => item.label.toLowerCase().includes(q));
    return filtered.length > 0 ? filtered : base;
  }, [stateName, value, mobileQuery, mobileSheetOpen]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDesktopOpen(false);
      }
    };
    const handleOtherSheetOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      if (detail?.id && detail.id !== id) {
        setMobileSheetOpen(false);
        setDesktopOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    window.addEventListener('saqo:address-sheet-open', handleOtherSheetOpen);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('saqo:address-sheet-open', handleOtherSheetOpen);
    };
  }, [id]);

  useEffect(() => {
    if (mobileSheetOpen) {
      window.dispatchEvent(new CustomEvent('saqo:address-sheet-open', { detail: { id } }));
      setMobileQuery(value);
      setTimeout(() => mobileInputRef.current?.focus(), 60);
    }
  }, [mobileSheetOpen, value, id]);

  const handleSelectSuggestion = (addr: string) => {
    onChange(addr);
    onCommit?.(addr);
    setDesktopOpen(false);
    setMobileSheetOpen(false);
    triggerInputRef.current?.blur();
  };

  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const nearest = findNearestPlaceFromCoords(pos.coords.latitude, pos.coords.longitude);
        if (onStateDetected) {
          onStateDetected(nearest.state);
        }
        handleSelectSuggestion(nearest.address);
        setLocating(false);
      },
      () => {
        const fallback = getLandmarksForState(stateName)[0]?.label || `${stateName} Central`;
        handleSelectSuggestion(fallback);
        setLocating(false);
      },
      { timeout: 4000 }
    );
  };

  const handleInputFocus = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileSheetOpen(true);
    } else {
      setDesktopOpen(true);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative flex items-center">
        <input
          ref={triggerInputRef}
          id={id}
          type="text"
          required={required}
          value={value}
          onFocus={handleInputFocus}
          onChange={(e) => {
            onChange(e.target.value);
            if (typeof window !== 'undefined' && window.innerWidth >= 768) {
              setDesktopOpen(true);
            }
          }}
          onBlur={() => {
            setTimeout(() => {
              onCommit?.(value);
            }, 120);
          }}
          aria-label={label}
          placeholder={placeholder}
          autoComplete="off"
          className={`w-full rounded-lg pl-3.5 pr-9 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black ${surfaceClassName}`}
        />
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && window.innerWidth < 768) {
              setMobileSheetOpen(true);
            } else {
              handleUseCurrentLocation();
            }
          }}
          aria-label={`Search or locate ${label}`}
          className="absolute right-2.5 p-1 text-neutral-500 hover:text-black cursor-pointer"
        >
          <Search className="w-4 h-4" />
        </button>
      </div>

      {/* Desktop Autocomplete Dropdown */}
      {desktopOpen && (
        <div className="hidden md:block absolute left-0 right-0 top-full mt-1.5 z-30 bg-white border border-neutral-200 rounded-xl shadow-lg overflow-hidden">
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              handleUseCurrentLocation();
            }}
            className="w-full px-3.5 py-2.5 text-left text-xs font-semibold flex items-center gap-2 border-b border-neutral-200 hover:bg-neutral-50 cursor-pointer"
          >
            <LocateFixed className="w-3.5 h-3.5 shrink-0" />
            <span>{locating ? 'Locating...' : 'Use current GPS location'}</span>
          </button>
          <ul className="max-h-52 overflow-y-auto divide-y divide-neutral-100">
            {suggestions.map((s) => (
              <li key={s.label}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelectSuggestion(s.label);
                  }}
                  className="w-full px-3.5 py-2.5 text-left text-sm flex items-center gap-2.5 hover:bg-neutral-100 cursor-pointer"
                >
                  <MapPin className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                  <span className="truncate">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Native Mobile Full-Height Address Search Sheet */}
      {mobileSheetOpen && (
        <div
          role="dialog"
          aria-label={`Search ${label}`}
          className="md:hidden fixed inset-0 z-50 bg-white text-black flex flex-col"
        >
          <div className="px-4 pt-4 pb-3 border-b border-neutral-200 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileSheetOpen(false)}
              aria-label="Close address search"
              className="w-10 h-10 rounded-full bg-neutral-100 flex items-center justify-center shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-neutral-500">
                {label} · {stateName}
              </p>
              <input
                ref={mobileInputRef}
                type="text"
                value={mobileQuery}
                onChange={(e) => setMobileQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && mobileQuery.trim()) {
                    e.preventDefault();
                    handleSelectSuggestion(mobileQuery.trim());
                  }
                }}
                placeholder={placeholder}
                className="w-full text-base font-medium bg-transparent py-1 focus:outline-none"
              />
            </div>
            {mobileQuery && (
              <button
                type="button"
                onClick={() => setMobileQuery('')}
                className="text-xs font-semibold text-neutral-500 px-2 py-1"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-neutral-100">
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              className="w-full px-5 py-4 flex items-center gap-3 text-left active:bg-neutral-100"
            >
              <span className="w-9 h-9 rounded-full bg-black text-white flex items-center justify-center shrink-0">
                <LocateFixed className="w-4 h-4" />
              </span>
              <div>
                <p className="text-sm font-bold">
                  {locating ? 'Detecting location...' : 'Use Current GPS Location'}
                </p>
                <p className="text-xs text-neutral-500">Auto-detect nearest Nigerian hub</p>
              </div>
            </button>

            {mobileQuery.trim().length > 1 && (
              <button
                type="button"
                onClick={() => handleSelectSuggestion(mobileQuery.trim())}
                className="w-full px-5 py-4 flex items-center gap-3 text-left bg-neutral-50 active:bg-neutral-200"
              >
                <span className="w-9 h-9 rounded-full border border-black flex items-center justify-center shrink-0">
                  <MapPin className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold truncate">Use &ldquo;{mobileQuery.trim()}&rdquo;</p>
                  <p className="text-xs text-neutral-500">{stateName}</p>
                </div>
              </button>
            )}

            <div className="px-5 py-2.5 bg-neutral-50 text-xs font-semibold text-neutral-500">
              Popular locations in {stateName}
            </div>
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => handleSelectSuggestion(s.label)}
                className="w-full px-5 py-4 flex items-center gap-3 text-left active:bg-neutral-100"
              >
                <span className="w-9 h-9 rounded-full bg-neutral-100 flex items-center justify-center shrink-0">
                  <MapPin className="w-4 h-4 text-neutral-700" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{s.label}</p>
                  <p className="text-xs text-neutral-500">{s.state}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
