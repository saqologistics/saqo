import React, { useCallback, useEffect, useState } from 'react';
import {
  BadgeCheck,
  Banknote,
  Bell,
  CheckCircle2,
  Clock,
  LogOut,
  MapPin,
  Navigation,
  Phone,
  Power,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Truck,
  User,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useRealtime } from '../hooks/useRealtime';
import { calculateRiderPayoutNgn, formatEta, formatNaira } from '../shared/pricing';
import type {
  DeliveryAssignment,
  DeliveryRequest,
  DeliveryStatus,
  NotificationItem,
  PlatformSettings,
  Profile,
  RiderProfile,
} from '../shared/types';
import { LiveNigeriaMap } from './LiveNigeriaMap';
import { PWAInstallButton } from './PWAInstallButton';
import { SaqoLogo } from './SaqoLogo';

interface RiderDashboardProps {
  profile: Profile;
  onGoHome: () => void;
  onLogout: () => void;
}

const NEXT_STATUS_STEP: Record<string, { status: DeliveryStatus; label: string } | undefined> = {
  accepted: { status: 'heading_to_pickup', label: 'Heading to Pickup' },
  heading_to_pickup: { status: 'parcel_picked_up', label: 'Confirm Parcel Picked Up' },
  parcel_picked_up: { status: 'in_transit', label: 'Mark In Transit' },
  in_transit: { status: 'arrived_at_destination', label: 'Mark Arrived at Destination' },
  arrived_at_destination: { status: 'delivered', label: 'Complete Delivery' },
};

