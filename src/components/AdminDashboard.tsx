import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  CreditCard,
  Download,
  Edit3,
  Eye,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Package,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Truck,
  Users,
  X,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useRealtime } from '../hooks/useRealtime';
import { NIGERIA_STATES } from '../shared/nigeria';
import { formatNaira } from '../shared/pricing';
import { formatDeliveryStatusLabel } from '../shared/tracking';
import type {
  ComplaintRecord,
  CustomerSummary,
  DeliveryRequest,
  DeliveryStatus,
  DeliveryStatusHistoryItem,
  PaymentRecord,
  PlatformSettings,
  Profile,
  RiderProfile,
  SupportConversation,
  SupportConversationStatus,
  SupportMessage,
  SupportPresence,
} from '../shared/types';
import { LiveNigeriaMap } from './LiveNigeriaMap';
import { PWAInstallButton } from './PWAInstallButton';
import { SaqoLogo } from './SaqoLogo';
import { buildWhatsAppUrl } from './WhatsAppWidget';

interface AdminDashboardProps {
  profile: Profile;
  onGoHome: () => void;
  onLogout: () => void;
  onSettingsChanged: (settings: PlatformSettings) => void;
}

type AdminSection =
  | 'overview'
  | 'deliveries'
  | 'riders'
  | 'customers'
  | 'chats'
  | 'settings'
  | 'finance';

