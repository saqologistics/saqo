import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  CornerDownLeft,
  Loader2,
  LocateFixed,
  MapPin,
  Navigation,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  findNearestPlaceFromCoords,
  findStateHub,
  searchSmartAddresses,
  type AddressSuggestion,
} from '../shared/nigeria';

export interface ResolvedPlace {
  address: string;
  state: string;
  lat: number;
  lng: number;
}

interface AddressPickerFieldProps {
  id: string;
  label: string;
  stateName: string;
  restrictToState?: boolean;
  value: string;
  variant?: 'pickup' | 'destination';
  oppositeAddress?: string;
  selectedCoords?: { lat: number; lng: number } | null;
  placeholder?: string;
  required?: boolean;
  surfaceClassName?: string;
  onChange: (value: string) => void;
  onStateDetected?: (stateName: string) => void;
  onLocationResolved?: (place: ResolvedPlace) => void;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    town?: string;
    district?: string;
    county?: string;
    state?: string;
    countrycode?: string;
  };
}

const photonEndpoint = import.meta.env.VITE_PHOTON_URL || 'https://photon.komoot.io/api/';
const normalizeLabel = (text: string) => text.trim().toLowerCase();

export const AddressPickerField: React.FC<AddressPickerFieldProps> = ({
  id,
  label,
  stateName,
  restrictToState = false,
  value,
  variant = 'pickup',
  oppositeAddress,
  selectedCoords,
  placeholder = 'Search street, gate, market, or LGA',
  required = false,
  surfaceClassName = 'bg-white border border-neutral-300',
  onChange,
  onStateDetected,
  onLocationResolved,
}) => {
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [mobileQuery, setMobileQuery] = useState(value);
  const [locating, setLocating] = useState(false);
  const [liveSearch, setLiveSearch] = useState<{
    key: string;
    results: AddressSuggestion[];
    unavailable?: boolean;
  } | null>(null);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [locationError, setLocationError] = useState<string | null>(null);
  const gpsRequest = useRef(0);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerInputRef = useRef<HTMLInputElement | null>(null);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);

  const activeQuery = (mobileSheetOpen ? mobileQuery : value).trim();
  const isPickup = variant === 'pickup';

  const localSuggestions = useMemo(() => {
    return searchSmartAddresses(stateName, activeQuery, oppositeAddress);
  }, [stateName, activeQuery, oppositeAddress]);

  const searchOpen = desktopOpen || mobileSheetOpen;
  const searchKey = `${stateName}:${activeQuery}`;
  const canSearchLive = searchOpen && activeQuery.length >= 3;
  const currentSearch = liveSearch?.key === searchKey ? liveSearch : null;
  const liveSearching = canSearchLive && !currentSearch;

  useEffect(() => {
    if (!canSearchLive) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const timeout = window.setTimeout(() => controller.abort('timeout'), 5500);
      try {
        const hub = findStateHub(stateName);
        const url = new URL(photonEndpoint, window.location.origin);
        url.search = new URLSearchParams({
          q: activeQuery,
          countrycode: 'NG',
          limit: '12',
          lat: String(hub.lat),
          lon: String(hub.lng),
        }).toString();
        if (normalizeLabel(stateName) === 'katsina') {
          url.searchParams.set('bbox', '6.75,10.85,9.35,13.45');
        }
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Map search unavailable');
        const { features = [] } = (await response.json()) as { features?: PhotonFeature[] };
        const results: AddressSuggestion[] = [];
        for (const { properties, geometry } of features) {
          if (!properties || !geometry?.coordinates) continue;
          const province = normalizeLabel(properties.state || '').replace(/ state$/, '');
          if (properties.countrycode?.toUpperCase() !== 'NG' || province !== normalizeLabel(stateName)) continue;
          const [lng, lat] = geometry.coordinates;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          const street = [properties.housenumber, properties.street].filter(Boolean).join(' ');
          const place = properties.housenumber ? street : properties.name || street;
          if (!place) continue;
          const parts = [place, properties.district || properties.city || properties.town || properties.county, stateName];
          const label = parts.filter((part, index) =>
            part && parts.findIndex((other) => other && normalizeLabel(other) === normalizeLabel(part)) === index
          ).join(', ');
          results.push({ label, state: stateName, lat, lng, category: 'OpenStreetMap', source: 'live' });
        }
        if (!controller.signal.aborted) setLiveSearch({ key: searchKey, results });
      } catch {
        if (!controller.signal.aborted || controller.signal.reason === 'timeout') {
          setLiveSearch({ key: searchKey, results: [], unavailable: true });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }, 380);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [activeQuery, canSearchLive, searchKey, stateName]);

  const suggestions = useMemo(() => {
    const seen = new Set([normalizeLabel(oppositeAddress || '')]);
    const combined = [...localSuggestions.slice(0, 5), ...(currentSearch?.results || []), ...localSuggestions.slice(5)];
    return combined.filter((item) => {
      const key = normalizeLabel(item.label);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);
  }, [localSuggestions, currentSearch, oppositeAddress]);

  const noResultsMessage = activeQuery && !liveSearching && suggestions.length === 0
    ? currentSearch?.unavailable
      ? 'Map search is unavailable. Try a nearby landmark or use GPS.'
      : 'No matching locations. Try a street, landmark, or town.'
    : null;

  // Top auto-completion candidate when user is typing
  const topAutocomplete = useMemo(() => {
    if (!activeQuery || activeQuery.length < 2) return null;
    const match = suggestions[0];
    if (!match) return null;
    if (match.label.toLowerCase() === activeQuery.toLowerCase()) return null;
    return match;
  }, [activeQuery, suggestions]);

  useEffect(() => {
    setHighlightedIdx(0);
  }, [activeQuery, stateName]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDesktopOpen(false);
      }
    };
    const handleOtherSheetOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      if (detail?.id && detail.id !== id) {
        gpsRequest.current += 1;
        setLocating(false);
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

  useEffect(() => () => { gpsRequest.current += 1; }, []);

  const openMobileSearch = () => {
    setMobileQuery(value);
    setLocationError(null);
    setDesktopOpen(false);
    setMobileSheetOpen(true);
    window.dispatchEvent(new CustomEvent('saqo:address-sheet-open', { detail: { id } }));
  };

  useEffect(() => {
    if (mobileSheetOpen) mobileInputRef.current?.focus();
  }, [mobileSheetOpen]);

  const handleSelectSuggestion = (place: { label: string; state: string; lat: number; lng: number }) => {
    gpsRequest.current += 1;
    setLocating(false);
    setLocationError(null);
    onChange(place.label);
    if (place.state !== stateName) onStateDetected?.(place.state);
    onLocationResolved?.({
      address: place.label,
      state: place.state,
      lat: place.lat,
      lng: place.lng,
    });
    setDesktopOpen(false);
    setMobileSheetOpen(false);
    triggerInputRef.current?.blur();
  };

  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) {
      setLocationError('GPS is unavailable on this device. Search for a location.');
      return;
    }
    const request = ++gpsRequest.current;
    setLocationError(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (request !== gpsRequest.current) return;
        const nearest = findNearestPlaceFromCoords(coords.latitude, coords.longitude);
        if (restrictToState && nearest.state !== stateName) {
          setLocationError(`Choose a location in ${stateName} State.`);
          setLocating(false);
          return;
        }
        handleSelectSuggestion({
          label: `GPS location near ${nearest.address}`,
          state: nearest.state,
          lat: coords.latitude,
          lng: coords.longitude,
        });
      },
      () => {
        if (request !== gpsRequest.current) return;
        setLocationError('Could not get your GPS location. Check location permissions or search for an address.');
        setLocating(false);
      },
      { timeout: 8000, enableHighAccuracy: true }
    );
  };

  const handleInputFocus = () => {
    if (window.innerWidth < 768) openMobileSearch();
    else setDesktopOpen(true);
  };

  const handleDesktopKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!desktopOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setDesktopOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIdx((idx) => Math.max(0, Math.min(suggestions.length - 1, idx + 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIdx((idx) => Math.max(0, idx - 1));
    } else if (e.key === 'Enter' && desktopOpen) {
      e.preventDefault();
      const target = suggestions[highlightedIdx] || suggestions[0];
      if (target) handleSelectSuggestion(target);
    } else if (e.key === 'Escape') {
      setDesktopOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative flex items-center">
        <span
          aria-hidden="true"
          className="absolute left-3.5 flex items-center justify-center pointer-events-none z-10"
        >
          {isPickup ? (
            <span className="w-3.5 h-3.5 rounded-full bg-black flex items-center justify-center">
              <span className="w-1.5 h-1.5 rounded-full bg-white" />
            </span>
          ) : (
            <span className="w-3.5 h-3.5 rounded-[3px] bg-black flex items-center justify-center">
              <span className="w-1.5 h-1.5 bg-white" />
            </span>
          )}
        </span>
        <input
          ref={triggerInputRef}
          id={id}
          type="text"
          required={required}
          value={value}
          onFocus={handleInputFocus}
          onKeyDown={handleDesktopKeyDown}
          onChange={(e) => {
            gpsRequest.current += 1;
            setLocating(false);
            setLocationError(null);
            onChange(e.target.value);
            if (window.innerWidth >= 768) setDesktopOpen(true);
          }}
          onBlur={(event) => {
            if (!wrapperRef.current?.contains(event.relatedTarget)) setDesktopOpen(false);
          }}
          aria-label={label}
          placeholder={placeholder}
          autoComplete="off"
          className={`w-full rounded-xl pl-10 pr-16 py-3.5 text-base sm:text-sm font-medium placeholder:text-neutral-500 transition-colors focus:outline-none focus:ring-2 focus:ring-black ${surfaceClassName}`}
        />
        <div className="absolute right-2.5 flex items-center gap-0.5">
          {value && (
            <button
              type="button"
              onClick={() => {
                gpsRequest.current += 1;
                setLocating(false);
                setLocationError(null);
                onChange('');
                if (window.innerWidth < 768) {
                  openMobileSearch();
                  setMobileQuery('');
                } else {
                  triggerInputRef.current?.focus();
                }
              }}
              aria-label={`Clear ${label}`}
              className="p-1 text-neutral-400 hover:text-black cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined' && window.innerWidth < 768) {
                openMobileSearch();
              } else if (isPickup) {
                handleUseCurrentLocation();
              } else {
                setDesktopOpen((o) => !o);
              }
            }}
            title={isPickup ? 'Detect GPS pickup location' : `Browse ${stateName} destinations`}
            aria-label={isPickup ? `Detect GPS for ${label}` : `Search ${label}`}
            className="p-1.5 text-black hover:text-neutral-700 cursor-pointer"
          >
            {locating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : isPickup ? (
              <Navigation className="w-4 h-4 fill-black" />
            ) : (
              <Search className="w-4 h-4 text-neutral-500" />
            )}
          </button>
        </div>
      </div>

      {locationError && !mobileSheetOpen && (
        <p role="status" className="mt-1 text-xs text-neutral-600">{locationError}</p>
      )}
      {value.trim() && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-neutral-600">
          {selectedCoords ? (
            <>
              <CheckCircle2 className="w-3 h-3 shrink-0" />
              <span>Pinned in {stateName}</span>
            </>
          ) : (
            'Select a suggestion to pin this address.'
          )}
        </p>
      )}

      {/* Desktop Smart Autocomplete Dropdown */}
      {desktopOpen && (
        <div className="hidden md:block absolute left-0 right-0 top-full mt-1.5 z-40 bg-white border border-neutral-300 rounded-xl shadow-xl overflow-hidden">
          <div className="px-3.5 py-2 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between gap-2 text-[11px]">
            <span className="font-semibold text-neutral-700 inline-flex items-center gap-1.5">
              {isPickup ? (
                <>
                  <Navigation className="w-3 h-3" />
                  <span>Pickup suggestions · {stateName}</span>
                </>
              ) : (
                <>
                  <MapPin className="w-3 h-3" />
                  <span>Drop-off destinations · {stateName}</span>
                </>
              )}
            </span>
            {liveSearching && (
              <span className="inline-flex items-center gap-1 text-neutral-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Searching map...</span>
              </span>
            )}
          </div>

          {topAutocomplete && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelectSuggestion(topAutocomplete)}
              className="w-full px-3.5 py-2 text-left text-xs bg-black text-white flex items-center justify-between gap-2 hover:bg-neutral-800 cursor-pointer"
            >
              <span className="inline-flex items-center gap-2 min-w-0">
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  Complete: <strong>{topAutocomplete.label}</strong>
                </span>
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] font-mono bg-white/15 px-1.5 py-0.5 rounded shrink-0">
                <CornerDownLeft className="w-2.5 h-2.5" />
                <span>Enter / Tab</span>
              </span>
            </button>
          )}

          {isPickup && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                handleUseCurrentLocation();
              }}
              className="w-full px-3.5 py-2.5 text-left text-xs font-semibold flex items-center gap-2 border-b border-neutral-200 hover:bg-neutral-50 cursor-pointer"
            >
              <LocateFixed className="w-3.5 h-3.5 shrink-0" />
              <span>{locating ? 'Detecting GPS location...' : 'Use my current GPS pickup spot'}</span>
            </button>
          )}

          <ul className="max-h-60 overflow-y-auto divide-y divide-neutral-100">
            {suggestions.map((s, idx) => {
              const isHighlighted = idx === highlightedIdx;
              return (
                <li key={`${s.label}-${s.lat}-${s.lng}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlightedIdx(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelectSuggestion(s)}
                    className={`w-full px-3.5 py-2.5 text-left text-sm flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                      isHighlighted ? 'bg-neutral-100' : 'hover:bg-neutral-50'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <MapPin className="w-3.5 h-3.5 text-neutral-600 shrink-0" />
                      <span className="min-w-0">
                        <span className="block font-medium text-black truncate">{s.label}</span>
                        {s.subtitle && (
                          <span className="block text-[11px] text-neutral-500 truncate">
                            {s.subtitle}
                          </span>
                        )}
                      </span>
                    </span>
                    {s.category && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide border border-neutral-200 bg-white px-1.5 py-0.5 rounded text-neutral-600 shrink-0">
                        {s.category}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {noResultsMessage && (
            <p role="status" className="p-3 text-xs text-neutral-600">{noResultsMessage}</p>
          )}
        </div>
      )}

      {/* Native Mobile Full-Height Smart Address Search Sheet */}
      {mobileSheetOpen && (
        <div
          role="dialog"
          aria-label={`Search ${label}`}
          className="md:hidden fixed inset-0 z-50 bg-white text-black flex flex-col"
        >
          <div className="px-4 pt-4 pb-3 border-b border-neutral-200 flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                gpsRequest.current += 1;
                setLocating(false);
                setMobileSheetOpen(false);
              }}
              aria-label="Close address search"
              className="w-10 h-10 rounded-full bg-neutral-100 flex items-center justify-center shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-neutral-500 flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 shrink-0 ${
                    isPickup ? 'rounded-full bg-black' : 'border-2 border-black bg-white'
                  }`}
                />
                <span>
                  {label} · {stateName}
                </span>
              </p>
              <input
                ref={mobileInputRef}
                type="text"
                value={mobileQuery}
                onChange={(e) => setMobileQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && mobileQuery.trim()) {
                    e.preventDefault();
                    if (suggestions[0]) handleSelectSuggestion(suggestions[0]);
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
            {topAutocomplete && (
              <button
                type="button"
                onClick={() => handleSelectSuggestion(topAutocomplete)}
                className="w-full px-5 py-3.5 flex items-center justify-between gap-3 text-left bg-black text-white"
              >
                <div className="min-w-0 flex items-center gap-2.5">
                  <Sparkles className="w-4 h-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-neutral-300">Auto-complete match</p>
                    <p className="text-sm font-bold truncate">{topAutocomplete.label}</p>
                  </div>
                </div>
                {topAutocomplete.category && (
                  <span className="text-[10px] font-semibold uppercase bg-white/15 px-2 py-0.5 rounded shrink-0">
                    {topAutocomplete.category}
                  </span>
                )}
              </button>
            )}

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
                <p className="text-xs text-neutral-500">
                  Auto-detect nearest {stateName} landmark
                </p>
              </div>
            </button>

            {locationError && <p role="status" className="p-4 text-sm text-neutral-600">{locationError}</p>}
            {noResultsMessage && <p role="status" className="p-4 text-sm text-neutral-600">{noResultsMessage}</p>}

            <div className="px-5 py-2.5 bg-neutral-50 text-xs font-semibold text-neutral-500 flex items-center justify-between">
              <span>
                {activeQuery ? `Matching locations in ${stateName}` : `Popular locations in ${stateName}`}
              </span>
              {liveSearching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            </div>
            {suggestions.map((s) => (
              <button
                key={`${s.label}-${s.lat}-${s.lng}`}
                type="button"
                onClick={() => handleSelectSuggestion(s)}
                className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left active:bg-neutral-100"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-9 h-9 rounded-full bg-neutral-100 flex items-center justify-center shrink-0">
                    <MapPin className="w-4 h-4 text-neutral-700" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{s.label}</p>
                    <p className="text-xs text-neutral-500 truncate">
                      {s.subtitle || s.state}
                    </p>
                  </div>
                </div>
                {s.category && (
                  <span className="text-[10px] font-semibold uppercase border border-neutral-200 px-1.5 py-0.5 rounded text-neutral-600 shrink-0">
                    {s.category}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
