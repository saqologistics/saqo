import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  CreditCard,
  LayoutGrid,
  LogOut,
  MapPin,
  Menu,
  MessageCircle,
  MessageSquarePlus,
  Package,
  Phone,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Star,
  User,
  Volume2,
  VolumeX,
  Wallet,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import {
  getNotificationPermissionState,
  isSoundMuted,
  playNotificationSound,
  requestPushNotificationPermission,
  setSoundMuted,
  showPushNotification,
} from '../lib/alerts';
import type { SaqoReceiptData } from '../lib/receipt';
import { useRealtime } from '../hooks/useRealtime';
import { resolveAddressCoordinates } from '../shared/nigeria';
import {
  formatEta,
  formatNaira,
  formatPaymentMethodLabel,
  formatPaymentStatusLabel,
  isValidNigerianPhone,
} from '../shared/pricing';
import { formatDeliveryStatusLabel, getTrackingProgress } from '../shared/tracking';
import type {
  ComplaintRecord,
  DeliveryRequest,
  DeliveryStatusHistoryItem,
  NotificationItem,
  ParcelCategory,
  PaymentGatewayPublicConfig,
  PaymentMethodCode,
  PaymentTransaction,
  PriceQuote,
  Profile,
  TicketType,
  WalletAccount,
  WalletTransaction,
} from '../shared/types';
import type { QuickDraft } from './LandingPage';
import { LiveNigeriaMap } from './LiveNigeriaMap';
import { MobileNavDrawer } from './MobileNavDrawer';
import { OtpAlertModal } from './OtpAlertModal';
import { PWAInstallButton } from './PWAInstallButton';
import { ReceiptModal } from './ReceiptModal';
import { RouteLocationCard } from './RouteLocationCard';
import { SaqoLogo } from './SaqoLogo';
import { buildWhatsAppUrl } from './WhatsAppWidget';

interface DeliveryWithHistory extends DeliveryRequest {
  history?: DeliveryStatusHistoryItem[];
}

