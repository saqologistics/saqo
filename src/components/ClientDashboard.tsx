import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowUpDown,
  BadgeCheck,
  Bell,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  LogOut,
  MapPin,
  MessageCircle,
  MessageSquarePlus,
  Package,
  Phone,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useRealtime } from '../hooks/useRealtime';
import { NIGERIA_STATES } from '../shared/nigeria';
import { formatEta, formatNaira, isValidNigerianPhone } from '../shared/pricing';
import { formatDeliveryStatusLabel, getTrackingProgress } from '../shared/tracking';
import type {
  ComplaintRecord,
  DeliveryRequest,
  DeliveryStatusHistoryItem,
  NotificationItem,
  ParcelCategory,
  PriceQuote,
  Profile,
  TicketType,
} from '../shared/types';
import { AddressPickerField } from './AddressPickerField';
import type { QuickDraft } from './LandingPage';
import { LiveNigeriaMap } from './LiveNigeriaMap';
import { PWAInstallButton } from './PWAInstallButton';
import { SaqoLogo } from './SaqoLogo';
import { buildWhatsAppUrl } from './WhatsAppWidget';

interface DeliveryWithHistory extends DeliveryRequest {
  history?: DeliveryStatusHistoryItem[];
}

interface ClientDashboardProps {
  profile: Profile;
  whatsappNumber: string;
  initialDraft?: QuickDraft | null;
  onGoHome: () => void;
  onLogout: () => void;
}

const PARCEL_CATEGORIES: ParcelCategory[] = [
  'Documents',
  'Electronics',
  'Fashion & Apparel',
  'Food & Perishables',
  'Medical & Fragile',
  'General Cargo',
];

