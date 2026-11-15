import type { publicTrackingDelivery, publicTrackingHistory } from '../server/db';
import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpDown,
  BadgeCheck,
  Check,
  CheckCircle2,
  Copy,
  MapPin,
  Menu,
  MessageCircle,
  Package,
  Phone,
  RefreshCw,
  Search,
  ShieldCheck,
  Truck,
  X,
} from 'lucide-react';
import heroCourierImg from '../assets/images/hero_saqo_dispatch_1794561358037.jpg';
import hubImg from '../assets/images/interstate_parcel_hub_1794561359146.jpg';
import { useRealtime } from '../hooks/useRealtime';
import { apiRequest } from '../lib/api';
import { NIGERIA_STATES, resolveAddressCoordinates } from '../shared/nigeria';
import { formatEta, formatNaira } from '../shared/pricing';
import { formatDeliveryStatusLabel, getTrackingProgress } from '../shared/tracking';
import type {
  DeliveryRequest,

  PriceQuote,
  Profile,
} from '../shared/types';
import { AddressPickerField } from './AddressPickerField';
import { LiveNigeriaMap } from './LiveNigeriaMap';
import { PWAInstallButton } from './PWAInstallButton';
import { SaqoLogo } from './SaqoLogo';
import { buildWhatsAppUrl } from './WhatsAppWidget';

export interface QuickDraft {
  pickupState: string;
  pickupAddress: string;
  pickupCoords?: { lat: number; lng: number } | null;
  destinationState: string;
  destinationAddress: string;
  destinationCoords?: { lat: number; lng: number } | null;
}