type AdminDeliveryRecord = DeliveryRequest & {
  history?: DeliveryStatusHistoryItem[];
};

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  profile,
  onGoHome,
  onLogout,
  onSettingsChanged,
}) => {
  const [section, setSection] = useState<AdminSection>('overview');
  const [deliveries, setDeliveries] = useState<AdminDeliveryRecord[]>([]);
  const [riders, setRiders] = useState<RiderProfile[]>([]);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [complaints, setComplaints] = useState<ComplaintRecord[]>([]);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Filters & Modals
  const [deliveryFilter, setDeliveryFilter] = useState<
    'all' | 'active' | 'needs_rider' | 'delivered' | 'cancelled'
  >('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [ticketFilter, setTicketFilter] = useState<'all' | 'complaint' | 'suggestion'>('all');
  const [ticketStatusFilter, setTicketStatusFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [resolutionDrafts, setResolutionDrafts] = useState<Record<string, string>>({});
  const [inspectedUserRef, setInspectedUserRef] = useState<{
    kind: 'customer' | 'rider';
    profileId: string;
  } | null>(null);
  const [inspectedDelivery, setInspectedDelivery] = useState<AdminDeliveryRecord | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [assigningDelivery, setAssigningDelivery] = useState<AdminDeliveryRecord | null>(null);
  const [selectedRiderId, setSelectedRiderId] = useState('');
  const [focusedDelivery, setFocusedDelivery] = useState<AdminDeliveryRecord | null>(null);
  const [retryingDispatchId, setRetryingDispatchId] = useState<string | null>(null);
  const [adminStatusDraft, setAdminStatusDraft] = useState<DeliveryStatus>('in_transit');
  const [adminStatusNote, setAdminStatusNote] = useState('');
  const [updatingDeliveryStatus, setUpdatingDeliveryStatus] = useState(false);
  const [resetPasswordOpen, setResetPasswordOpen] = useState(false);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);

  // Issue Rider Account Modal State
  const [issueRiderOpen, setIssueRiderOpen] = useState(false);
  const [issuingRider, setIssuingRider] = useState(false);
  const [issueRiderForm, setIssueRiderForm] = useState({
    fullName: '',
    phone: '',
    email: '',
    password: '',
    homeState: 'Katsina',
    vehicleType: 'Motorcycle' as 'Motorcycle' | 'Van' | 'Inter-State Sprinter',
    plateNumber: '',
    verifyImmediately: false,
  });

  // Inline Edit Rider State in User Details Drawer
  const [editingRiderMode, setEditingRiderMode] = useState(false);
  const [savingRiderEdit, setSavingRiderEdit] = useState(false);
  const [editRiderForm, setEditRiderForm] = useState({
    fullName: '',
    phone: '',
    homeState: 'Katsina',
    vehicleType: 'Motorcycle' as 'Motorcycle' | 'Van' | 'Inter-State Sprinter',
    plateNumber: '',
  });

  // Settings Form State
  const [settingsDraft, setSettingsDraft] = useState<PlatformSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Persistent Live Support Chat Management State
  const [conversations, setConversations] = useState<SupportConversation[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<SupportMessage[]>([]);
  const [loadingChatMessages, setLoadingChatMessages] = useState(false);
  const [chatFilter, setChatFilter] = useState<'all' | 'open' | 'pending' | 'resolved'>('all');
  const [chatSearch, setChatSearch] = useState('');
  const [chatReply, setChatReply] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [adminAcceptingChats, setAdminAcceptingChats] = useState(true);
  const [chatPresence, setChatPresence] = useState<SupportPresence>({
    adminOnline: true,
    onlineAdminCount: 1,
  });
  const [visitorTypingConvId, setVisitorTypingConvId] = useState<string | null>(null);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const adminChatEndRef = React.useRef<HTMLDivElement | null>(null);
  const lastAdminTypingEmitRef = React.useRef<number>(0);

  const loadSupportChats = useCallback(async () => {
    try {
      const res = await apiRequest<{
        conversations: SupportConversation[];
        presence: SupportPresence;
        adminAcceptingChats: boolean;
      }>('/api/admin/support/conversations');
      setConversations(res.conversations);
      if (res.presence) setChatPresence(res.presence);
      if (typeof res.adminAcceptingChats === 'boolean') {
        setAdminAcceptingChats(res.adminAcceptingChats);
      }
    } catch {
      // non-fatal if support chats endpoint temporarily unavailable
    }
  }, []);

  const loadChatMessages = useCallback(async (convId: string) => {
    setLoadingChatMessages(true);
    try {
      const res = await apiRequest<{
        conversation: SupportConversation;
        messages: SupportMessage[];
      }>(`/api/admin/support/conversations/${encodeURIComponent(convId)}/messages`);
      setChatMessages(res.messages);
      setConversations((prev) =>
        prev.map((c) => (c.id === res.conversation.id ? res.conversation : c))
      );
    } catch (err: any) {
      setError(err.message || 'Could not load chat history.');
    } finally {
      setLoadingChatMessages(false);
    }
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const [res] = await Promise.all([
        apiRequest<{
          deliveries: AdminDeliveryRecord[];
          riders: RiderProfile[];
          customers: CustomerSummary[];
          payments: PaymentRecord[];
          complaints: ComplaintRecord[];
          settings: PlatformSettings;
        }>('/api/admin/overview'),
        loadSupportChats(),
      ]);
      setDeliveries(res.deliveries);
      setInspectedDelivery((curr) =>
        curr ? res.deliveries.find((d) => d.id === curr.id) || curr : null
      );
      setFocusedDelivery((curr) =>
        curr ? res.deliveries.find((d) => d.id === curr.id) || curr : null
      );
      setRiders(res.riders);
      setCustomers(res.customers);
      setPayments(res.payments);
      setComplaints(res.complaints);
      setSettings(res.settings);
      setSettingsDraft((prev) => prev || res.settings);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load admin overview.');
    } finally {
      setLoading(false);
    }
  }, [loadSupportChats]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (inspectedDelivery) {
      setAdminStatusDraft(inspectedDelivery.status);
      setAdminStatusNote('');
    }
  }, [inspectedDelivery?.id, inspectedDelivery?.status]);

  useEffect(() => {
    setResetPasswordOpen(false);
    setResetPasswordValue('');
    setEditingRiderMode(false);
  }, [inspectedUserRef?.profileId]);

  useEffect(() => {
    if (section === 'chats' && activeChatId) {
      loadChatMessages(activeChatId);
    }
  }, [section, activeChatId, loadChatMessages]);

  useEffect(() => {
    if (section === 'chats' && activeChatId) {
      adminChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages.length, section, activeChatId, visitorTypingConvId]);

  const { sendEvent } = useRealtime((evt) => {
    if (
      evt.type === 'delivery:created' ||
      evt.type === 'delivery:updated' ||
      evt.type === 'rider:location' ||
      evt.type === 'rider:availability' ||
      evt.type === 'complaint:updated'
    ) {
      loadOverview();
    } else if (evt.type === 'support:presence') {
      setChatPresence(evt.payload as SupportPresence);
    } else if (evt.type === 'support:conversation') {
      const conv = evt.payload as SupportConversation;
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === conv.id);
        const next = exists
          ? prev.map((c) => (c.id === conv.id ? conv : c))
          : [conv, ...prev];
        return next.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      });
    } else if (evt.type === 'support:message') {
      const msg = evt.payload as SupportMessage;
      if (msg.conversationId === activeChatId) {
        setChatMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        if (msg.senderRole !== 'admin') {
          setVisitorTypingConvId((curr) => (curr === msg.conversationId ? null : curr));
          if (section === 'chats') {
            apiRequest(`/api/admin/support/conversations/${encodeURIComponent(msg.conversationId)}/messages`)
              .then((res: any) => {
                if (res?.conversation) {
                  setConversations((prev) =>
                    prev.map((c) => (c.id === res.conversation.id ? res.conversation : c))
                  );
                }
              })
              .catch(() => {});
          }
        }
      }
    } else if (evt.type === 'support:typing') {
      const t = evt.payload as {
        conversationId: string;
        senderRole: string;
        isTyping: boolean;
      };
      if (t.senderRole !== 'admin') {
        setVisitorTypingConvId(t.isTyping ? t.conversationId : null);
      }
    }
  });

  const handleManualAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assigningDelivery || !selectedRiderId) return;
    try {
      await apiRequest(`/api/admin/deliveries/${assigningDelivery.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ riderId: selectedRiderId }),
      });
      setToast(`Assigned ${assigningDelivery.trackingCode} manually.`);
      setAssigningDelivery(null);
      setSelectedRiderId('');
      await loadOverview();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleVerifyRider = async (
    riderId: string,
    verificationStatus: 'verified' | 'pending' | 'rejected'
  ) => {
    try {
      await apiRequest(`/api/admin/riders/${riderId}/verify`, {
        method: 'PATCH',
        body: JSON.stringify({ verificationStatus }),
      });
      setToast(`Rider verification set to ${verificationStatus}.`);
      await loadOverview();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleAccountStatus = async (
    profileId: string,
    nextStatus: 'active' | 'suspended'
  ) => {
    try {
      await apiRequest(`/api/admin/profiles/${profileId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus: nextStatus }),
      });
      setToast(`Account status updated to ${nextStatus}.`);
      await loadOverview();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settingsDraft) return;
    setSavingSettings(true);
    try {
      const res = await apiRequest<{ settings: PlatformSettings }>('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify(settingsDraft),
      });
      setSettings(res.settings);
      setSettingsDraft(res.settings);
      onSettingsChanged(res.settings);
      setToast('Dispatch, pricing & WhatsApp settings saved.');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleUpdateComplaint = async (
    id: string,
    status: 'open' | 'investigating' | 'resolved'
  ) => {
    try {
      const customNote = resolutionDrafts[id]?.trim();
      await apiRequest(`/api/admin/complaints/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          resolutionNote:
            customNote ||
            (status === 'resolved' ? 'Resolved by SAQO Operations.' : 'Under review by SAQO Operations.'),
        }),
      });
      setToast(`Ticket marked as ${status}.`);
      await loadOverview();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleIssueRider = async (e: React.FormEvent) => {
    e.preventDefault();
    const phoneDigits = issueRiderForm.phone.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      setError('Please enter a valid rider phone number (at least 10 digits).');
      return;
    }
    setIssuingRider(true);
    setError(null);
    try {
      const res = await apiRequest<{ rider: RiderProfile }>('/api/admin/riders', {
        method: 'POST',
        body: JSON.stringify({
          fullName: issueRiderForm.fullName,
          phone: issueRiderForm.phone,
          email: issueRiderForm.email,
          password: issueRiderForm.password,
          homeState: issueRiderForm.homeState,
          vehicleType: issueRiderForm.vehicleType,
          plateNumber: issueRiderForm.plateNumber,
          verificationStatus: issueRiderForm.verifyImmediately ? 'verified' : 'pending',
        }),
      });
      setToast(
        `Rider account issued for ${res.rider.fullName} (${res.rider.email})${
          res.rider.verificationStatus === 'verified' ? ' with Verification Tick enabled' : ''
        }.`
      );
      setIssueRiderOpen(false);
      setIssueRiderForm({
        fullName: '',
        phone: '',
        email: '',
        password: '',
        homeState: 'Katsina',
        vehicleType: 'Motorcycle',
        plateNumber: '',
        verifyImmediately: false,
      });
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Could not issue rider account.');
    } finally {
      setIssuingRider(false);
    }
  };

  const handleSaveRiderEdit = async (e: React.FormEvent, riderId: string) => {
    e.preventDefault();
    setSavingRiderEdit(true);
    setError(null);
    try {
      await apiRequest(`/api/admin/riders/${riderId}`, {
        method: 'PATCH',
        body: JSON.stringify(editRiderForm),
      });
      setToast('Rider details updated.');
      setEditingRiderMode(false);
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Failed to update rider details.');
    } finally {
      setSavingRiderEdit(false);
    }
  };

  const handleCancelDelivery = async (deliveryId: string) => {
    try {
      await apiRequest(`/api/deliveries/${deliveryId}/cancel`, { method: 'POST' });
      setToast('Delivery cancelled by SAQO Operations.');
      setConfirmCancelId(null);
      if (inspectedDelivery?.id === deliveryId) {
        setInspectedDelivery(null);
      }
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Could not cancel delivery.');
    }
  };

  const handleRetryDispatch = async (deliveryId: string) => {
    setRetryingDispatchId(deliveryId);
    setError(null);
    try {
      const res = await apiRequest<{ message?: string; delivery: AdminDeliveryRecord }>(
        `/api/deliveries/${deliveryId}/retry-dispatch`,
        { method: 'POST' }
      );
      setToast(res.message || 'Smart dispatch re-run completed.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Could not retry dispatch.');
    } finally {
      setRetryingDispatchId(null);
    }
  };

  const handleAdminUpdateDeliveryStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectedDelivery) return;
    setUpdatingDeliveryStatus(true);
    setError(null);
    try {
      await apiRequest(`/api/admin/deliveries/${inspectedDelivery.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: adminStatusDraft,
          note: adminStatusNote.trim() || undefined,
        }),
      });
      setToast(
        `${inspectedDelivery.trackingCode} updated to ${formatDeliveryStatusLabel(adminStatusDraft)}.`
      );
      setAdminStatusNote('');
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Could not update delivery status.');
    } finally {
      setUpdatingDeliveryStatus(false);
    }
  };

  const handleResetUserPassword = async (e: React.FormEvent, profileId: string) => {
    e.preventDefault();
    if (resetPasswordValue.trim().length < 6) {
      setError('Temporary password must be at least 6 characters.');
      return;
    }
    setResettingPassword(true);
    setError(null);
    try {
      await apiRequest(`/api/admin/profiles/${profileId}/reset-password`, {
        method: 'PATCH',
        body: JSON.stringify({ newPassword: resetPasswordValue.trim() }),
      });
      setToast('Account password reset successfully.');
      setResetPasswordOpen(false);
      setResetPasswordValue('');
    } catch (err: any) {
      setError(err.message || 'Failed to reset password.');
    } finally {
      setResettingPassword(false);
    }
  };

  const handleExportDeliveriesCsv = () => {
    const header = [
      'Tracking Code',
      'Status',
      'Service Tier',
      'Pickup State',
      'Pickup Address',
      'Destination State',
      'Destination Address',
      'Customer',
      'Customer Phone',
      'Recipient',
      'Recipient Phone',
      'Assigned Rider',
      'Fee (NGN)',
      'Distance (km)',
      'Created At',
    ];
    const rows = filteredDeliveries.map((d) => [
      d.trackingCode,
      d.status,
      d.serviceTier,
      `"${d.pickupState.replace(/"/g, '""')}"`,
      `"${d.pickupAddress.replace(/"/g, '""')}"`,
      `"${d.destinationState.replace(/"/g, '""')}"`,
      `"${d.destinationAddress.replace(/"/g, '""')}"`,
      `"${d.customerName.replace(/"/g, '""')}"`,
      d.customerPhone,
      `"${d.recipientName.replace(/"/g, '""')}"`,
      d.recipientPhone,
      `"${(d.assignedRiderName || 'Unassigned').replace(/"/g, '""')}"`,
      String(d.deliveryFeeNgn),
      String(d.distanceKm),
      d.createdAt,
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `saqo-deliveries-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportLedgerCsv = () => {
    const header = ['Tracking Code', 'Customer', 'Status', 'Total Fee (NGN)', 'Rider Payout (NGN)', 'Platform Fee (NGN)', 'Created At'];
    const rows = payments.map((p) => [
      p.trackingCode,
      `"${p.customerName.replace(/"/g, '""')}"`,
      p.status,
      String(p.amountNgn),
      String(p.riderPayoutNgn),
      String(p.platformFeeNgn),
      p.createdAt,
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `saqo-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const activeDeliveries = deliveries.filter(
    (d) => !['delivered', 'cancelled'].includes(d.status)
  );
  const needsRiderDeliveries = deliveries.filter((d) =>
    ['pending_dispatch', 'no_rider_available'].includes(d.status)
  );
  const completedDeliveries = deliveries.filter((d) => d.status === 'delivered');
  const cancelledDeliveries = deliveries.filter((d) => d.status === 'cancelled');
  const pendingVerificationRiders = riders.filter((r) => r.verificationStatus === 'pending');
  const openTicketsCount = complaints.filter((c) => c.status !== 'resolved').length;

  const nonRefundedPayments = payments.filter((p) => p.status !== 'refunded');
  const grossVolumeNgn = nonRefundedPayments.reduce((acc, p) => acc + p.amountNgn, 0);
  const riderPayoutsNgn = nonRefundedPayments.reduce((acc, p) => acc + p.riderPayoutNgn, 0);
  const platformRevenueNgn = nonRefundedPayments.reduce((acc, p) => acc + p.platformFeeNgn, 0);

  const availableRiders = riders.filter(
    (r) =>
      r.isOnline &&
      r.activeParcelsCount === 0 &&
      r.accountStatus === 'active' &&
      r.verificationStatus === 'verified'
  );
  const busyRiders = riders.filter((r) => r.isOnline && r.activeParcelsCount > 0);
  const offlineRiders = riders.filter((r) => !r.isOnline);

  const filteredDeliveries = deliveries.filter((d) => {
    if (deliveryFilter === 'active' && ['delivered', 'cancelled'].includes(d.status)) return false;
    if (
      deliveryFilter === 'needs_rider' &&
      !['pending_dispatch', 'no_rider_available'].includes(d.status)
    ) {
      return false;
    }
    if (deliveryFilter === 'delivered' && d.status !== 'delivered') return false;
    if (deliveryFilter === 'cancelled' && d.status !== 'cancelled') return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        d.trackingCode.toLowerCase().includes(q) ||
        d.pickupState.toLowerCase().includes(q) ||
        d.destinationState.toLowerCase().includes(q) ||
        d.customerName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const filteredRiders = riders.filter((r) => {
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return (
      r.fullName.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      r.phone.toLowerCase().includes(q) ||
      r.homeState.toLowerCase().includes(q) ||
      r.plateNumber.toLowerCase().includes(q)
    );
  });

  const filteredCustomers = customers.filter((c) => {
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return (
      c.fullName.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      c.phone.toLowerCase().includes(q) ||
      c.defaultState.toLowerCase().includes(q)
    );
  });

  const filteredTickets = complaints.filter((c) => {
    const typeOk = ticketFilter === 'all' ? true : (c.ticketType || 'complaint') === ticketFilter;
    const statusOk =
      ticketStatusFilter === 'all'
        ? true
        : ticketStatusFilter === 'resolved'
        ? c.status === 'resolved'
        : c.status !== 'resolved';
    return typeOk && statusOk;
  });

  const inspectedCustomer =
    inspectedUserRef?.kind === 'customer'
      ? customers.find((c) => c.id === inspectedUserRef.profileId) || null
      : null;
  const inspectedRider =
    inspectedUserRef?.kind === 'rider'
      ? riders.find((r) => r.id === inspectedUserRef.profileId) || null
      : null;

  const totalUnreadChats = conversations.reduce((sum, c) => sum + (c.unreadByAdmin || 0), 0);

  const filteredConversations = conversations.filter((c) => {
    if (chatFilter === 'open' && c.status !== 'open') return false;
    if (chatFilter === 'pending' && c.status !== 'pending') return false;
    if (chatFilter === 'resolved' && c.status !== 'resolved' && c.status !== 'closed') return false;
    if (chatSearch.trim()) {
      const q = chatSearch.toLowerCase();
      return (
        c.visitorName.toLowerCase().includes(q) ||
        (c.visitorEmail || '').toLowerCase().includes(q) ||
        (c.visitorPhone || '').toLowerCase().includes(q) ||
        (c.trackingCode || '').toLowerCase().includes(q) ||
        (c.lastMessagePreview || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const activeConversation = conversations.find((c) => c.id === activeChatId) || null;

  const handleToggleAdminPresence = async () => {
    try {
      const nextAvailable = !adminAcceptingChats;
      const res = await apiRequest<{
        presence: SupportPresence;
        adminAcceptingChats: boolean;
      }>('/api/admin/support/presence', {
        method: 'POST',
        body: JSON.stringify({ available: nextAvailable }),
      });
      setChatPresence(res.presence);
      setAdminAcceptingChats(res.adminAcceptingChats);
      setToast(
        res.adminAcceptingChats
          ? 'Live support status set to Online.'
          : 'Live support status set to Away (Offline).'
      );
    } catch (err: any) {
      setError(err.message || 'Could not update availability.');
    }
  };

  const handleSendAdminReply = async (e?: React.FormEvent, presetBody?: string) => {
    e?.preventDefault();
    const text = (presetBody ?? chatReply).trim();
    if (!activeChatId || !text || sendingChat) return;
    setSendingChat(true);
    try {
      const res = await apiRequest<{
        conversation: SupportConversation;
        message: SupportMessage;
      }>(`/api/admin/support/conversations/${encodeURIComponent(activeChatId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      });
      if (!presetBody) setChatReply('');
      setChatMessages((prev) =>
        prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]
      );
      setConversations((prev) =>
        prev
          .map((c) => (c.id === res.conversation.id ? res.conversation : c))
          .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      );
      sendEvent({
        type: 'support:typing',
        conversationId: activeChatId,
        senderRole: 'admin',
        senderName: profile.fullName,
        isTyping: false,
      });
    } catch (err: any) {
      setError(err.message || 'Failed to send reply.');
    } finally {
      setSendingChat(false);
    }
  };

  const handleUpdateConversationStatus = async (
    convId: string,
    status: SupportConversationStatus
  ) => {
    try {
      const res = await apiRequest<{
        conversation: SupportConversation;
        systemMessage: SupportMessage;
      }>(`/api/admin/support/conversations/${encodeURIComponent(convId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setConversations((prev) =>
        prev.map((c) => (c.id === res.conversation.id ? res.conversation : c))
      );
      if (convId === activeChatId) {
        setChatMessages((prev) =>
          prev.some((m) => m.id === res.systemMessage.id)
            ? prev
            : [...prev, res.systemMessage]
        );
      }
      setToast(`Chat marked as ${status}.`);
    } catch (err: any) {
      setError(err.message || 'Could not update chat status.');
    }
  };

  const navItems: Array<{
    id: AdminSection;
    label: string;
    mobileLabel: string;
    icon: React.ReactNode;
    badge?: number;
  }> = [
    {
      id: 'overview',
      label: 'Overview & Map',
      mobileLabel: 'Live',
      icon: <LayoutDashboard className="w-4 h-4" />,
    },
    {
      id: 'deliveries',
      label: 'Deliveries',
      mobileLabel: 'Orders',
      icon: <Package className="w-4 h-4" />,
    },
    {
      id: 'riders',
      label: 'Riders',
      mobileLabel: 'Riders',
      icon: <Truck className="w-4 h-4" />,
    },
    {
      id: 'customers',
      label: 'Customers',
      mobileLabel: 'Users',
      icon: <Users className="w-4 h-4" />,
    },
    {
      id: 'chats',
      label: 'Support Chats',
      mobileLabel: 'Chats',
      icon: <MessageCircle className="w-4 h-4" />,
      badge: totalUnreadChats > 0 ? totalUnreadChats : undefined,
    },
    {
      id: 'settings',
      label: 'Pricing & Dispatch',
      mobileLabel: 'Rates',
      icon: <Settings className="w-4 h-4" />,
    },
    {
      id: 'finance',
      label: 'Ledger & Tickets',
      mobileLabel: 'Tickets',
      icon: <CreditCard className="w-4 h-4" />,
    },
  ];

  return (
    <div className="min-h-screen bg-neutral-50 text-black flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 bg-black text-white flex-col justify-between shrink-0">
        <div>
          <div className="h-16 px-6 flex items-center border-b border-white/15">
            <button type="button" onClick={onGoHome} className="cursor-pointer">
              <SaqoLogo inverted />
            </button>
          </div>
          <nav className="p-4 space-y-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  section === item.id
                    ? 'bg-white text-black font-semibold'
                    : 'text-neutral-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  {item.icon}
                  <span className="whitespace-nowrap truncate">{item.label}</span>
                </span>
                {item.badge && (
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold tabular-nums ${
                      section === item.id ? 'bg-black text-white' : 'bg-white text-black'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-4 border-t border-white/15 space-y-3">
          <div className="text-xs">
            <p className="font-semibold text-white">{profile.fullName}</p>
            <p className="text-neutral-400">Operations Admin</p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="w-full inline-flex items-center justify-center gap-2 border border-white/25 py-2 rounded-lg text-xs font-semibold hover:bg-white/10 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="bg-white border-b border-neutral-200 px-4 sm:px-6 h-16 flex items-center justify-between gap-3 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button type="button" onClick={onGoHome} className="lg:hidden cursor-pointer shrink-0">
              <SaqoLogo />
            </button>
            <h1 className="font-display font-bold text-sm sm:text-lg capitalize truncate">
              <span className="hidden sm:inline">SAQO Operations / </span>
              {section === 'overview'
                ? 'Live Fleet'
                : section === 'chats'
                ? 'Support Chats'
                : section === 'finance'
                ? 'Ledger & Tickets'
                : section}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton compact />
            <button
              type="button"
              onClick={loadOverview}
              className="border border-neutral-300 px-3 py-1.5 rounded-lg text-xs font-semibold hover:border-black cursor-pointer"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="lg:hidden bg-black text-white px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 sm:px-6 pt-5 sm:pt-6 pb-24 lg:pb-10 max-w-7xl w-full mx-auto space-y-6">
          {error && (
            <div role="alert" className="bg-white border border-black rounded-xl p-4 text-sm font-medium flex justify-between">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} className="text-xs underline cursor-pointer">
                Dismiss
              </button>
            </div>
          )}
          {toast && (
            <div className="bg-black text-white rounded-xl p-3.5 text-sm font-medium flex justify-between items-center">
              <span>{toast}</span>
              <button type="button" onClick={() => setToast(null)} className="text-xs underline cursor-pointer">
                Close
              </button>
            </div>
          )}

          {loading ? (
            <div className="bg-white border border-neutral-200 rounded-xl p-10 text-sm text-neutral-500">
              Loading platform telemetry...
            </div>
          ) : (
            <>
              {/* OVERVIEW & LIVE MAP */}
              {section === 'overview' && (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-white border border-neutral-200 rounded-xl p-5">
                      <p className="text-xs text-neutral-500">Active Deliveries</p>
                      <p className="font-display font-extrabold text-3xl mt-1 tabular-nums">
                        {activeDeliveries.length}
                      </p>
                      <p className="text-xs text-neutral-500 mt-1 tabular-nums">
                        {completedDeliveries.length} completed · {cancelledDeliveries.length} cancelled
                      </p>
                    </div>
                    <div className="bg-white border border-neutral-200 rounded-xl p-5">
                      <p className="text-xs text-neutral-500">Fleet Status ({riders.length} Riders)</p>
                      <p className="font-display font-extrabold text-3xl mt-1 tabular-nums">
                        {availableRiders.length + busyRiders.length} Online
                      </p>
                      <p className="text-xs text-neutral-500 mt-1 tabular-nums">
                        {availableRiders.length} available · {busyRiders.length} busy · {offlineRiders.length} offline
                      </p>
                    </div>
                    <div className="bg-white border border-neutral-200 rounded-xl p-5">
                      <p className="text-xs text-neutral-500">Registered Customers</p>
                      <p className="font-display font-extrabold text-3xl mt-1 tabular-nums">
                        {customers.length}
                      </p>
                      <p className="text-xs text-neutral-500 mt-1 tabular-nums">
                        {deliveries.length} total parcel orders
                      </p>
                    </div>
                    <div className="bg-white border border-neutral-200 rounded-xl p-5">
                      <p className="text-xs text-neutral-500">Gross Parcel Volume</p>
                      <p className="font-display font-extrabold text-3xl mt-1 tabular-nums">
                        {formatNaira(grossVolumeNgn)}
                      </p>
                      <p className="text-xs text-neutral-500 mt-1 tabular-nums">
                        Max {settings?.maxActiveParcelsPerRider} parcels/rider
                      </p>
                    </div>
                  </div>

                  {/* Operations Action Queue */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setDeliveryFilter('needs_rider');
                        setSection('deliveries');
                      }}
                      className="bg-white border border-neutral-200 hover:border-black rounded-xl p-4 text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-neutral-500">Needs Rider</span>
                        <span className="font-mono font-bold text-sm tabular-nums">
                          {needsRiderDeliveries.length}
                        </span>
                      </div>
                      <p className="text-xs font-semibold mt-1 text-black">
                        {needsRiderDeliveries.length > 0 ? 'Assign or retry dispatch →' : 'All parcels covered'}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSection('riders')}
                      className="bg-white border border-neutral-200 hover:border-black rounded-xl p-4 text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-neutral-500">Pending Rider Ticks</span>
                        <span className="font-mono font-bold text-sm tabular-nums">
                          {pendingVerificationRiders.length}
                        </span>
                      </div>
                      <p className="text-xs font-semibold mt-1 text-black">
                        {pendingVerificationRiders.length > 0 ? 'Review rider verification →' : 'All riders reviewed'}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSection('chats')}
                      className="bg-white border border-neutral-200 hover:border-black rounded-xl p-4 text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-neutral-500">Unread Live Chats</span>
                        <span className="font-mono font-bold text-sm tabular-nums">
                          {totalUnreadChats}
                        </span>
                      </div>
                      <p className="text-xs font-semibold mt-1 text-black">
                        {chatPresence.adminOnline ? 'Desk online · View chats →' : 'Desk away · View chats →'}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTicketStatusFilter('active');
                        setSection('finance');
                      }}
                      className="bg-white border border-neutral-200 hover:border-black rounded-xl p-4 text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-neutral-500">Open Tickets</span>
                        <span className="font-mono font-bold text-sm tabular-nums">
                          {openTicketsCount}
                        </span>
                      </div>
                      <p className="text-xs font-semibold mt-1 text-black">
                        {openTicketsCount > 0 ? 'Respond to client tickets →' : 'Zero open tickets'}
                      </p>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    <div className="lg:col-span-8">
                      <LiveNigeriaMap
                        deliveries={deliveries}
                        riders={riders}
                        focusedDelivery={focusedDelivery}
                        onSelectDelivery={(d) => setFocusedDelivery(d)}
                        heightClass="h-[460px]"
                      />
                    </div>

                    <div className="lg:col-span-4 bg-white border border-neutral-200 rounded-xl p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <h2 className="font-display font-bold text-base">Live Queue</h2>
                        <button
                          type="button"
                          onClick={() => setSection('deliveries')}
                          className="text-xs font-semibold underline cursor-pointer"
                        >
                          Manage all
                        </button>
                      </div>
                      {activeDeliveries.length === 0 ? (
                        <p className="text-sm text-neutral-500 py-6 text-center">
                          No active parcels right now.
                        </p>
                      ) : (
                        <ul className="divide-y divide-neutral-200">
                          {activeDeliveries.slice(0, 6).map((d) => (
                            <li key={d.id} className="py-3 flex items-start justify-between gap-3">
                              <button
                                type="button"
                                onClick={() => setFocusedDelivery(d)}
                                className="text-left cursor-pointer min-w-0"
                              >
                                <p className="font-mono text-xs font-bold">{d.trackingCode}</p>
                                <p className="text-xs text-neutral-700 mt-0.5 truncate">
                                  {d.pickupState} → {d.destinationState}
                                </p>
                                <p className="text-xs text-neutral-500 capitalize truncate">
                                  {formatDeliveryStatusLabel(d.status)} · {d.assignedRiderName || 'Unassigned'}
                                </p>
                              </button>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => setInspectedDelivery(d)}
                                  className="text-xs font-semibold border border-neutral-300 px-2 py-1 rounded hover:border-black cursor-pointer"
                                >
                                  Details
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAssigningDelivery(d);
                                    setSelectedRiderId(d.assignedRiderId || '');
                                  }}
                                  className="text-xs font-semibold border border-black px-2 py-1 rounded hover:bg-neutral-100 cursor-pointer"
                                >
                                  Assign
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* DELIVERIES MANAGEMENT */}
              {section === 'deliveries' && (
                <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
                  <div className="p-4 sm:p-5 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-1 p-1 bg-neutral-100 rounded-lg overflow-x-auto max-w-full">
                      {(
                        [
                          { id: 'all', label: 'All' },
                          { id: 'active', label: 'Active' },
                          { id: 'needs_rider', label: 'Needs Rider' },
                          { id: 'delivered', label: 'Delivered' },
                          { id: 'cancelled', label: 'Cancelled' },
                        ] as const
                      ).map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setDeliveryFilter(f.id)}
                          className={`px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap ${
                            deliveryFilter === f.id ? 'bg-white text-black shadow-sm' : 'text-neutral-600'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search code, state, or customer..."
                        aria-label="Search deliveries"
                        className="border border-neutral-300 rounded-lg px-3.5 py-2 text-base sm:text-sm flex-1 min-w-0 sm:w-64 focus:outline-none focus:ring-2 focus:ring-black"
                      />
                      {filteredDeliveries.length > 0 && (
                        <button
                          type="button"
                          onClick={handleExportDeliveriesCsv}
                          className="inline-flex items-center gap-1.5 border border-black px-3 py-2 rounded-lg text-xs font-semibold hover:bg-neutral-100 shrink-0 cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Export CSV</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {filteredDeliveries.length === 0 ? (
                    <div className="p-10 text-center text-sm text-neutral-500">
                      No parcel deliveries match the selected filter.
                    </div>
                  ) : (
                    <>
                      {/* Mobile Delivery Cards */}
                      <div className="md:hidden divide-y divide-neutral-200">
                        {filteredDeliveries.map((d) => (
                          <div key={d.id} className="p-4 space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs font-bold">{d.trackingCode}</span>
                              <span className="text-xs font-semibold capitalize border border-neutral-300 px-2 py-0.5 rounded">
                                {d.status.replace(/_/g, ' ')}
                              </span>
                            </div>
                            <p className="font-display font-bold text-sm">
                              {d.pickupState} → {d.destinationState}
                            </p>
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-600">
                              <span>
                                Client: <strong className="text-black">{d.customerName}</strong>
                              </span>
                              <span className="font-mono font-bold text-black tabular-nums">
                                {formatNaira(d.deliveryFeeNgn)}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                              <span className="text-xs text-neutral-500 inline-flex items-center gap-1">
                                <span>Rider: {d.assignedRiderName || 'Unassigned'}</span>
                                {d.assignedRiderVerified && <BadgeCheck className="w-3.5 h-3.5 text-black" />}
                              </span>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => setInspectedDelivery(d)}
                                  className="border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold cursor-pointer"
                                >
                                  Details
                                </button>
                                {['pending_dispatch', 'no_rider_available'].includes(d.status) && (
                                  <button
                                    type="button"
                                    disabled={retryingDispatchId === d.id}
                                    onClick={() => handleRetryDispatch(d.id)}
                                    className="border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                                  >
                                    <RefreshCw className="w-3 h-3" />
                                    <span>{retryingDispatchId === d.id ? '...' : 'Retry'}</span>
                                  </button>
                                )}
                                {!['delivered', 'cancelled'].includes(d.status) && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setAssigningDelivery(d);
                                      setSelectedRiderId(d.assignedRiderId || '');
                                    }}
                                    className="border border-black px-2.5 py-1 rounded text-xs font-semibold cursor-pointer"
                                  >
                                    Reassign
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Desktop Delivery Table */}
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-neutral-50 border-b border-neutral-200 text-xs text-neutral-500">
                            <tr>
                              <th className="py-3 px-4 font-semibold">Tracking</th>
                              <th className="py-3 px-4 font-semibold">Route</th>
                              <th className="py-3 px-4 font-semibold">Customer</th>
                              <th className="py-3 px-4 font-semibold">Rider</th>
                              <th className="py-3 px-4 font-semibold">Status</th>
                              <th className="py-3 px-4 font-semibold text-right">Fee</th>
                              <th className="py-3 px-4 font-semibold text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-200">
                            {filteredDeliveries.map((d) => (
                              <tr key={d.id} className="hover:bg-neutral-50">
                                <td className="py-3 px-4 font-mono text-xs font-semibold">
                                  {d.trackingCode}
                                </td>
                                <td className="py-3 px-4">
                                  <span className="font-medium">
                                    {d.pickupState} → {d.destinationState}
                                  </span>
                                  <span className="block text-xs text-neutral-500 tabular-nums">
                                    {d.serviceTier.replace('_', ' ')} · {d.distanceKm} km
                                  </span>
                                </td>
                                <td className="py-3 px-4">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const match = customers.find((c) => c.customerId === d.customerId);
                                      if (match) {
                                        setInspectedUserRef({ kind: 'customer', profileId: match.id });
                                      }
                                    }}
                                    className="font-medium hover:underline cursor-pointer text-left"
                                  >
                                    {d.customerName}
                                  </button>
                                </td>
                                <td className="py-3 px-4">
                                  {d.assignedRiderName ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const match = riders.find(
                                          (r) => r.riderId === d.assignedRiderId
                                        );
                                        if (match) {
                                          setInspectedUserRef({ kind: 'rider', profileId: match.id });
                                        }
                                      }}
                                      className="hover:underline cursor-pointer text-left inline-flex items-center gap-1"
                                    >
                                      <span>{d.assignedRiderName}</span>
                                      {d.assignedRiderVerified && (
                                        <BadgeCheck aria-label="Verified rider" className="w-3.5 h-3.5 text-black shrink-0" />
                                      )}
                                    </button>
                                  ) : (
                                    <span className="text-neutral-400">Unassigned</span>
                                  )}
                                </td>
                                <td className="py-3 px-4 capitalize text-xs font-semibold">
                                  {d.status.replace(/_/g, ' ')}
                                </td>
                                <td className="py-3 px-4 text-right font-mono tabular-nums">
                                  {formatNaira(d.deliveryFeeNgn)}
                                </td>
                                <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => setInspectedDelivery(d)}
                                    className="border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold hover:border-black cursor-pointer"
                                  >
                                    Details
                                  </button>
                                  {['pending_dispatch', 'no_rider_available'].includes(d.status) && (
                                    <button
                                      type="button"
                                      disabled={retryingDispatchId === d.id}
                                      onClick={() => handleRetryDispatch(d.id)}
                                      className="border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold hover:border-black inline-flex items-center gap-1 cursor-pointer"
                                    >
                                      <RefreshCw className="w-3 h-3" />
                                      <span>{retryingDispatchId === d.id ? '...' : 'Retry'}</span>
                                    </button>
                                  )}
                                  {!['delivered', 'cancelled'].includes(d.status) && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setAssigningDelivery(d);
                                          setSelectedRiderId(d.assignedRiderId || '');
                                        }}
                                        className="border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold hover:border-black cursor-pointer"
                                      >
                                        Reassign
                                      </button>
                                      {confirmCancelId === d.id ? (
                                        <button
                                          type="button"
                                          onClick={() => handleCancelDelivery(d.id)}
                                          className="bg-black text-white px-2.5 py-1 rounded text-xs font-semibold cursor-pointer"
                                        >
                                          Confirm Cancel
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => setConfirmCancelId(d.id)}
                                          className="border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold hover:border-black cursor-pointer"
                                        >
                                          Cancel
                                        </button>
                                      )}
                                    </>
                                  )}
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

              {/* RIDERS MANAGEMENT */}
              {section === 'riders' && (
                <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
                  <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h2 className="font-display font-bold text-xl">
                        Fleet Riders ({filteredRiders.length})
                      </h2>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        Issue rider accounts, enable Admin Verification Ticks, edit vehicles, or manage status.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
                      <div className="relative flex-1 sm:w-64">
                        <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={userSearch}
                          onChange={(e) => setUserSearch(e.target.value)}
                          placeholder="Search rider, phone, plate..."
                          aria-label="Search riders"
                          className="w-full border border-neutral-300 rounded-lg pl-9 pr-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setIssueRiderOpen(true)}
                        className="inline-flex items-center gap-1.5 bg-black text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-neutral-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Issue Rider Account</span>
                      </button>
                    </div>
                  </div>

                  {filteredRiders.length === 0 ? (
                    <div className="p-10 text-center space-y-3">
                      <Truck className="w-8 h-8 mx-auto text-neutral-400" />
                      <p className="font-display font-bold text-base">No rider accounts issued yet</p>
                      <p className="text-xs text-neutral-500">
                        Issue a new dispatch rider account and enable their verification tick so they can go online.
                      </p>
                      <button
                        type="button"
                        onClick={() => setIssueRiderOpen(true)}
                        className="inline-flex items-center gap-1.5 bg-black text-white px-4 py-2 rounded-lg text-xs font-bold cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Issue First Rider</span>
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* Mobile Rider Cards */}
                      <div className="md:hidden divide-y divide-neutral-200">
                        {filteredRiders.map((r) => (
                          <div key={r.riderId} className="p-4 space-y-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-display font-bold text-base inline-flex items-center gap-1.5">
                                  <span>{r.fullName}</span>
                                  {r.verificationStatus === 'verified' && (
                                    <BadgeCheck aria-label="Verified rider tick" className="w-4 h-4 text-black shrink-0" />
                                  )}
                                </p>
                                <p className="font-mono text-xs text-neutral-600">{r.phone}</p>
                                <p className="text-xs text-neutral-500 mt-0.5">
                                  {r.homeState} · {r.vehicleType} ({r.plateNumber})
                                </p>
                              </div>
                              <span className="text-xs font-semibold capitalize border border-neutral-300 px-2 py-0.5 rounded">
                                {r.isOnline ? 'Online' : 'Offline'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-xs text-neutral-600">
                              <span className="inline-flex items-center gap-1.5">
                                {r.verificationStatus === 'verified' ? (
                                  <span className="inline-flex items-center gap-1 bg-black text-white px-2 py-0.5 rounded text-[11px] font-semibold">
                                    <BadgeCheck className="w-3 h-3" />
                                    <span>Verified Tick Active</span>
                                  </span>
                                ) : (
                                  <span className="capitalize">
                                    Verification: <strong className="text-black">{r.verificationStatus}</strong>
                                  </span>
                                )}
                              </span>
                              <span className="font-mono tabular-nums">
                                Load: {r.activeParcelsCount}/{settings?.maxActiveParcelsPerRider ?? 3}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingRiderMode(false);
                                  setInspectedUserRef({ kind: 'rider', profileId: r.id });
                                }}
                                className="inline-flex items-center gap-1 border border-black px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>View Details</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleVerifyRider(
                                    r.riderId,
                                    r.verificationStatus === 'verified' ? 'pending' : 'verified'
                                  )
                                }
                                className={
                                  r.verificationStatus === 'verified'
                                    ? 'border border-neutral-300 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer'
                                    : 'bg-black text-white px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer'
                                }
                              >
                                {r.verificationStatus === 'verified' ? 'Revoke Tick' : 'Enable Tick'}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleToggleAccountStatus(
                                    r.id,
                                    r.accountStatus === 'active' ? 'suspended' : 'active'
                                  )
                                }
                                className="border border-neutral-300 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                              >
                                {r.accountStatus === 'active' ? 'Suspend' : 'Activate'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Desktop Rider Table */}
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-neutral-50 border-b border-neutral-200 text-xs text-neutral-500">
                            <tr>
                              <th className="py-3 px-4 font-semibold">Rider</th>
                              <th className="py-3 px-4 font-semibold">State / Vehicle</th>
                              <th className="py-3 px-4 font-semibold">Availability</th>
                              <th className="py-3 px-4 font-semibold">Workload</th>
                              <th className="py-3 px-4 font-semibold">Verification Tick</th>
                              <th className="py-3 px-4 font-semibold">Account</th>
                              <th className="py-3 px-4 font-semibold text-right">Controls</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-200">
                            {filteredRiders.map((r) => (
                              <tr key={r.riderId} className="hover:bg-neutral-50">
                                <td className="py-3 px-4">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingRiderMode(false);
                                      setInspectedUserRef({ kind: 'rider', profileId: r.id });
                                    }}
                                    className="text-left hover:underline cursor-pointer"
                                  >
                                    <p className="font-semibold inline-flex items-center gap-1.5">
                                      <span>{r.fullName}</span>
                                      {r.verificationStatus === 'verified' && (
                                        <BadgeCheck aria-label="Verified rider tick" className="w-4 h-4 text-black shrink-0" />
                                      )}
                                    </p>
                                    <p className="font-mono text-xs text-neutral-500">{r.phone}</p>
                                  </button>
                                </td>
                                <td className="py-3 px-4">
                                  <p>{r.homeState}</p>
                                  <p className="text-xs text-neutral-500 font-mono">
                                    {r.vehicleType} · {r.plateNumber}
                                  </p>
                                </td>
                                <td className="py-3 px-4 text-xs font-semibold">
                                  {r.isOnline ? 'Online' : 'Offline'}
                                </td>
                                <td className="py-3 px-4 font-mono text-xs tabular-nums">
                                  {r.activeParcelsCount} / {settings?.maxActiveParcelsPerRider ?? 3}
                                </td>
                                <td className="py-3 px-4 text-xs">
                                  {r.verificationStatus === 'verified' ? (
                                    <span className="inline-flex items-center gap-1 bg-black text-white px-2 py-0.5 rounded font-semibold">
                                      <BadgeCheck className="w-3.5 h-3.5" />
                                      <span>Verified</span>
                                    </span>
                                  ) : (
                                    <span className="capitalize font-semibold text-neutral-500">
                                      {r.verificationStatus}
                                    </span>
                                  )}
                                </td>
                                <td className="py-3 px-4 capitalize text-xs font-semibold">
                                  {r.accountStatus}
                                </td>
                                <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingRiderMode(false);
                                      setInspectedUserRef({ kind: 'rider', profileId: r.id });
                                    }}
                                    className="border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold hover:border-black cursor-pointer"
                                  >
                                    Details
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleVerifyRider(
                                        r.riderId,
                                        r.verificationStatus === 'verified' ? 'pending' : 'verified'
                                      )
                                    }
                                    className={
                                      r.verificationStatus === 'verified'
                                        ? 'border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold hover:border-black cursor-pointer'
                                        : 'bg-black text-white px-2.5 py-1 rounded text-xs font-semibold cursor-pointer'
                                    }
                                  >
                                    {r.verificationStatus === 'verified' ? 'Revoke Tick' : 'Enable Tick'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleToggleAccountStatus(
                                        r.id,
                                        r.accountStatus === 'active' ? 'suspended' : 'active'
                                      )
                                    }
                                    className="border border-neutral-300 px-2.5 py-1 rounded text-xs font-semibold hover:border-black cursor-pointer"
                                  >
                                    {r.accountStatus === 'active' ? 'Suspend' : 'Activate'}
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

              {/* CUSTOMERS MANAGEMENT */}
              {section === 'customers' && (
                <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
                  <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h2 className="font-display font-bold text-xl">
                        Customer Accounts ({filteredCustomers.length})
                      </h2>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        Click any customer to view full contact info, parcel orders, and submitted tickets.
                      </p>
                    </div>
                    <div className="relative w-full sm:w-64">
                      <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={userSearch}
                        onChange={(e) => setUserSearch(e.target.value)}
                        placeholder="Search name, email, phone..."
                        aria-label="Search customers"
                        className="w-full border border-neutral-300 rounded-lg pl-9 pr-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                      />
                    </div>
                  </div>

                  {/* Mobile Customer Cards */}
                  <div className="md:hidden divide-y divide-neutral-200">
                    {filteredCustomers.map((c) => (
                      <div key={c.customerId} className="p-4 space-y-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-display font-bold text-base">{c.fullName}</p>
                            <p className="text-xs text-neutral-600">{c.email}</p>
                            <p className="font-mono text-xs text-neutral-600">{c.phone}</p>
                          </div>
                          <span className="capitalize text-xs font-semibold border border-neutral-300 px-2 py-0.5 rounded">
                            {c.accountStatus}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs text-neutral-500">
                          <span>{c.defaultState}</span>
                          <span className="font-mono tabular-nums">
                            {c.totalRequests} requests ({c.completedRequests} done)
                          </span>
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setInspectedUserRef({ kind: 'customer', profileId: c.id })}
                            className="inline-flex items-center gap-1 bg-black text-white px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View Details</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleToggleAccountStatus(
                                c.id,
                                c.accountStatus === 'active' ? 'suspended' : 'active'
                              )
                            }
                            className="border border-neutral-300 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                          >
                            {c.accountStatus === 'active' ? 'Suspend' : 'Activate'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop Customer Table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-neutral-50 border-b border-neutral-200 text-xs text-neutral-500">
                        <tr>
                          <th className="py-3 px-4 font-semibold">Customer</th>
                          <th className="py-3 px-4 font-semibold">Contact</th>
                          <th className="py-3 px-4 font-semibold">State</th>
                          <th className="py-3 px-4 font-semibold text-right">Requests</th>
                          <th className="py-3 px-4 font-semibold">Status</th>
                          <th className="py-3 px-4 font-semibold text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-200">
                        {filteredCustomers.map((c) => (
                          <tr key={c.customerId} className="hover:bg-neutral-50">
                            <td className="py-3 px-4">
                              <button
                                type="button"
                                onClick={() => setInspectedUserRef({ kind: 'customer', profileId: c.id })}
                                className="font-semibold hover:underline cursor-pointer text-left"
                              >
                                {c.fullName}
                              </button>
                            </td>
                            <td className="py-3 px-4">
                              <p className="text-xs">{c.email}</p>
                              <p className="font-mono text-xs text-neutral-500">{c.phone}</p>
                            </td>
                            <td className="py-3 px-4">{c.defaultState}</td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums">
                              {c.totalRequests} ({c.completedRequests} done)
                            </td>
                            <td className="py-3 px-4 capitalize text-xs font-semibold">
                              {c.accountStatus}
                            </td>
                            <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => setInspectedUserRef({ kind: 'customer', profileId: c.id })}
                                className="border border-neutral-300 px-3 py-1 rounded text-xs font-semibold hover:border-black cursor-pointer"
                              >
                                View Details
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleToggleAccountStatus(
                                    c.id,
                                    c.accountStatus === 'active' ? 'suspended' : 'active'
                                  )
                                }
                                className="border border-neutral-300 px-3 py-1 rounded text-xs font-semibold hover:border-black cursor-pointer"
                              >
                                {c.accountStatus === 'active' ? 'Suspend' : 'Activate'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* SETTINGS: DISPATCH, PRICING & WHATSAPP */}
              {section === 'settings' && settingsDraft && (
                <form
                  onSubmit={handleSaveSettings}
                  className="bg-white border border-neutral-200 rounded-xl p-6 sm:p-8 max-w-3xl space-y-6"
                >
                  <div>
                    <h2 className="font-display font-bold text-xl">
                      Smart Dispatch, Pricing & WhatsApp Settings
                    </h2>
                    <p className="text-sm text-neutral-600 mt-1">
                      Changes take effect immediately across all quotes, smart rider assignments, and customer support links.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-neutral-200 pt-5">
                    <div>
                      <label htmlFor="set-max-parcels" className="block text-xs font-semibold mb-1.5">
                        Max Active Parcels / Rider
                      </label>
                      <input
                        id="set-max-parcels"
                        type="number"
                        min={1}
                        max={20}
                        value={settingsDraft.maxActiveParcelsPerRider}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            maxActiveParcelsPerRider: Number(e.target.value),
                          })
                        }
                        className="w-full border border-neutral-300 rounded-lg px-3.5 py-2 text-sm font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label htmlFor="set-radius" className="block text-xs font-semibold mb-1.5">
                        Search Radius (km)
                      </label>
                      <input
                        id="set-radius"
                        type="number"
                        min={5}
                        max={500}
                        value={settingsDraft.searchRadiusKm}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            searchRadiusKm: Number(e.target.value),
                          })
                        }
                        className="w-full border border-neutral-300 rounded-lg px-3.5 py-2 text-sm font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label htmlFor="set-timeout" className="block text-xs font-semibold mb-1.5">
                        Offer Timeout (sec)
                      </label>
                      <input
                        id="set-timeout"
                        type="number"
                        min={10}
                        max={300}
                        value={settingsDraft.offerTimeoutSeconds}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            offerTimeoutSeconds: Number(e.target.value),
                          })
                        }
                        className="w-full border border-neutral-300 rounded-lg px-3.5 py-2 text-sm font-mono tabular-nums"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-neutral-200 pt-5">
                    <div>
                      <label htmlFor="set-base-fee" className="block text-xs font-semibold mb-1.5">
                        Base Local Fee (₦)
                      </label>
                      <input
                        id="set-base-fee"
                        type="number"
                        min={500}
                        step={100}
                        value={settingsDraft.baseLocalFeeNgn}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            baseLocalFeeNgn: Number(e.target.value),
                          })
                        }
                        className="w-full border border-neutral-300 rounded-lg px-3.5 py-2 text-sm font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label htmlFor="set-per-km" className="block text-xs font-semibold mb-1.5">
                        Rate per km (₦)
                      </label>
                      <input
                        id="set-per-km"
                        type="number"
                        min={10}
                        value={settingsDraft.perKmRateNgn}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            perKmRateNgn: Number(e.target.value),
                          })
                        }
                        className="w-full border border-neutral-300 rounded-lg px-3.5 py-2 text-sm font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label htmlFor="set-interstate" className="block text-xs font-semibold mb-1.5">
                        Inter-State Corridor Fee (₦)
                      </label>
                      <input
                        id="set-interstate"
                        type="number"
                        min={0}
                        step={100}
                        value={settingsDraft.interStateSurchargeNgn}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            interStateSurchargeNgn: Number(e.target.value),
                          })
                        }
                        className="w-full border border-neutral-300 rounded-lg px-3.5 py-2 text-sm font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label htmlFor="set-commission" className="block text-xs font-semibold mb-1.5">
                        Rider Payout Share (%)
                      </label>
                      <input
                        id="set-commission"
                        type="number"
                        min={40}
                        max={95}
                        value={settingsDraft.riderCommissionPercent}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            riderCommissionPercent: Number(e.target.value),
                          })
                        }
                        className="w-full border border-neutral-300 rounded-lg px-3.5 py-2 text-sm font-mono tabular-nums"
                      />
                    </div>
                  </div>

                  <div className="border-t border-neutral-200 pt-5">
                    <label htmlFor="set-whatsapp" className="block text-xs font-semibold mb-1.5">
                      Official WhatsApp Support Number (digits with country code)
                    </label>
                    <input
                      id="set-whatsapp"
                      type="text"
                      value={settingsDraft.whatsappSupportNumber}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settingsDraft,
                          whatsappSupportNumber: e.target.value,
                        })
                      }
                      placeholder="2348007276000"
                      className="w-full border border-neutral-300 rounded-lg px-3.5 py-2 text-sm font-mono"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={savingSettings}
                    className="bg-black text-white px-6 py-3 rounded-lg text-sm font-bold hover:bg-neutral-800 cursor-pointer"
                  >
                    {savingSettings ? 'Saving...' : 'Save Platform Settings'}
                  </button>
                </form>
              )}

              {/* FINANCE, TICKETS & SUGGESTIONS */}
              {section === 'finance' && (
                <div className="space-y-6">
                  {/* Financial Summary Breakdown */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="bg-white border border-neutral-200 rounded-xl p-5">
                      <p className="text-xs text-neutral-500">Gross Parcel Volume</p>
                      <p className="font-display font-extrabold text-2xl mt-1 tabular-nums">
                        {formatNaira(grossVolumeNgn)}
                      </p>
                      <p className="text-xs text-neutral-500 mt-1 tabular-nums">
                        {nonRefundedPayments.length} active/settled transactions
                      </p>
                    </div>
                    <div className="bg-white border border-neutral-200 rounded-xl p-5">
                      <p className="text-xs text-neutral-500">Rider Payout Pool</p>
                      <p className="font-display font-extrabold text-2xl mt-1 tabular-nums">
                        {formatNaira(riderPayoutsNgn)}
                      </p>
                      <p className="text-xs text-neutral-500 mt-1">Allocated to verified fleet</p>
                    </div>
                    <div className="bg-white border border-neutral-200 rounded-xl p-5">
                      <p className="text-xs text-neutral-500">SAQO Net Revenue</p>
                      <p className="font-display font-extrabold text-2xl mt-1 tabular-nums">
                        {formatNaira(platformRevenueNgn)}
                      </p>
                      <p className="text-xs text-neutral-500 mt-1">Platform commission share</p>
                    </div>
                  </div>

                  <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
                    <div className="px-4 sm:px-6 py-4 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4" />
                        <h2 className="font-display font-bold text-lg">
                          Tickets: Complaints & Suggestions ({filteredTickets.length})
                        </h2>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1 p-1 bg-neutral-100 rounded-lg">
                          {(['all', 'complaint', 'suggestion'] as const).map((tf) => (
                            <button
                              key={tf}
                              type="button"
                              onClick={() => setTicketFilter(tf)}
                              className={`px-3 py-1 rounded-md text-xs font-semibold capitalize cursor-pointer ${
                                ticketFilter === tf ? 'bg-white text-black shadow-sm' : 'text-neutral-600'
                              }`}
                            >
                              {tf}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-1 p-1 bg-neutral-100 rounded-lg">
                          {(
                            [
                              { id: 'all', label: 'All Status' },
                              { id: 'active', label: 'Open' },
                              { id: 'resolved', label: 'Resolved' },
                            ] as const
                          ).map((sf) => (
                            <button
                              key={sf.id}
                              type="button"
                              onClick={() => setTicketStatusFilter(sf.id)}
                              className={`px-3 py-1 rounded-md text-xs font-semibold cursor-pointer ${
                                ticketStatusFilter === sf.id
                                  ? 'bg-white text-black shadow-sm'
                                  : 'text-neutral-600'
                              }`}
                            >
                              {sf.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {filteredTickets.length === 0 ? (
                      <div className="p-8 text-center text-sm text-neutral-500">
                        No matching tickets.
                      </div>
                    ) : (
                      <ul className="divide-y divide-neutral-200">
                        {filteredTickets.map((c) => (
                          <li key={c.id} className="p-4 sm:p-5 space-y-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                  <span className="border border-black px-2 py-0.5 rounded font-semibold uppercase tracking-wide text-[10px]">
                                    {c.ticketType === 'suggestion' ? 'Suggestion' : 'Complaint'}
                                  </span>
                                  <span className="font-mono text-neutral-500">
                                    {c.trackingCode || 'General'}
                                  </span>
                                  <span className="text-neutral-500">·</span>
                                  <span className="font-semibold text-black">{c.reporterName}</span>
                                  {c.reporterPhone && (
                                    <span className="font-mono text-neutral-500">({c.reporterPhone})</span>
                                  )}
                                </div>
                                <p className="font-display font-bold text-sm mt-1.5">{c.subject}</p>
                                <p className="text-sm text-neutral-600 mt-1">{c.details}</p>
                                {c.resolutionNote && (
                                  <p className="text-xs text-neutral-700 bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-2 mt-2">
                                    <strong>Response:</strong> {c.resolutionNote}
                                  </p>
                                )}
                              </div>
                              <span className="capitalize text-xs font-semibold border border-neutral-300 px-2.5 py-0.5 rounded shrink-0">
                                {c.status}
                              </span>
                            </div>

                            {c.status !== 'resolved' ? (
                              <div className="flex flex-wrap items-center gap-2 pt-1">
                                <input
                                  type="text"
                                  value={resolutionDrafts[c.id] || ''}
                                  onChange={(e) =>
                                    setResolutionDrafts((prev) => ({
                                      ...prev,
                                      [c.id]: e.target.value,
                                    }))
                                  }
                                  placeholder="Optional response note for client..."
                                  className="flex-1 min-w-[200px] border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs"
                                />
                                {c.status === 'open' && (
                                  <button
                                    type="button"
                                    onClick={() => handleUpdateComplaint(c.id, 'investigating')}
                                    className="border border-black px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                                  >
                                    Investigating
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleUpdateComplaint(c.id, 'resolved')}
                                  className="bg-black text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                                >
                                  Mark Resolved
                                </button>
                              </div>
                            ) : (
                              <div className="pt-1">
                                <button
                                  type="button"
                                  onClick={() => handleUpdateComplaint(c.id, 'open')}
                                  className="border border-neutral-300 hover:border-black px-3 py-1 rounded-lg text-xs font-semibold cursor-pointer"
                                >
                                  Reopen Ticket
                                </button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
                    <div className="px-6 py-4 border-b border-neutral-200 flex items-center justify-between gap-3">
                      <h2 className="font-display font-bold text-lg">Transaction Records</h2>
                      {payments.length > 0 && (
                        <button
                          type="button"
                          onClick={handleExportLedgerCsv}
                          className="inline-flex items-center gap-1.5 border border-black px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-neutral-100 cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Export CSV</span>
                        </button>
                      )}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-neutral-50 border-b border-neutral-200 text-xs text-neutral-500">
                          <tr>
                            <th className="py-3 px-4 font-semibold">Tracking</th>
                            <th className="py-3 px-4 font-semibold">Customer</th>
                            <th className="py-3 px-4 font-semibold">Status</th>
                            <th className="py-3 px-4 font-semibold text-right">Total Fee</th>
                            <th className="py-3 px-4 font-semibold text-right">Rider Payout</th>
                            <th className="py-3 px-4 font-semibold text-right">Platform Fee</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-200">
                          {payments.map((p) => (
                            <tr key={p.id}>
                              <td className="py-3 px-4 font-mono text-xs">{p.trackingCode}</td>
                              <td className="py-3 px-4">{p.customerName}</td>
                              <td className="py-3 px-4 capitalize text-xs font-semibold">{p.status}</td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums">
                                {formatNaira(p.amountNgn)}
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums">
                                {formatNaira(p.riderPayoutNgn)}
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums">
                                {formatNaira(p.platformFeeNgn)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
              {/* PERSISTENT SUPPORT CHATS */}
              {section === 'chats' && (
                <div className="space-y-4">
                  {/* Live Presence & Filters Bar */}
                  <div className="bg-white border border-neutral-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          chatPresence.adminOnline
                            ? 'bg-black'
                            : 'bg-neutral-200 border border-neutral-400'
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-display font-bold">
                          {chatPresence.adminOnline
                            ? 'Live Chat Status: Online'
                            : 'Live Chat Status: Away (Offline)'}
                        </p>
                        <p className="text-xs text-neutral-500">
                          {chatPresence.adminOnline
                            ? 'Visitors and clients see agents online for immediate replies.'
                            : 'Visitors are notified agents are offline and receive replies when back.'}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleToggleAdminPresence}
                        className={`px-3.5 py-2 rounded-lg text-xs font-semibold cursor-pointer border ${
                          adminAcceptingChats
                            ? 'bg-black text-white border-black hover:bg-neutral-800'
                            : 'bg-white text-black border-black hover:bg-neutral-100'
                        }`}
                      >
                        {adminAcceptingChats ? 'Set Status: Away' : 'Go Online'}
                      </button>
                      <div className="flex items-center gap-1 p-1 bg-neutral-100 rounded-lg">
                        {(['all', 'open', 'pending', 'resolved'] as const).map((cf) => (
                          <button
                            key={cf}
                            type="button"
                            onClick={() => setChatFilter(cf)}
                            className={`px-2.5 py-1 rounded-md text-xs font-semibold capitalize cursor-pointer ${
                              chatFilter === cf
                                ? 'bg-white text-black shadow-sm'
                                : 'text-neutral-600'
                            }`}
                          >
                            {cf}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Two-pane persistent chat desk */}
                  <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 min-h-[540px]">
                    {/* Conversation List */}
                    <div
                      className={`lg:col-span-4 border-b lg:border-b-0 lg:border-r border-neutral-200 flex flex-col ${
                        activeChatId ? 'hidden lg:flex' : 'flex'
                      }`}
                    >
                      <div className="p-3 border-b border-neutral-200">
                        <div className="relative">
                          <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={chatSearch}
                            onChange={(e) => setChatSearch(e.target.value)}
                            placeholder="Search name, phone, SQ-..."
                            className="w-full min-w-0 border border-neutral-300 rounded-lg pl-8 pr-3 py-2 text-base sm:text-xs"
                          />
                        </div>
                      </div>

                      <div className="flex-1 overflow-y-auto divide-y divide-neutral-200 max-h-[520px]">
                        {filteredConversations.length === 0 ? (
                          <div className="p-8 text-center text-xs text-neutral-500">
                            No saved support conversations match your filter. All visitor and client chats stay archived here permanently.
                          </div>
                        ) : (
                          filteredConversations.map((c) => {
                            const selected = c.id === activeChatId;
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => setActiveChatId(c.id)}
                                className={`w-full text-left p-4 transition-colors cursor-pointer ${
                                  selected ? 'bg-neutral-100' : 'hover:bg-neutral-50'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="font-display font-bold text-sm truncate">
                                        {c.visitorName}
                                      </span>
                                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border border-neutral-300 text-neutral-600">
                                        {c.userId ? 'Client' : 'Visitor'}
                                      </span>
                                    </div>
                                    {c.trackingCode && (
                                      <span className="inline-block mt-1 text-[10px] font-mono font-semibold bg-black text-white px-1.5 py-0.5 rounded">
                                        {c.trackingCode}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex flex-col items-end gap-1 shrink-0">
                                    <span className="text-[10px] font-mono text-neutral-500 tabular-nums">
                                      {new Date(c.lastMessageAt).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })}
                                    </span>
                                    {c.unreadByAdmin > 0 && (
                                      <span className="px-1.5 py-0.5 rounded bg-black text-white text-[10px] font-mono font-bold tabular-nums">
                                        {c.unreadByAdmin}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <p className="text-xs text-neutral-600 truncate mt-1.5">
                                  {c.lastMessagePreview}
                                </p>
                                <div className="mt-2 flex items-center justify-between text-[10px]">
                                  <span className="capitalize font-semibold border border-neutral-300 px-1.5 py-0.5 rounded text-neutral-700">
                                    {c.status}
                                  </span>
                                  {c.visitorPhone && (
                                    <span className="font-mono text-neutral-500">
                                      {c.visitorPhone}
                                    </span>
                                  )}
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {/* Active Chat Thread */}
                    <div
                      className={`lg:col-span-8 flex flex-col min-h-[540px] max-h-[640px] ${
                        activeChatId ? 'flex' : 'hidden lg:flex'
                      }`}
                    >
                      {!activeConversation ? (
                        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-sm text-neutral-500">
                          <MessageCircle className="w-8 h-8 mb-3 text-neutral-400" />
                          <p className="font-display font-bold text-black">
                            Select a support conversation
                          </p>
                          <p className="text-xs mt-1 max-w-sm">
                            All landing page visitor chats and customer support threads stay saved permanently so no inquiry is ever lost.
                          </p>
                        </div>
                      ) : (
                        <>
                          {/* Thread Header */}
                          <div className="px-4 py-3 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-3 bg-white">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <button
                                type="button"
                                onClick={() => setActiveChatId(null)}
                                className="lg:hidden border border-neutral-300 px-2.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
                              >
                                Back
                              </button>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <h3 className="font-display font-bold text-sm truncate">
                                    {activeConversation.visitorName}
                                  </h3>
                                  {activeConversation.trackingCode && (
                                    <span className="text-[11px] font-mono bg-neutral-100 border border-neutral-300 px-2 py-0.5 rounded">
                                      {activeConversation.trackingCode}
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-[11px] text-neutral-500 mt-0.5">
                                  {activeConversation.visitorEmail && (
                                    <span className="truncate">{activeConversation.visitorEmail}</span>
                                  )}
                                  {activeConversation.visitorPhone && (
                                    <a
                                      href={`tel:${activeConversation.visitorPhone}`}
                                      className="font-mono underline text-black"
                                    >
                                      {activeConversation.visitorPhone}
                                    </a>
                                  )}
                                  {!activeConversation.visitorEmail &&
                                    !activeConversation.visitorPhone && (
                                      <span>Website visitor session</span>
                                    )}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <label htmlFor="admin-chat-status" className="sr-only">
                                Conversation status
                              </label>
                              <select
                                id="admin-chat-status"
                                value={activeConversation.status}
                                onChange={(e) =>
                                  handleUpdateConversationStatus(
                                    activeConversation.id,
                                    e.target.value as SupportConversationStatus
                                  )
                                }
                                className="border border-neutral-300 rounded-lg px-2.5 py-1.5 text-xs font-semibold capitalize bg-white cursor-pointer"
                              >
                                <option value="open">Open</option>
                                <option value="pending">Pending</option>
                                <option value="resolved">Resolved</option>
                                <option value="closed">Closed</option>
                              </select>
                            </div>
                          </div>

                          {/* Message History */}
                          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-neutral-50">
                            {loadingChatMessages ? (
                              <p className="text-xs text-neutral-500 text-center py-6">
                                Loading message history...
                              </p>
                            ) : chatMessages.length === 0 ? (
                              <p className="text-xs text-neutral-500 text-center py-6">
                                No messages yet.
                              </p>
                            ) : (
                              chatMessages.map((m) => {
                                if (m.senderRole === 'system') {
                                  return (
                                    <div key={m.id} className="flex justify-center">
                                      <span className="text-[11px] font-mono text-neutral-500 bg-white border border-neutral-200 rounded-full px-3 py-1">
                                        {m.body}
                                      </span>
                                    </div>
                                  );
                                }
                                const isAdminMsg = m.senderRole === 'admin';
                                return (
                                  <div
                                    key={m.id}
                                    className={`flex flex-col ${
                                      isAdminMsg ? 'items-end' : 'items-start'
                                    }`}
                                  >
                                    <div
                                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                                        isAdminMsg
                                          ? 'bg-black text-white rounded-br-sm'
                                          : 'bg-white border border-neutral-200 text-black rounded-bl-sm'
                                      }`}
                                    >
                                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                                    </div>
                                    <span className="text-[10px] font-mono text-neutral-400 mt-1 tabular-nums">
                                      {m.senderName} ·{' '}
                                      {new Date(m.createdAt).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })}
                                    </span>
                                  </div>
                                );
                              })
                            )}
                            {visitorTypingConvId === activeConversation.id && (
                              <div className="text-xs text-neutral-500 font-mono">
                                {activeConversation.visitorName} is typing...
                              </div>
                            )}
                            <div ref={adminChatEndRef} />
                          </div>

                          {/* Quick Canned Replies */}
                          <div className="px-4 py-2 border-t border-neutral-200 bg-white flex items-center gap-2 overflow-x-auto">
                            {[
                              'Checking rider location now.',
                              'Please share your 4-digit OTP.',
                              'Verified rider assigned.',
                            ].map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => setChatReply(preset)}
                                className="shrink-0 border border-neutral-300 hover:border-black rounded-lg px-2.5 py-1 text-[11px] font-medium text-neutral-700 cursor-pointer"
                              >
                                {preset}
                              </button>
                            ))}
                          </div>

                          {/* Reply Input */}
                          <form
                            onSubmit={(e) => handleSendAdminReply(e)}
                            className="p-3 border-t border-neutral-200 bg-white flex items-center gap-2"
                          >
                            <input
                              type="text"
                              value={chatReply}
                              onChange={(e) => {
                                setChatReply(e.target.value);
                                const now = Date.now();
                                if (now - lastAdminTypingEmitRef.current > 1500) {
                                  lastAdminTypingEmitRef.current = now;
                                  sendEvent({
                                    type: 'support:typing',
                                    conversationId: activeConversation.id,
                                    senderRole: 'admin',
                                    senderName: profile.fullName,
                                    isTyping: e.target.value.trim().length > 0,
                                  });
                                }
                              }}
                              placeholder={`Reply to ${activeConversation.visitorName}...`}
                              className="flex-1 min-w-0 w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm"
                            />
                            <button
                              type="submit"
                              disabled={sendingChat || !chatReply.trim()}
                              className="bg-black text-white px-4 py-2.5 rounded-lg text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-neutral-800 disabled:opacity-40 shrink-0 cursor-pointer"
                            >
                              <Send className="w-4 h-4" />
                              <span>{sendingChat ? 'Sending' : 'Send'}</span>
                            </button>
                          </form>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Native Mobile Bottom Navigation (5 spacious slots + More sheet) */}
      <nav
        aria-label="Admin mobile navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-neutral-200 grid grid-cols-5 pb-[env(safe-area-inset-bottom)]"
      >
        {navItems.slice(0, 4).map((item) => {
          const targetId = item.id === 'customers' ? 'chats' : item.id;
          const navItem = navItems.find((n) => n.id === targetId)!;
          return (
            <button
              key={navItem.id}
              type="button"
              onClick={() => {
                setSection(navItem.id);
                setMobileMoreOpen(false);
              }}
              className={`relative flex flex-col items-center justify-center py-2.5 px-1 gap-1 text-[11px] font-semibold ${
                section === navItem.id ? 'text-black' : 'text-neutral-600'
              }`}
            >
              {navItem.icon}
              <span className="truncate max-w-full">{navItem.mobileLabel}</span>
              {navItem.badge && (
                <span className="absolute top-1 right-2 min-w-[15px] h-[15px] px-1 rounded-full bg-black text-white text-[9px] font-mono font-bold flex items-center justify-center tabular-nums">
                  {navItem.badge}
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileMoreOpen((v) => !v)}
          aria-expanded={mobileMoreOpen}
          className={`relative flex flex-col items-center justify-center py-2.5 px-1 gap-1 text-[11px] font-semibold ${
            ['customers', 'settings', 'finance'].includes(section) || mobileMoreOpen
              ? 'text-black'
              : 'text-neutral-600'
          }`}
        >
          <MoreHorizontal className="w-4 h-4" />
          <span>More</span>
          {openTicketsCount > 0 && (
            <span className="absolute top-1 right-2 min-w-[15px] h-[15px] px-1 rounded-full bg-black text-white text-[9px] font-mono font-bold flex items-center justify-center tabular-nums">
              {openTicketsCount}
            </span>
          )}
        </button>
      </nav>

      {/* Mobile More Sections Sheet */}
      {mobileMoreOpen && (
        <div
          role="dialog"
          aria-label="More admin sections"
          className="lg:hidden fixed inset-0 z-50 bg-black/50 flex items-end justify-center"
          onClick={() => setMobileMoreOpen(false)}
        >
          <div
            className="bg-white border-t border-black rounded-t-2xl w-full p-5 pb-8 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-200 pb-3">
              <p className="font-display font-bold text-base">Operations Menu</p>
              <button
                type="button"
                onClick={() => setMobileMoreOpen(false)}
                aria-label="Close operations menu"
                className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {(['customers', 'settings', 'finance'] as AdminSection[]).map((id) => {
                const item = navItems.find((n) => n.id === id)!;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSection(item.id);
                      setMobileMoreOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm font-semibold cursor-pointer ${
                      section === item.id
                        ? 'bg-black text-white border-black'
                        : 'bg-white text-black border-neutral-200'
                    }`}
                  >
                    <span className="inline-flex items-center gap-3">
                      {item.icon}
                      <span>{item.label}</span>
                    </span>
                    {item.id === 'finance' && openTicketsCount > 0 && (
                      <span
                        className={`text-xs font-mono font-bold px-2 py-0.5 rounded tabular-nums ${
                          section === item.id ? 'bg-white text-black' : 'bg-black text-white'
                        }`}
                      >
                        {openTicketsCount} open
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* User Details Drawer / Modal */}
      {(inspectedCustomer || inspectedRider) && (
        <div
          role="dialog"
          aria-label="User details"
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-end p-0 sm:p-4"
        >
          <div className="bg-white border border-black rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-200 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-mono uppercase tracking-wider text-neutral-500">
                  {inspectedCustomer ? 'Customer Profile' : 'Rider Profile'}
                </p>
                <h2 className="font-display font-extrabold text-xl">
                  {(inspectedCustomer || inspectedRider)!.fullName}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setInspectedUserRef(null)}
                aria-label="Close user details"
                className="w-9 h-9 rounded-full bg-neutral-100 flex items-center justify-center hover:bg-neutral-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-5 text-sm">
              {(() => {
                const person = (inspectedCustomer || inspectedRider)!;
                const userDeliveries = inspectedCustomer
                  ? deliveries.filter((d) => d.customerId === inspectedCustomer.customerId)
                  : deliveries.filter((d) => d.assignedRiderId === inspectedRider!.riderId);
                const userTickets = complaints.filter((t) => t.reporterId === person.id);

                return (
                  <>
                    {/* Contact & Identity */}
                    <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4 space-y-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-neutral-500">Account Status</span>
                        <span className="font-semibold capitalize border border-black px-2 py-0.5 rounded">
                          {person.accountStatus}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <Mail className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                        <span className="truncate">{person.email}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="inline-flex items-center gap-2 font-mono">
                          <Phone className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                          <span>{person.phone}</span>
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <a
                            href={`tel:${person.phone}`}
                            className="border border-neutral-300 px-2.5 py-1 rounded text-[11px] font-semibold hover:border-black"
                          >
                            Call
                          </a>
                          <a
                            href={buildWhatsAppUrl(
                              person.phone,
                              `Hello ${person.fullName}, this is SAQO Operations regarding your account.`
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bg-black text-white px-2.5 py-1 rounded text-[11px] font-semibold"
                          >
                            WhatsApp
                          </a>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs text-neutral-500 pt-1 border-t border-neutral-200">
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5" />
                          <span>
                            {inspectedCustomer
                              ? inspectedCustomer.defaultState
                              : inspectedRider!.homeState}
                          </span>
                        </span>
                        <span className="font-mono">
                          Joined {new Date(person.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    {/* Metrics */}
                    {inspectedCustomer ? (
                      <div className="grid grid-cols-3 gap-3">
                        <div className="border border-neutral-200 rounded-xl p-3">
                          <p className="text-[11px] text-neutral-500">Requests</p>
                          <p className="font-display font-extrabold text-xl tabular-nums mt-0.5">
                            {inspectedCustomer.totalRequests}
                          </p>
                        </div>
                        <div className="border border-neutral-200 rounded-xl p-3">
                          <p className="text-[11px] text-neutral-500">Completed</p>
                          <p className="font-display font-extrabold text-xl tabular-nums mt-0.5">
                            {inspectedCustomer.completedRequests}
                          </p>
                        </div>
                        <div className="border border-neutral-200 rounded-xl p-3">
                          <p className="text-[11px] text-neutral-500">Total Spend</p>
                          <p className="font-display font-extrabold text-base tabular-nums mt-1">
                            {formatNaira(
                              userDeliveries.reduce((sum, d) => sum + d.deliveryFeeNgn, 0)
                            )}
                          </p>
                        </div>
                      </div>
                    ) : (
                      inspectedRider && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-neutral-500">
                              Rider Fleet Profile
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                if (!editingRiderMode) {
                                  setEditRiderForm({
                                    fullName: inspectedRider.fullName,
                                    phone: inspectedRider.phone,
                                    homeState: inspectedRider.homeState,
                                    vehicleType: inspectedRider.vehicleType,
                                    plateNumber: inspectedRider.plateNumber,
                                  });
                                }
                                setEditingRiderMode((v) => !v);
                              }}
                              className="inline-flex items-center gap-1 text-xs font-semibold underline cursor-pointer"
                            >
                              <Edit3 className="w-3 h-3" />
                              <span>{editingRiderMode ? 'Cancel Edit' : 'Edit Rider Details'}</span>
                            </button>
                          </div>

                          {editingRiderMode ? (
                            <form
                              onSubmit={(e) => handleSaveRiderEdit(e, inspectedRider.riderId)}
                              className="border border-black rounded-xl p-4 space-y-3 bg-neutral-50"
                            >
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-[11px] font-semibold mb-1">
                                    Full Name
                                  </label>
                                  <input
                                    type="text"
                                    required
                                    value={editRiderForm.fullName}
                                    onChange={(e) =>
                                      setEditRiderForm({ ...editRiderForm, fullName: e.target.value })
                                    }
                                    className="w-full border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs bg-white"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] font-semibold mb-1">
                                    Phone
                                  </label>
                                  <input
                                    type="tel"
                                    required
                                    value={editRiderForm.phone}
                                    onChange={(e) =>
                                      setEditRiderForm({ ...editRiderForm, phone: e.target.value })
                                    }
                                    className="w-full border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs bg-white"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] font-semibold mb-1">
                                    Operating State
                                  </label>
                                  <select
                                    value={editRiderForm.homeState}
                                    onChange={(e) =>
                                      setEditRiderForm({ ...editRiderForm, homeState: e.target.value })
                                    }
                                    className="w-full border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs bg-white"
                                  >
                                    {NIGERIA_STATES.map((s) => (
                                      <option key={s.name} value={s.name}>
                                        {s.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <label className="block text-[11px] font-semibold mb-1">
                                    Vehicle Type
                                  </label>
                                  <select
                                    value={editRiderForm.vehicleType}
                                    onChange={(e) =>
                                      setEditRiderForm({
                                        ...editRiderForm,
                                        vehicleType: e.target.value as any,
                                      })
                                    }
                                    className="w-full border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs bg-white"
                                  >
                                    <option value="Motorcycle">Motorcycle</option>
                                    <option value="Van">Van</option>
                                    <option value="Inter-State Sprinter">Inter-State Sprinter</option>
                                  </select>
                                </div>
                              </div>
                              <div>
                                <label className="block text-[11px] font-semibold mb-1">
                                  Plate Number
                                </label>
                                <input
                                  type="text"
                                  required
                                  value={editRiderForm.plateNumber}
                                  onChange={(e) =>
                                    setEditRiderForm({
                                      ...editRiderForm,
                                      plateNumber: e.target.value,
                                    })
                                  }
                                  className="w-full border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs font-mono uppercase bg-white"
                                />
                              </div>
                              <button
                                type="submit"
                                disabled={savingRiderEdit}
                                className="bg-black text-white px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer"
                              >
                                {savingRiderEdit ? 'Saving...' : 'Save Rider Updates'}
                              </button>
                            </form>
                          ) : (
                            <div className="grid grid-cols-2 gap-3">
                              <div className="border border-neutral-200 rounded-xl p-3">
                                <p className="text-[11px] text-neutral-500">Vehicle & Plate</p>
                                <p className="font-semibold text-sm mt-0.5">
                                  {inspectedRider.vehicleType}
                                </p>
                                <p className="font-mono text-xs text-neutral-500">
                                  {inspectedRider.plateNumber}
                                </p>
                              </div>
                              <div className="border border-neutral-200 rounded-xl p-3">
                                <p className="text-[11px] text-neutral-500">Verification Tick & Rating</p>
                                <p className="font-semibold text-sm capitalize mt-0.5 inline-flex items-center gap-1">
                                  {inspectedRider.verificationStatus === 'verified' ? (
                                    <BadgeCheck className="w-4 h-4 text-black" />
                                  ) : (
                                    <ShieldCheck className="w-3.5 h-3.5" />
                                  )}
                                  <span>{inspectedRider.verificationStatus}</span>
                                </p>
                                <p className="font-mono text-xs text-neutral-500">
                                  {inspectedRider.rating.toFixed(1)} ★ · {inspectedRider.isOnline ? 'Online' : 'Offline'}
                                </p>
                              </div>
                            </div>
                          )}
                          <div className="grid grid-cols-3 gap-3">
                            <div className="border border-neutral-200 rounded-xl p-3">
                              <p className="text-[11px] text-neutral-500">Active Load</p>
                              <p className="font-display font-extrabold text-xl tabular-nums mt-0.5">
                                {inspectedRider.activeParcelsCount}
                              </p>
                            </div>
                            <div className="border border-neutral-200 rounded-xl p-3">
                              <p className="text-[11px] text-neutral-500">Delivered</p>
                              <p className="font-display font-extrabold text-xl tabular-nums mt-0.5">
                                {inspectedRider.completedDeliveriesCount}
                              </p>
                            </div>
                            <div className="border border-neutral-200 rounded-xl p-3">
                              <p className="text-[11px] text-neutral-500">Earnings</p>
                              <p className="font-display font-extrabold text-base tabular-nums mt-1">
                                {formatNaira(inspectedRider.totalEarningsNgn)}
                              </p>
                            </div>
                          </div>
                        </div>
                      )
                    )}

                    {/* Recent Deliveries */}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-neutral-500">
                        Parcel Deliveries ({userDeliveries.length})
                      </p>
                      {userDeliveries.length === 0 ? (
                        <p className="text-xs text-neutral-500 border border-neutral-200 rounded-lg p-3">
                          No parcel deliveries recorded yet.
                        </p>
                      ) : (
                        <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-xl overflow-hidden">
                          {userDeliveries.slice(0, 5).map((d) => (
                            <li key={d.id} className="p-3 flex items-center justify-between gap-2 text-xs">
                              <div className="min-w-0">
                                <p className="font-mono font-bold">{d.trackingCode}</p>
                                <p className="text-neutral-600 truncate">
                                  {d.pickupState} → {d.destinationState}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-mono font-semibold tabular-nums">
                                  {formatNaira(d.deliveryFeeNgn)}
                                </p>
                                <p className="capitalize text-neutral-500">
                                  {d.status.replace(/_/g, ' ')}
                                </p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* User Tickets */}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-neutral-500">
                        Submitted Tickets ({userTickets.length})
                      </p>
                      {userTickets.length === 0 ? (
                        <p className="text-xs text-neutral-500 border border-neutral-200 rounded-lg p-3">
                          No tickets submitted by this account.
                        </p>
                      ) : (
                        <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-xl overflow-hidden">
                          {userTickets.slice(0, 4).map((t) => (
                            <li key={t.id} className="p-3 text-xs space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="font-semibold uppercase text-[10px]">
                                  {t.ticketType || 'complaint'}
                                </span>
                                <span className="capitalize text-neutral-500">{t.status}</span>
                              </div>
                              <p className="font-semibold">{t.subject}</p>
                              <p className="text-neutral-600">{t.details}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* Account Security: Admin Password Reset */}
                    <div className="border border-neutral-200 rounded-xl p-3.5 space-y-3 bg-neutral-50">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                          <KeyRound className="w-3.5 h-3.5" />
                          <span>Account Credentials</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setResetPasswordOpen((v) => !v)}
                          className="text-xs font-semibold underline cursor-pointer"
                        >
                          {resetPasswordOpen ? 'Cancel Reset' : 'Reset Password'}
                        </button>
                      </div>
                      {resetPasswordOpen && (
                        <form
                          onSubmit={(e) => handleResetUserPassword(e, person.id)}
                          className="space-y-2.5 pt-1"
                        >
                          <div className="flex items-center justify-between">
                            <label htmlFor="admin-reset-pw" className="text-[11px] font-semibold">
                              New Temporary Password
                            </label>
                            <button
                              type="button"
                              onClick={() =>
                                setResetPasswordValue(
                                  `Saqo#${Math.floor(1000 + Math.random() * 9000)}`
                                )
                              }
                              className="text-[11px] font-semibold underline cursor-pointer"
                            >
                              Generate
                            </button>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              id="admin-reset-pw"
                              type="text"
                              required
                              minLength={6}
                              value={resetPasswordValue}
                              onChange={(e) => setResetPasswordValue(e.target.value)}
                              placeholder="Minimum 6 characters"
                              className="flex-1 min-w-0 border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs font-mono bg-white"
                            />
                            <button
                              type="submit"
                              disabled={resettingPassword || resetPasswordValue.trim().length < 6}
                              className="bg-black text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 shrink-0 cursor-pointer"
                            >
                              {resettingPassword ? 'Saving...' : 'Set Password'}
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>

            <div className="px-5 py-3.5 border-t border-neutral-200 flex items-center justify-between gap-2 bg-neutral-50">
              {inspectedRider && (
                <button
                  type="button"
                  onClick={() =>
                    handleVerifyRider(
                      inspectedRider.riderId,
                      inspectedRider.verificationStatus === 'verified' ? 'pending' : 'verified'
                    )
                  }
                  className={
                    inspectedRider.verificationStatus === 'verified'
                      ? 'border border-black px-3.5 py-2 rounded-lg text-xs font-semibold hover:bg-neutral-100 cursor-pointer'
                      : 'bg-black text-white px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer'
                  }
                >
                  {inspectedRider.verificationStatus === 'verified'
                    ? 'Revoke Tick'
                    : 'Enable Verification Tick'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const person = (inspectedCustomer || inspectedRider)!;
                  handleToggleAccountStatus(
                    person.id,
                    person.accountStatus === 'active' ? 'suspended' : 'active'
                  );
                }}
                className="border border-black px-4 py-2 rounded-lg text-xs font-semibold hover:bg-neutral-100 cursor-pointer"
              >
                {(inspectedCustomer || inspectedRider)!.accountStatus === 'active'
                  ? 'Suspend Account'
                  : 'Activate Account'}
              </button>
              <button
                type="button"
                onClick={() => setInspectedUserRef(null)}
                className="ml-auto bg-black text-white px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Issue Rider Account Modal */}
      {issueRiderOpen && (
        <div
          role="dialog"
          aria-label="Issue new rider account"
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
        >
          <form
            onSubmit={handleIssueRider}
            className="bg-white border border-black rounded-t-2xl sm:rounded-2xl max-w-lg w-full max-h-[92vh] flex flex-col overflow-hidden"
          >
            <div className="px-5 py-4 border-b border-neutral-200 flex items-center justify-between">
              <div>
                <p className="text-[11px] font-mono uppercase tracking-wider text-neutral-500">
                  SAQO Fleet Issuance
                </p>
                <h2 className="font-display font-bold text-lg">Issue Rider Account</h2>
              </div>
              <button
                type="button"
                onClick={() => setIssueRiderOpen(false)}
                aria-label="Close issue rider modal"
                className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center hover:bg-neutral-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="issue-rider-name" className="block text-xs font-semibold mb-1">
                    Rider Full Name
                  </label>
                  <input
                    id="issue-rider-name"
                    type="text"
                    required
                    value={issueRiderForm.fullName}
                    onChange={(e) =>
                      setIssueRiderForm({ ...issueRiderForm, fullName: e.target.value })
                    }
                    placeholder="e.g. Sani Lawal"
                    className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label htmlFor="issue-rider-phone" className="block text-xs font-semibold mb-1">
                    Phone Number (Required)
                  </label>
                  <input
                    id="issue-rider-phone"
                    type="tel"
                    required
                    value={issueRiderForm.phone}
                    onChange={(e) =>
                      setIssueRiderForm({ ...issueRiderForm, phone: e.target.value })
                    }
                    placeholder="+234 803 000 0000"
                    className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="issue-rider-email" className="block text-xs font-semibold mb-1">
                    Sign-In Email
                  </label>
                  <input
                    id="issue-rider-email"
                    type="email"
                    required
                    value={issueRiderForm.email}
                    onChange={(e) =>
                      setIssueRiderForm({ ...issueRiderForm, email: e.target.value })
                    }
                    placeholder="rider@saqo.ng"
                    className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="issue-rider-password" className="block text-xs font-semibold">
                      Initial Password
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setIssueRiderForm({
                          ...issueRiderForm,
                          password: `Saqo#${Math.floor(1000 + Math.random() * 9000)}`,
                        })
                      }
                      className="text-[11px] font-semibold underline cursor-pointer"
                    >
                      Generate
                    </button>
                  </div>
                  <input
                    id="issue-rider-password"
                    type="text"
                    required
                    minLength={6}
                    value={issueRiderForm.password}
                    onChange={(e) =>
                      setIssueRiderForm({ ...issueRiderForm, password: e.target.value })
                    }
                    placeholder="Minimum 6 characters"
                    className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm font-mono focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor="issue-rider-state" className="block text-xs font-semibold mb-1">
                    Operating State
                  </label>
                  <select
                    id="issue-rider-state"
                    value={issueRiderForm.homeState}
                    onChange={(e) =>
                      setIssueRiderForm({ ...issueRiderForm, homeState: e.target.value })
                    }
                    className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm"
                  >
                    {NIGERIA_STATES.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="issue-rider-vehicle" className="block text-xs font-semibold mb-1">
                    Vehicle Type
                  </label>
                  <select
                    id="issue-rider-vehicle"
                    value={issueRiderForm.vehicleType}
                    onChange={(e) =>
                      setIssueRiderForm({
                        ...issueRiderForm,
                        vehicleType: e.target.value as any,
                      })
                    }
                    className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm"
                  >
                    <option value="Motorcycle">Motorcycle</option>
                    <option value="Van">Van</option>
                    <option value="Inter-State Sprinter">Inter-State Sprinter</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="issue-rider-plate" className="block text-xs font-semibold mb-1">
                    Plate Number
                  </label>
                  <input
                    id="issue-rider-plate"
                    type="text"
                    required
                    value={issueRiderForm.plateNumber}
                    onChange={(e) =>
                      setIssueRiderForm({ ...issueRiderForm, plateNumber: e.target.value })
                    }
                    placeholder="KTS-502-SQ"
                    className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-base sm:text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded-xl border border-neutral-200 bg-neutral-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={issueRiderForm.verifyImmediately}
                  onChange={(e) =>
                    setIssueRiderForm({
                      ...issueRiderForm,
                      verifyImmediately: e.target.checked,
                    })
                  }
                  className="mt-0.5 accent-black"
                />
                <span className="text-xs leading-relaxed">
                  <strong className="block font-semibold text-black">
                    Enable Verification Tick immediately
                  </strong>
                  <span className="text-neutral-600">
                    Allows this rider to go online and receive smart dispatch offers as soon as they sign in.
                  </span>
                </span>
              </label>
            </div>

            <div className="px-5 py-3.5 border-t border-neutral-200 flex justify-end gap-2 bg-neutral-50">
              <button
                type="button"
                onClick={() => setIssueRiderOpen(false)}
                className="px-4 py-2 rounded-lg border border-neutral-300 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={issuingRider}
                className="px-4 py-2 rounded-lg bg-black text-white text-xs font-bold cursor-pointer"
              >
                {issuingRider ? 'Issuing...' : 'Create Rider Account'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delivery Details Modal */}
      {inspectedDelivery && (
        <div
          role="dialog"
          aria-label="Delivery details"
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
        >
          <div className="bg-white border border-black rounded-t-2xl sm:rounded-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-200 flex items-center justify-between">
              <div>
                <p className="font-mono text-xs text-neutral-500">
                  {inspectedDelivery.trackingCode} · {inspectedDelivery.serviceTier.replace('_', ' ')}
                </p>
                <h2 className="font-display font-bold text-lg">
                  {inspectedDelivery.pickupState} → {inspectedDelivery.destinationState}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setInspectedDelivery(null)}
                aria-label="Close delivery details"
                className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center hover:bg-neutral-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="border border-neutral-200 rounded-xl p-3">
                  <p className="text-[11px] text-neutral-500">Status</p>
                  <p className="font-semibold capitalize mt-0.5">
                    {formatDeliveryStatusLabel(inspectedDelivery.status)}
                  </p>
                </div>
                <div className="border border-neutral-200 rounded-xl p-3">
                  <p className="text-[11px] text-neutral-500">Delivery Fee</p>
                  <p className="font-mono font-bold mt-0.5 tabular-nums">
                    {formatNaira(inspectedDelivery.deliveryFeeNgn)}
                  </p>
                </div>
              </div>

              <div className="border border-neutral-200 rounded-xl p-3.5 space-y-2 text-xs">
                <div>
                  <span className="text-neutral-500 block">From · Pickup Address</span>
                  <span className="font-semibold text-sm">
                    {inspectedDelivery.pickupAddress}, {inspectedDelivery.pickupState}
                  </span>
                </div>
                <div className="border-t border-neutral-100 pt-2">
                  <span className="text-neutral-500 block">To · Destination Address</span>
                  <span className="font-semibold text-sm">
                    {inspectedDelivery.destinationAddress}, {inspectedDelivery.destinationState}
                  </span>
                </div>
              </div>

              <div className="border border-neutral-200 rounded-xl p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-neutral-500">Sender</span>
                  <span className="font-semibold inline-flex items-center gap-2">
                    <span>
                      {inspectedDelivery.customerName} ({inspectedDelivery.customerPhone})
                    </span>
                    <a
                      href={`tel:${inspectedDelivery.customerPhone}`}
                      className="underline font-semibold"
                    >
                      Call
                    </a>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-neutral-500">Recipient</span>
                  <span className="font-semibold inline-flex items-center gap-2">
                    <span>
                      {inspectedDelivery.recipientName} ({inspectedDelivery.recipientPhone})
                    </span>
                    <a
                      href={`tel:${inspectedDelivery.recipientPhone}`}
                      className="underline font-semibold"
                    >
                      Call
                    </a>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-neutral-500">Assigned Rider</span>
                  {inspectedDelivery.assignedRiderName ? (
                    <span className="font-semibold inline-flex items-center gap-1.5">
                      <span>
                        {inspectedDelivery.assignedRiderName}
                        {inspectedDelivery.assignedRiderVehicle
                          ? ` · ${inspectedDelivery.assignedRiderVehicle}`
                          : ''}
                      </span>
                      {inspectedDelivery.assignedRiderVerified && (
                        <BadgeCheck className="w-3.5 h-3.5 text-black shrink-0" />
                      )}
                      {inspectedDelivery.assignedRiderPhone && (
                        <a
                          href={`tel:${inspectedDelivery.assignedRiderPhone}`}
                          className="underline font-semibold ml-1"
                        >
                          Call
                        </a>
                      )}
                    </span>
                  ) : (
                    <span className="text-neutral-500">Unassigned</span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-neutral-500">Parcel</span>
                  <span className="font-medium text-right">
                    {inspectedDelivery.parcelCategory} · {inspectedDelivery.parcelDescription} (
                    {inspectedDelivery.weightKg} kg)
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-neutral-500">OTP Verification</span>
                  <span className="font-mono font-semibold">
                    {inspectedDelivery.otpVerified ? 'Verified ✓' : `Code ${inspectedDelivery.deliveryOtp}`}
                  </span>
                </div>
              </div>

              {/* Admin Status Override */}
              <form
                onSubmit={handleAdminUpdateDeliveryStatus}
                className="border border-neutral-200 rounded-xl p-3.5 space-y-2.5 bg-neutral-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="admin-status-override" className="text-xs font-semibold">
                    Operations Status Override
                  </label>
                  {['pending_dispatch', 'no_rider_available'].includes(inspectedDelivery.status) && (
                    <button
                      type="button"
                      disabled={retryingDispatchId === inspectedDelivery.id}
                      onClick={() => handleRetryDispatch(inspectedDelivery.id)}
                      className="inline-flex items-center gap-1 text-xs font-semibold underline cursor-pointer"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>
                        {retryingDispatchId === inspectedDelivery.id
                          ? 'Retrying...'
                          : 'Retry Auto-Dispatch'}
                      </span>
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select
                    id="admin-status-override"
                    value={adminStatusDraft}
                    onChange={(e) => setAdminStatusDraft(e.target.value as DeliveryStatus)}
                    className="border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs bg-white"
                  >
                    <option value="pending_dispatch">Finding Rider</option>
                    <option value="no_rider_available">Awaiting Rider</option>
                    <option value="assigned">Rider Offered</option>
                    <option value="accepted">Rider Accepted</option>
                    <option value="heading_to_pickup">Heading to Pickup</option>
                    <option value="parcel_picked_up">Parcel Picked Up</option>
                    <option value="in_transit">In Transit</option>
                    <option value="arrived_at_destination">Arrived at Destination</option>
                    <option value="delivered">Delivered (Settle)</option>
                    <option value="cancelled">Cancelled (Refund)</option>
                  </select>
                  <input
                    type="text"
                    value={adminStatusNote}
                    onChange={(e) => setAdminStatusNote(e.target.value)}
                    placeholder="Optional admin note..."
                    className="border border-neutral-300 rounded-lg px-3 py-1.5 text-base sm:text-xs bg-white"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  {!['delivered', 'cancelled'].includes(inspectedDelivery.status) && (
                    <button
                      type="button"
                      onClick={() => {
                        setAssigningDelivery(inspectedDelivery);
                        setSelectedRiderId(inspectedDelivery.assignedRiderId || '');
                      }}
                      className="border border-neutral-300 bg-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:border-black cursor-pointer"
                    >
                      {inspectedDelivery.assignedRiderId ? 'Reassign Rider' : 'Assign Rider'}
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={updatingDeliveryStatus}
                    className="ml-auto bg-black text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 cursor-pointer"
                  >
                    {updatingDeliveryStatus ? 'Updating...' : 'Update Status'}
                  </button>
                </div>
              </form>

              {/* Status History Timeline */}
              {inspectedDelivery.history && inspectedDelivery.history.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-neutral-500">
                    Dispatch & Status History ({inspectedDelivery.history.length})
                  </p>
                  <ul className="border border-neutral-200 rounded-xl divide-y divide-neutral-200 overflow-hidden">
                    {inspectedDelivery.history.map((h) => (
                      <li key={h.id} className="p-3 text-xs space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold capitalize">
                            {formatDeliveryStatusLabel(h.status)}
                          </span>
                          <span className="font-mono text-[11px] text-neutral-500 tabular-nums">
                            {h.actorRole} ·{' '}
                            {new Date(h.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <p className="text-neutral-600">{h.note}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 border-t border-neutral-200 flex items-center justify-between gap-2 bg-neutral-50">
              {!['delivered', 'cancelled'].includes(inspectedDelivery.status) &&
                (confirmCancelId === inspectedDelivery.id ? (
                  <div className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleCancelDelivery(inspectedDelivery.id)}
                      className="bg-black text-white px-3.5 py-2 rounded-lg text-xs font-semibold cursor-pointer"
                    >
                      Confirm Cancel
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
                    onClick={() => setConfirmCancelId(inspectedDelivery.id)}
                    className="border border-black px-3.5 py-2 rounded-lg text-xs font-semibold hover:bg-neutral-100 cursor-pointer"
                  >
                    Cancel Delivery
                  </button>
                ))}
              <button
                type="button"
                onClick={() => setInspectedDelivery(null)}
                className="ml-auto bg-black text-white px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Rider Assignment Modal */}
      {assigningDelivery && (
        <div
          role="dialog"
          aria-label="Manually assign rider"
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
        >
          {(() => {
            const eligibleRiders = riders.filter(
              (r) => r.verificationStatus === 'verified' && r.accountStatus === 'active'
            );
            return (
              <form
                onSubmit={handleManualAssign}
                className="bg-white border border-black rounded-t-2xl sm:rounded-xl max-w-md w-full p-6 space-y-4"
              >
                <div>
                  <h2 className="font-display font-bold text-lg">
                    Assign Rider for {assigningDelivery.trackingCode}
                  </h2>
                  <p className="text-xs text-neutral-600 mt-0.5">
                    {assigningDelivery.pickupState} → {assigningDelivery.destinationState}
                  </p>
                </div>

                {eligibleRiders.length === 0 ? (
                  <div className="border border-neutral-200 bg-neutral-50 rounded-xl p-4 space-y-3 text-xs">
                    <p className="font-semibold text-black">
                      No verified active riders available yet.
                    </p>
                    <p className="text-neutral-600 leading-relaxed">
                      Issue a rider account with the verification tick enabled, or verify an existing pending rider in the Riders tab.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setAssigningDelivery(null);
                          setIssueRiderOpen(true);
                        }}
                        className="bg-black text-white px-3 py-1.5 rounded-lg font-semibold cursor-pointer"
                      >
                        Issue Rider Account
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAssigningDelivery(null);
                          setSection('riders');
                        }}
                        className="border border-neutral-300 bg-white px-3 py-1.5 rounded-lg font-semibold cursor-pointer"
                      >
                        Open Riders Tab
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <label htmlFor="admin-assign-rider" className="block text-xs font-semibold mb-1.5">
                      Select Verified Rider
                    </label>
                    <select
                      id="admin-assign-rider"
                      required
                      value={selectedRiderId}
                      onChange={(e) => setSelectedRiderId(e.target.value)}
                      className="w-full border border-neutral-300 rounded-lg px-3 py-2.5 text-base sm:text-sm"
                    >
                      <option value="">Choose rider...</option>
                      {eligibleRiders.map((r) => (
                        <option key={r.riderId} value={r.riderId}>
                          {r.fullName} ({r.homeState} · {r.activeParcelsCount} active ·{' '}
                          {r.isOnline ? 'Online' : 'Offline'})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setAssigningDelivery(null)}
                    className="px-4 py-2 rounded-lg border border-neutral-300 text-xs font-semibold cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!selectedRiderId || eligibleRiders.length === 0}
                    className="px-4 py-2 rounded-lg bg-black text-white text-xs font-semibold disabled:opacity-40 cursor-pointer"
                  >
                    Confirm Assignment
                  </button>
                </div>
              </form>
            );
          })()}
        </div>
      )}
    </div>
  );
};