export const ClientDashboard: React.FC<ClientDashboardProps> = ({
  profile,
  whatsappNumber,
  initialDraft,
  onGoHome,
  onLogout,
}) => {
  const [tab, setTab] = useState<'active' | 'send' | 'history' | 'notifications' | 'tickets'>(
    initialDraft ? 'send' : 'active'
  );
  const [deliveries, setDeliveries] = useState<DeliveryWithHistory[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [tickets, setTickets] = useState<ComplaintRecord[]>([]);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Send parcel form
  const [pickupState, setPickupState] = useState(initialDraft?.pickupState || 'Katsina');
  const [pickupAddress, setPickupAddress] = useState(initialDraft?.pickupAddress || '');
  const [destinationState, setDestinationState] = useState(
    initialDraft?.destinationState || 'Katsina'
  );
  const [destinationAddress, setDestinationAddress] = useState(
    initialDraft?.destinationAddress || ''
  );
  const [liveToast, setLiveToast] = useState<NotificationItem | null>(null);
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [parcelCategory, setParcelCategory] = useState<ParcelCategory>('Documents');
  const [parcelDescription, setParcelDescription] = useState('');
  const [weightKg, setWeightKg] = useState('1.5');
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // OTP confirmation
  const [otpInput, setOtpInput] = useState('');
  const [otpFeedback, setOtpFeedback] = useState<string | null>(null);

  // Issue modal (quick link from delivery card)
  const [issueDeliveryId, setIssueDeliveryId] = useState<string | null>(null);
  const [issueTicketType, setIssueTicketType] = useState<TicketType>('complaint');
  const [issueSubject, setIssueSubject] = useState('');
  const [issueDetails, setIssueDetails] = useState('');
  const [issueSaved, setIssueSaved] = useState<string | null>(null);

  // Dedicated Tickets tab form
  const [ticketType, setTicketType] = useState<TicketType>('suggestion');
  const [ticketDeliveryId, setTicketDeliveryId] = useState<string>('');
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketDetails, setTicketDetails] = useState('');
  const [ticketSubmitting, setTicketSubmitting] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [confirmingOtp, setConfirmingOtp] = useState(false);
  const [justConfirmedId, setJustConfirmedId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [delRes, notifRes, ticketsRes] = await Promise.all([
        apiRequest<{ deliveries: DeliveryWithHistory[] }>('/api/client/deliveries'),
        apiRequest<{ notifications: NotificationItem[] }>('/api/notifications'),
        apiRequest<{ tickets: ComplaintRecord[] }>('/api/client/tickets'),
      ]);
      setDeliveries(delRes.deliveries);
      setNotifications(notifRes.notifications);
      setTickets(ticketsRes.tickets);
      if (!selectedDeliveryId && delRes.deliveries.length > 0) {
        const firstActive =
          delRes.deliveries.find((d) => !['delivered', 'cancelled'].includes(d.status)) ||
          delRes.deliveries[0];
        setSelectedDeliveryId(firstActive.id);
      }
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load deliveries.');
    } finally {
      setLoading(false);
    }
  }, [selectedDeliveryId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!liveToast) return;
    const t = window.setTimeout(() => setLiveToast(null), 9000);
    return () => window.clearTimeout(t);
  }, [liveToast]);

  useRealtime((evt) => {
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
      evt.type === 'delivery:created' ||
      evt.type === 'delivery:updated' ||
      evt.type === 'rider:location' ||
      evt.type === 'notification:created' ||
      evt.type === 'complaint:updated'
    ) {
      loadData();
    }
  });

  // Live quote calculation
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const q = await apiRequest<PriceQuote>('/api/quote', {
          method: 'POST',
          body: JSON.stringify({
            pickupState,
            pickupAddress: pickupAddress || pickupState,
            destinationState,
            destinationAddress: destinationAddress || destinationState,
            weightKg: Number(weightKg) || 1,
          }),
        });
        if (active) setQuote(q);
      } catch {
        // ignore transient quote error
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pickupState, pickupAddress, destinationState, destinationAddress, weightKg]);

  const handleCreateDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidNigerianPhone(recipientPhone)) {
      setError('Please enter a valid recipient phone number (at least 10 digits).');
      return;
    }
    setSubmitting(true);
    setError(null);
    setJustConfirmedId(null);
    try {
      const res = await apiRequest<{
        delivery: DeliveryWithHistory;
        history: DeliveryStatusHistoryItem[];
      }>('/api/deliveries', {
        method: 'POST',
        body: JSON.stringify({
          pickupState,
          pickupAddress,
          destinationState,
          destinationAddress,
          recipientName,
          recipientPhone,
          parcelCategory,
          parcelDescription,
          weightKg: Number(weightKg) || 1,
        }),
      });
      setSelectedDeliveryId(res.delivery.id);
      setPickupAddress('');
      setDestinationAddress('');
      setRecipientName('');
      setRecipientPhone('');
      setParcelDescription('');
      setTab('active');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Could not create parcel request.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryDispatch = async (deliveryId: string) => {
    setRetryingId(deliveryId);
    setError(null);
    try {
      await apiRequest(`/api/deliveries/${deliveryId}/retry-dispatch`, { method: 'POST' });
      await loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRetryingId(null);
    }
  };

  const handleCancelDelivery = async (deliveryId: string) => {
    setCancellingId(deliveryId);
    setError(null);
    try {
      await apiRequest(`/api/deliveries/${deliveryId}/cancel`, { method: 'POST' });
      setConfirmCancelId(null);
      if (justConfirmedId === deliveryId) setJustConfirmedId(null);
      await loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCancellingId(null);
    }
  };

  const handleConfirmOtp = async (delivery: DeliveryWithHistory) => {
    setOtpFeedback(null);
    setConfirmingOtp(true);
    try {
      await apiRequest(`/api/track/${encodeURIComponent(delivery.trackingCode)}/confirm-otp`, {
        method: 'POST',
        body: JSON.stringify({ otp: otpInput.trim() }),
      });
      setOtpInput('');
      setJustConfirmedId(delivery.id);
      setOtpFeedback('Parcel delivery confirmed via OTP.');
      await loadData();
    } catch (err: any) {
      setOtpFeedback(err.message || 'Invalid OTP.');
    } finally {
      setConfirmingOtp(false);
    }
  };

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleRepeatDeliveryRoute = (d: DeliveryWithHistory) => {
    setPickupState(d.pickupState);
    setPickupAddress(d.pickupAddress);
    setDestinationState(d.destinationState);
    setDestinationAddress(d.destinationAddress);
    setRecipientName(d.recipientName);
    setRecipientPhone(d.recipientPhone);
    setTab('send');
  };

  const handleMarkNotificationsRead = async () => {
    await apiRequest('/api/notifications/read', { method: 'POST' });
    await loadData();
  };

  const handleSubmitIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!issueDeliveryId) return;
    try {
      await apiRequest('/api/tickets', {
        method: 'POST',
        body: JSON.stringify({
          ticketType: issueTicketType,
          deliveryId: issueDeliveryId,
          subject: issueSubject,
          details: issueDetails,
        }),
      });
      setIssueSaved(
        issueTicketType === 'suggestion'
          ? 'Suggestion submitted to SAQO Operations.'
          : 'Complaint submitted to SAQO Operations.'
      );
      setIssueSubject('');
      setIssueDetails('');
      setIssueDeliveryId(null);
      await loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSubmitTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    setTicketSubmitting(true);
    setError(null);
    try {
      await apiRequest('/api/tickets', {
        method: 'POST',
        body: JSON.stringify({
          ticketType,
          deliveryId: ticketDeliveryId || null,
          subject: ticketSubject,
          details: ticketDetails,
        }),
      });
      setIssueSaved(
        ticketType === 'suggestion'
          ? 'Thank you — your suggestion has been logged with SAQO Operations.'
          : 'Your complaint ticket has been opened with SAQO Operations.'
      );
      setTicketSubject('');
      setTicketDetails('');
      setTicketDeliveryId('');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Could not submit ticket.');
    } finally {
      setTicketSubmitting(false);
    }
  };

  const activeDeliveries = deliveries.filter(
    (d) => !['delivered', 'cancelled'].includes(d.status)
  );
  const pastDeliveries = deliveries.filter((d) =>
    ['delivered', 'cancelled'].includes(d.status)
  );
  const activeTabList = deliveries.filter(
    (d) => !['delivered', 'cancelled'].includes(d.status) || d.id === justConfirmedId
  );
  const filteredPastDeliveries = pastDeliveries.filter((d) => {
    if (!historySearch.trim()) return true;
    const q = historySearch.toLowerCase();
    return (
      d.trackingCode.toLowerCase().includes(q) ||
      d.pickupState.toLowerCase().includes(q) ||
      d.destinationState.toLowerCase().includes(q) ||
      d.recipientName.toLowerCase().includes(q)
    );
  });
  const selectedDelivery =
    activeTabList.find((d) => d.id === selectedDeliveryId) || activeTabList[0] || null;
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <div className="min-h-screen bg-neutral-50 text-black flex flex-col">
      {/* Top Bar */}
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
            Active Tracking
          </button>
          <button
            type="button"
            onClick={() => setTab('send')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              tab === 'send' ? 'text-white underline underline-offset-8' : 'text-neutral-400 hover:text-white'
            }`}
          >
            Send a Parcel
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              tab === 'history' ? 'text-white underline underline-offset-8' : 'text-neutral-400 hover:text-white'
            }`}
          >
            History
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
            onClick={() => setTab('tickets')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              tab === 'tickets'
                ? 'text-white underline underline-offset-8'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            Tickets{tickets.length > 0 ? ` (${tickets.length})` : ''}
          </button>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <PWAInstallButton inverted compact />
          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={refreshing}
            aria-label="Refresh deliveries"
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

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pt-5 sm:pt-8 pb-28 md:pb-16">
        {liveToast && (
          <div
            role="status"
            aria-live="polite"
            className="mb-6 bg-black text-white rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 border border-black"
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
                  setTab('notifications');
                  setLiveToast(null);
                }}
                className="text-xs font-semibold underline cursor-pointer"
              >
                View All
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
          <div role="alert" className="mb-6 bg-white border border-black rounded-xl p-4 text-sm font-medium flex items-center justify-between">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-xs underline cursor-pointer">
              Dismiss
            </button>
          </div>
        )}
        {issueSaved && (
          <div className="mb-6 bg-black text-white rounded-xl p-4 text-sm font-medium flex items-center justify-between">
            <span>{issueSaved}</span>
            <button type="button" onClick={() => setIssueSaved(null)} className="text-xs underline cursor-pointer">
              Close
            </button>
          </div>
        )}

        {/* SEND A PARCEL TAB */}
        {tab === 'send' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            <form
              id="client-send-parcel-form"
              onSubmit={handleCreateDelivery}
              className="lg:col-span-7 bg-white border border-neutral-200 rounded-xl p-5 sm:p-8 space-y-6"
            >
              <div>
                <h1 className="font-display font-extrabold text-2xl">Request a Parcel Pickup</h1>
                <p className="text-sm text-neutral-600 mt-1">
                  Tap any address field to search landmarks or detect GPS location.
                </p>
                <p className="text-xs font-mono text-neutral-500 mt-2">
                  Sender: {profile.fullName} · {profile.phone}
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-neutral-500">01. Route: From &amp; To</p>
                  {deliveries.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const last = deliveries[0];
                        setPickupState(last.pickupState);
                        setPickupAddress(last.pickupAddress);
                        setDestinationState(last.destinationState);
                        setDestinationAddress(last.destinationAddress);
                        setRecipientName(last.recipientName);
                        setRecipientPhone(last.recipientPhone);
                      }}
                      className="text-[11px] font-semibold underline text-neutral-600 hover:text-black cursor-pointer"
                    >
                      Repeat last route ({deliveries[0].pickupState} → {deliveries[0].destinationState})
                    </button>
                  )}
                </div>

                {/* FROM — PICKUP LOCATION */}
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-black">
                      <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-black shrink-0" />
                      <span>From · Pickup Location</span>
                    </span>
                    <span className="text-[11px] text-neutral-500">Where rider collects parcel</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label htmlFor="send-pickup-state" className="block text-xs font-semibold mb-1">
                        Pickup State
                      </label>
                      <select
                        id="send-pickup-state"
                        value={pickupState}
                        onChange={(e) => setPickupState(e.target.value)}
                        className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                      >
                        {NIGERIA_STATES.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="send-pickup-addr" className="block text-xs font-semibold mb-1">
                        Pickup Street / Landmark
                      </label>
                      <AddressPickerField
                        id="send-pickup-addr"
                        label="Pickup Address"
                        stateName={pickupState}
                        value={pickupAddress}
                        required
                        surfaceClassName="bg-white border border-neutral-300"
                        placeholder="e.g. Kofar Kaura"
                        onChange={setPickupAddress}
                        onStateDetected={(st) => setPickupState(st)}
                      />
                    </div>
                  </div>
                </div>

                {/* Swap From & To */}
                <div className="flex items-center justify-center -my-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPickupState(destinationState);
                      setDestinationState(pickupState);
                      setPickupAddress(destinationAddress);
                      setDestinationAddress(pickupAddress);
                    }}
                    className="inline-flex items-center gap-1.5 border border-neutral-300 bg-white hover:border-black px-3.5 py-1.5 rounded-full text-xs font-semibold text-neutral-700 hover:text-black cursor-pointer transition-colors"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5" />
                    <span>Swap From &amp; To</span>
                  </button>
                </div>

                {/* TO — DELIVERY DESTINATION */}
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-black">
                      <span aria-hidden="true" className="w-2.5 h-2.5 border-2 border-black bg-white shrink-0" />
                      <span>To · Delivery Destination</span>
                    </span>
                    <span className="text-[11px] text-neutral-500">Where parcel will be delivered</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label htmlFor="send-dest-state" className="block text-xs font-semibold mb-1">
                        Destination State
                      </label>
                      <select
                        id="send-dest-state"
                        value={destinationState}
                        onChange={(e) => setDestinationState(e.target.value)}
                        className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                      >
                        {NIGERIA_STATES.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="send-dest-addr" className="block text-xs font-semibold mb-1">
                        Destination Street / Landmark
                      </label>
                      <AddressPickerField
                        id="send-dest-addr"
                        label="Destination Address"
                        stateName={destinationState}
                        value={destinationAddress}
                        required
                        surfaceClassName="bg-white border border-neutral-300"
                        placeholder="e.g. Batagarawa"
                        onChange={setDestinationAddress}
                        onStateDetected={(st) => setDestinationState(st)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-4 border-t border-neutral-200 pt-5">
                <p className="text-xs font-semibold text-neutral-500">02. Recipient Information</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="send-rec-name" className="block text-xs font-semibold mb-1">
                      Recipient Full Name
                    </label>
                    <input
                      id="send-rec-name"
                      type="text"
                      required
                      value={recipientName}
                      onChange={(e) => setRecipientName(e.target.value)}
                      placeholder="e.g. Ngozi Adewale"
                      className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>
                  <div>
                    <label htmlFor="send-rec-phone" className="block text-xs font-semibold mb-1">
                      Recipient Phone Number
                    </label>
                    <input
                      id="send-rec-phone"
                      type="tel"
                      inputMode="tel"
                      required
                      value={recipientPhone}
                      onChange={(e) => setRecipientPhone(e.target.value)}
                      placeholder="+234 806 000 0000"
                      className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-4 border-t border-neutral-200 pt-5">
                <p className="text-xs font-semibold text-neutral-500">03. Parcel Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="sm:col-span-2">
                    <label htmlFor="send-category" className="block text-xs font-semibold mb-1">
                      Parcel Category
                    </label>
                    <select
                      id="send-category"
                      value={parcelCategory}
                      onChange={(e) => setParcelCategory(e.target.value as ParcelCategory)}
                      className="w-full border border-neutral-300 rounded-lg px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      {PARCEL_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="send-weight" className="block text-xs font-semibold mb-1">
                      Weight (kg)
                    </label>
                    <input
                      id="send-weight"
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="100"
                      value={weightKg}
                      onChange={(e) => setWeightKg(e.target.value)}
                      className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="send-desc" className="block text-xs font-semibold mb-1">
                    Parcel Description
                  </label>
                  <input
                    id="send-desc"
                    type="text"
                    required
                    value={parcelDescription}
                    onChange={(e) => setParcelDescription(e.target.value)}
                    placeholder="e.g. Sealed legal folder or electronics box"
                    className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="hidden lg:block w-full bg-black text-white py-3.5 rounded-lg text-sm font-bold hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                {submitting ? 'Dispatching Rider...' : 'Confirm & Request Rider'}
              </button>

              {/* Sticky Native Mobile Fare & Dispatch Bar */}
              <div className="lg:hidden sticky bottom-[4.5rem] z-20 bg-black text-white rounded-xl p-3.5 flex items-center justify-between gap-3 shadow-xl border border-white/15">
                <div className="min-w-0">
                  <p className="text-[11px] text-neutral-400 truncate">
                    {pickupState} → {destinationState}
                  </p>
                  <p className="font-display font-extrabold text-lg leading-tight tabular-nums">
                    {quote ? formatNaira(quote.deliveryFeeNgn) : '₦600'}
                    <span className="text-xs font-normal text-neutral-300 ml-2">
                      {quote ? formatEta(quote.estimatedMinutes) : '16 min'}
                    </span>
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="bg-white text-black px-4 py-2.5 rounded-lg text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {submitting ? 'Dispatching...' : 'Request Rider'}
                </button>
              </div>
            </form>

            {/* Quote Summary Panel */}
            <aside className="lg:col-span-5 bg-black text-white rounded-xl p-6 sm:p-8 space-y-6">
              <div>
                <p className="text-xs text-neutral-400 font-medium">Estimated Dispatch Summary</p>
                <h2 className="font-display font-bold text-2xl mt-1">
                  {pickupState} → {destinationState}
                </h2>
              </div>

              {quote ? (
                <div className="space-y-4 border-t border-white/15 pt-5">
                  <div className="flex justify-between text-sm">
                    <span className="text-neutral-400">Service Tier</span>
                    <span className="font-semibold">{quote.targetLabel}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-neutral-400">Estimated Distance</span>
                    <span className="font-mono tabular-nums">{quote.distanceKm} km</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-neutral-400">Estimated Delivery Time</span>
                    <span className="font-mono tabular-nums">
                      {formatEta(quote.estimatedMinutes)}
                    </span>
                  </div>
                  <div className="border-t border-white/15 pt-4 flex items-baseline justify-between">
                    <span className="text-sm text-neutral-300">Delivery Fee</span>
                    <span className="font-display font-extrabold text-3xl tabular-nums">
                      {formatNaira(quote.deliveryFeeNgn)}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-neutral-400">Calculating route estimate...</p>
              )}

              <p className="text-xs text-neutral-400 leading-relaxed border-t border-white/15 pt-4">
                Local eligible deliveries target a 15-minute completion window. Inter-city and inter-state estimates reflect actual Nigerian highway corridor distance and rider routing.
              </p>
            </aside>
          </div>
        )}

        {/* ACTIVE TRACKING TAB */}
        {tab === 'active' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="font-display font-extrabold text-2xl">Active Parcel Deliveries</h1>
                <p className="text-sm text-neutral-600">
                  Real-time rider location, status updates, and delivery OTP confirmation.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTab('send')}
                className="inline-flex items-center gap-2 bg-black text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Send a Parcel</span>
              </button>
            </div>

            {loading ? (
              <div className="bg-white border border-neutral-200 rounded-xl p-10 text-sm text-neutral-500">
                Loading deliveries...
              </div>
            ) : activeTabList.length === 0 ? (
              <div className="bg-white border border-neutral-200 rounded-xl p-10 text-center space-y-3">
                <Package className="w-8 h-8 mx-auto text-neutral-400" />
                <p className="font-display font-bold text-lg">
                  {pastDeliveries.length === 0
                    ? 'No parcels requested yet'
                    : 'No active parcels right now'}
                </p>
                <p className="text-sm text-neutral-600">
                  {pastDeliveries.length === 0
                    ? 'Create your first parcel request to connect with an available SAQO rider.'
                    : 'All previous parcels are saved in your Delivery History.'}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setTab('send')}
                    className="bg-black text-white px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer"
                  >
                    Send a Parcel
                  </button>
                  {pastDeliveries.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setTab('history')}
                      className="border border-neutral-300 hover:border-black px-5 py-2.5 rounded-lg text-sm font-semibold cursor-pointer"
                    >
                      View History ({pastDeliveries.length})
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Left List */}
                <div className="lg:col-span-4 space-y-3">
                  {activeTabList.map((del) => {
                    const isSelected = selectedDelivery?.id === del.id;
                    return (
                      <button
                        key={del.id}
                        type="button"
                        onClick={() => setSelectedDeliveryId(del.id)}
                        className={`w-full text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-black text-white border-black'
                            : 'bg-white text-black border-neutral-200 hover:border-black'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-semibold">
                            {del.trackingCode}
                          </span>
                          <span
                            className={`text-xs font-medium capitalize ${
                              isSelected ? 'text-neutral-300' : 'text-neutral-500'
                            }`}
                          >
                            {del.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <p className="font-display font-bold text-sm mt-1.5">
                          {del.pickupState} → {del.destinationState}
                        </p>
                        <p
                          className={`text-xs mt-1 truncate ${
                            isSelected ? 'text-neutral-300' : 'text-neutral-600'
                          }`}
                        >
                          To {del.recipientName} · {formatNaira(del.deliveryFeeNgn)}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {/* Right Detail + Live Map */}
                {selectedDelivery && (
                  <div className="lg:col-span-8 space-y-6">
                    <LiveNigeriaMap
                      deliveries={[selectedDelivery]}
                      focusedDelivery={selectedDelivery}
                      riders={
                        selectedDelivery.assignedRiderId &&
                        selectedDelivery.assignedRiderLat &&
                        selectedDelivery.assignedRiderLng
                          ? [
                              {
                                id: 'sel-rider',
                                riderId: selectedDelivery.assignedRiderId,
                                email: '',
                                fullName: selectedDelivery.assignedRiderName || 'Rider',
                                phone: selectedDelivery.assignedRiderPhone || '',
                                role: 'rider',
                                accountStatus: 'active',
                                createdAt: '',
                                vehicleType:
                                  (selectedDelivery.assignedRiderVehicle as any) || 'Motorcycle',
                                plateNumber: '',
                                homeState: selectedDelivery.pickupState,
                                verificationStatus: selectedDelivery.assignedRiderVerified
                                  ? 'verified'
                                  : 'pending',
                                isOnline: true,
                                currentLat: selectedDelivery.assignedRiderLat,
                                currentLng: selectedDelivery.assignedRiderLng,
                                lastLocationAt: selectedDelivery.updatedAt,
                                activeParcelsCount: 1,
                                completedDeliveriesCount: 0,
                                totalEarningsNgn: 0,
                                rating: 5,
                              },
                            ]
                          : []
                      }
                      heightClass="h-[360px]"
                    />

                    <div className="bg-white border border-neutral-200 rounded-xl p-6 space-y-6">
                      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-4">
                        <div>
                          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-neutral-500">
                            <span className="font-bold text-black">{selectedDelivery.trackingCode}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const shareUrl = `${window.location.origin}/?track=${encodeURIComponent(
                                  selectedDelivery.trackingCode
                                )}`;
                                navigator.clipboard?.writeText(shareUrl).catch(() => {});
                                setCopiedCode(true);
                                window.setTimeout(() => setCopiedCode(false), 1800);
                              }}
                              className="inline-flex items-center gap-1 border border-neutral-300 hover:border-black rounded px-2 py-0.5 text-[11px] font-sans font-semibold text-black cursor-pointer"
                            >
                              {copiedCode ? (
                                <>
                                  <Check className="w-3 h-3" />
                                  <span>Link Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span>Copy Track Link</span>
                                </>
                              )}
                            </button>
                            <span>·</span>
                            <span>{selectedDelivery.serviceTier.replace('_', ' ')}</span>
                            <span>·</span>
                            <span className="tabular-nums">{selectedDelivery.distanceKm} km</span>
                          </div>
                          <h2 className="font-display font-extrabold text-xl mt-1.5">
                            {selectedDelivery.pickupState} → {selectedDelivery.destinationState}
                          </h2>
                          <p className="text-sm text-neutral-600 mt-1">
                            Current Status:{' '}
                            <span className="font-bold text-black">
                              {formatDeliveryStatusLabel(selectedDelivery.status)}
                            </span>
                          </p>
                        </div>

                        <div className="text-right">
                          <p className="font-mono font-bold text-xl tabular-nums">
                            {formatNaira(selectedDelivery.deliveryFeeNgn)}
                          </p>
                          <p className="text-xs text-neutral-500 tabular-nums">
                            Est. {formatEta(selectedDelivery.estimatedMinutes)}
                          </p>
                        </div>
                      </div>

                      {/* 5-Stage Milestone Stepper */}
                      {(() => {
                        const progress = getTrackingProgress(selectedDelivery.status);
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

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-3 text-sm">
                          <div className="flex items-start gap-2.5">
                            <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
                            <div>
                              <p className="text-xs text-neutral-500">Pickup Address</p>
                              <p className="font-medium">
                                {selectedDelivery.pickupAddress.toLowerCase().includes(selectedDelivery.pickupState.toLowerCase())
                                  ? selectedDelivery.pickupAddress
                                  : `${selectedDelivery.pickupAddress}, ${selectedDelivery.pickupState}`}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <Package className="w-4 h-4 mt-0.5 shrink-0" />
                            <div>
                              <p className="text-xs text-neutral-500">
                                Recipient ({selectedDelivery.recipientName} · {selectedDelivery.recipientPhone})
                              </p>
                              <p className="font-medium">
                                {selectedDelivery.destinationAddress.toLowerCase().includes(selectedDelivery.destinationState.toLowerCase())
                                  ? selectedDelivery.destinationAddress
                                  : `${selectedDelivery.destinationAddress}, ${selectedDelivery.destinationState}`}
                              </p>
                            </div>
                          </div>
                        </div>

                        <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-neutral-500 font-medium">Delivery OTP</span>
                            <span className="font-mono font-bold text-lg tracking-widest tabular-nums">
                              {selectedDelivery.deliveryOtp}
                            </span>
                          </div>
                          {selectedDelivery.assignedRiderName ? (
                            <div className="border-t border-neutral-200 pt-2.5 text-xs space-y-1.5">
                              <p className="text-neutral-500">Assigned Rider</p>
                              <p className="font-semibold text-sm inline-flex items-center gap-1.5 flex-wrap">
                                <span>{selectedDelivery.assignedRiderName}</span>
                                {selectedDelivery.assignedRiderVerified && (
                                  <span className="inline-flex items-center gap-0.5 bg-black text-white px-1.5 py-0.5 rounded text-[10px] font-semibold">
                                    <BadgeCheck className="w-3 h-3" />
                                    <span>Verified</span>
                                  </span>
                                )}
                                <span className="text-neutral-500 font-normal text-xs">
                                  · {selectedDelivery.assignedRiderVehicle}
                                </span>
                              </p>
                              {selectedDelivery.assignedRiderPhone && (
                                <div className="flex items-center justify-between gap-2 pt-0.5">
                                  <span className="font-mono text-neutral-600">
                                    {selectedDelivery.assignedRiderPhone}
                                  </span>
                                  <a
                                    href={`tel:${selectedDelivery.assignedRiderPhone}`}
                                    className="inline-flex items-center gap-1 border border-black px-2.5 py-1 rounded text-[11px] font-semibold text-black hover:bg-neutral-100"
                                  >
                                    <Phone className="w-3 h-3" />
                                    <span>Call Rider</span>
                                  </a>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-neutral-600 border-t border-neutral-200 pt-2.5">
                              {selectedDelivery.status === 'no_rider_available'
                                ? 'No eligible riders matched within radius.'
                                : 'Matching nearest verified rider...'}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Actions & OTP Confirmation */}
                      {!['delivered', 'cancelled'].includes(selectedDelivery.status) && (
                        <div className="border-t border-neutral-200 pt-5 flex flex-wrap items-center justify-between gap-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={4}
                              value={otpInput}
                              onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                              aria-label="Enter 4-digit delivery OTP"
                              placeholder="4-digit OTP"
                              className="w-36 border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-black"
                            />
                            <button
                              type="button"
                              disabled={confirmingOtp || otpInput.trim().length !== 4}
                              onClick={() => handleConfirmOtp(selectedDelivery)}
                              className="bg-black text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40 cursor-pointer"
                            >
                              {confirmingOtp ? 'Confirming...' : 'Confirm Receipt'}
                            </button>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            {selectedDelivery.status === 'no_rider_available' && (
                              <button
                                type="button"
                                disabled={retryingId === selectedDelivery.id}
                                onClick={() => handleRetryDispatch(selectedDelivery.id)}
                                className="inline-flex items-center gap-1.5 bg-black text-white px-3.5 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 cursor-pointer"
                              >
                                <RefreshCw
                                  className={`w-3.5 h-3.5 ${
                                    retryingId === selectedDelivery.id ? 'animate-spin' : ''
                                  }`}
                                />
                                <span>
                                  {retryingId === selectedDelivery.id
                                    ? 'Retrying...'
                                    : 'Retry Dispatch'}
                                </span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setIssueDeliveryId(selectedDelivery.id)}
                              className="inline-flex items-center gap-1.5 border border-neutral-300 px-3.5 py-2 rounded-lg text-xs font-semibold hover:border-black cursor-pointer"
                            >
                              <AlertCircle className="w-3.5 h-3.5" />
                              <span>Report Issue</span>
                            </button>
                            {confirmCancelId === selectedDelivery.id ? (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={cancellingId === selectedDelivery.id}
                                  onClick={() => handleCancelDelivery(selectedDelivery.id)}
                                  className="bg-black text-white px-3.5 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 cursor-pointer"
                                >
                                  {cancellingId === selectedDelivery.id
                                    ? 'Cancelling...'
                                    : 'Confirm Cancel'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmCancelId(null)}
                                  className="border border-neutral-300 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer"
                                >
                                  Keep
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmCancelId(selectedDelivery.id)}
                                className="border border-neutral-300 px-3.5 py-2 rounded-lg text-xs font-semibold hover:border-black cursor-pointer"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {otpFeedback && (
                        <p className="text-xs font-semibold text-black">{otpFeedback}</p>
                      )}

                      {/* Status History + WhatsApp Link */}
                      <div className="border-t border-neutral-200 pt-4 flex flex-col md:flex-row md:items-end justify-between gap-4">
                        <div className="space-y-2 flex-1">
                          <p className="text-xs font-semibold text-neutral-500">Status History</p>
                          <ul className="space-y-1.5">
                            {(selectedDelivery.history || []).map((h) => (
                              <li key={h.id} className="text-xs flex justify-between gap-4">
                                <span className="text-neutral-800">{h.note}</span>
                                <span className="font-mono text-neutral-400 shrink-0 tabular-nums">
                                  {new Date(h.createdAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <a
                          href={buildWhatsAppUrl(
                            whatsappNumber,
                            `Hello SAQO Support, I need assistance with my parcel ${selectedDelivery.trackingCode} (${selectedDelivery.pickupState} to ${selectedDelivery.destinationState}).`
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 border border-black px-4 py-2.5 rounded-lg text-xs font-semibold hover:bg-neutral-100 whitespace-nowrap shrink-0"
                        >
                          <MessageCircle className="w-4 h-4" />
                          <span>WhatsApp Support</span>
                        </a>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* HISTORY TAB */}
        {tab === 'history' && (
          <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
            <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="font-display font-bold text-xl">Delivery History</h1>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Completed and cancelled parcels ({filteredPastDeliveries.length})
                </p>
              </div>
              {pastDeliveries.length > 0 && (
                <div className="relative w-full sm:w-64">
                  <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Search code, state, recipient..."
                    aria-label="Search delivery history"
                    className="w-full border border-neutral-300 rounded-lg pl-9 pr-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              )}
            </div>
            {filteredPastDeliveries.length === 0 ? (
              <div className="p-10 text-center text-sm text-neutral-500">
                {pastDeliveries.length === 0
                  ? 'No completed or cancelled deliveries yet.'
                  : 'No history records match your search.'}
              </div>
            ) : (
              <>
                {/* Mobile History Cards */}
                <div className="md:hidden divide-y divide-neutral-200">
                  {filteredPastDeliveries.map((d) => (
                    <div key={d.id} className="p-4 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-bold">{d.trackingCode}</span>
                        <span className="inline-flex items-center gap-1 text-xs font-semibold capitalize border border-neutral-300 px-2 py-0.5 rounded">
                          {d.status === 'delivered' && <CheckCircle2 className="w-3 h-3" />}
                          <span>{d.status.replace(/_/g, ' ')}</span>
                        </span>
                      </div>
                      <p className="font-display font-bold text-sm">
                        {d.pickupState} → {d.destinationState}
                      </p>
                      <div className="flex items-center justify-between text-xs text-neutral-600">
                        <span>To {d.recipientName}</span>
                        <span className="font-mono font-bold text-black tabular-nums">
                          {formatNaira(d.deliveryFeeNgn)}
                        </span>
                      </div>
                      <div className="pt-1 flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleRepeatDeliveryRoute(d)}
                          className="border border-neutral-300 hover:border-black px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                        >
                          Repeat Route
                        </button>
                      </div>
                    </div>
                  ))}
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
                        <th className="py-3 px-4 font-semibold text-right">Fee</th>
                        <th className="py-3 px-4 font-semibold text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200">
                      {filteredPastDeliveries.map((d) => (
                        <tr key={d.id} className="hover:bg-neutral-50">
                          <td className="py-3 px-4 font-mono text-xs">{d.trackingCode}</td>
                          <td className="py-3 px-4">
                            {d.pickupState} → {d.destinationState}
                          </td>
                          <td className="py-3 px-4">{d.recipientName}</td>
                          <td className="py-3 px-4 capitalize">
                            <span className="inline-flex items-center gap-1">
                              {d.status === 'delivered' && <CheckCircle2 className="w-3.5 h-3.5" />}
                              <span>{d.status.replace(/_/g, ' ')}</span>
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            {formatNaira(d.deliveryFeeNgn)}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => handleRepeatDeliveryRoute(d)}
                              className="border border-neutral-300 hover:border-black px-3 py-1 rounded text-xs font-semibold cursor-pointer"
                            >
                              Repeat
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* NOTIFICATIONS TAB */}
        {tab === 'notifications' && (
          <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
            <div className="px-6 py-5 border-b border-neutral-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4" />
                <h1 className="font-display font-bold text-xl">Delivery Notifications</h1>
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
                No notifications yet.
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

        {/* TICKETS TAB (COMPLAINTS & SUGGESTIONS) */}
        {tab === 'tickets' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <form
              onSubmit={handleSubmitTicket}
              className="lg:col-span-5 bg-white border border-neutral-200 rounded-xl p-5 sm:p-6 space-y-5"
            >
              <div>
                <h1 className="font-display font-extrabold text-xl">Create a Ticket</h1>
                <p className="text-xs text-neutral-600 mt-1">
                  Share a product suggestion or report a delivery complaint directly to SAQO Operations.
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold text-neutral-500 mb-2">Ticket Type</p>
                <div className="grid grid-cols-2 gap-2 p-1 bg-neutral-100 rounded-lg">
                  {(['suggestion', 'complaint'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={ticketType === type}
                      onClick={() => setTicketType(type)}
                      className={`py-2 rounded-md text-xs font-semibold capitalize transition-colors cursor-pointer ${
                        ticketType === type ? 'bg-black text-white' : 'text-neutral-700 hover:text-black'
                      }`}
                    >
                      {type === 'suggestion' ? 'Suggestion' : 'Complaint'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="ticket-delivery" className="block text-xs font-semibold mb-1.5">
                  Related Parcel (Optional)
                </label>
                <select
                  id="ticket-delivery"
                  value={ticketDeliveryId}
                  onChange={(e) => setTicketDeliveryId(e.target.value)}
                  className="w-full border border-neutral-300 rounded-lg px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                >
                  <option value="">General Feedback / Platform Experience</option>
                  {deliveries.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.trackingCode} · {d.pickupState} → {d.destinationState}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="ticket-subject" className="block text-xs font-semibold mb-1.5">
                  Subject
                </label>
                <input
                  id="ticket-subject"
                  type="text"
                  required
                  value={ticketSubject}
                  onChange={(e) => setTicketSubject(e.target.value)}
                  placeholder={
                    ticketType === 'suggestion'
                      ? 'e.g. Add scheduled pickup window'
                      : 'e.g. Rider arrival delay or parcel condition'
                  }
                  className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <div>
                <label htmlFor="ticket-details" className="block text-xs font-semibold mb-1.5">
                  Details
                </label>
                <textarea
                  id="ticket-details"
                  required
                  rows={4}
                  value={ticketDetails}
                  onChange={(e) => setTicketDetails(e.target.value)}
                  placeholder={
                    ticketType === 'suggestion'
                      ? 'Tell us how we can make SAQO better for you...'
                      : 'Provide details so our operations team can investigate...'
                  }
                  className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <button
                type="submit"
                disabled={ticketSubmitting}
                className="w-full bg-black text-white py-3 rounded-lg text-sm font-bold hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                {ticketSubmitting
                  ? 'Submitting...'
                  : ticketType === 'suggestion'
                  ? 'Submit Suggestion'
                  : 'Submit Complaint'}
              </button>
            </form>

            <div className="lg:col-span-7 bg-white border border-neutral-200 rounded-xl overflow-hidden">
              <div className="px-5 sm:px-6 py-4 border-b border-neutral-200 flex items-center justify-between">
                <h2 className="font-display font-bold text-lg">
                  Your Tickets ({tickets.length})
                </h2>
              </div>
              {tickets.length === 0 ? (
                <div className="p-10 text-center space-y-2">
                  <MessageSquarePlus className="w-7 h-7 mx-auto text-neutral-400" />
                  <p className="font-display font-bold text-base">No tickets submitted yet</p>
                  <p className="text-xs text-neutral-500">
                    Use the form to submit a suggestion or open a complaint ticket.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-neutral-200">
                  {tickets.map((t) => (
                    <li key={t.id} className="p-5 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="border border-black px-2 py-0.5 rounded font-semibold uppercase tracking-wide text-[10px]">
                            {t.ticketType === 'suggestion' ? 'Suggestion' : 'Complaint'}
                          </span>
                          <span className="font-mono text-neutral-500">
                            {t.trackingCode || 'General'}
                          </span>
                        </div>
                        <span className="text-xs font-semibold capitalize border border-neutral-300 px-2 py-0.5 rounded">
                          {t.status}
                        </span>
                      </div>
                      <p className="font-display font-bold text-sm">{t.subject}</p>
                      <p className="text-sm text-neutral-600">{t.details}</p>
                      {t.resolutionNote && (
                        <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 text-xs">
                          <p className="font-semibold text-black">SAQO Response</p>
                          <p className="text-neutral-700 mt-0.5">{t.resolutionNote}</p>
                        </div>
                      )}
                      <p className="font-mono text-[11px] text-neutral-400">
                        {new Date(t.createdAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Issue Reporting Modal */}
        {issueDeliveryId && (
          <div
            role="dialog"
            aria-label="Submit ticket for delivery"
            className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          >
            <form
              onSubmit={handleSubmitIssue}
              className="bg-white border border-black rounded-t-2xl sm:rounded-xl max-w-md w-full p-6 space-y-4"
            >
              <h2 className="font-display font-bold text-lg">Submit Delivery Ticket</h2>
              <div className="grid grid-cols-2 gap-2 p-1 bg-neutral-100 rounded-lg">
                {(['complaint', 'suggestion'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setIssueTicketType(type)}
                    className={`py-1.5 rounded-md text-xs font-semibold capitalize cursor-pointer ${
                      issueTicketType === type ? 'bg-black text-white' : 'text-neutral-700'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
              <div>
                <label htmlFor="issue-subject" className="block text-xs font-semibold mb-1">
                  Subject
                </label>
                <input
                  id="issue-subject"
                  type="text"
                  required
                  value={issueSubject}
                  onChange={(e) => setIssueSubject(e.target.value)}
                  placeholder="e.g. Delayed pickup or address note"
                  className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm"
                />
              </div>
              <div>
                <label htmlFor="issue-details" className="block text-xs font-semibold mb-1">
                  Details
                </label>
                <textarea
                  id="issue-details"
                  required
                  rows={3}
                  value={issueDetails}
                  onChange={(e) => setIssueDetails(e.target.value)}
                  placeholder="Describe your issue or suggestion for SAQO operations..."
                  className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIssueDeliveryId(null)}
                  className="px-4 py-2 rounded-lg border border-neutral-300 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-black text-white text-xs font-semibold cursor-pointer"
                >
                  Submit Ticket
                </button>
              </div>
            </form>
          </div>
        )}
      </main>

      {/* Native Mobile Bottom Navigation */}
      <nav
        aria-label="Client mobile navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-neutral-200 grid grid-cols-5 pb-[env(safe-area-inset-bottom)]"
      >
        <button
          type="button"
          onClick={() => setTab('active')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'active' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <MapPin className="w-4 h-4" />
          <span>Active</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('send')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'send' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <Plus className="w-4 h-4" />
          <span>Send</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('history')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'history' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <Clock className="w-4 h-4" />
          <span>History</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('notifications')}
          className={`relative flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'notifications' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <Bell className="w-4 h-4" />
          <span>Alerts{unreadCount > 0 ? ` (${unreadCount})` : ''}</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('tickets')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-[11px] font-semibold ${
            tab === 'tickets' ? 'text-black' : 'text-neutral-600'
          }`}
        >
          <MessageSquarePlus className="w-4 h-4" />
          <span>Tickets</span>
        </button>
      </nav>
    </div>
  );
};