export const RiderDashboard: React.FC<RiderDashboardProps> = ({
  profile,
  onGoHome,
  onLogout,
}) => {
  const [rider, setRider] = useState<RiderProfile | null>(null);
  const [assignments, setAssignments] = useState<DeliveryAssignment[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRequest[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [liveToast, setLiveToast] = useState<NotificationItem | null>(null);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [tab, setTab] = useState<'active' | 'history' | 'notifications' | 'profile'>('active');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [busyAssignmentId, setBusyAssignmentId] = useState<string | null>(null);
  const [busyDeliveryId, setBusyDeliveryId] = useState<string | null>(null);
  const [confirmingCashId, setConfirmingCashId] = useState<string | null>(null);
  const [otpInputs, setOtpInputs] = useState<Record<string, string>>({});

  const loadDashboard = useCallback(async () => {
    try {
      const res = await apiRequest<{
        rider: RiderProfile;
        assignments: DeliveryAssignment[];
        deliveries: DeliveryRequest[];
        settings: PlatformSettings;
        notifications?: NotificationItem[];
      }>('/api/rider/dashboard');
      setRider(res.rider);
      setAssignments(res.assignments);
      setDeliveries(res.deliveries);
      setSettings(res.settings);
      if (res.notifications) {
        setNotifications(res.notifications);
      }
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load rider workspace.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!liveToast) return;
    const t = window.setTimeout(() => setLiveToast(null), 9000);
    return () => window.clearTimeout(t);
  }, [liveToast]);

  useRealtime((evt) => {
    if (evt.type === 'notifications:refresh' || evt.type === 'connected') {
      loadDashboard();
      return;
    }
    if (evt.type === 'notification:created') {
      const notif = evt.payload as NotificationItem;
      if (notif && notif.userId === profile.id) {
        setNotifications((prev) =>
          prev.some((n) => n.id === notif.id) ? prev : [notif, ...prev]
        );
        setLiveToast(notif);
      }
    }
    if (
      evt.type === 'assignment:offered' ||
      evt.type === 'assignment:updated' ||
      evt.type === 'delivery:updated' ||
      evt.type === 'rider:availability' ||
      evt.type === 'settings:updated' ||
      evt.type === 'notification:created'
    ) {
      loadDashboard();
    }
  });

  const handleToggleOnline = async () => {
    if (!rider) return;
    try {
      const res = await apiRequest<{ rider: RiderProfile }>('/api/rider/availability', {
        method: 'PATCH',
        body: JSON.stringify({ isOnline: !rider.isOnline }),
      });
      setRider(res.rider);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const [sharingGps, setSharingGps] = useState(false);
  const handleShareGps = () => {
    if (sharingGps) {
      setSharingGps(false);
      setGpsStatus('GPS sharing paused.');
    } else if (navigator.geolocation) {
      setGpsStatus('Reading device GPS…');
      setSharingGps(true);
    } else {
      setGpsStatus('Device GPS is not supported in this browser.');
    }
  };

  useEffect(() => {
    if (!sharingGps) return;
    let lastUpdate = 0;
    const request = new AbortController();
    const watcher = navigator.geolocation.watchPosition(
      async ({ coords }) => {
        if (Date.now() - lastUpdate < 5000 || request.signal.aborted) return;
        lastUpdate = Date.now();
        try {
          const result = await apiRequest<{ rider: RiderProfile }>('/api/rider/location', {
            method: 'POST',
            signal: request.signal,
            body: JSON.stringify({ lat: coords.latitude, lng: coords.longitude }),
          });
          if (!request.signal.aborted) {
            setRider(result.rider);
            setGpsStatus('Live device GPS synced.');
          }
        } catch (error) {
          if (!request.signal.aborted) {
            setGpsStatus(error instanceof Error ? error.message : 'Could not sync GPS coordinates.');
          }
        }
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) setSharingGps(false);
        setGpsStatus(error.code === error.PERMISSION_DENIED
          ? 'Location permission denied. Enable GPS to share your location.'
          : 'Waiting for a device GPS signal…');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
    return () => {
      request.abort();
      navigator.geolocation.clearWatch(watcher);
    };
  }, [sharingGps]);

  const handleRespondOffer = async (assignmentId: string, action: 'accept' | 'reject') => {
    setBusyAssignmentId(assignmentId);
    setError(null);
    try {
      await apiRequest(`/api/rider/assignments/${assignmentId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      await loadDashboard();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyAssignmentId(null);
    }
  };

  const handleAdvanceStatus = async (
    deliveryId: string,
    nextStatus: DeliveryStatus,
    otp?: string
  ) => {
    setBusyDeliveryId(deliveryId);
    setError(null);
    try {
      await apiRequest(`/api/rider/deliveries/${deliveryId}/status`, {
        method: 'PATCH',
        body: JSON.stringify(otp !== undefined ? { status: nextStatus, otp } : { status: nextStatus }),
      });
      if (nextStatus === 'delivered') {
        setOtpInputs((prev) => {
          const next = { ...prev };
          delete next[deliveryId];
          return next;
        });
      }
      await loadDashboard();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyDeliveryId(null);
    }
  };

  const handleConfirmCashCollected = async (deliveryId: string, expectedAmountNgn: number) => {
    setConfirmingCashId(deliveryId);
    setError(null);
    try {
      await apiRequest(`/api/rider/deliveries/${deliveryId}/collect-cash`, {
        method: 'POST',
        body: JSON.stringify({ collectedAmountNgn: expectedAmountNgn }),
      });
      await loadDashboard();
    } catch (err: any) {
      setError(err.message || 'Could not confirm cash collection.');
    } finally {
      setConfirmingCashId(null);
    }
  };

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await loadDashboard();
    setRefreshing(false);
  };

  const handleMarkNotificationsRead = async () => {
    await apiRequest('/api/notifications/read', { method: 'POST' });
    await loadDashboard();
  };

  const pendingOffers = assignments.filter((a) => a.status === 'offered');
  const pendingOfferDeliveryIds = new Set(pendingOffers.map((o) => o.deliveryId));
  const activeDeliveries = deliveries.filter(
    (d) =>
      !['delivered', 'cancelled'].includes(d.status) &&
      !pendingOfferDeliveryIds.has(d.id)
  );
  const completedDeliveries = deliveries.filter((d) => d.status === 'delivered');
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <div className="min-h-screen bg-neutral-50 text-black flex flex-col">
      {/* Header */}
      <header className="bg-black text-white border-b border-white/15 px-4 sm:px-6 h-16 flex items-center justify-between gap-4 sticky top-0 z-30">
        <button type="button" onClick={onGoHome} className="cursor-pointer shrink-0">
          <SaqoLogo inverted />
        </button>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          <button
            type="button"
            onClick={() => setTab('active')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              tab === 'active' ? 'text-white underline underline-offset-8' : 'text-neutral-400 hover:text-white'
            }`}
          >
            Active Dispatch ({activeDeliveries.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              tab === 'history' ? 'text-white underline underline-offset-8' : 'text-neutral-400 hover:text-white'
            }`}
          >
            Earnings & History
          </button>
          <button
            type="button"
            onClick={() => setTab('notifications')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              tab === 'notifications'
                ? 'text-white underline underline-offset-8'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setTab('profile')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              tab === 'profile'
                ? 'text-white underline underline-offset-8'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            Account
          </button>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <PWAInstallButton inverted compact />
          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={refreshing}
            aria-label="Refresh rider dispatch"
            className="inline-flex items-center gap-1.5 border border-white/25 text-white px-2.5 py-2 rounded-lg text-xs font-semibold hover:bg-white/10 transition-colors shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <span className="hidden md:inline text-xs text-neutral-300 whitespace-nowrap">
            {profile.fullName}
          </span>
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 bg-white text-black px-3 py-2 rounded-lg text-xs font-semibold hover:bg-neutral-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pt-5 sm:pt-8 pb-24 md:pb-12 space-y-6">
        {liveToast && (
          <div
            role="status"
            aria-live="polite"
            className="bg-black text-white rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 border border-black"
          >
            <div className="flex items-start gap-3">
              <Bell className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-display font-bold text-sm">{liveToast.title}</p>
                <p className="text-xs text-neutral-300 mt-0.5">{liveToast.message}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setTab('active');
                  setLiveToast(null);
                }}
                className="text-xs font-semibold underline cursor-pointer"
              >
                View Offer
              </button>
              <button
                type="button"
                onClick={() => setLiveToast(null)}
                className="text-xs text-neutral-400 hover:text-white cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {error && (
          <div role="alert" className="bg-white border border-black rounded-xl p-4 text-sm font-medium flex justify-between">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-xs underline cursor-pointer">
              Dismiss
            </button>
          </div>
        )}

        {loading || !rider ? (
          <div className="bg-white border border-neutral-200 rounded-xl p-10 text-sm text-neutral-500">
            Loading rider workspace...
          </div>
        ) : (
          <>
            {/* Verification Gate Banner when not yet verified by Admin */}
            {rider.verificationStatus !== 'verified' && (
              <div
                role="status"
                className="bg-white border-2 border-black rounded-xl p-4 sm:p-5 flex items-start gap-3"
              >
                <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-display font-bold text-sm">
                    Verification Pending — Waiting for SAQO Admin Verification Tick
                  </p>
                  <p className="text-xs text-neutral-600 mt-0.5 leading-relaxed">
                    Your rider account has been created, but dispatch eligibility requires an active Admin Verification Tick. Once SAQO Operations enables your verified badge, you can go online and accept parcel requests.
                  </p>
                </div>
              </div>
            )}

            {/* Rider Status & Controls Bar */}
            <section className="bg-white border border-neutral-200 rounded-xl p-6 flex flex-wrap items-center justify-between gap-6">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
                  {rider.verificationStatus === 'verified' ? (
                    <span className="inline-flex items-center gap-1 bg-black text-white px-2 py-0.5 rounded font-semibold">
                      <BadgeCheck className="w-3.5 h-3.5" />
                      <span>Verified Rider</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 border border-neutral-300 px-2 py-0.5 rounded font-semibold text-black capitalize">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>{rider.verificationStatus} Verification</span>
                    </span>
                  )}
                  <span>·</span>
                  <span>{rider.vehicleType}</span>
                  <span>·</span>
                  <span className="font-mono">{rider.plateNumber}</span>
                  <span>·</span>
                  <span>{rider.homeState}</span>
                </div>
                <div className="flex items-center gap-2">
                  <h1 className="font-display font-extrabold text-2xl">{rider.fullName}</h1>
                  {rider.verificationStatus === 'verified' && (
                    <BadgeCheck aria-label="Verified rider badge" className="w-5 h-5 text-black shrink-0" />
                  )}
                </div>
                <p className="text-xs text-neutral-500 tabular-nums">
                  Workload: {activeDeliveries.length} / {settings?.maxActiveParcelsPerRider ?? 3} max active parcels · Rating {rider.rating.toFixed(1)}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleShareGps}
                  className="inline-flex items-center gap-2 border border-neutral-300 px-4 py-2.5 rounded-lg text-xs font-semibold hover:border-black transition-colors cursor-pointer"
                >
                  <Navigation className="w-3.5 h-3.5" />
                  <span>{sharingGps ? 'Pause GPS Sharing' : 'Share Live GPS'}</span>
                </button>
                <button
                  type="button"
                  disabled={rider.verificationStatus !== 'verified'}
                  onClick={handleToggleOnline}
                  className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-colors ${
                    rider.verificationStatus !== 'verified'
                      ? 'bg-neutral-200 text-neutral-500 cursor-not-allowed'
                      : rider.isOnline
                      ? 'bg-black text-white hover:bg-neutral-800 cursor-pointer'
                      : 'bg-neutral-200 text-black hover:bg-neutral-300 cursor-pointer'
                  }`}
                >
                  <Power className="w-4 h-4" />
                  <span>
                    {rider.verificationStatus !== 'verified'
                      ? 'Verification Required'
                      : rider.isOnline
                      ? 'Online · Receiving Offers'
                      : 'Go Online'}
                  </span>
                </button>
              </div>
            </section>

            {gpsStatus && (
              <p className="text-xs font-mono text-neutral-600">
                {gpsStatus} ({rider.currentLat.toFixed(4)}, {rider.currentLng.toFixed(4)})
              </p>
            )}

            {tab === 'active' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Left: Offers + Active Parcels */}
                <div className="lg:col-span-6 space-y-5">
                  {/* Incoming Smart-Dispatched Offers */}
                  {pendingOffers.map((offer) => {
                    const remainingSec = Math.max(
                      0,
                      Math.ceil((new Date(offer.expiresAt).getTime() - nowTick) / 1000)
                    );
                    const d = offer.delivery;
                    if (!d) return null;
                    const estPayout = calculateRiderPayoutNgn(
                      d.deliveryFeeNgn,
                      settings?.riderCommissionPercent
                    );
                    const offerBusy = busyAssignmentId === offer.id;
                    return (
                      <div
                        key={offer.id}
                        className="bg-black text-white rounded-xl p-6 space-y-4 border border-black"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-300">
                            Incoming Parcel Offer
                          </span>
                          <span className="font-mono text-xs inline-flex items-center gap-1 tabular-nums">
                            <Clock className="w-3.5 h-3.5" />
                            <span>{remainingSec}s</span>
                          </span>
                        </div>

                        <div>
                          <h2 className="font-display font-bold text-xl">
                            {d.pickupState} → {d.destinationState}
                          </h2>
                          <p className="text-xs text-neutral-300 mt-1 tabular-nums">
                            {d.trackingCode} · {offer.distanceToPickupKm} km to pickup · Route fit{' '}
                            {Math.round(offer.routeCompatibilityScore * 100)}%
                          </p>
                        </div>

                        <div className="text-sm space-y-1.5 border-t border-white/15 pt-3">
                          <p>
                            <span className="text-neutral-400">From:</span> {d.pickupAddress}
                          </p>
                          <p>
                            <span className="text-neutral-400">To:</span> {d.destinationAddress}
                          </p>
                          <p className="font-mono font-bold text-base pt-1 tabular-nums">
                            Your Payout: {formatNaira(estPayout)} · Est. {formatEta(d.estimatedMinutes)}
                          </p>
                          <p className="text-[11px] text-neutral-400 font-mono tabular-nums">
                            Customer Fee: {formatNaira(d.deliveryFeeNgn)} ·{' '}
                            <span className="uppercase text-white">
                              {(d.paymentMethod || 'cash').replace(/_/g, ' ')}
                            </span>{' '}
                            ({(d.paymentStatus || 'pending').replace(/_/g, ' ')})
                          </p>
                        </div>

                        <div className="grid grid-cols-2 gap-3 pt-2">
                          <button
                            type="button"
                            disabled={offerBusy}
                            onClick={() => handleRespondOffer(offer.id, 'reject')}
                            className="border border-white/30 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-white/10 disabled:opacity-50 cursor-pointer"
                          >
                            {offerBusy ? 'Working...' : 'Reject'}
                          </button>
                          <button
                            type="button"
                            disabled={offerBusy}
                            onClick={() => handleRespondOffer(offer.id, 'accept')}
                            className="bg-white text-black py-2.5 rounded-lg text-sm font-bold hover:bg-neutral-200 disabled:opacity-50 cursor-pointer"
                          >
                            {offerBusy ? 'Accepting...' : 'Accept Request'}
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Active Assigned Parcels */}
                  {activeDeliveries.length === 0 && pendingOffers.length === 0 ? (
                    <div className="bg-white border border-neutral-200 rounded-xl p-10 text-center space-y-2">
                      <Truck className="w-8 h-8 mx-auto text-neutral-400" />
                      <p className="font-display font-bold text-lg">No active parcels</p>
                      <p className="text-sm text-neutral-600">
                        {rider.isOnline
                          ? 'Stay online — nearby & route-compatible parcels will appear here automatically.'
                          : 'Switch to Online to receive dispatch requests.'}
                      </p>
                    </div>
                  ) : (
                    activeDeliveries.map((del) => {
                      const nextStep = NEXT_STATUS_STEP[del.status];
                      const estPayout = calculateRiderPayoutNgn(
                        del.deliveryFeeNgn,
                        settings?.riderCommissionPercent
                      );
                      const isBusy = busyDeliveryId === del.id;
                      const otpValue = otpInputs[del.id] || '';
                      const pickupMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
                        `${del.pickupLat},${del.pickupLng}`
                      )}&travelmode=driving`;
                      const dropoffMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
                        `${del.destinationLat},${del.destinationLng}`
                      )}&travelmode=driving`;

                      return (
                        <div
                          key={del.id}
                          className="bg-white border border-neutral-200 rounded-xl p-5 sm:p-6 space-y-4"
                        >
                          <div className="flex items-start justify-between gap-4 border-b border-neutral-200 pb-3">
                            <div>
                              <p className="font-mono text-xs text-neutral-500">
                                {del.trackingCode} · {del.parcelCategory}
                              </p>
                              <h3 className="font-display font-bold text-lg mt-0.5">
                                {del.pickupState} → {del.destinationState}
                              </h3>
                              <p className="text-xs text-neutral-600 mt-0.5 capitalize">
                                Status:{' '}
                                <span className="font-semibold text-black">
                                  {del.status.replace(/_/g, ' ')}
                                </span>
                                <span className="ml-2 font-mono uppercase text-[10px] px-2 py-0.5 rounded-full bg-neutral-100 border border-neutral-300 text-neutral-800">
                                  {(del.paymentMethod || 'cash').replace(/_/g, ' ')} ·{' '}
                                  {(del.paymentStatus || 'pending').replace(/_/g, ' ')}
                                </span>
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-mono font-bold text-base tabular-nums">
                                {formatNaira(estPayout)}
                              </p>
                              <p className="text-[11px] font-mono text-neutral-500 tabular-nums">
                                Fee {formatNaira(del.deliveryFeeNgn)}
                              </p>
                            </div>
                          </div>

                          <div className="space-y-3 text-sm">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="flex items-start gap-2 min-w-0 flex-1">
                                <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-xs text-neutral-500">
                                    From · Pickup ({del.customerName})
                                  </p>
                                  <p className="font-medium">
                                    {del.pickupAddress.toLowerCase().includes(del.pickupState.toLowerCase())
                                      ? del.pickupAddress
                                      : `${del.pickupAddress}, ${del.pickupState}`}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <a
                                  href={pickupMapsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 border border-neutral-300 px-2.5 py-1 rounded text-[11px] font-semibold hover:border-black"
                                >
                                  <Navigation className="w-3 h-3" />
                                  <span>Navigate</span>
                                </a>
                                {del.customerPhone && (
                                  <a
                                    href={`tel:${del.customerPhone}`}
                                    className="inline-flex items-center gap-1 border border-neutral-300 px-2.5 py-1 rounded text-[11px] font-semibold hover:border-black"
                                  >
                                    <Phone className="w-3 h-3" />
                                    <span>Sender</span>
                                  </a>
                                )}
                              </div>
                            </div>

                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="flex items-start gap-2 min-w-0 flex-1">
                                <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-xs text-neutral-500">
                                    To · Destination ({del.recipientName})
                                  </p>
                                  <p className="font-medium">
                                    {del.destinationAddress.toLowerCase().includes(del.destinationState.toLowerCase())
                                      ? del.destinationAddress
                                      : `${del.destinationAddress}, ${del.destinationState}`}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <a
                                  href={dropoffMapsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 border border-neutral-300 px-2.5 py-1 rounded text-[11px] font-semibold hover:border-black"
                                >
                                  <Navigation className="w-3 h-3" />
                                  <span>Navigate</span>
                                </a>
                                {del.recipientPhone && (
                                  <a
                                    href={`tel:${del.recipientPhone}`}
                                    className="inline-flex items-center gap-1 border border-neutral-300 px-2.5 py-1 rounded text-[11px] font-semibold hover:border-black"
                                  >
                                    <Phone className="w-3 h-3" />
                                    <span>Recipient</span>
                                  </a>
                                )}
                              </div>
                            </div>

                            <p className="text-xs text-neutral-600 pt-1 border-t border-neutral-100">
                              Parcel: {del.parcelDescription} ({del.weightKg} kg)
                            </p>

                            {del.paymentMethod === 'cash' && (
                              <div className="rounded-lg border border-neutral-300 bg-neutral-50 p-3 flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2 text-xs">
                                  <Banknote className="w-4 h-4 shrink-0" />
                                  <div>
                                    <p className="font-bold text-black">
                                      {del.paymentStatus === 'pending'
                                        ? `Collect Cash: ${formatNaira(del.deliveryFeeNgn)}`
                                        : 'Cash Collection Recorded'}
                                    </p>
                                    <p className="text-[11px] text-neutral-600">
                                      Status: {(del.paymentStatus || 'pending').replace(/_/g, ' ').toUpperCase()}
                                    </p>
                                  </div>
                                </div>
                                {del.paymentStatus === 'pending' && (
                                  <button
                                    type="button"
                                    disabled={confirmingCashId === del.id}
                                    onClick={() =>
                                      handleConfirmCashCollected(del.id, del.deliveryFeeNgn)
                                    }
                                    className="bg-black text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-neutral-800 disabled:opacity-45 cursor-pointer"
                                  >
                                    {confirmingCashId === del.id
                                      ? 'Recording...'
                                      : `Confirm Cash Collected (${formatNaira(del.deliveryFeeNgn)})`}
                                  </button>
                                )}
                              </div>
                            )}

                            {del.paymentMethod === 'bank_transfer' && del.paymentStatus !== 'paid' && (
                              <div className="rounded-lg border border-neutral-300 bg-neutral-50 p-2.5 text-xs text-neutral-700">
                                Bank transfer awaiting admin verification ({del.paymentReference || 'No ref'}).
                              </div>
                            )}
                          </div>

                          {del.status === 'arrived_at_destination' ? (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                handleAdvanceStatus(del.id, 'delivered', otpValue);
                              }}
                              className="border border-black rounded-lg p-3.5 bg-neutral-50 space-y-2.5"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <label
                                  htmlFor={`rider-otp-${del.id}`}
                                  className="text-xs font-bold text-black"
                                >
                                  Verify 4-Digit Recipient OTP to Complete
                                </label>
                              </div>
                              <div className="flex items-center gap-2">
                                <input
                                  id={`rider-otp-${del.id}`}
                                  type="text"
                                  inputMode="numeric"
                                  maxLength={4}
                                  required
                                  value={otpValue}
                                  onChange={(e) =>
                                    setOtpInputs((prev) => ({
                                      ...prev,
                                      [del.id]: e.target.value.replace(/\D/g, '').slice(0, 4),
                                    }))
                                  }
                                  placeholder="0000"
                                  className="w-28 bg-white border border-neutral-300 rounded-lg px-3 py-2.5 text-center text-base sm:text-sm font-mono tracking-widest tabular-nums focus:outline-none focus:ring-2 focus:ring-black"
                                />
                                <button
                                  type="submit"
                                  disabled={isBusy || otpValue.trim().length !== 4}
                                  className="flex-1 bg-black text-white py-2.5 px-4 rounded-lg text-xs sm:text-sm font-bold hover:bg-neutral-800 disabled:opacity-40 transition-colors cursor-pointer"
                                >
                                  {isBusy ? 'Verifying...' : 'Verify OTP & Complete'}
                                </button>
                              </div>
                            </form>
                          ) : (
                            nextStep && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleAdvanceStatus(del.id, nextStep.status)}
                                className="w-full bg-black text-white py-3 rounded-lg text-sm font-bold hover:bg-neutral-800 disabled:opacity-50 transition-colors cursor-pointer"
                              >
                                {isBusy ? 'Updating...' : nextStep.label}
                              </button>
                            )
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Right: Route Navigation Map */}
                <div className="lg:col-span-6">
                  <LiveNigeriaMap
                    deliveries={activeDeliveries}
                    riders={[rider]}
                    focusedDelivery={activeDeliveries[0] || pendingOffers[0]?.delivery || null}
                    heightClass="h-[460px]"
                  />
                </div>
              </div>
            )}

            {tab === 'history' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="bg-white border border-neutral-200 rounded-xl p-5">
                    <p className="text-xs text-neutral-500">Completed Deliveries</p>
                    <p className="font-display font-extrabold text-3xl mt-1 tabular-nums">
                      {rider.completedDeliveriesCount}
                    </p>
                  </div>
                  <div className="bg-white border border-neutral-200 rounded-xl p-5">
                    <p className="text-xs text-neutral-500">Total Rider Earnings</p>
                    <p className="font-display font-extrabold text-3xl mt-1 tabular-nums">
                      {formatNaira(rider.totalEarningsNgn)}
                    </p>
                  </div>
                  <div className="bg-white border border-neutral-200 rounded-xl p-5">
                    <p className="text-xs text-neutral-500">Rider Rating</p>
                    <p className="font-display font-extrabold text-3xl mt-1 tabular-nums">
                      {rider.rating.toFixed(2)} / 5.0
                    </p>
                  </div>
                </div>

                <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
                  <div className="px-6 py-4 border-b border-neutral-200">
                    <h2 className="font-display font-bold text-lg">Completed Deliveries</h2>
                  </div>
                  {completedDeliveries.length === 0 ? (
                    <div className="p-8 text-center text-sm text-neutral-500">
                      No completed deliveries recorded on this account yet.
                    </div>
                  ) : (
                    <>
                      {/* Mobile Completed Cards */}
                      <div className="md:hidden divide-y divide-neutral-200">
                        {completedDeliveries.map((d) => {
                          const payout = calculateRiderPayoutNgn(
                            d.deliveryFeeNgn,
                            settings?.riderCommissionPercent
                          );
                          return (
                            <div key={d.id} className="p-4 space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-xs font-bold">{d.trackingCode}</span>
                                <span className="inline-flex items-center gap-1 text-xs font-semibold">
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  <span>Delivered</span>
                                </span>
                              </div>
                              <p className="font-display font-bold text-sm">
                                {d.pickupState} → {d.destinationState}
                              </p>
                              <div className="flex items-center justify-between text-xs text-neutral-600">
                                <span>To {d.recipientName}</span>
                                <span className="font-mono font-bold text-black tabular-nums">
                                  +{formatNaira(payout)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Desktop History Table */}
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-neutral-50 border-b border-neutral-200 text-xs text-neutral-500">
                            <tr>
                              <th className="py-3 px-4 font-semibold">Tracking</th>
                              <th className="py-3 px-4 font-semibold">Route</th>
                              <th className="py-3 px-4 font-semibold">Recipient</th>
                              <th className="py-3 px-4 font-semibold">Status</th>
                              <th className="py-3 px-4 font-semibold text-right">Order Value</th>
                              <th className="py-3 px-4 font-semibold text-right">Your Payout</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-200">
                            {completedDeliveries.map((d) => {
                              const payout = calculateRiderPayoutNgn(
                                d.deliveryFeeNgn,
                                settings?.riderCommissionPercent
                              );
                              return (
                                <tr key={d.id}>
                                  <td className="py-3 px-4 font-mono text-xs">{d.trackingCode}</td>
                                  <td className="py-3 px-4">
                                    {d.pickupState} → {d.destinationState}
                                  </td>
                                  <td className="py-3 px-4">{d.recipientName}</td>
                                  <td className="py-3 px-4">
                                    <span className="inline-flex items-center gap-1.5">
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      <span>Delivered</span>
                                    </span>
                                  </td>
                                  <td className="py-3 px-4 text-right font-mono tabular-nums text-neutral-500">
                                    {formatNaira(d.deliveryFeeNgn)}
                                  </td>
                                  <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums">
                                    {formatNaira(payout)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
            {tab === 'notifications' && (
              <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
                <div className="px-6 py-5 border-b border-neutral-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bell className="w-4 h-4" />
                    <h2 className="font-display font-bold text-xl">Rider Dispatch Notifications</h2>
                  </div>
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={handleMarkNotificationsRead}
                      className="text-xs font-semibold underline cursor-pointer"
                    >
                      Mark all as read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <div className="p-10 text-center text-sm text-neutral-500">
                    No notifications yet. Stay online to receive new delivery request alerts.
                  </div>
                ) : (
                  <ul className="divide-y divide-neutral-200">
                    {notifications.map((n) => (
                      <li key={n.id} className={`px-6 py-4 ${n.isRead ? 'bg-white' : 'bg-neutral-50'}`}>
                        <div className="flex items-center justify-between gap-4">
                          <p className="font-display font-bold text-sm">{n.title}</p>
                          <span className="font-mono text-xs text-neutral-400 tabular-nums">
                            {new Date(n.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm text-neutral-600 mt-1">{n.message}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {tab === 'profile' && (
              <div className="bg-white border border-neutral-200 rounded-xl p-6 sm:p-8 max-w-2xl space-y-6">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-4">
                  <div>
                    <p className="text-xs font-mono uppercase tracking-wider text-neutral-500">
                      Issued Rider Credentials
                    </p>
                    <h2 className="font-display font-extrabold text-2xl mt-1 inline-flex items-center gap-2">
                      <span>{rider.fullName}</span>
                      {rider.verificationStatus === 'verified' && (
                        <BadgeCheck className="w-5 h-5 text-black" />
                      )}
                    </h2>
                  </div>
                  <span
                    className={`text-xs font-semibold px-3 py-1 rounded-lg capitalize ${
                      rider.verificationStatus === 'verified'
                        ? 'bg-black text-white'
                        : 'border border-neutral-300 text-black'
                    }`}
                  >
                    {rider.verificationStatus === 'verified'
                      ? 'Admin Verified ✓'
                      : `Verification ${rider.verificationStatus}`}
                  </span>
                </div>

                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div className="border border-neutral-200 rounded-lg p-3.5">
                    <dt className="text-xs text-neutral-500">Email Address</dt>
                    <dd className="font-medium mt-0.5">{rider.email}</dd>
                  </div>
                  <div className="border border-neutral-200 rounded-lg p-3.5">
                    <dt className="text-xs text-neutral-500">Phone Number</dt>
                    <dd className="font-mono mt-0.5">{rider.phone}</dd>
                  </div>
                  <div className="border border-neutral-200 rounded-lg p-3.5">
                    <dt className="text-xs text-neutral-500">Operating State</dt>
                    <dd className="font-medium mt-0.5">{rider.homeState}</dd>
                  </div>
                  <div className="border border-neutral-200 rounded-lg p-3.5">
                    <dt className="text-xs text-neutral-500">Vehicle & Plate Number</dt>
                    <dd className="font-medium mt-0.5">
                      {rider.vehicleType} · <span className="font-mono">{rider.plateNumber}</span>
                    </dd>
                  </div>
                  <div className="border border-neutral-200 rounded-lg p-3.5">
                    <dt className="text-xs text-neutral-500">Account Status</dt>
                    <dd className="font-semibold capitalize mt-0.5">{rider.accountStatus}</dd>
                  </div>
                  <div className="border border-neutral-200 rounded-lg p-3.5">
                    <dt className="text-xs text-neutral-500">Last Known Coordinates</dt>
                    <dd className="font-mono text-xs mt-1 tabular-nums">
                      {rider.currentLat.toFixed(5)}, {rider.currentLng.toFixed(5)}
                    </dd>
                  </div>
                </dl>

                <p className="text-xs text-neutral-500 border-t border-neutral-200 pt-4">
                  Rider accounts and verification ticks are managed by SAQO Operations Admin. Contact Operations if your vehicle details or operating state change.
                </p>
              </div>
            )}
          </>
        )}
      </main>

      {/* Native Mobile Bottom Navigation */}
      <nav
        aria-label="Rider mobile navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-neutral-200 grid grid-cols-4 pb-[env(safe-area-inset-bottom)]"
      >
        <button
          type="button"
          onClick={() => setTab('active')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'active' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <Truck className="w-4 h-4" />
          <span>Dispatch ({activeDeliveries.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('history')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'history' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>Earnings</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('notifications')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'notifications' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <Bell className="w-4 h-4" />
          <span>Alerts{unreadCount > 0 ? ` (${unreadCount})` : ''}</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('profile')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'profile' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <User className="w-4 h-4" />
          <span>Account</span>
        </button>
      </nav>
    </div>
  );
};