interface LandingPageProps {
  currentUser: Profile | null;
  whatsappNumber: string;
  showDeliveryStateSelectors: boolean;
  whatsAppOrderNumber: string | null;
  initialTrackCode?: string;
  onNavigateAuth: (mode?: 'login' | 'register', role?: 'client' | 'rider', draft?: QuickDraft) => void;
  onOpenDashboard: (draft?: QuickDraft) => void;
  onOpenSupportChat?: (trackingCode?: string) => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  currentUser,
  whatsappNumber,
  showDeliveryStateSelectors,
  whatsAppOrderNumber,
  initialTrackCode,
  onNavigateAuth,
  onOpenDashboard,
  onOpenSupportChat,
}) => {
  const [heroTab, setHeroTab] = useState<'send' | 'track'>(initialTrackCode ? 'track' : 'send');
  const [pickupState, setPickupState] = useState('Katsina');
  const [pickupAddress, setPickupAddress] = useState('Kofar Kaura, Katsina');
  const [pickupCoords, setPickupCoords] = useState<{ lat: number; lng: number } | null>(() =>
    resolveAddressCoordinates('Katsina', 'Kofar Kaura, Katsina')
  );
  const [destinationState, setDestinationState] = useState('Katsina');
  const [destinationAddress, setDestinationAddress] = useState('Batagarawa, Katsina');
  const [destinationCoords, setDestinationCoords] = useState<{ lat: number; lng: number } | null>(() =>
    resolveAddressCoordinates('Katsina', 'Batagarawa, Katsina')
  );
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  const [trackCode, setTrackCode] = useState(initialTrackCode || '');
  const [trackedDelivery, setTrackedDelivery] = useState<ReturnType<typeof publicTrackingDelivery> | null>(null);
  const [trackedHistory, setTrackedHistory] = useState<ReturnType<typeof publicTrackingHistory>>([]);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const [otpInput, setOtpInput] = useState('');
  const [otpMessage, setOtpMessage] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpSubmitting, setOtpSubmitting] = useState(false);

  const [heroImgFailed, setHeroImgFailed] = useState(false);
  const [hubImgFailed, setHubImgFailed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (showDeliveryStateSelectors) return;
    if (pickupState !== 'Katsina') {
      setPickupState('Katsina');
      setPickupAddress('');
      setPickupCoords(null);
    }
    if (destinationState !== 'Katsina') {
      setDestinationState('Katsina');
      setDestinationAddress('');
      setDestinationCoords(null);
    }
  }, [showDeliveryStateSelectors, pickupState, destinationState]);

  useEffect(() => {
    setQuote(null);
    setQuoteLoading(Boolean(pickupCoords && destinationCoords));
    if (!pickupCoords || !destinationCoords) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const result = await apiRequest<PriceQuote>('/api/quote', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            pickupState, pickupAddress,
            pickupLat: pickupCoords.lat, pickupLng: pickupCoords.lng,
            destinationState, destinationAddress,
            destinationLat: destinationCoords.lat, destinationLng: destinationCoords.lng,
            weightKg: 1.5,
          }),
        });
        if (!controller.signal.aborted) setQuote(result);
      } catch {
        // The next address selection can request a fresh quote.
      } finally {
        if (!controller.signal.aborted) setQuoteLoading(false);
      }
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [pickupState, pickupAddress, pickupCoords, destinationState, destinationAddress, destinationCoords]);

  const handleTrackSearch = async (codeToSearch?: string) => {
    const code = (codeToSearch ?? trackCode).trim();
    if (!code) {
      setTrackError('Enter your SAQO tracking code to locate a parcel.');
      return;
    }
    setTrackLoading(true);
    setTrackError(null);
    setOtpMessage(null);
    setOtpError(null);
    try {
      const res = await apiRequest<{
        delivery: ReturnType<typeof publicTrackingDelivery>;
        history: ReturnType<typeof publicTrackingHistory>;
      }>(`/api/track/${encodeURIComponent(code)}`);
      setTrackedDelivery(res.delivery);
      setTrackedHistory(res.history);
    } catch (err: any) {
      setTrackedDelivery(null);
      setTrackedHistory([]);
      setTrackError(err.message || 'Parcel not found.');
    } finally {
      setTrackLoading(false);
    }
  };

  useEffect(() => {
    if (initialTrackCode) {
      handleTrackSearch(initialTrackCode);
    }
  }, [initialTrackCode]);

  // Live real-time tracking updates for the currently tracked parcel
  const { connected, sendEvent } = useRealtime((evt) => {
    if (!trackedDelivery) return;
    if (evt.type === 'delivery:updated') {
      const updated = evt.payload as ReturnType<typeof publicTrackingDelivery>;
      if (updated?.id === trackedDelivery.id) {
        if (updated.status) setTrackedDelivery(updated);
        apiRequest<{
          delivery: ReturnType<typeof publicTrackingDelivery>;
          history: ReturnType<typeof publicTrackingHistory>;
        }>(`/api/track/${encodeURIComponent(trackedDelivery.trackingCode)}`)
          .then((res) => {
            setTrackedDelivery(res.delivery);
            setTrackedHistory(res.history);
          })
          .catch(() => {});
      }
    } else if (evt.type === 'rider:location') {
      const loc = evt.payload as { riderId: string; lat: number; lng: number; lastLocationAt: string };
      if (trackedDelivery.assignedRiderId && loc.riderId === trackedDelivery.assignedRiderId) {
        setTrackedDelivery((prev) =>
          prev
            ? {
                ...prev,
                assignedRiderLat: loc.lat,
                assignedRiderLng: loc.lng,
                updatedAt: loc.lastLocationAt,
              }
            : prev
        );
      }
    }
  });

  useEffect(() => {
    if (!connected || !trackedDelivery?.trackingCode) return;
    sendEvent({ type: 'track', trackingCode: trackedDelivery.trackingCode });
    return () => sendEvent({ type: 'track', trackingCode: '' });
  }, [connected, sendEvent, trackedDelivery?.trackingCode]);

  const handleConfirmOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trackedDelivery) return;
    if (otpInput.trim().length < 4) {
      setOtpError('Enter the 4-digit delivery OTP.');
      return;
    }
    setOtpSubmitting(true);
    setOtpError(null);
    setOtpMessage(null);
    try {
      const res = await apiRequest<{
        delivery: ReturnType<typeof publicTrackingDelivery>;
        history: ReturnType<typeof publicTrackingHistory>;
      }>(`/api/track/${encodeURIComponent(trackedDelivery.trackingCode)}/confirm-otp`, {
        method: 'POST',
        body: JSON.stringify({ otp: otpInput.trim() }),
      });
      setTrackedDelivery(res.delivery);
      setTrackedHistory(res.history);
      setOtpMessage('Delivery confirmed. Recipient OTP verified.');
      setOtpInput('');
    } catch (err: any) {
      setOtpError(err.message || 'OTP verification failed.');
    } finally {
      setOtpSubmitting(false);
    }
  };

  const scrollToTrack = () => {
    setHeroTab('track');
    document.getElementById('track-section')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-black text-white border-b border-white/15">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4 sm:gap-8">
          <a href="#top" aria-label="SAQO Logistics Home" className="shrink-0">
            <SaqoLogo inverted showLogisticsSub />
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-neutral-300">
            <a
              href="#send-box"
              onClick={() => setHeroTab('send')}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Send
            </a>
            <a
              href="#track-section"
              onClick={scrollToTrack}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Track
            </a>
            <button
              type="button"
              onClick={() => onNavigateAuth('login', 'rider')}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Drive
            </button>
            <a
              href="#how-it-works"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              How it works
            </a>
          </nav>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <PWAInstallButton inverted compact />
            {currentUser ? (
              <button
                type="button"
                onClick={() => onOpenDashboard()}
                className="px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-semibold bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Open Dashboard
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onNavigateAuth('login', 'client')}
                className="px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-semibold bg-white text-black rounded-lg hover:bg-neutral-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Sign in
              </button>
            )}
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileMenuOpen}
              className="md:hidden p-2 rounded-lg border border-white/20 text-white hover:bg-white/10 cursor-pointer"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden bg-black border-t border-white/15 px-4 py-4 space-y-2 text-sm font-medium">
            <a
              href="#send-box"
              onClick={() => {
                setHeroTab('send');
                setMobileMenuOpen(false);
              }}
              className="block py-2.5 px-3 rounded-lg text-neutral-200 hover:bg-white/10"
            >
              Send a Parcel
            </a>
            <a
              href="#track-section"
              onClick={() => {
                scrollToTrack();
                setMobileMenuOpen(false);
              }}
              className="block py-2.5 px-3 rounded-lg text-neutral-200 hover:bg-white/10"
            >
              Track a Parcel
            </a>
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                onNavigateAuth('login', 'rider');
              }}
              className="w-full text-left py-2.5 px-3 rounded-lg text-neutral-200 hover:bg-white/10 cursor-pointer"
            >
              Rider Sign In
            </button>
            <a
              href="#how-it-works"
              onClick={() => setMobileMenuOpen(false)}
              className="block py-2.5 px-3 rounded-lg text-neutral-200 hover:bg-white/10"
            >
              How it works
            </a>
          </div>
        )}
      </header>

      {/* Hero Section: Uber-inspired High-Contrast Black Editorial Canvas */}
      <section id="top" className="bg-black text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 sm:py-14 lg:py-20 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
          {/* Left Column: Headline + Instant Send/Track Widget */}
          <div id="send-box" className="lg:col-span-6 flex flex-col justify-center">
            <h1 className="font-display font-extrabold text-4xl sm:text-5xl lg:text-[56px] leading-[1.05] tracking-tight text-white [text-wrap:balance]">
              Send Anything. Anywhere.
            </h1>
            <p className="mt-4 text-base sm:text-lg text-neutral-300 max-w-xl leading-relaxed">
              Fast, reliable parcel delivery across cities and states. Request a rider, track your parcel, and deliver with confidence.
            </p>

            {/* Primary & Secondary CTAs */}
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (currentUser?.role === 'client') {
                    onOpenDashboard();
                  } else {
                    onNavigateAuth('login', 'client', {
                      pickupState,
                      pickupAddress,
                      pickupCoords,
                      destinationState,
                      destinationAddress,
                      destinationCoords,
                    });
                  }
                }}
                className="inline-flex items-center gap-2 bg-white text-black px-6 py-3.5 rounded-lg text-sm font-bold hover:bg-neutral-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Send a Parcel</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={scrollToTrack}
                className="inline-flex items-center gap-2 bg-neutral-900 text-white border border-white/25 px-6 py-3.5 rounded-lg text-sm font-semibold hover:bg-neutral-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Search className="w-4 h-4" />
                <span>Track a Parcel</span>
              </button>
            </div>

            {/* Uber-inspired Instant Quote / Track Box */}
            <div className="mt-8 bg-white text-black rounded-xl p-5 sm:p-6">
              <div className="flex items-center gap-2 border-b border-neutral-200 pb-3 mb-4">
                <button
                  type="button"
                  onClick={() => setHeroTab('send')}
                  className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    heroTab === 'send'
                      ? 'bg-black text-white'
                      : 'text-neutral-600 hover:bg-neutral-100'
                  }`}
                >
                  Instant Rate & Pickup
                </button>
                <button
                  type="button"
                  onClick={() => setHeroTab('track')}
                  className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    heroTab === 'track'
                      ? 'bg-black text-white'
                      : 'text-neutral-600 hover:bg-neutral-100'
                  }`}
                >
                  Quick Track
                </button>
              </div>

              {heroTab === 'send' && whatsAppOrderNumber && (
                <a href={buildWhatsAppUrl(whatsAppOrderNumber, 'ORDER')} target="_blank" rel="noreferrer"
                  className="mb-3 inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-3 py-2 text-xs font-semibold hover:bg-neutral-100">
                  Order on WhatsApp
                </a>
              )}

              {heroTab === 'send' ? (
                <div className="space-y-3">
                  <div className="space-y-2.5">
                    {/* FROM: PICKUP */}
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-black">
                          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-black shrink-0" />
                          <span>From · Pickup</span>
                        </span>
                        <span className="text-[11px] text-neutral-500">{showDeliveryStateSelectors ? pickupState : "Katsina State"}</span>
                      </div>
                      <div className={showDeliveryStateSelectors ? "grid grid-cols-1 sm:grid-cols-5 gap-2" : undefined}>
                        {showDeliveryStateSelectors && (
                          <div className="sm:col-span-2">
                            <label className="sr-only" htmlFor="hero-pickup-state">
                              Pickup state
                            </label>
                            <select
                              id="hero-pickup-state"
                              value={pickupState}
                              onChange={(e) => {
                                const nextState = e.target.value;
                                setPickupState(nextState);
                                setPickupAddress('');
                                setPickupCoords(null);
                              }}
                              className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2.5 text-base sm:text-sm font-medium focus:outline-none focus:ring-2 focus:ring-black"
                            >
                              <option value="Katsina">Katsina (Live Hub)</option>
                              {NIGERIA_STATES.filter((s) => s.name !== 'Katsina').map((s) => (
                                <option key={s.name} value={s.name}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div className={showDeliveryStateSelectors ? "sm:col-span-3" : undefined}>
                          <label className="sr-only" htmlFor="hero-pickup-address">
                            Pickup address
                          </label>
                          <AddressPickerField
                            id="hero-pickup-address"
                            label="Pickup address"
                            variant="pickup"
                            stateName={pickupState}
                            restrictToState={!showDeliveryStateSelectors}
                            value={pickupAddress}
                            oppositeAddress={destinationCoords ? destinationAddress : undefined}
                            selectedCoords={pickupCoords}
                            placeholder="Type Katsina street, gate, or LGA..."
                            surfaceClassName="bg-white border border-neutral-300"
                            onChange={(value) => {
                              setPickupAddress(value);
                              setPickupCoords(null);
                            }}
                            onStateDetected={setPickupState}
                            onLocationResolved={(place) => {
                              setPickupCoords({ lat: place.lat, lng: place.lng });
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Swap From & To Divider (clean spacing, zero overlap) */}
                    <div className="flex items-center justify-center gap-3 py-2">
                      <div className="h-px flex-1 bg-neutral-200" />
                      <button
                        type="button"
                        onClick={() => {
                          const nextPState = destinationState;
                          const nextDState = pickupState;
                          const nextPAddr = destinationAddress;
                          const nextDAddr = pickupAddress;
                          const nextPCoords = destinationCoords;
                          const nextDCoords = pickupCoords;
                          setPickupState(nextPState);
                          setDestinationState(nextDState);
                          setPickupAddress(nextPAddr);
                          setDestinationAddress(nextDAddr);
                          setPickupCoords(nextPCoords);
                          setDestinationCoords(nextDCoords);
                        }}
                        aria-label="Swap From and To locations"
                        className="inline-flex items-center gap-1.5 min-h-10 border border-neutral-300 bg-white hover:border-black px-3.5 py-1.5 rounded-full text-[11px] font-semibold text-neutral-700 hover:text-black shadow-xs cursor-pointer transition-colors shrink-0"
                      >
                        <ArrowUpDown className="w-3 h-3" />
                        <span>Swap From / To</span>
                      </button>
                      <div className="h-px flex-1 bg-neutral-200" />
                    </div>

                    {/* TO: DESTINATION */}
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-black">
                          <span aria-hidden="true" className="w-2 h-2 border-2 border-black bg-white shrink-0" />
                          <span>To · Destination</span>
                        </span>
                        <span className="text-[11px] text-neutral-500">{showDeliveryStateSelectors ? destinationState : "Katsina State"}</span>
                      </div>
                      <div className={showDeliveryStateSelectors ? "grid grid-cols-1 sm:grid-cols-5 gap-2" : undefined}>
                        {showDeliveryStateSelectors && (
                          <div className="sm:col-span-2">
                            <label className="sr-only" htmlFor="hero-dest-state">
                              Destination state
                            </label>
                            <select
                              id="hero-dest-state"
                              value={destinationState}
                              onChange={(e) => {
                                const nextState = e.target.value;
                                setDestinationState(nextState);
                                setDestinationAddress('');
                                setDestinationCoords(null);
                              }}
                              className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2.5 text-base sm:text-sm font-medium focus:outline-none focus:ring-2 focus:ring-black"
                            >
                              <option value="Katsina">Katsina (Live Hub)</option>
                              {NIGERIA_STATES.filter((s) => s.name !== 'Katsina').map((s) => (
                                <option key={s.name} value={s.name}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div className={showDeliveryStateSelectors ? "sm:col-span-3" : undefined}>
                          <label className="sr-only" htmlFor="hero-dest-address">
                            Destination address
                          </label>
                          <AddressPickerField
                            id="hero-dest-address"
                            label="Destination address"
                            variant="destination"
                            stateName={destinationState}
                            restrictToState={!showDeliveryStateSelectors}
                            value={destinationAddress}
                            oppositeAddress={pickupCoords ? pickupAddress : undefined}
                            selectedCoords={destinationCoords}
                            placeholder="Type drop-off street, campus, or town..."
                            surfaceClassName="bg-white border border-neutral-300"
                            onChange={(value) => {
                              setDestinationAddress(value);
                              setDestinationCoords(null);
                            }}
                            onStateDetected={setDestinationState}
                            onLocationResolved={(place) => {
                              setDestinationCoords({ lat: place.lat, lng: place.lng });
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {quoteLoading && <p role="status" className="text-sm text-neutral-500">Calculating quote…</p>}
                  {quote && pickupCoords && destinationCoords && (
                    <div className="pt-2 flex flex-wrap items-center justify-between gap-4 border-t border-neutral-200">
                      <div>
                        <p className="text-xs text-neutral-500 font-medium">
                          {quote.targetLabel} · <span className="tabular-nums">{quote.distanceKm} km</span>
                        </p>
                        <p className="font-display font-bold text-lg tabular-nums">
                          {formatNaira(quote.deliveryFeeNgn)}{' '}
                          <span className="text-sm font-normal text-neutral-600">
                            · Est. {formatEta(quote.estimatedMinutes)}
                          </span>
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const draft = { pickupState, pickupAddress, pickupCoords, destinationState, destinationAddress, destinationCoords };
                          if (currentUser?.role === 'client') onOpenDashboard(draft);
                          else onNavigateAuth('login', 'client', draft);
                        }}
                        className="bg-black text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-neutral-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Request Rider
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleTrackSearch(trackCode);
                    document
                      .getElementById('track-section')
                      ?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className="space-y-3"
                >
                  <label htmlFor="hero-track-input" className="block text-xs font-medium text-neutral-600">
                    Enter your SAQO parcel tracking code
                  </label>
                  <div className="flex items-stretch gap-2 w-full">
                    <input
                      id="hero-track-input"
                      type="text"
                      value={trackCode}
                      onChange={(e) => setTrackCode(e.target.value)}
                      placeholder="e.g. SQ-2026-A1B2C3D4E5F6071829"
                      className="flex-1 min-w-0 w-full bg-neutral-100 border border-neutral-200 rounded-lg px-3.5 py-2.5 text-base sm:text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-black"
                    />
                    <button
                      type="submit"
                      disabled={trackLoading}
                      className="bg-black text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-neutral-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {trackLoading ? '...' : 'Track'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>

          {/* Right Column: Editorial Courier Photography */}
          <div className="lg:col-span-6 flex items-stretch">
            <div className="relative w-full min-h-[340px] lg:h-full rounded-xl overflow-hidden border border-white/15 bg-neutral-900">
              {!heroImgFailed ? (
                <img
                  src={heroCourierImg}
                  alt="SAQO parcel courier rider dispatching a sealed package in Katsina"
                  referrerPolicy="no-referrer"
                  onError={() => setHeroImgFailed(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 text-neutral-400">
                  <Truck className="w-12 h-12 mb-3" />
                  <p className="font-display font-semibold text-white">SAQO Express Fleet</p>
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
              <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-neutral-300">
                    Request · Assign · Track · Deliver
                  </p>
                  <p className="font-display font-bold text-lg text-white mt-0.5">
                    One state at a time · Live in Katsina
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Full-Width Service Tier Strip (below hero split) */}
      <section className="border-b border-neutral-200 bg-neutral-50">
        <div className="max-w-7xl mx-auto px-6 py-10 grid grid-cols-1 md:grid-cols-4 gap-8">
          <div>
            <p className="font-display font-bold text-2xl tabular-nums">From ₦600</p>
            <p className="text-sm text-neutral-600 mt-1">
              Local dispatch from ₦600 with a 15-minute target completion window across Katsina State.
            </p>
          </div>
          <div>
            <p className="font-display font-bold text-2xl">Inter-City</p>
            <p className="text-sm text-neutral-600 mt-1">
              Same-day highway corridors linking Katsina City, Daura, Funtua, Malumfashi, Dutsin-Ma & LGAs.
            </p>
          </div>
          <div>
            <p className="font-display font-bold text-2xl">Starting with One State at a Time.</p>
            <p className="text-sm text-neutral-600 mt-1">
              Now serving Katsina State.
            </p>
          </div>
          <div>
            <p className="font-display font-bold text-2xl">OTP Verified</p>
            <p className="text-sm text-neutral-600 mt-1">
              Every parcel handoff is secured by a 4-digit recipient delivery OTP.
            </p>
          </div>
        </div>
      </section>

      {/* How It Works: Editorial 3-Step Flow */}
      <section id="how-it-works" className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-12 gap-14 items-center">
          <div className="lg:col-span-6 space-y-8">
            <div>
              <p className="text-xs font-semibold text-neutral-500 tracking-wide">
                How SAQO Works
              </p>
              <h2 className="mt-2 font-display font-extrabold text-3xl sm:text-4xl tracking-tight [text-wrap:balance]">
                Zero friction from pickup request to recipient OTP.
              </h2>
            </div>

            <div className="divide-y divide-neutral-200 border-t border-b border-neutral-200">
              <div className="py-6 flex gap-5">
                <span className="font-mono text-sm font-semibold text-neutral-400 pt-0.5 tabular-nums">
                  01
                </span>
                <div>
                  <h3 className="font-display font-bold text-lg">Request a parcel pickup</h3>
                  <p className="text-sm text-neutral-600 mt-1 leading-relaxed">
                    Enter pickup and destination states, street addresses, recipient phone, and parcel details. See transparent Naira pricing and realistic ETA upfront.
                  </p>
                </div>
              </div>

              <div className="py-6 flex gap-5">
                <span className="font-mono text-sm font-semibold text-neutral-400 pt-0.5 tabular-nums">
                  02
                </span>
                <div>
                  <h3 className="font-display font-bold text-lg">Smart rider assignment</h3>
                  <p className="text-sm text-neutral-600 mt-1 leading-relaxed">
                    Our dispatch engine scores nearby verified riders by proximity, active parcel workload, capacity ceiling, and route compatibility — with automatic timeout fallback.
                  </p>
                </div>
              </div>

              <div className="py-6 flex gap-5">
                <span className="font-mono text-sm font-semibold text-neutral-400 pt-0.5 tabular-nums">
                  03
                </span>
                <div>
                  <h3 className="font-display font-bold text-lg">Live tracking & OTP delivery</h3>
                  <p className="text-sm text-neutral-600 mt-1 leading-relaxed">
                    Sender and recipient follow live rider movement on the map, message support on WhatsApp anytime, and confirm final receipt with the 4-digit delivery OTP.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="rounded-xl overflow-hidden border border-neutral-200 bg-neutral-100 aspect-[4/3]">
              {!hubImgFailed ? (
                <img
                  src={hubImg}
                  alt="SAQO inter-state parcel sorting and dispatch facility"
                  referrerPolicy="no-referrer"
                  onError={() => setHubImgFailed(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-neutral-500">
                  <Package className="w-12 h-12 mb-2" />
                  <p className="font-display font-semibold">SAQO Dispatch Hub</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Public Live Parcel Tracking & Recipient OTP Confirmation */}
      <section id="track-section" className="py-20 bg-neutral-50 border-t border-neutral-200">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
            <div>
              <p className="text-xs font-semibold text-neutral-500 tracking-wide">
                Live Parcel Tracking
              </p>
              <h2 className="mt-2 font-display font-extrabold text-3xl tracking-tight">
                Track a delivery or confirm receipt
              </h2>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleTrackSearch();
              }}
              className="flex items-stretch gap-2 w-full md:w-auto"
            >
              <label htmlFor="public-track-input" className="sr-only">
                Tracking Code
              </label>
              <input
                id="public-track-input"
                type="text"
                value={trackCode}
                onChange={(e) => setTrackCode(e.target.value)}
                placeholder="Enter tracking code"
                className="flex-1 min-w-0 md:w-72 bg-white border border-neutral-300 rounded-lg px-3.5 sm:px-4 py-2.5 text-base sm:text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-black"
              />
              <button
                type="submit"
                disabled={trackLoading}
                className="bg-black text-white px-4 sm:px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-neutral-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {trackLoading ? 'Locating...' : 'Track Parcel'}
              </button>
            </form>
          </div>

          {trackError && (
            <div className="mb-6 bg-white border border-black rounded-xl p-6 text-sm font-medium">
              {trackError}
            </div>
          )}

          {!trackedDelivery ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              <div className="lg:col-span-7 space-y-2">
                <LiveNigeriaMap
                  deliveries={[]}
                  riders={[]}
                  previewRoute={
                    pickupCoords || destinationCoords
                      ? {
                          pickupLat: pickupCoords?.lat,
                          pickupLng: pickupCoords?.lng,
                          pickupAddress,
                          pickupState,
                          destinationLat: destinationCoords?.lat,
                          destinationLng: destinationCoords?.lng,
                          destinationAddress,
                          destinationState,
                        }
                      : null
                  }
                  heightClass="h-[380px]"
                />
                {pickupCoords && destinationCoords && (
                  <p className="text-xs text-neutral-500 flex items-center justify-between gap-2 px-1">
                    <span className="truncate">
                      Selected route: <strong className="text-black">{pickupAddress}</strong> →{' '}
                      <strong className="text-black">{destinationAddress}</strong>
                    </span>
                    {quote && (
                      <span className="font-mono text-black font-semibold shrink-0 tabular-nums">
                        {quote.distanceKm} km · {formatNaira(quote.deliveryFeeNgn)}
                      </span>
                    )}
                  </p>
                )}
              </div>
              <div className="lg:col-span-5 bg-white border border-neutral-200 rounded-xl p-6 sm:p-8 space-y-4">
                <Package className="w-7 h-7" />
                <h3 className="font-display font-bold text-xl">
                  Real-time route & OTP lookup
                </h3>
                <p className="text-sm text-neutral-600 leading-relaxed">
                  Enter the tracking code shared when your parcel was dispatched to follow live rider GPS coordinates, view status milestones, or confirm final delivery with your 4-digit OTP.
                </p>
                <div className="pt-2 border-t border-neutral-200 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onNavigateAuth('register', 'client')}
                    className="bg-black text-white px-4 py-2.5 rounded-lg text-xs font-bold hover:bg-neutral-800 cursor-pointer"
                  >
                    Create Customer Account
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigateAuth('login', 'client')}
                    className="border border-neutral-300 px-4 py-2.5 rounded-lg text-xs font-semibold hover:border-black cursor-pointer"
                  >
                    Sign In
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              <div className="lg:col-span-7">
                <LiveNigeriaMap
                  deliveries={[trackedDelivery as DeliveryRequest]}
                  focusedDelivery={trackedDelivery as DeliveryRequest}
                  riders={
                    trackedDelivery.assignedRiderId &&
                    trackedDelivery.assignedRiderLat &&
                    trackedDelivery.assignedRiderLng
                      ? [
                          {
                            id: 'tracked-rider',
                            riderId: trackedDelivery.assignedRiderId,
                            email: '',
                            fullName: trackedDelivery.assignedRiderName || 'Rider',
                            phone: '',
                            role: 'rider',
                            accountStatus: 'active',
                            createdAt: '',
                            vehicleType: (trackedDelivery.assignedRiderVehicle as any) || 'Motorcycle',
                            plateNumber: '',
                            homeState: trackedDelivery.pickupState,
                            verificationStatus: trackedDelivery.assignedRiderVerified ? 'verified' : 'pending',
                            isOnline: true,
                            currentLat: trackedDelivery.assignedRiderLat,
                            currentLng: trackedDelivery.assignedRiderLng,
                            lastLocationAt: trackedDelivery.updatedAt,
                            activeParcelsCount: 1,
                            completedDeliveriesCount: 0,
                            totalEarningsNgn: 0,
                            rating: 5,
                          },
                        ]
                      : []
                  }
                  heightClass="h-[420px]"
                />
              </div>

              <div className="lg:col-span-5 bg-white border border-neutral-200 rounded-xl p-5 sm:p-6 space-y-5">
                <div className="flex items-start justify-between gap-3 border-b border-neutral-200 pb-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-mono text-xs font-semibold text-black">
                        {trackedDelivery.trackingCode}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(trackedDelivery.trackingCode).catch(() => {});
                          setCopiedCode(true);
                          setTimeout(() => setCopiedCode(false), 1800);
                        }}
                        aria-label="Copy tracking code"
                        className="inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-black cursor-pointer"
                      >
                        {copiedCode ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedCode ? 'Copied' : 'Copy'}</span>
                      </button>
                      <span className="text-neutral-300">·</span>
                      <span className="text-xs text-neutral-500">
                        {trackedDelivery.pickupState === trackedDelivery.destinationState
                          ? `${trackedDelivery.pickupState} Local`
                          : trackedDelivery.serviceTier.replace('_', ' ')}
                      </span>
                    </div>
                    <h3 className="font-display font-bold text-xl mt-1">
                      {trackedDelivery.pickupState === trackedDelivery.destinationState
                        ? `${trackedDelivery.pickupAddress} → ${trackedDelivery.destinationAddress}`
                        : `${trackedDelivery.pickupState} → ${trackedDelivery.destinationState}`}
                    </h3>
                    <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                      <span className="inline-block bg-black text-white px-2.5 py-0.5 rounded text-xs font-semibold">
                        {formatDeliveryStatusLabel(trackedDelivery.status)}
                      </span>
                      <span className="text-xs text-neutral-500 font-mono">
                        Updated{' '}
                        {new Date(trackedDelivery.updatedAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono font-bold text-lg tabular-nums">
                      {formatNaira(trackedDelivery.deliveryFeeNgn)}
                    </p>
                    <p className="text-xs text-neutral-500 tabular-nums">
                      {trackedDelivery.distanceKm} km · {formatEta(trackedDelivery.estimatedMinutes)}
                    </p>
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleTrackSearch(trackedDelivery.trackingCode)}
                        aria-label="Refresh parcel status"
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-neutral-600 hover:text-black cursor-pointer"
                      >
                        <RefreshCw className={`w-3 h-3 ${trackLoading ? 'animate-spin' : ''}`} />
                        <span>Refresh</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTrackedDelivery(null);
                          setTrackedHistory([]);
                          setTrackCode('');
                          setTrackError(null);
                        }}
                        className="text-[11px] font-semibold text-neutral-500 hover:text-black underline cursor-pointer"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                </div>

                {/* Standard 5-Stage Milestone Stepper */}
                {(() => {
                  const progress = getTrackingProgress(trackedDelivery.status);
                  return (
                    <div className="space-y-2.5">
                      {progress.isException && progress.exceptionLabel && (
                        <div className="bg-neutral-100 border border-black rounded-lg px-3 py-2 text-xs font-semibold">
                          {progress.exceptionLabel}
                        </div>
                      )}
                      <div className="w-full h-1.5 bg-neutral-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-black transition-all duration-300"
                          style={{ width: `${progress.percent}%` }}
                        />
                      </div>
                      <div className="grid grid-cols-5 gap-1">
                        {progress.steps.map((step) => (
                          <div key={step.key} className="text-center">
                            <div
                              className={`mx-auto w-2.5 h-2.5 rounded-full border mb-1 ${
                                step.state === 'completed'
                                  ? 'bg-black border-black'
                                  : step.state === 'current'
                                  ? 'bg-white border-2 border-black'
                                  : 'bg-white border-neutral-300'
                              }`}
                            />
                            <p
                              className={`text-[10px] leading-tight ${
                                step.state === 'upcoming'
                                  ? 'text-neutral-400 font-medium'
                                  : 'text-black font-semibold'
                              }`}
                            >
                              {step.label}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                <div className="space-y-2 text-sm border-t border-neutral-200 pt-4">
                  <div className="flex items-start gap-2.5">
                    <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs text-neutral-500">Pickup</p>
                      <p className="font-medium">
                        {trackedDelivery.pickupAddress}, {trackedDelivery.pickupState}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <Package className="w-4 h-4 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs text-neutral-500">
                        Destination
                      </p>
                      <p className="font-medium">
                        {trackedDelivery.destinationAddress}, {trackedDelivery.destinationState}
                      </p>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        {trackedDelivery.parcelCategory} · {trackedDelivery.weightKg} kg
                      </p>
                    </div>
                  </div>
                </div>

                {trackedDelivery.assignedRiderName && (
                  <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3.5 text-sm flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-neutral-500">Assigned Rider</p>
                      <p className="font-semibold mt-0.5 inline-flex items-center gap-1.5 flex-wrap">
                        <span>{trackedDelivery.assignedRiderName}</span>
                        {trackedDelivery.assignedRiderVerified && (
                          <span className="inline-flex items-center gap-0.5 bg-black text-white px-1.5 py-0.5 rounded text-[10px] font-semibold">
                            <BadgeCheck className="w-3 h-3" />
                            <span>Verified</span>
                          </span>
                        )}
                        <span className="text-neutral-500 font-normal">
                          · {trackedDelivery.assignedRiderVehicle}
                        </span>
                      </p>
                    </div>
                  </div>
                )}

                {/* Recipient OTP Confirmation */}
                {trackedDelivery.status === 'arrived_at_destination' ? (
                  <form onSubmit={handleConfirmOtp} className="border-t border-neutral-200 pt-4 space-y-2.5">
                    <label htmlFor="track-otp-input" className="block text-xs font-semibold">
                      Recipient Delivery OTP Confirmation
                    </label>
                    <div className="flex items-stretch gap-2 w-full">
                      <input
                        id="track-otp-input"
                        type="text"
                        inputMode="numeric"
                        maxLength={4}
                        value={otpInput}
                        onChange={(e) => setOtpInput(e.target.value)}
                        placeholder="4-digit OTP"
                        className="flex-1 min-w-0 bg-neutral-50 border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-black"
                      />
                      <button
                        type="submit"
                        disabled={otpSubmitting}
                        className="bg-black text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-neutral-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {otpSubmitting ? 'Verifying...' : 'Confirm Delivery'}
                      </button>
                    </div>
                    {otpError && <p className="text-xs text-black font-medium">{otpError}</p>}
                    {otpMessage && <p className="text-xs text-black font-semibold">{otpMessage}</p>}
                  </form>
                ) : ['delivered', 'cancelled'].includes(trackedDelivery.status) && (
                  <div className="flex items-center gap-2 text-sm font-semibold border-t border-neutral-200 pt-4">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>
                      {trackedDelivery.status === 'delivered'
                        ? 'Parcel delivered & OTP verified'
                        : 'Delivery cancelled'}
                    </span>
                  </div>
                )}

                {/* Timeline */}
                {trackedHistory.length > 0 && (
                  <div className="border-t border-neutral-200 pt-4">
                    <p className="text-xs font-semibold text-neutral-500 mb-3">Status Timeline</p>
                    <ul className="space-y-2.5">
                      {trackedHistory.map((item) => (
                        <li key={item.id} className="text-xs flex justify-between gap-3">
                          <span className="text-neutral-800">{formatDeliveryStatusLabel(item.status)}</span>
                          <span className="font-mono text-neutral-400 shrink-0 tabular-nums">
                            {new Date(item.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Live Support Chat + WhatsApp Fallback */}
                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                  {onOpenSupportChat && (
                    <button
                      type="button"
                      onClick={() => onOpenSupportChat(trackedDelivery.trackingCode)}
                      className="flex-1 inline-flex items-center justify-center gap-2 bg-black text-white px-4 py-2.5 rounded-lg text-xs font-bold hover:bg-neutral-800 transition-colors cursor-pointer"
                    >
                      <MessageCircle className="w-4 h-4" />
                      <span>Live Chat about {trackedDelivery.trackingCode}</span>
                    </button>
                  )}
                  <a
                    href={buildWhatsAppUrl(
                      whatsappNumber,
                      `Hello SAQO Support, I am checking on parcel ${trackedDelivery.trackingCode} (${trackedDelivery.pickupState} to ${trackedDelivery.destinationState}).`
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 border border-black px-4 py-2.5 rounded-lg text-xs font-semibold hover:bg-neutral-100 transition-colors"
                  >
                    <span>WhatsApp</span>
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Role Portals Banner */}
      <section className="py-16 bg-black text-white">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="border border-white/15 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <Package className="w-6 h-6 mb-4" />
              <h3 className="font-display font-bold text-xl">Senders & Recipients</h3>
              <p className="text-sm text-neutral-400 mt-2 leading-relaxed">
                Create parcel requests in seconds, monitor live rider GPS movement, and confirm receipt with a secure OTP.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigateAuth('login', 'client')}
              className="mt-6 w-full bg-white text-black py-2.5 rounded-lg text-sm font-semibold hover:bg-neutral-200 transition-colors cursor-pointer"
            >
              Client Portal
            </button>
          </div>

          <div className="border border-white/15 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <Truck className="w-6 h-6 mb-4" />
              <h3 className="font-display font-bold text-xl">Dispatch Riders</h3>
              <p className="text-sm text-neutral-400 mt-2 leading-relaxed">
                Go online, receive smart-matched nearby and route-compatible parcel offers, update transit steps, and track earnings.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigateAuth('login', 'rider')}
              className="mt-6 w-full bg-white text-black py-2.5 rounded-lg text-sm font-semibold hover:bg-neutral-200 transition-colors cursor-pointer"
            >
              Rider Portal
            </button>
          </div>

          <div className="border border-white/15 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <ShieldCheck className="w-6 h-6 mb-4" />
              <h3 className="font-display font-bold text-xl">SAQO Operations</h3>
              <p className="text-sm text-neutral-400 mt-2 leading-relaxed">
                Monitor live Nigerian fleet activity, manually reassign parcels, verify riders, and configure dispatch rules & pricing.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigateAuth('login', 'client')}
              className="mt-6 w-full border border-white/30 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-white/10 transition-colors cursor-pointer"
            >
              Admin Console Sign In
            </button>
          </div>
        </div>
      </section>

      {/* Quiet Footer */}
      <footer className="bg-white border-t border-neutral-200 py-10">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-neutral-600">
          <div className="flex items-center gap-4">
            <SaqoLogo />
            <span>·</span>
            <span>Katsina Parcel Delivery · Starting with One State at a Time</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#track-section" className="hover:text-black">
              Track Parcel
            </a>
            <button
              type="button"
              onClick={() => onOpenSupportChat?.()}
              className="hover:text-black cursor-pointer"
            >
              Live Support Chat
            </button>
            <span>© {new Date().getFullYear()} SAQO Logistics</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