interface ClientDashboardProps {
  profile: Profile;
  whatsappNumber: string;
  showDeliveryStateSelectors: boolean;
  initialDraft?: QuickDraft | null;
  onGoHome: () => void;
  onLogout: () => void;
  onProfileUpdated?: (profile: Profile) => void;
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
  showDeliveryStateSelectors,
  initialDraft,
  onGoHome,
  onLogout,
  onProfileUpdated,
}) => {
  const [tab, setTab] = useState<
    'active' | 'send' | 'wallet' | 'history' | 'notifications' | 'tickets' | 'profile' | 'more'
  >(initialDraft ? 'send' : 'active');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [deliveries, setDeliveries] = useState<DeliveryWithHistory[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [tickets, setTickets] = useState<ComplaintRecord[]>([]);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [otpAlert, setOtpAlert] = useState<{ message: string; trackingCode?: string } | null>(null);
  const [muted, setMuted] = useState<boolean>(() => isSoundMuted());
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    getNotificationPermissionState()
  );

  // Post-delivery Rating state
  const [ratingTargetDelivery, setRatingTargetDelivery] = useState<DeliveryWithHistory | null>(null);
  const [ratingStars, setRatingStars] = useState(5);
  const [ratingComment, setRatingComment] = useState('');
  const [submittingRating, setSubmittingRating] = useState(false);

  // Editable Profile state
  const [editFullName, setEditFullName] = useState(profile.fullName);
  const [editPhone, setEditPhone] = useState(profile.phone);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const seenStatusesRef = useRef<Map<string, string>>(new Map());
  const loadSeqRef = useRef(0);
  const realtimeTimerRef = useRef<number | null>(null);
  const lastStatusAlertAtRef = useRef<Map<string, number>>(new Map());

  // Wallet & Payment states
  const [wallet, setWallet] = useState<WalletAccount | null>(null);
  const [walletTransactions, setWalletTransactions] = useState<WalletTransaction[]>([]);
  const [paymentTransactions, setPaymentTransactions] = useState<PaymentTransaction[]>([]);
  const [paymentConfig, setPaymentConfig] = useState<PaymentGatewayPublicConfig | null>(null);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethodCode>('wallet');
  const [transferReference, setTransferReference] = useState('');
  const [transferProofNote, setTransferProofNote] = useState('');
  const [checkoutIdempotencyKey, setCheckoutIdempotencyKey] = useState(() => crypto.randomUUID());
  const [fundIdempotencyKey, setFundIdempotencyKey] = useState(() => crypto.randomUUID());
  const [walletFilter, setWalletFilter] = useState<'all' | 'credit' | 'debit' | 'pending' | 'failed'>('all');
  const handledFlwCallbackRef = useRef<string | null>(null);
  const [fundModalOpen, setFundModalOpen] = useState(false);
  const [fundAmount, setFundAmount] = useState('5000');
  const [fundingSubmitting, setFundingSubmitting] = useState(false);
  const [verifyingRef, setVerifyingRef] = useState<string | null>(null);
  const [paymentBanner, setPaymentBanner] = useState<string | null>(null);
  const [activeReceipt, setActiveReceipt] = useState<SaqoReceiptData | null>(null);
  const [payNowOpenFor, setPayNowOpenFor] = useState(false);
  const [payingDeliveryId, setPayingDeliveryId] = useState<string | null>(null);
  const [copiedBank, setCopiedBank] = useState(false);

  // Send parcel form
  const [pickupState, setPickupState] = useState(initialDraft?.pickupState || 'Katsina');
  const [pickupAddress, setPickupAddress] = useState(initialDraft?.pickupAddress || '');
  const [pickupCoords, setPickupCoords] = useState<{ lat: number; lng: number } | null>(
    initialDraft?.pickupCoords ||
      (initialDraft?.pickupAddress
        ? resolveAddressCoordinates(initialDraft.pickupState || 'Katsina', initialDraft.pickupAddress)
        : null)
  );
  const [destinationState, setDestinationState] = useState(
    initialDraft?.destinationState || 'Katsina'
  );
  const [destinationAddress, setDestinationAddress] = useState(
    initialDraft?.destinationAddress || ''
  );
  const [destinationCoords, setDestinationCoords] = useState<{ lat: number; lng: number } | null>(
    initialDraft?.destinationCoords ||
      (initialDraft?.destinationAddress
        ? resolveAddressCoordinates(
            initialDraft.destinationState || 'Katsina',
            initialDraft.destinationAddress
          )
        : null)
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

  const loadData = useCallback(async (checkExpiry = false) => {
    const seq = ++loadSeqRef.current;
    try {
      const delPath = checkExpiry ? '/api/client/deliveries?checkExpiry=1' : '/api/client/deliveries';
      const [delRes, notifRes, ticketsRes, walletRes, payCfgRes] = await Promise.all([
        apiRequest<{ deliveries: DeliveryWithHistory[] }>(delPath),
        apiRequest<{ notifications: NotificationItem[] }>('/api/notifications'),
        apiRequest<{ tickets: ComplaintRecord[] }>('/api/client/tickets'),
        apiRequest<{
          wallet: WalletAccount;
          walletTransactions: WalletTransaction[];
          paymentTransactions: PaymentTransaction[];
        }>('/api/wallet').catch(() => null),
        apiRequest<PaymentGatewayPublicConfig>('/api/payments/config').catch(() => null),
      ]);
      if (seq !== loadSeqRef.current) return;
      if (seenStatusesRef.current.size > 0) {
        const nowMs = Date.now();
        for (const d of delRes.deliveries) {
          const prev = seenStatusesRef.current.get(d.id);
          if (prev && prev !== d.status) {
            const lastAlert = lastStatusAlertAtRef.current.get(d.id) || 0;
            if (nowMs - lastAlert > 5000) {
              lastStatusAlertAtRef.current.set(d.id, nowMs);
              playNotificationSound('status');
              showPushNotification(
                `Parcel ${d.trackingCode}: ${formatDeliveryStatusLabel(d.status)}`,
                `${d.pickupState} → ${d.destinationState}`,
                `saqo-del-${d.id}`
              );
            }
          }
        }
      }
      seenStatusesRef.current = new Map(delRes.deliveries.map((d) => [d.id, d.status]));
      setDeliveries(delRes.deliveries);
      setNotifications(notifRes.notifications);
      setTickets(ticketsRes.tickets);
      if (walletRes) {
        setWallet(walletRes.wallet);
        setWalletTransactions(walletRes.walletTransactions);
        setPaymentTransactions(walletRes.paymentTransactions);
      }
      if (payCfgRes) {
        setPaymentConfig(payCfgRes);
      }
      if (delRes.deliveries.length > 0) {
        const firstActive =
          delRes.deliveries.find((d) => !['delivered', 'cancelled'].includes(d.status)) ||
          delRes.deliveries[0];
        setSelectedDeliveryId((prev) => prev || firstActive.id);
      }
      setError(null);
    } catch (err: any) {
      if (seq !== loadSeqRef.current) return;
      setError(err.message || 'Failed to load deliveries.');
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const scheduleRealtimeRefresh = useCallback((checkExpiry = true) => {
    if (realtimeTimerRef.current !== null) {
      window.clearTimeout(realtimeTimerRef.current);
    }
    realtimeTimerRef.current = window.setTimeout(() => {
      realtimeTimerRef.current = null;
      void loadData(checkExpiry);
    }, 180);
  }, [loadData]);

  useEffect(() => {
    return () => {
      if (realtimeTimerRef.current !== null) {
        window.clearTimeout(realtimeTimerRef.current);
      }
    };
  }, []);

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
    loadData();
  }, [loadData]);

  const isMethodEnabled = useCallback(
    (code: PaymentMethodCode): boolean => {
      if (code === 'flutterwave' && paymentConfig && !paymentConfig.isEnabled) return false;
      const cfg = paymentConfig?.methods?.find((m) => m.code === code);
      return cfg ? cfg.isEnabled : true;
    },
    [paymentConfig]
  );

  useEffect(() => {
    if (!paymentConfig) return;
    if (!isMethodEnabled(selectedPaymentMethod)) {
      const fallback = (['wallet', 'flutterwave', 'cash', 'bank_transfer'] as PaymentMethodCode[]).find(
        isMethodEnabled
      );
      if (fallback) setSelectedPaymentMethod(fallback);
    }
  }, [paymentConfig, selectedPaymentMethod, isMethodEnabled]);

  useEffect(() => {
    if (fundModalOpen) {
      setFundIdempotencyKey(crypto.randomUUID());
    }
  }, [fundModalOpen]);

  // Verify Flutterwave redirect callback automatically on return
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hasCallback = params.get('flw_callback') === '1' || Boolean(params.get('tx_ref'));
    const txRef = params.get('tx_ref');
    const transactionId = params.get('transaction_id');
    const flwStatus = params.get('status');
    if (!hasCallback || (!txRef && !transactionId)) return;

    const callbackSig = `${txRef || ''}:${transactionId || ''}:${flwStatus || ''}`;
    if (handledFlwCallbackRef.current === callbackSig) return;
    handledFlwCallbackRef.current = callbackSig;

    if (flwStatus === 'cancelled' && !transactionId) {
      window.history.replaceState({}, '', '/');
      setTab('wallet');
      setPaymentBanner('Flutterwave checkout was cancelled before completion.');
      return;
    }

    setTab('wallet');
    setVerifyingRef(txRef || transactionId || 'callback');
    apiRequest<{ paymentTransaction: PaymentTransaction }>('/api/wallet/verify', {
      method: 'POST',
      body: JSON.stringify({ txRef, transactionId }),
    })
      .then((res) => {
        window.history.replaceState({}, '', '/');
        const st = res.paymentTransaction.status;
        if (st === 'paid') {
          setPaymentBanner(
            `Payment ${res.paymentTransaction.reference} verified (${formatNaira(res.paymentTransaction.amountNgn)}).`
          );
        } else {
          setPaymentBanner(
            `Payment ${res.paymentTransaction.reference} status: ${st.replace(/_/g, ' ')}.`
          );
        }
        return loadData();
      })
      .catch((err: any) => {
        setError(err?.message || 'Unable to verify Flutterwave transaction yet.');
      })
      .finally(() => {
        setVerifyingRef(null);
      });
  }, [loadData]);

  useEffect(() => {
    if (!liveToast) return;
    const t = window.setTimeout(() => setLiveToast(null), 9000);
    return () => window.clearTimeout(t);
  }, [liveToast]);

  useRealtime((evt) => {
    if (evt.type === 'notifications:refresh' || evt.type === 'connected') {
      scheduleRealtimeRefresh(true);
      return;
    }
    if (evt.type === 'notification:created') {
      const notif = evt.payload as NotificationItem;
      if (notif && notif.userId === profile.id) {
        setNotifications((prev) =>
          prev.some((n) => n.id === notif.id) ? prev : [notif, ...prev]
        );
        setLiveToast(notif);
        const nowMs = Date.now();
        const delKey = notif.deliveryId || '';
        const lastAlert = delKey ? lastStatusAlertAtRef.current.get(delKey) || 0 : 0;
        if (!delKey || nowMs - lastAlert > 5000) {
          if (delKey) lastStatusAlertAtRef.current.set(delKey, nowMs);
          playNotificationSound('status');
          showPushNotification(notif.title, notif.message, `saqo-notif-${notif.id}`);
        }
      }
    }
    if (
      evt.type === 'delivery:created' ||
      evt.type === 'delivery:updated' ||
      evt.type === 'rider:location' ||
      evt.type === 'notification:created' ||
      evt.type === 'complaint:updated' ||
      evt.type === 'wallet:updated' ||
      evt.type === 'payment:updated' ||
      evt.type === 'cash_collection:updated' ||
      evt.type === 'gateway:updated'
    ) {
      scheduleRealtimeRefresh(true);
    }
  });

  // Sync profile edit form & keep active parcels synced automatically
  useEffect(() => {
    setEditFullName(profile.fullName);
    setEditPhone(profile.phone);
  }, [profile.fullName, profile.phone]);

  useEffect(() => {
    const hasActive = deliveries.some((d) => !['delivered', 'cancelled'].includes(d.status));
    const onVis = () => {
      if (document.visibilityState === 'visible') void loadData(true);
    };
    document.addEventListener('visibilitychange', onVis);
    const interval = hasActive ? window.setInterval(() => void loadData(true), 8000) : null;
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [deliveries, loadData]);

  // Live quote calculation
  useEffect(() => {
    setQuote(null);
    if (!pickupCoords || !destinationCoords) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const q = await apiRequest<PriceQuote>('/api/quote', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            pickupState,
            pickupAddress: pickupAddress || pickupState,
            pickupLat: pickupCoords?.lat,
            pickupLng: pickupCoords?.lng,
            destinationState,
            destinationAddress: destinationAddress || destinationState,
            destinationLat: destinationCoords?.lat,
            destinationLng: destinationCoords?.lng,
            weightKg: Number(weightKg) || 1,
          }),
        });
        if (!controller.signal.aborted) setQuote(q);
      } catch {
        // ignore transient quote error
      }
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    pickupState,
    pickupAddress,
    pickupCoords,
    destinationState,
    destinationAddress,
    destinationCoords,
    weightKg,
  ]);

  const handleCreateDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pickupCoords || !destinationCoords) {
      setError('Select a pickup and a destination from the address suggestions.');
      return;
    }
    if (pickupCoords.lat === destinationCoords.lat && pickupCoords.lng === destinationCoords.lng) {
      setError('Choose different pickup and destination locations.');
      return;
    }
    if (!isValidNigerianPhone(recipientPhone)) {
      setError('Please enter a valid recipient phone number (at least 10 digits).');
      return;
    }
    if (selectedPaymentMethod === 'bank_transfer' && !transferReference.trim()) {
      setError('Please enter your bank transfer reference or session ID before submitting.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setJustConfirmedId(null);
    try {
      const res = await apiRequest<{
        delivery: DeliveryWithHistory;
        history: DeliveryStatusHistoryItem[];
        checkoutUrl?: string | null;
      }>('/api/deliveries', {
        method: 'POST',
        body: JSON.stringify({
          pickupState,
          pickupAddress,
          pickupLat: pickupCoords.lat,
          pickupLng: pickupCoords.lng,
          destinationState,
          destinationAddress,
          destinationLat: destinationCoords.lat,
          destinationLng: destinationCoords.lng,
          recipientName,
          recipientPhone,
          parcelCategory,
          parcelDescription,
          weightKg: Number(weightKg) || 1,
          paymentMethod: selectedPaymentMethod,
          idempotencyKey: checkoutIdempotencyKey,
          transferReference: selectedPaymentMethod === 'bank_transfer' ? transferReference.trim() : undefined,
          transferProofNote: selectedPaymentMethod === 'bank_transfer' ? transferProofNote.trim() : undefined,
        }),
      });
      setCheckoutIdempotencyKey(crypto.randomUUID());
      setSelectedDeliveryId(res.delivery.id);
      setPickupAddress('');
      setPickupCoords(null);
      setDestinationAddress('');
      setDestinationCoords(null);
      setRecipientName('');
      setRecipientPhone('');
      setParcelDescription('');
      setTransferReference('');
      setTransferProofNote('');
      if (selectedPaymentMethod === 'flutterwave' && res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      setTab('active');
      await loadData();
    } catch (err: any) {
      if (err?.code === 'INSUFFICIENT_WALLET_BALANCE') {
        setFundAmount(String(Math.max(1000, Math.ceil((quote?.deliveryFeeNgn || 1000) - (wallet?.balanceNgn || 0)))));
      }
      setError(err.message || 'Could not create parcel request.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFundWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    const numericAmount = Number(fundAmount);
    if (!Number.isFinite(numericAmount) || numericAmount < 100) {
      setError('Minimum wallet funding amount is ₦100.');
      return;
    }
    setFundingSubmitting(true);
    setError(null);
    try {
      const res = await apiRequest<{ checkoutUrl?: string; paymentTransaction: PaymentTransaction }>(
        '/api/wallet/fund/initialize',
        {
          method: 'POST',
          body: JSON.stringify({
            amountNgn: numericAmount,
            idempotencyKey: `fund:${profile.id}:${numericAmount}:${fundIdempotencyKey}`,
          }),
        }
      );
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      setFundIdempotencyKey(crypto.randomUUID());
      setFundModalOpen(false);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to initialize Flutterwave wallet funding.');
    } finally {
      setFundingSubmitting(false);
    }
  };

  const handleVerifyPayment = async (tx: PaymentTransaction) => {
    setVerifyingRef(tx.reference);
    setError(null);
    try {
      const res = await apiRequest<{ paymentTransaction: PaymentTransaction }>('/api/wallet/verify', {
        method: 'POST',
        body: JSON.stringify({ txRef: tx.reference, transactionId: tx.providerTxId }),
      });
      setPaymentBanner(
        `Transaction ${res.paymentTransaction.reference} status: ${res.paymentTransaction.status.replace(/_/g, ' ')}.`
      );
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Could not verify transaction with Flutterwave.');
    } finally {
      setVerifyingRef(null);
    }
  };

  const handlePayExistingDelivery = async (
    deliveryId: string,
    method: 'wallet' | 'flutterwave'
  ) => {
    setPayingDeliveryId(deliveryId);
    setError(null);
    try {
      const res = await apiRequest<{ checkoutUrl?: string | null; delivery?: DeliveryRequest }>(
        `/api/deliveries/${deliveryId}/pay`,
        {
          method: 'POST',
          body: JSON.stringify({
            paymentMethod: method,
            idempotencyKey: `pay:${deliveryId}:${method}:${crypto.randomUUID()}`,
          }),
        }
      );
      if (method === 'flutterwave' && res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      setPaymentBanner('Delivery payment completed from your SAQO wallet.');
      setPayNowOpenFor(false);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Unable to process delivery payment.');
    } finally {
      setPayingDeliveryId(null);
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
      playNotificationSound('status');
      await loadData();
    } catch (err: any) {
      const msg = err.message || 'Invalid OTP.';
      setOtpFeedback(msg);
      setOtpAlert({ message: msg, trackingCode: delivery.trackingCode });
      playNotificationSound('status');
    } finally {
      setConfirmingOtp(false);
    }
  };

  const handleSubmitRating = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ratingTargetDelivery) return;
    setSubmittingRating(true);
    setError(null);
    try {
      await apiRequest(`/api/deliveries/${ratingTargetDelivery.id}/rate`, {
        method: 'POST',
        body: JSON.stringify({
          rating: ratingStars,
          comment: ratingComment.trim() || undefined,
        }),
      });
      setRatingTargetDelivery(null);
      setRatingStars(5);
      setRatingComment('');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Could not submit rider rating.');
    } finally {
      setSubmittingRating(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setProfileNotice(null);
    setError(null);
    try {
      const res = await apiRequest<{ profile: Profile }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: editFullName.trim(),
          phone: editPhone.trim(),
        }),
      });
      onProfileUpdated?.(res.profile);
      setProfileNotice('Profile saved successfully.');
    } catch (err: any) {
      setError(err.message || 'Could not update profile.');
    } finally {
      setSavingProfile(false);
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setSoundMuted(next);
  };

  const handleEnablePush = async () => {
    const perm = await requestPushNotificationPermission();
    setNotifPerm(perm);
    if (perm === 'granted') playNotificationSound('status');
  };

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleRepeatDeliveryRoute = (d: DeliveryWithHistory) => {
    setPickupState(d.pickupState);
    setPickupAddress(d.pickupAddress);
    setPickupCoords(
      typeof d.pickupLat === 'number' && typeof d.pickupLng === 'number'
        ? { lat: d.pickupLat, lng: d.pickupLng }
        : resolveAddressCoordinates(d.pickupState, d.pickupAddress)
    );
    setDestinationState(d.destinationState);
    setDestinationAddress(d.destinationAddress);
    setDestinationCoords(
      typeof d.destinationLat === 'number' && typeof d.destinationLng === 'number'
        ? { lat: d.destinationLat, lng: d.destinationLng }
        : resolveAddressCoordinates(d.destinationState, d.destinationAddress)
    );
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
            Track
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
            onClick={() => setTab('wallet')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              tab === 'wallet' ? 'text-white underline underline-offset-8' : 'text-neutral-400 hover:text-white'
            }`}
          >
            Wallet
          </button>
          <button
            type="button"
            onClick={() => setTab('more')}
            className={`whitespace-nowrap shrink-0 cursor-pointer ${
              ['more', 'history', 'notifications', 'tickets', 'profile'].includes(tab)
                ? 'text-white underline underline-offset-8'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            More{unreadCount > 0 ? ` (${unreadCount})` : ''}
          </button>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setTab('wallet')}
            className="hidden sm:inline-flex items-center gap-1.5 border border-white/25 bg-white/10 text-white px-3 py-1.5 rounded-full text-xs font-mono font-bold tabular-nums hover:bg-white/20 transition-colors cursor-pointer"
            title="Open SAQO Wallet"
          >
            <Wallet className="w-3.5 h-3.5" />
            <span>{formatNaira(wallet?.balanceNgn ?? 0)}</span>
          </button>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute alert sounds' : 'Mute alert sounds'}
            title={muted ? 'Sound Muted' : 'Sound Alerts On'}
            className="hidden md:inline-flex items-center justify-center border border-white/25 text-white p-2 rounded-full hover:bg-white/10 transition-colors cursor-pointer"
          >
            {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
          <div className="hidden md:inline-flex">
            <PWAInstallButton inverted compact />
          </div>
          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={refreshing}
            aria-label="Refresh deliveries"
            className="hidden md:inline-flex items-center gap-1.5 border border-white/25 text-white px-2.5 py-2 rounded-full text-xs font-semibold hover:bg-white/10 transition-colors shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="hidden lg:inline">Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('profile')}
            className="inline-flex items-center gap-1.5 bg-white text-black px-3.5 py-1.5 rounded-full text-xs font-bold hover:bg-neutral-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            title="View & Edit Profile"
          >
            <span>{profile.fullName.split(' ')[0]}</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={mobileMenuOpen}
            className="md:hidden p-2 rounded-lg text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </header>

      <MobileNavDrawer
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        ariaLabel="Client portal navigation"
        headerAction={
          <button
            type="button"
            onClick={() => {
              setMobileMenuOpen(false);
              setTab('profile');
            }}
            className="inline-flex items-center gap-1.5 bg-black text-white px-3.5 py-1.5 rounded-full text-xs font-bold whitespace-nowrap cursor-pointer"
          >
            <span>{profile.fullName.split(' ')[0]}</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        }
        items={[
          {
            id: 'active',
            label: 'Track',
            active: tab === 'active',
            badge: activeDeliveries.length > 0 ? activeDeliveries.length : undefined,
            onSelect: () => setTab('active'),
          },
          {
            id: 'send',
            label: 'Send a Parcel',
            active: tab === 'send',
            onSelect: () => setTab('send'),
          },
          {
            id: 'wallet',
            label: 'Wallet',
            active: tab === 'wallet',
            badge: formatNaira(wallet?.balanceNgn ?? 0),
            onSelect: () => setTab('wallet'),
          },
          {
            id: 'history',
            label: 'History',
            active: tab === 'history',
            onSelect: () => setTab('history'),
          },
          {
            id: 'notifications',
            label: 'Notifications',
            active: tab === 'notifications',
            badge: unreadCount > 0 ? unreadCount : undefined,
            onSelect: () => setTab('notifications'),
          },
          {
            id: 'tickets',
            label: 'Support & Tickets',
            active: tab === 'tickets',
            onSelect: () => setTab('tickets'),
          },
          {
            id: 'profile',
            label: 'Profile',
            active: tab === 'profile',
            onSelect: () => setTab('profile'),
          },
        ]}
        footerContent={
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={toggleMute}
                className="inline-flex items-center gap-1.5 border border-neutral-300 bg-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
              >
                {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                <span>{muted ? 'Sound Muted' : 'Sound On'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  handleManualRefresh();
                  setMobileMenuOpen(false);
                }}
                className="inline-flex items-center gap-1.5 border border-neutral-300 bg-white px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
              <PWAInstallButton />
              {whatsappNumber && (
                <a
                  href={buildWhatsAppUrl(whatsappNumber, `Hello SAQO, client inquiry from ${profile.fullName}`)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 border border-neutral-300 bg-white px-3 py-1.5 rounded-lg text-xs font-bold"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>WhatsApp</span>
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                onLogout();
              }}
              className="w-full inline-flex items-center justify-center gap-2 bg-black text-white py-3 rounded-xl text-sm font-bold cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign out</span>
            </button>
          </div>
        }
      />

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
        {paymentBanner && (
          <div role="status" className="mb-6 bg-black text-white rounded-xl p-4 text-sm font-medium flex items-center justify-between">
            <span>{paymentBanner}</span>
            <button type="button" onClick={() => setPaymentBanner(null)} className="text-xs underline cursor-pointer">
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
                  {deliveries.length > 0 && (showDeliveryStateSelectors || (deliveries[0].pickupState === 'Katsina' && deliveries[0].destinationState === 'Katsina')) && (
                    <button
                      type="button"
                      onClick={() => {
                        const last = deliveries[0];
                        setPickupState(last.pickupState);
                        setPickupAddress(last.pickupAddress);
                        setPickupCoords({ lat: last.pickupLat, lng: last.pickupLng });
                        setDestinationState(last.destinationState);
                        setDestinationAddress(last.destinationAddress);
                        setDestinationCoords({ lat: last.destinationLat, lng: last.destinationLng });
                        setRecipientName(last.recipientName);
                        setRecipientPhone(last.recipientPhone);
                      }}
                      className="text-[11px] font-semibold underline text-neutral-600 hover:text-black cursor-pointer"
                    >
                      Repeat last route ({deliveries[0].pickupState} → {deliveries[0].destinationState})
                    </button>
                  )}
                </div>

                <RouteLocationCard
                  idPrefix="send"
                  showDeliveryStateSelectors={showDeliveryStateSelectors}
                  pickupState={pickupState}
                  pickupAddress={pickupAddress}
                  pickupCoords={pickupCoords}
                  destinationState={destinationState}
                  destinationAddress={destinationAddress}
                  destinationCoords={destinationCoords}
                  onPickupStateChange={setPickupState}
                  onPickupAddressChange={setPickupAddress}
                  onPickupCoordsChange={setPickupCoords}
                  onDestinationStateChange={setDestinationState}
                  onDestinationAddressChange={setDestinationAddress}
                  onDestinationCoordsChange={setDestinationCoords}
                  onSwap={() => {
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
                />
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

              {/* 04. Payment Method Selection */}
              <div className="space-y-4 border-t border-neutral-200 pt-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-neutral-500">04. Payment Method</p>
                  <span className="font-mono text-xs text-neutral-600 tabular-nums">
                    Wallet: {formatNaira(wallet?.balanceNgn ?? 0)}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  {/* A. Wallet */}
                  <button
                    type="button"
                    disabled={!isMethodEnabled('wallet')}
                    onClick={() => setSelectedPaymentMethod('wallet')}
                    className={`text-left rounded-xl border p-3.5 transition-all cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                      selectedPaymentMethod === 'wallet'
                        ? 'border-black bg-black text-white shadow-sm'
                        : 'border-neutral-200 bg-white text-black hover:border-neutral-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <Wallet className="w-4 h-4" />
                      <span className="font-mono text-[10px] uppercase tracking-wider opacity-80">
                        {!isMethodEnabled('wallet') ? 'Off' : 'Instant'}
                      </span>
                    </div>
                    <p className="font-display font-bold text-sm mt-2">SAQO Wallet</p>
                    <p className="font-mono text-[11px] mt-0.5 tabular-nums opacity-85">
                      Bal: {formatNaira(wallet?.balanceNgn ?? 0)}
                    </p>
                  </button>

                  {/* B. Flutterwave Direct */}
                  <button
                    type="button"
                    disabled={!isMethodEnabled('flutterwave')}
                    onClick={() => setSelectedPaymentMethod('flutterwave')}
                    className={`text-left rounded-xl border p-3.5 transition-all cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                      selectedPaymentMethod === 'flutterwave'
                        ? 'border-black bg-black text-white shadow-sm'
                        : 'border-neutral-200 bg-white text-black hover:border-neutral-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <CreditCard className="w-4 h-4" />
                      <span className="font-mono text-[10px] uppercase tracking-wider opacity-80">
                        {!isMethodEnabled('flutterwave') ? 'Off' : 'Card / USSD'}
                      </span>
                    </div>
                    <p className="font-display font-bold text-sm mt-2">Pay Online</p>
                    <p className="text-[11px] mt-0.5 opacity-80">Flutterwave Direct</p>
                  </button>

                  {/* C. Cash / Bank Transfer */}
                  <button
                    type="button"
                    disabled={!isMethodEnabled('cash') && !isMethodEnabled('bank_transfer')}
                    onClick={() =>
                      setSelectedPaymentMethod(
                        selectedPaymentMethod === 'bank_transfer' && isMethodEnabled('bank_transfer')
                          ? 'bank_transfer'
                          : isMethodEnabled('cash')
                            ? 'cash'
                            : 'bank_transfer'
                      )
                    }
                    className={`text-left rounded-xl border p-3.5 transition-all cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                      selectedPaymentMethod === 'cash' || selectedPaymentMethod === 'bank_transfer'
                        ? 'border-black bg-black text-white shadow-sm'
                        : 'border-neutral-200 bg-white text-black hover:border-neutral-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <Banknote className="w-4 h-4" />
                      <span className="font-mono text-[10px] uppercase tracking-wider opacity-80">
                        {!isMethodEnabled('cash') && !isMethodEnabled('bank_transfer') ? 'Off' : 'Manual'}
                      </span>
                    </div>
                    <p className="font-display font-bold text-sm mt-2">Cash / Transfer</p>
                    <p className="text-[11px] mt-0.5 opacity-80">Rider or Bank</p>
                  </button>
                </div>

                {/* Insufficient Wallet Balance Warning */}
                {selectedPaymentMethod === 'wallet' &&
                  quote &&
                  (wallet?.balanceNgn ?? 0) < quote.deliveryFeeNgn && (
                    <div className="rounded-xl border border-neutral-900 bg-neutral-100 p-3.5 flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs">
                        <p className="font-bold text-black">Insufficient wallet balance</p>
                        <p className="text-neutral-700 mt-0.5">
                          Fee is {formatNaira(quote.deliveryFeeNgn)}, available balance is{' '}
                          {formatNaira(wallet?.balanceNgn ?? 0)}. Fund your wallet or pick another method.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setFundAmount(
                            String(Math.max(1000, Math.ceil(quote.deliveryFeeNgn - (wallet?.balanceNgn ?? 0))))
                          );
                          setFundModalOpen(true);
                        }}
                        className="bg-black text-white px-3.5 py-2 rounded-lg text-xs font-semibold hover:bg-neutral-800 cursor-pointer shrink-0"
                      >
                        Fund Wallet
                      </button>
                    </div>
                  )}

                {/* Cash vs Bank Transfer sub-selector */}
                {(selectedPaymentMethod === 'cash' || selectedPaymentMethod === 'bank_transfer') && (
                  <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-2 p-1 bg-white border border-neutral-200 rounded-lg">
                      <button
                        type="button"
                        disabled={!isMethodEnabled('cash')}
                        onClick={() => setSelectedPaymentMethod('cash')}
                        className={`py-2 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                          selectedPaymentMethod === 'cash'
                            ? 'bg-black text-white'
                            : 'text-neutral-600 hover:text-black'
                        }`}
                      >
                        <Banknote className="w-3.5 h-3.5" />
                        <span>Cash to Rider</span>
                      </button>
                      <button
                        type="button"
                        disabled={!isMethodEnabled('bank_transfer')}
                        onClick={() => setSelectedPaymentMethod('bank_transfer')}
                        className={`py-2 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                          selectedPaymentMethod === 'bank_transfer'
                            ? 'bg-black text-white'
                            : 'text-neutral-600 hover:text-black'
                        }`}
                      >
                        <Building2 className="w-3.5 h-3.5" />
                        <span>Bank Transfer</span>
                      </button>
                    </div>

                    {selectedPaymentMethod === 'cash' ? (
                      <p className="text-xs text-neutral-600">
                        Pay cash directly to the assigned SAQO rider upon pickup or delivery. Rider confirmation will be recorded for admin reconciliation.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-neutral-300 bg-white p-3 space-y-1.5 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-neutral-500">Bank</span>
                            <span className="font-semibold text-black">
                              {paymentConfig?.bankDetails.bankName || 'Access Bank'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-neutral-500">Account Name</span>
                            <span className="font-semibold text-black">
                              {paymentConfig?.bankDetails.accountName || 'SAQO Logistics Ltd'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-neutral-500">Account Number</span>
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-black">
                                {paymentConfig?.bankDetails.accountNumber || '0000000000'}
                              </span>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard?.writeText(
                                      paymentConfig?.bankDetails.accountNumber || '0000000000'
                                    );
                                    setCopiedBank(true);
                                    setTimeout(() => setCopiedBank(false), 1800);
                                  } catch {
                                    // Ignore clipboard permission errors
                                  }
                                }}
                                className="inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-0.5 text-[10px] font-semibold hover:border-black cursor-pointer"
                              >
                                {copiedBank ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                <span>{copiedBank ? 'Copied' : 'Copy'}</span>
                              </button>
                            </div>
                          </div>
                          {paymentConfig?.bankDetails.instructions && (
                            <p className="text-[11px] text-neutral-500 pt-1 border-t border-neutral-100">
                              {paymentConfig.bankDetails.instructions}
                            </p>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label htmlFor="bank-ref" className="block text-xs font-semibold mb-1">
                              Transfer Reference / Session ID *
                            </label>
                            <input
                              id="bank-ref"
                              type="text"
                              required={selectedPaymentMethod === 'bank_transfer'}
                              value={transferReference}
                              onChange={(e) => setTransferReference(e.target.value)}
                              placeholder="e.g. TRF-99881234"
                              className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-xs font-mono"
                            />
                          </div>
                          <div>
                            <label htmlFor="bank-note" className="block text-xs font-semibold mb-1">
                              Sender Bank / Proof Note (optional)
                            </label>
                            <input
                              id="bank-note"
                              type="text"
                              value={transferProofNote}
                              onChange={(e) => setTransferProofNote(e.target.value)}
                              placeholder="e.g. Sent from GTBank"
                              className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-xs"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={
                  submitting ||
                  !pickupCoords ||
                  !destinationCoords ||
                  !isMethodEnabled(selectedPaymentMethod) ||
                  Boolean(
                    selectedPaymentMethod === 'wallet' &&
                      quote &&
                      (wallet?.balanceNgn ?? 0) < quote.deliveryFeeNgn
                  )
                }
                className="hidden lg:block w-full bg-black text-white py-3.5 rounded-lg text-sm font-bold hover:bg-neutral-800 disabled:opacity-45 transition-colors cursor-pointer"
              >
                {submitting
                  ? 'Processing Request...'
                  : selectedPaymentMethod === 'wallet'
                    ? 'Pay from Wallet & Dispatch Rider'
                    : selectedPaymentMethod === 'flutterwave'
                      ? 'Continue to Flutterwave Payment'
                      : 'Confirm & Request Rider'}
              </button>

              {/* Sticky Native Mobile Fare & Dispatch Bar */}
              <div className="lg:hidden sticky bottom-[4.5rem] z-20 bg-black text-white rounded-xl p-3.5 flex items-center justify-between gap-3 shadow-xl border border-white/15">
                <div className="min-w-0">
                  <p className="text-[11px] text-neutral-400 truncate">
                    {pickupState} → {destinationState}
                  </p>
                  <p className="font-display font-extrabold text-lg leading-tight tabular-nums">
                    {quote ? formatNaira(quote.deliveryFeeNgn) : 'Calculating...'}
                    <span className="text-xs font-normal text-neutral-300 ml-2">
                      {quote ? formatEta(quote.estimatedMinutes) : 'Estimating ETA'}
                    </span>
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={
                    submitting ||
                    !pickupCoords ||
                    !destinationCoords ||
                    !isMethodEnabled(selectedPaymentMethod) ||
                    Boolean(
                      selectedPaymentMethod === 'wallet' &&
                        quote &&
                        (wallet?.balanceNgn ?? 0) < quote.deliveryFeeNgn
                    )
                  }
                  className="bg-white text-black px-4 py-2.5 rounded-lg text-xs font-bold whitespace-nowrap shrink-0 disabled:opacity-45 cursor-pointer"
                >
                  {submitting
                    ? 'Dispatching...'
                    : selectedPaymentMethod === 'flutterwave'
                      ? 'Pay Online'
                      : 'Request Rider'}
                </button>
              </div>
            </form>

            {/* Quote Summary + Live Route Map Panel */}
            <aside className="lg:col-span-5 bg-black text-white rounded-xl p-6 sm:p-8 space-y-5">
              <div>
                <p className="text-xs text-neutral-400 font-medium">Estimated Dispatch Summary</p>
                <h2 className="font-display font-bold text-2xl mt-1">
                  {pickupState} → {destinationState}
                </h2>
              </div>

              <LiveNigeriaMap
                deliveries={[]}
                riders={[]}
                previewRoute={
                  pickupCoords || destinationCoords
                    ? {
                        pickupLat: pickupCoords?.lat,
                        pickupLng: pickupCoords?.lng,
                        pickupAddress: pickupAddress || `${pickupState} Hub`,
                        pickupState,
                        destinationLat: destinationCoords?.lat,
                        destinationLng: destinationCoords?.lng,
                        destinationAddress: destinationAddress || `${destinationState} Hub`,
                        destinationState,
                      }
                    : null
                }
                heightClass="h-[230px]"
              />

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
                  <div className="flex justify-between text-sm">
                    <span className="text-neutral-400">Payment Method</span>
                    <span className="font-mono uppercase text-xs font-semibold">
                      {selectedPaymentMethod.replace(/_/g, ' ')}
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
                          <div className="border-t border-neutral-200 pt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div>
                              <span className="text-neutral-500">Payment: </span>
                              <span className="font-semibold text-black">
                                {formatPaymentMethodLabel(selectedDelivery.paymentMethod)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                                  selectedDelivery.paymentStatus === 'paid' ||
                                  selectedDelivery.paymentStatus === 'collected_by_rider'
                                    ? 'bg-black text-white'
                                    : 'bg-neutral-200 text-neutral-800'
                                }`}
                              >
                                {formatPaymentStatusLabel(
                                  selectedDelivery.paymentMethod,
                                  selectedDelivery.paymentStatus
                                )}
                              </span>
                              {selectedDelivery.paymentReference && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setActiveReceipt({
                                      reference: selectedDelivery.paymentReference!,
                                      title: `Delivery ${selectedDelivery.trackingCode}`,
                                      receiptType: 'Delivery Payment',
                                      amountNgn: selectedDelivery.deliveryFeeNgn,
                                      status: selectedDelivery.paymentStatus || 'pending',
                                      paymentMethod: selectedDelivery.paymentMethod || 'cash',
                                      createdAt: selectedDelivery.createdAt,
                                      customerName: selectedDelivery.customerName,
                                      customerPhone: selectedDelivery.customerPhone,
                                      trackingCode: selectedDelivery.trackingCode,
                                      description: `${selectedDelivery.pickupState} → ${selectedDelivery.destinationState}`,
                                    })
                                  }
                                  className="inline-flex items-center gap-1 border border-neutral-300 bg-white hover:border-black px-2 py-0.5 rounded font-semibold cursor-pointer"
                                >
                                  <Receipt className="w-3 h-3" />
                                  <span>Receipt</span>
                                </button>
                              )}
                            </div>
                          </div>
                          {['unpaid', 'pending', 'failed', 'reversed'].includes(
                            selectedDelivery.paymentStatus || 'pending'
                          ) &&
                            selectedDelivery.status !== 'cancelled' && (
                              <div className="flex flex-wrap gap-2 pt-1">
                                {isMethodEnabled('wallet') && (
                                  <button
                                    type="button"
                                    disabled={
                                      payingDeliveryId === selectedDelivery.id ||
                                      (wallet?.balanceNgn ?? 0) < selectedDelivery.deliveryFeeNgn
                                    }
                                    onClick={() => handlePayExistingDelivery(selectedDelivery.id, 'wallet')}
                                    className="bg-black text-white px-3 py-1.5 rounded-lg text-[11px] font-semibold hover:bg-neutral-800 disabled:opacity-40 cursor-pointer"
                                  >
                                    Pay with Wallet
                                  </button>
                                )}
                                {isMethodEnabled('flutterwave') && (
                                  <button
                                    type="button"
                                    disabled={payingDeliveryId === selectedDelivery.id}
                                    onClick={() =>
                                      handlePayExistingDelivery(selectedDelivery.id, 'flutterwave')
                                    }
                                    className="border border-black bg-white text-black px-3 py-1.5 rounded-lg text-[11px] font-semibold hover:bg-neutral-100 disabled:opacity-40 cursor-pointer"
                                  >
                                    Pay via Flutterwave
                                  </button>
                                )}
                              </div>
                            )}
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

                      {selectedDelivery.status === 'delivered' && selectedDelivery.assignedRiderId && (
                        <div className="border-t border-neutral-200 pt-4">
                          {selectedDelivery.riderRating ? (
                            <div className="rounded-xl bg-neutral-100 border border-neutral-200 px-4 py-3 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2 text-xs font-semibold text-black">
                                <Star className="w-4 h-4 fill-black text-black" />
                                <span>
                                  You rated {selectedDelivery.assignedRiderName || 'your rider'}{' '}
                                  {selectedDelivery.riderRating}/5
                                </span>
                              </div>
                              {selectedDelivery.riderRatingComment && (
                                <span className="text-xs text-neutral-600 truncate max-w-xs">
                                  &ldquo;{selectedDelivery.riderRatingComment}&rdquo;
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="rounded-xl bg-black text-white px-5 py-4 flex flex-wrap items-center justify-between gap-4">
                              <div>
                                <p className="font-display font-bold text-sm">
                                  How was your delivery with {selectedDelivery.assignedRiderName || 'your rider'}?
                                </p>
                                <p className="text-xs text-neutral-300 mt-0.5">
                                  Rate this completed delivery to help keep SAQO dispatch top-rated.
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setRatingTargetDelivery(selectedDelivery);
                                  setRatingStars(5);
                                  setRatingComment('');
                                }}
                                className="inline-flex items-center gap-1.5 bg-white text-black px-4 py-2 rounded-xl text-xs font-bold hover:bg-neutral-200 cursor-pointer"
                              >
                                <Star className="w-3.5 h-3.5 fill-black" />
                                <span>Rate Rider</span>
                              </button>
                            </div>
                          )}
                        </div>
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

        {/* WALLET TAB */}
        {tab === 'wallet' && (
          <div className="space-y-6">
            {/* Hero Balance & Primary Actions */}
            <div className="bg-black text-white rounded-2xl p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-neutral-400">
                  SAQO Customer Wallet · NGN
                </p>
                <p className="font-display font-extrabold text-4xl sm:text-5xl tracking-tight tabular-nums mt-2">
                  {formatNaira(wallet?.balanceNgn ?? 0)}
                </p>
                <p className="text-xs text-neutral-400 mt-2">
                  Status: <span className="text-white font-semibold uppercase">{wallet?.status || 'active'}</span>
                  {verifyingRef && (
                    <span className="ml-3 font-mono text-white">· Verifying {verifyingRef}...</span>
                  )}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setFundModalOpen(true)}
                  className="inline-flex items-center gap-2 bg-white text-black px-5 py-3 rounded-xl text-sm font-bold hover:bg-neutral-200 transition-colors cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Add Money</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPayNowOpenFor((v) => !v)}
                  className="inline-flex items-center gap-2 border border-white/30 bg-white/10 text-white px-5 py-3 rounded-xl text-sm font-bold hover:bg-white/20 transition-colors cursor-pointer"
                >
                  <Package className="w-4 h-4" />
                  <span>Pay for Delivery</span>
                </button>
                <a
                  href="#wallet-transactions-list"
                  className="inline-flex items-center gap-2 border border-white/20 text-neutral-200 px-4 py-3 rounded-xl text-sm font-semibold hover:bg-white/10 transition-colors"
                >
                  <Clock className="w-4 h-4" />
                  <span>Transaction History</span>
                </a>
              </div>
            </div>

            {/* Unpaid / Pending Deliveries Quick Pay Panel */}
            {(payNowOpenFor ||
              deliveries.some(
                (d) =>
                  d.status !== 'cancelled' &&
                  ['unpaid', 'pending', 'failed', 'reversed'].includes(d.paymentStatus || 'pending')
              )) && (
              <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-neutral-200 flex items-center justify-between">
                  <div>
                    <h2 className="font-display font-bold text-base">Deliveries Awaiting Payment</h2>
                    <p className="text-xs text-neutral-500">
                      Settle unpaid or pending parcel deliveries directly from your wallet or via Flutterwave.
                    </p>
                  </div>
                </div>
                {(() => {
                  const unpaidList = deliveries.filter(
                    (d) =>
                      d.status !== 'cancelled' &&
                      ['unpaid', 'pending', 'failed', 'reversed'].includes(d.paymentStatus || 'pending')
                  );
                  if (unpaidList.length === 0) {
                    return (
                      <div className="p-6 text-xs text-neutral-500">
                        All your parcel deliveries are paid or settled.
                      </div>
                    );
                  }
                  return (
                    <div className="divide-y divide-neutral-200">
                      {unpaidList.map((d) => (
                        <div
                          key={d.id}
                          className="px-6 py-4 flex flex-wrap items-center justify-between gap-4"
                        >
                          <div>
                            <p className="font-mono font-bold text-sm">{d.trackingCode}</p>
                            <p className="text-xs text-neutral-600 mt-0.5">
                              {d.pickupState} → {d.destinationState} ·{' '}
                              <span className="font-medium">
                                {formatPaymentMethodLabel(d.paymentMethod)}
                              </span>{' '}
                              ·{' '}
                              <span className="font-semibold text-black">
                                {formatPaymentStatusLabel(d.paymentMethod, d.paymentStatus)}
                              </span>
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-bold text-sm tabular-nums mr-2">
                              {formatNaira(d.deliveryFeeNgn)}
                            </span>
                            {isMethodEnabled('wallet') && (
                              <button
                                type="button"
                                disabled={
                                  payingDeliveryId === d.id ||
                                  (wallet?.balanceNgn ?? 0) < d.deliveryFeeNgn
                                }
                                onClick={() => handlePayExistingDelivery(d.id, 'wallet')}
                                className="bg-black text-white px-3.5 py-2 rounded-lg text-xs font-semibold hover:bg-neutral-800 disabled:opacity-40 cursor-pointer"
                              >
                                {payingDeliveryId === d.id ? 'Processing...' : 'Pay from Wallet'}
                              </button>
                            )}
                            {isMethodEnabled('flutterwave') && (
                              <button
                                type="button"
                                disabled={payingDeliveryId === d.id}
                                onClick={() => handlePayExistingDelivery(d.id, 'flutterwave')}
                                className="border border-neutral-300 hover:border-black px-3.5 py-2 rounded-lg text-xs font-semibold cursor-pointer"
                              >
                                Pay Online
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Filterable Transaction & Ledger History */}
            <div
              id="wallet-transactions-list"
              className="bg-white border border-neutral-200 rounded-xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="font-display font-bold text-lg">Wallet & Payment History</h2>
                  <p className="text-xs text-neutral-500">
                    Immutable wallet credits, debits, refunds, and gateway checkout records.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(['all', 'credit', 'debit', 'pending', 'failed'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setWalletFilter(f)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize cursor-pointer ${
                        walletFilter === f
                          ? 'bg-black text-white'
                          : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-neutral-200">
                {/* Immutable Wallet Ledger */}
                <div className="p-5 sm:p-6 space-y-3">
                  <h3 className="font-mono text-xs uppercase tracking-wider text-neutral-500 font-bold">
                    Wallet Ledger Entries
                  </h3>
                  {(() => {
                    const filteredLedger = walletTransactions.filter((wt) => {
                      if (walletFilter === 'all') return true;
                      if (walletFilter === 'credit') return wt.type === 'credit' || wt.type === 'refund';
                      if (walletFilter === 'debit') return wt.type === 'debit';
                      if (walletFilter === 'pending') return wt.status === 'pending';
                      if (walletFilter === 'failed') return wt.status === 'failed';
                      return true;
                    });
                    if (filteredLedger.length === 0) {
                      return (
                        <p className="text-xs text-neutral-500 py-6 text-center">
                          No wallet ledger transactions match this filter.
                        </p>
                      );
                    }
                    return (
                      <div className="divide-y divide-neutral-200">
                        {filteredLedger.map((wt) => {
                          const isPositive =
                            wt.type === 'credit' ||
                            wt.type === 'refund' ||
                            (wt.type === 'adjustment' && wt.balanceAfterNgn >= wt.balanceBeforeNgn);
                          return (
                            <div
                              key={wt.id}
                              className="py-3.5 flex items-center justify-between gap-3"
                            >
                              <div className="flex items-start gap-3 min-w-0">
                                <div
                                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                                    isPositive
                                      ? 'bg-black text-white'
                                      : 'bg-neutral-100 text-black border border-neutral-300'
                                  }`}
                                >
                                  {isPositive ? (
                                    <ArrowDownLeft className="w-4 h-4" />
                                  ) : (
                                    <ArrowUpRight className="w-4 h-4" />
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-xs font-bold text-black truncate">
                                    {wt.description}
                                  </p>
                                  <p className="font-mono text-[11px] text-neutral-500 truncate">
                                    {wt.reference} · {new Date(wt.createdAt).toLocaleString()}
                                  </p>
                                  <p className="font-mono text-[10px] text-neutral-400 tabular-nums mt-0.5">
                                    {formatNaira(wt.balanceBeforeNgn)} → {formatNaira(wt.balanceAfterNgn)}
                                  </p>
                                </div>
                              </div>
                              <div className="text-right shrink-0 space-y-1">
                                <p className="font-mono font-bold text-sm tabular-nums">
                                  {isPositive ? '+' : '-'}
                                  {formatNaira(wt.amountNgn)}
                                </p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setActiveReceipt({
                                      reference: wt.reference,
                                      title: wt.category === 'funding' ? 'Wallet Funding Receipt' : 'Wallet Transaction',
                                      receiptType:
                                        wt.category === 'funding'
                                          ? 'Wallet Funding'
                                          : wt.category === 'refund'
                                            ? 'Refund Receipt'
                                            : 'Wallet Transaction',
                                      amountNgn: wt.amountNgn,
                                      status: wt.status,
                                      paymentMethod: 'wallet',
                                      createdAt: wt.createdAt,
                                      customerName: profile.fullName,
                                      customerEmail: profile.email,
                                      customerPhone: profile.phone,
                                      trackingCode: wt.trackingCode,
                                      balanceBeforeNgn: wt.balanceBeforeNgn,
                                      balanceAfterNgn: wt.balanceAfterNgn,
                                      description: wt.description,
                                    })
                                  }
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold border border-neutral-300 hover:border-black px-2 py-0.5 rounded cursor-pointer"
                                >
                                  <Receipt className="w-3 h-3" />
                                  <span>Receipt</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>

                {/* Gateway & Checkout Transactions */}
                <div className="p-5 sm:p-6 space-y-3">
                  <h3 className="font-mono text-xs uppercase tracking-wider text-neutral-500 font-bold">
                    Checkout & Funding Transactions
                  </h3>
                  {(() => {
                    const filteredPay = paymentTransactions.filter((pt) => {
                      if (walletFilter === 'all') return true;
                      if (walletFilter === 'credit') return pt.purpose === 'wallet_funding' && pt.status === 'paid';
                      if (walletFilter === 'debit') return pt.purpose === 'delivery_payment';
                      if (walletFilter === 'pending') {
                        return ['pending', 'pending_verification', 'collected_by_rider'].includes(pt.status);
                      }
                      if (walletFilter === 'failed') return pt.status === 'failed' || pt.status === 'reversed';
                      return true;
                    });
                    if (filteredPay.length === 0) {
                      return (
                        <p className="text-xs text-neutral-500 py-6 text-center">
                          No payment gateway transactions match this filter.
                        </p>
                      );
                    }
                    return (
                      <div className="divide-y divide-neutral-200">
                        {filteredPay.map((pt) => (
                          <div
                            key={pt.id}
                            className="py-3.5 flex items-center justify-between gap-3"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono font-bold text-xs text-black">
                                  {pt.reference}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                                    pt.status === 'paid' || pt.status === 'collected_by_rider'
                                      ? 'bg-black text-white'
                                      : pt.status === 'failed' || pt.status === 'reversed'
                                        ? 'border border-black text-black'
                                        : 'bg-neutral-200 text-neutral-800'
                                  }`}
                                >
                                  {formatPaymentStatusLabel(pt.paymentMethod, pt.status)}
                                </span>
                              </div>
                              <p className="text-xs text-neutral-600 mt-1">
                                {pt.purpose === 'wallet_funding' ? 'Wallet Funding' : `Delivery ${pt.trackingCode || ''}`}{' '}
                                · {formatPaymentMethodLabel(pt.paymentMethod)}
                              </p>
                              <p className="font-mono text-[10px] text-neutral-400">
                                {new Date(pt.createdAt).toLocaleString()}
                              </p>
                            </div>

                            <div className="text-right shrink-0 space-y-1.5">
                              <p className="font-mono font-bold text-sm tabular-nums">
                                {formatNaira(pt.amountNgn)}
                              </p>
                              <div className="flex items-center justify-end gap-1.5">
                                {pt.provider === 'flutterwave' && pt.status === 'pending' && (
                                  <button
                                    type="button"
                                    disabled={verifyingRef === pt.reference}
                                    onClick={() => handleVerifyPayment(pt)}
                                    className="bg-black text-white px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer"
                                  >
                                    {verifyingRef === pt.reference ? 'Checking...' : 'Verify'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    setActiveReceipt({
                                      reference: pt.reference,
                                      title:
                                        pt.purpose === 'wallet_funding'
                                          ? 'Wallet Funding Receipt'
                                          : 'Delivery Payment Receipt',
                                      receiptType:
                                        pt.purpose === 'wallet_funding'
                                          ? 'Wallet Funding'
                                          : 'Delivery Payment',
                                      amountNgn: pt.amountNgn,
                                      status: pt.status,
                                      paymentMethod: pt.paymentMethod,
                                      createdAt: pt.createdAt,
                                      customerName: pt.customerName || profile.fullName,
                                      customerEmail: pt.customerEmail || profile.email,
                                      customerPhone: pt.customerPhone || profile.phone,
                                      trackingCode: pt.trackingCode,
                                      providerTxId: pt.providerTxId,
                                      transferReference: pt.transferReference,
                                      verifiedAt: pt.verifiedAt,
                                      description:
                                        pt.purpose === 'wallet_funding'
                                          ? 'Customer wallet deposit'
                                          : `Parcel delivery payment (${pt.trackingCode || pt.deliveryId || ''})`,
                                    })
                                  }
                                  className="inline-flex items-center gap-1 border border-neutral-300 hover:border-black px-2 py-1 rounded text-[10px] font-semibold cursor-pointer"
                                >
                                  <Receipt className="w-3 h-3" />
                                  <span>Receipt</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
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
                        <span>
                          To {d.recipientName} ·{' '}
                          <span className="text-black font-semibold">
                            {formatPaymentMethodLabel(d.paymentMethod)} ·{' '}
                            {formatPaymentStatusLabel(d.paymentMethod, d.paymentStatus)}
                          </span>
                        </span>
                        <span className="font-mono font-bold text-black tabular-nums">
                          {formatNaira(d.deliveryFeeNgn)}
                        </span>
                      </div>
                      <div className="pt-1 flex flex-wrap justify-end gap-2">
                        {d.status === 'delivered' && d.assignedRiderId && (
                          d.riderRating ? (
                            <span className="inline-flex items-center gap-1 rounded-lg bg-neutral-100 border border-neutral-200 px-2.5 py-1.5 text-xs font-bold text-black">
                              <Star className="w-3.5 h-3.5 fill-black" />
                              <span>{d.riderRating}/5</span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setRatingTargetDelivery(d);
                                setRatingStars(5);
                                setRatingComment('');
                              }}
                              className="inline-flex items-center gap-1 bg-black text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-neutral-800 cursor-pointer"
                            >
                              <Star className="w-3.5 h-3.5" />
                              <span>Rate Rider</span>
                            </button>
                          )
                        )}
                        {d.paymentStatus === 'paid' && (
                          <button
                            type="button"
                            onClick={() =>
                              setActiveReceipt({
                                receiptType: 'Delivery Payment',
                                reference: d.paymentReference || d.trackingCode,
                                title: 'SAQO Delivery Payment Receipt',
                                status: d.paymentStatus || 'paid',
                                amountNgn: d.deliveryFeeNgn,
                                paymentMethod: d.paymentMethod || 'cash',
                                createdAt: d.updatedAt || d.createdAt,
                                customerName: profile.fullName,
                                customerEmail: profile.email,
                                customerPhone: profile.phone,
                                trackingCode: d.trackingCode,
                                description: `${d.pickupState} → ${d.destinationState} · ${d.parcelDescription}`,
                              })
                            }
                            className="inline-flex items-center gap-1 border border-neutral-300 hover:border-black px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                          >
                            <Receipt className="w-3.5 h-3.5" />
                            <span>Receipt</span>
                          </button>
                        )}
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
                        <th className="py-3 px-4 font-semibold">Payment</th>
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
                          <td className="py-3 px-4 text-xs">
                            {formatPaymentMethodLabel(d.paymentMethod)} ·{' '}
                            <span className="font-bold text-black">
                              {formatPaymentStatusLabel(d.paymentMethod, d.paymentStatus)}
                            </span>
                          </td>
                          <td className="py-3 px-4 capitalize">
                            <span className="inline-flex items-center gap-1">
                              {d.status === 'delivered' && <CheckCircle2 className="w-3.5 h-3.5" />}
                              <span>{d.status.replace(/_/g, ' ')}</span>
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            {formatNaira(d.deliveryFeeNgn)}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                            {d.status === 'delivered' && d.assignedRiderId && (
                              d.riderRating ? (
                                <span className="inline-flex items-center gap-1 rounded bg-neutral-100 border border-neutral-200 px-2 py-1 text-xs font-bold text-black">
                                  <Star className="w-3 h-3 fill-black" />
                                  <span>{d.riderRating}/5</span>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRatingTargetDelivery(d);
                                    setRatingStars(5);
                                    setRatingComment('');
                                  }}
                                  className="inline-flex items-center gap-1 bg-black text-white px-2.5 py-1 rounded text-xs font-semibold hover:bg-neutral-800 cursor-pointer"
                                >
                                  <Star className="w-3 h-3" />
                                  <span>Rate</span>
                                </button>
                              )
                            )}
                            {d.paymentStatus === 'paid' && (
                              <button
                                type="button"
                                onClick={() =>
                                  setActiveReceipt({
                                    receiptType: 'Delivery Payment',
                                    reference: d.paymentReference || d.trackingCode,
                                    title: 'SAQO Delivery Payment Receipt',
                                    status: d.paymentStatus || 'paid',
                                    amountNgn: d.deliveryFeeNgn,
                                    paymentMethod: d.paymentMethod || 'cash',
                                    createdAt: d.updatedAt || d.createdAt,
                                    customerName: profile.fullName,
                                    customerEmail: profile.email,
                                    customerPhone: profile.phone,
                                    trackingCode: d.trackingCode,
                                    description: `${d.pickupState} → ${d.destinationState} · ${d.parcelDescription}`,
                                  })
                                }
                                className="inline-flex items-center gap-1 border border-neutral-300 hover:border-black px-2.5 py-1 rounded text-xs font-semibold cursor-pointer"
                              >
                                <Receipt className="w-3 h-3" />
                                <span>Receipt</span>
                              </button>
                            )}
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

        {/* MORE MENU VIEW (Simplified hub for secondary tools) */}
        {tab === 'more' && (
          <div className="max-w-2xl mx-auto space-y-6">
            <div className="bg-black text-white rounded-2xl p-6 flex items-center justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-widest text-neutral-400">
                  Client Account
                </p>
                <h1 className="font-display font-extrabold text-2xl mt-1">{profile.fullName}</h1>
                <p className="text-xs text-neutral-300 mt-0.5">{profile.email} · {profile.phone}</p>
              </div>
              <button
                type="button"
                onClick={() => setTab('profile')}
                className="bg-white text-black px-4 py-2 rounded-xl text-xs font-bold hover:bg-neutral-200 cursor-pointer shrink-0"
              >
                Edit Profile
              </button>
            </div>

            <div className="bg-white border border-neutral-200 rounded-2xl divide-y divide-neutral-200 overflow-hidden">
              <button
                type="button"
                onClick={() => setTab('history')}
                className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-neutral-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3.5">
                  <Clock className="w-5 h-5 text-black" />
                  <div>
                    <p className="font-display font-bold text-base">Delivery History</p>
                    <p className="text-xs text-neutral-500">Past parcels, receipts &amp; rider ratings ({pastDeliveries.length})</p>
                  </div>
                </div>
                <ArrowUpRight className="w-4 h-4 text-neutral-400" />
              </button>

              <button
                type="button"
                onClick={() => setTab('notifications')}
                className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-neutral-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3.5">
                  <Bell className="w-5 h-5 text-black" />
                  <div>
                    <p className="font-display font-bold text-base">
                      Alerts &amp; Updates{unreadCount > 0 ? ` (${unreadCount})` : ''}
                    </p>
                    <p className="text-xs text-neutral-500">Real-time parcel &amp; rider dispatch alerts</p>
                  </div>
                </div>
                <ArrowUpRight className="w-4 h-4 text-neutral-400" />
              </button>

              <button
                type="button"
                onClick={() => setTab('tickets')}
                className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-neutral-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3.5">
                  <MessageSquarePlus className="w-5 h-5 text-black" />
                  <div>
                    <p className="font-display font-bold text-base">
                      Support &amp; Tickets{tickets.length > 0 ? ` (${tickets.length})` : ''}
                    </p>
                    <p className="text-xs text-neutral-500">Complaints, suggestions &amp; ops follow-up</p>
                  </div>
                </div>
                <ArrowUpRight className="w-4 h-4 text-neutral-400" />
              </button>

              <button
                type="button"
                onClick={() => setTab('profile')}
                className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-neutral-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3.5">
                  <User className="w-5 h-5 text-black" />
                  <div>
                    <p className="font-display font-bold text-base">Profile &amp; Alert Settings</p>
                    <p className="text-xs text-neutral-500">Update name, phone &amp; notification preferences</p>
                  </div>
                </div>
                <ArrowUpRight className="w-4 h-4 text-neutral-400" />
              </button>

              <a
                href={buildWhatsAppUrl(whatsappNumber, 'Hello SAQO Support, I need assistance.')}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-neutral-50 transition-colors"
              >
                <div className="flex items-center gap-3.5">
                  <MessageCircle className="w-5 h-5 text-black" />
                  <div>
                    <p className="font-display font-bold text-base">WhatsApp Support</p>
                    <p className="text-xs text-neutral-500">Chat directly with SAQO Operations</p>
                  </div>
                </div>
                <ArrowUpRight className="w-4 h-4 text-neutral-400" />
              </a>
            </div>

            <button
              type="button"
              onClick={onLogout}
              className="w-full flex items-center justify-center gap-2 border-2 border-black text-black py-3.5 rounded-2xl text-sm font-bold hover:bg-black hover:text-white transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out</span>
            </button>
          </div>
        )}

        {/* PROFILE TAB */}
        {tab === 'profile' && (
          <form
            onSubmit={handleSaveProfile}
            className="bg-white border border-neutral-200 rounded-2xl p-6 sm:p-8 max-w-2xl mx-auto space-y-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-wider text-neutral-500">
                  Client Profile
                </p>
                <h1 className="font-display font-extrabold text-2xl mt-1">{profile.fullName}</h1>
                <p className="text-xs text-neutral-500 mt-0.5">{profile.email}</p>
              </div>
              <button
                type="button"
                onClick={onLogout}
                className="inline-flex items-center gap-1.5 border border-neutral-300 hover:border-black px-3.5 py-2 rounded-xl text-xs font-bold cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign out</span>
              </button>
            </div>

            {profileNotice && (
              <div
                role="status"
                className="rounded-xl bg-neutral-100 border border-black px-4 py-3 text-xs font-semibold text-black"
              >
                {profileNotice}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="client-prof-name" className="block text-xs font-semibold text-neutral-600 mb-1">
                  Full Name
                </label>
                <input
                  id="client-prof-name"
                  type="text"
                  required
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  className="w-full rounded-xl bg-neutral-100 border border-transparent focus:bg-white focus:border-black px-3.5 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              <div>
                <label htmlFor="client-prof-phone" className="block text-xs font-semibold text-neutral-600 mb-1">
                  Phone Number
                </label>
                <input
                  id="client-prof-phone"
                  type="tel"
                  required
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="w-full rounded-xl bg-neutral-100 border border-transparent focus:bg-white focus:border-black px-3.5 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
            </div>

            <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-4 space-y-3">
              <p className="font-display font-bold text-sm">Push &amp; Sound Alerts</p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-neutral-600">
                  Receive live sound chimes &amp; browser alerts when your rider moves or delivers.
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleMute}
                    className="inline-flex items-center gap-1.5 border border-neutral-300 bg-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:border-black cursor-pointer"
                  >
                    {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                    <span>{muted ? 'Unmute Sound' : 'Sound On'}</span>
                  </button>
                  {notifPerm === 'default' && (
                    <button
                      type="button"
                      onClick={handleEnablePush}
                      className="inline-flex items-center gap-1.5 bg-black text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-neutral-800 cursor-pointer"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      <span>Enable Push</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-neutral-200">
              <button
                type="button"
                onClick={() => setTab('more')}
                className="text-xs font-semibold text-neutral-600 hover:text-black underline cursor-pointer"
              >
                ← Back to More
              </button>
              <button
                type="submit"
                disabled={savingProfile}
                className="bg-black text-white px-5 py-3 rounded-xl text-sm font-bold hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
              >
                {savingProfile ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
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
        {/* Add Money Modal (Flutterwave Wallet Funding) */}
        {fundModalOpen && (
          <div className="fixed inset-0 bg-black/65 z-50 flex items-center justify-center p-4">
            <form
              onSubmit={handleFundWallet}
              className="bg-white border-2 border-black rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    SAQO Wallet Top-Up
                  </p>
                  <h2 className="font-display font-bold text-xl mt-0.5">Add Money to Wallet</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setFundModalOpen(false)}
                  className="text-xs font-semibold border border-neutral-300 px-2.5 py-1 rounded-lg hover:border-black cursor-pointer"
                >
                  Close
                </button>
              </div>

              <div className="rounded-xl bg-neutral-50 border border-neutral-200 px-4 py-3 flex items-center justify-between text-xs">
                <span className="text-neutral-500">Current Balance</span>
                <span className="font-mono font-bold text-sm tabular-nums text-black">
                  {formatNaira(wallet?.balanceNgn ?? 0)}
                </span>
              </div>

              <div className="space-y-2">
                <label htmlFor="fund-amount-input" className="block text-xs font-semibold">
                  Amount to Add (NGN)
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[1000, 2500, 5000, 10000].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setFundAmount(String(amt))}
                      className={`py-2 rounded-lg text-xs font-mono font-bold border transition-colors cursor-pointer ${
                        Number(fundAmount) === amt
                          ? 'bg-black text-white border-black'
                          : 'bg-white text-black border-neutral-300 hover:border-black'
                      }`}
                    >
                      ₦{(amt / 1000).toFixed(amt % 1000 === 0 ? 0 : 1)}k
                    </button>
                  ))}
                </div>
                <input
                  id="fund-amount-input"
                  type="number"
                  min={100}
                  step="50"
                  required
                  value={fundAmount}
                  onChange={(e) => setFundAmount(e.target.value)}
                  className="w-full border border-neutral-300 rounded-xl px-3.5 py-2.5 text-lg font-mono font-bold tabular-nums focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              {paymentConfig && !paymentConfig.isEnabled ? (
                <div className="rounded-xl border border-black bg-neutral-100 p-3 text-xs text-black font-medium">
                  Flutterwave online top-up is currently disabled by an administrator. Please check back shortly or choose Cash / Bank Transfer at checkout.
                </div>
              ) : (
                <p className="text-[11px] text-neutral-500 leading-relaxed">
                  Secured via Flutterwave{paymentConfig?.mode === 'test' ? ' (Test Mode)' : ''}. Your wallet is credited immediately after server verification.
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setFundModalOpen(false)}
                  className="px-4 py-2.5 rounded-xl border border-neutral-300 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={fundingSubmitting || Boolean(paymentConfig && !paymentConfig.isEnabled)}
                  className="px-5 py-2.5 rounded-xl bg-black text-white text-xs font-bold hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
                >
                  {fundingSubmitting
                    ? 'Connecting to Flutterwave...'
                    : `Proceed (${formatNaira(Number(fundAmount) || 0)})`}
                </button>
              </div>
            </form>
          </div>
        )}

        <ReceiptModal receipt={activeReceipt} onClose={() => setActiveReceipt(null)} />

        {/* Rate Rider Modal */}
        {ratingTargetDelivery && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Rate delivery rider"
            className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4 backdrop-blur-[2px]"
          >
            <form
              onSubmit={handleSubmitRating}
              className="bg-white border-2 border-black rounded-t-2xl sm:rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl"
            >
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-neutral-500">
                  {ratingTargetDelivery.trackingCode}
                </p>
                <h2 className="font-display font-extrabold text-xl mt-1">
                  Rate {ratingTargetDelivery.assignedRiderName || 'your rider'}
                </h2>
                <p className="text-xs text-neutral-500 mt-0.5">
                  {ratingTargetDelivery.pickupState} → {ratingTargetDelivery.destinationState}
                </p>
              </div>

              <div className="flex items-center justify-center gap-2 py-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setRatingStars(star)}
                    aria-label={`Rate ${star} out of 5 stars`}
                    className="p-2 rounded-xl hover:bg-neutral-100 transition-colors cursor-pointer"
                  >
                    <Star
                      className={`w-8 h-8 ${
                        star <= ratingStars ? 'fill-black text-black' : 'text-neutral-300'
                      }`}
                    />
                  </button>
                ))}
              </div>

              <div>
                <label htmlFor="rating-comment" className="block text-xs font-semibold mb-1">
                  Feedback (Optional)
                </label>
                <textarea
                  id="rating-comment"
                  rows={3}
                  value={ratingComment}
                  onChange={(e) => setRatingComment(e.target.value)}
                  placeholder="Share how the pickup and delivery went..."
                  className="w-full rounded-xl bg-neutral-100 border border-transparent focus:bg-white focus:border-black px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setRatingTargetDelivery(null)}
                  className="border border-neutral-300 py-3 rounded-xl text-xs font-bold hover:border-black cursor-pointer"
                >
                  Later
                </button>
                <button
                  type="submit"
                  disabled={submittingRating}
                  className="bg-black text-white py-3 rounded-xl text-xs font-bold hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
                >
                  {submittingRating ? 'Submitting...' : `Submit ${ratingStars}★ Rating`}
                </button>
              </div>
            </form>
          </div>
        )}

        <OtpAlertModal
          open={Boolean(otpAlert)}
          title="Delivery OTP Verification Failed"
          message={otpAlert?.message || ''}
          trackingCode={otpAlert?.trackingCode}
          onClose={() => setOtpAlert(null)}
        />
      </main>

      {/* Native 4-Item Mobile Bottom Navigation */}
      <nav
        aria-label="Client mobile navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-neutral-200 grid grid-cols-4 pb-[env(safe-area-inset-bottom)]"
      >
        <button
          type="button"
          onClick={() => setTab('active')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-xs font-bold border-t-2 transition-colors ${
            tab === 'active' ? 'border-black text-black' : 'border-transparent text-neutral-500'
          }`}
        >
          <MapPin className="w-4 h-4" />
          <span>Track</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('send')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-xs font-bold border-t-2 transition-colors ${
            tab === 'send' ? 'border-black text-black' : 'border-transparent text-neutral-500'
          }`}
        >
          <Plus className="w-4 h-4" />
          <span>Send</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('wallet')}
          className={`flex flex-col items-center justify-center py-2.5 gap-1 text-xs font-bold border-t-2 transition-colors ${
            tab === 'wallet' ? 'border-black text-black' : 'border-transparent text-neutral-500'
          }`}
        >
          <Wallet className="w-4 h-4" />
          <span>Wallet</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('more')}
          className={`relative flex flex-col items-center justify-center py-2.5 gap-1 text-xs font-bold border-t-2 transition-colors ${
            ['more', 'history', 'notifications', 'tickets', 'profile'].includes(tab)
              ? 'border-black text-black'
              : 'border-transparent text-neutral-500'
          }`}
        >
          <LayoutGrid className="w-4 h-4" />
          <span>More{unreadCount > 0 ? ` (${unreadCount})` : ''}</span>
        </button>
      </nav>
    </div>
  );
};
