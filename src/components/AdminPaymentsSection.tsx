import React, { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Receipt,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Undo2,
  Wallet,
  X,
} from 'lucide-react';
import { apiRequest, getStoredToken } from '../lib/api';
import { apiUrl } from '../lib/deployment';
import type { SaqoReceiptData } from '../lib/receipt';
import { useRealtime } from '../hooks/useRealtime';
import { formatNaira } from '../shared/pricing';
import type {
  AdminPaymentsOverview,
  PaymentTransaction,
  Profile,
  WalletAccount,
  WalletTransaction,
} from '../shared/types';
import { ReceiptModal } from './ReceiptModal';

interface WalletAuditItem {
  id: string;
  walletId: string;
  userId: string;
  customerName: string;
  action: string;
  amountNgn: number;
  direction: string | null;
  reason: string;
  actorId: string;
  actorName: string | null;
  createdAt: string;
}

export const AdminPaymentsSection: React.FC<{
  onNotify: (msg: string) => void;
}> = ({ onNotify }) => {
  const [subTab, setSubTab] = useState<'transactions' | 'wallets' | 'reconciliation' | 'refunds'>(
    'transactions'
  );
  const [overview, setOverview] = useState<(AdminPaymentsOverview & { auditLogs?: WalletAuditItem[] }) | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Transaction search & filter + server pagination
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('all');
  const [status, setStatus] = useState('all');
  const [purpose, setPurpose] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Modals & Drawers
  const [activeReceipt, setActiveReceipt] = useState<SaqoReceiptData | null>(null);
  const [inspectedWallet, setInspectedWallet] = useState<{
    profile: Profile;
    wallet: WalletAccount;
    walletTransactions: WalletTransaction[];
    paymentTransactions: PaymentTransaction[];
    auditLogs: WalletAuditItem[];
  } | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<WalletAccount | null>(null);
  const [adjustDirection, setAdjustDirection] = useState<'credit' | 'debit'>('credit');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustIdempotencyKey, setAdjustIdempotencyKey] = useState('');
  const [adjustBusy, setAdjustBusy] = useState(false);

  const [refundTarget, setRefundTarget] = useState<PaymentTransaction | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundDestination, setRefundDestination] = useState<'wallet' | 'flutterwave' | 'manual'>(
    'wallet'
  );
  const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);

  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [walletSearch, setWalletSearch] = useState('');

  const buildQueryString = useCallback(
    (includePage = true) => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (method !== 'all') params.set('method', method);
      if (status !== 'all') params.set('status', status);
      if (purpose !== 'all') params.set('purpose', purpose);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (includePage) {
        params.set('page', String(page));
        params.set('pageSize', String(pageSize));
      }
      return params.toString();
    },
    [search, method, status, purpose, dateFrom, dateTo, page, pageSize]
  );

  const loadOverview = useCallback(async () => {
    try {
      const qs = buildQueryString(true);
      const data = await apiRequest<AdminPaymentsOverview & { auditLogs?: WalletAuditItem[] }>(
        `/api/admin/payments/overview?${qs}`
      );
      setOverview(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load payment overview.');
    } finally {
      setLoading(false);
    }
  }, [buildQueryString]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useRealtime((evt) => {
    if (
      evt.type === 'notifications:refresh' ||
      evt.type === 'wallet:updated' ||
      evt.type === 'payment:updated' ||
      evt.type === 'cash_collection:updated' ||
      evt.type === 'delivery:updated'
    ) {
      loadOverview();
    }
  });

  const handleExportCsv = async () => {
    try {
      const qs = buildQueryString(false);
      const token = getStoredToken();
      const res = await fetch(apiUrl(`/api/admin/payments/export?${qs}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('Could not export CSV report.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `saqo-payments-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onNotify('Payment report exported to CSV.');
    } catch (err: any) {
      setError(err.message || 'Export failed.');
    }
  };

  const handleInspectCustomerWallet = async (userId: string) => {
    setBusyActionId(userId);
    try {
      const data = await apiRequest<{
        profile: Profile;
        wallet: WalletAccount;
        walletTransactions: WalletTransaction[];
        paymentTransactions: PaymentTransaction[];
        auditLogs: WalletAuditItem[];
      }>(`/api/admin/customers/${encodeURIComponent(userId)}/wallet`);
      setInspectedWallet(data);
    } catch (err: any) {
      setError(err.message || 'Could not load customer wallet details.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleWalletAdjustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustTarget) return;
    setAdjustBusy(true);
    setError(null);
    const key = adjustIdempotencyKey || `adj:${adjustTarget.id}:${crypto.randomUUID()}`;
    if (!adjustIdempotencyKey) setAdjustIdempotencyKey(key);
    try {
      await apiRequest(`/api/admin/wallets/${encodeURIComponent(adjustTarget.id)}/adjust`, {
        method: 'POST',
        body: JSON.stringify({
          direction: adjustDirection,
          amountNgn: Number(adjustAmount),
          reason: adjustReason.trim(),
          idempotencyKey: key,
        }),
      });
      onNotify(`Wallet ${adjustDirection}ed by ${formatNaira(Number(adjustAmount))}.`);
      setAdjustTarget(null);
      setAdjustAmount('');
      setAdjustReason('');
      await loadOverview();
      if (inspectedWallet?.wallet.id === adjustTarget.id) {
        await handleInspectCustomerWallet(adjustTarget.userId);
      }
    } catch (err: any) {
      setError(err.message || 'Wallet adjustment failed.');
    } finally {
      setAdjustBusy(false);
    }
  };

  const [verifyingRefund, setVerifyingRefund] = useState<string | null>(null);
  const handleVerifyRefund = async (id: string) => {
    setVerifyingRefund(id);
    setError(null);
    try {
      const { status } = await apiRequest<{ status: string }>(`/api/admin/refunds/${id}/verify`, { method: 'POST' });
      onNotify(`Flutterwave refund status: ${status}.`);
      await loadOverview();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Refund verification failed.');
    } finally {
      setVerifyingRefund(null);
    }
  };

  const handleRefundSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundTarget) return;
    setRefundBusy(true);
    setError(null);
    try {
      const result = await apiRequest<{ refund: { status: string } }>('/api/admin/refunds', {
        method: 'POST',
        body: JSON.stringify({
          paymentTransactionId: refundTarget.id,
          amountNgn: Number(refundAmount),
          destination: refundDestination,
          reason: refundReason.trim(),
        }),
      });
      onNotify(result.refund.status === 'pending' ? 'Flutterwave refund is pending.' : `Refund issued for ${refundTarget.reference}.`);
      setRefundTarget(null);
      setRefundAmount('');
      setRefundReason('');
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Refund failed.');
    } finally {
      setRefundBusy(false);
    }
  };

  const handleVerifyPayment = async (txId: string) => {
    setBusyActionId(txId);
    try {
      await apiRequest(`/api/admin/payments/${encodeURIComponent(txId)}/verify`, {
        method: 'POST',
      });
      onNotify('Transaction re-verified with Flutterwave.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Verification failed.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleReconcile = async (collectionId: string, action: 'reconcile' | 'dispute') => {
    let notes = 'Reconciled by SAQO admin';
    if (action === 'dispute') {
      const entered = window.prompt('Enter dispute note for audit trail:');
      if (entered === null) return;
      notes = entered.trim() || 'Disputed by admin';
    }
    setBusyActionId(collectionId);
    try {
      await apiRequest(`/api/admin/cash-collections/${encodeURIComponent(collectionId)}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ action, notes }),
      });
      onNotify(action === 'reconcile' ? 'Collection reconciled & marked paid.' : 'Collection flagged disputed.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Reconciliation update failed.');
    } finally {
      setBusyActionId(null);
    }
  };

  const m = overview?.metrics;
  const txPage = overview?.transactions;

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="bg-white border border-black rounded-xl p-3.5 text-xs font-medium flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* 8 Financial KPI Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        <div className="bg-black text-white rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-400">
            Total Customer Wallets
          </p>
          <p className="font-display font-extrabold text-xl sm:text-2xl mt-1 tabular-nums">
            {formatNaira(m?.totalWalletBalancesNgn ?? 0)}
          </p>
          <p className="text-[11px] text-neutral-400 mt-1">
            {overview?.wallets.length ?? 0} active wallets
          </p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Total Wallet Funding
          </p>
          <p className="font-display font-extrabold text-xl sm:text-2xl mt-1 tabular-nums">
            {formatNaira(m?.totalWalletFundingNgn ?? 0)}
          </p>
          <p className="text-[11px] text-neutral-500 mt-1">Confirmed deposits</p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Delivery Payments
          </p>
          <p className="font-display font-extrabold text-xl sm:text-2xl mt-1 tabular-nums">
            {formatNaira(m?.totalDeliveryPaymentsNgn ?? 0)}
          </p>
          <p className="text-[11px] text-neutral-500 mt-1">Settled delivery fees</p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Cash Collections
          </p>
          <p className="font-display font-extrabold text-xl sm:text-2xl mt-1 tabular-nums">
            {formatNaira(m?.totalCashCollectionsNgn ?? 0)}
          </p>
          <p className="text-[11px] text-neutral-500 mt-1">Rider collected & settled</p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Bank Transfers
          </p>
          <p className="font-display font-extrabold text-xl sm:text-2xl mt-1 tabular-nums">
            {formatNaira(m?.totalBankTransfersNgn ?? 0)}
          </p>
          <p className="text-[11px] text-neutral-500 mt-1">Verified transfers</p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Pending Transactions
          </p>
          <p className="font-display font-extrabold text-xl sm:text-2xl mt-1 tabular-nums">
            {m?.pendingTransactionsCount ?? 0}
          </p>
          <p className="text-[11px] text-neutral-500 mt-1 tabular-nums">
            {formatNaira(m?.pendingTransactionsAmountNgn ?? 0)} awaiting
          </p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Failed Transactions
          </p>
          <p className="font-display font-extrabold text-xl sm:text-2xl mt-1 tabular-nums">
            {m?.failedTransactionsCount ?? 0}
          </p>
          <p className="text-[11px] text-neutral-500 mt-1">Declined or errored</p>
        </div>
        <div className="bg-white border border-neutral-200 rounded-xl p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Refunds Processed
          </p>
          <p className="font-display font-extrabold text-xl sm:text-2xl mt-1 tabular-nums">
            {formatNaira(m?.refundsTotalNgn ?? 0)}
          </p>
          <p className="text-[11px] text-neutral-500 mt-1 tabular-nums">
            {m?.refundsCount ?? 0} refund records
          </p>
        </div>
      </div>

      {/* Sub-Navigation & Real-Time Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 bg-white border border-neutral-200 p-1 rounded-xl">
          {(
            [
              { id: 'transactions', label: 'Transactions' },
              { id: 'wallets', label: `Customer Wallets (${overview?.wallets.length ?? 0})` },
              {
                id: 'reconciliation',
                label: `Cash & Transfers (${overview?.cashCollections.length ?? 0})`,
              },
              {
                id: 'refunds',
                label: `Refunds & Webhooks (${overview?.refunds.length ?? 0})`,
              },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                subTab === t.id ? 'bg-black text-white' : 'text-neutral-600 hover:text-black'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadOverview}
            className="inline-flex items-center gap-1.5 border border-neutral-300 bg-white hover:border-black px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Sync</span>
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 bg-black text-white px-3.5 py-2 rounded-lg text-xs font-semibold hover:bg-neutral-800 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* 1. TRANSACTIONS VIEW WITH FILTERS, PAGINATION & RECEIPTS */}
      {subTab === 'transactions' && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          <div className="p-4 sm:p-5 border-b border-neutral-200 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-2.5">
              <div className="lg:col-span-2 relative">
                <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search customer, ref, tracking code..."
                  className="w-full border border-neutral-300 rounded-lg pl-9 pr-3 py-2 text-xs"
                />
              </div>
              <select
                aria-label="Filter by purpose"
                value={purpose}
                onChange={(e) => {
                  setPurpose(e.target.value);
                  setPage(1);
                }}
                className="border border-neutral-300 rounded-lg px-3 py-2 text-xs bg-white"
              >
                <option value="all">All Purposes</option>
                <option value="wallet_funding">Wallet Funding</option>
                <option value="delivery_payment">Delivery Payment</option>
              </select>
              <select
                aria-label="Filter by method"
                value={method}
                onChange={(e) => {
                  setMethod(e.target.value);
                  setPage(1);
                }}
                className="border border-neutral-300 rounded-lg px-3 py-2 text-xs bg-white"
              >
                <option value="all">All Methods</option>
                <option value="wallet">Wallet</option>
                <option value="flutterwave">Flutterwave</option>
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
              </select>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                className="border border-neutral-300 rounded-lg px-3 py-2 text-xs bg-white"
              >
                <option value="all">All Statuses</option>
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
                <option value="pending_verification">Pending Verification</option>
                <option value="collected_by_rider">Collected by Rider</option>
                <option value="failed">Failed</option>
                <option value="refunded">Refunded</option>
                <option value="reversed">Reversed</option>
              </select>
              <input
                type="date"
                aria-label="Filter from date"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
                className="border border-neutral-300 rounded-lg px-2.5 py-2 text-xs font-mono"
              />
              <input
                type="date"
                aria-label="Filter to date"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(1);
                }}
                className="border border-neutral-300 rounded-lg px-2.5 py-2 text-xs font-mono"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>
                  Showing {txPage?.items.length ?? 0} of {txPage?.total ?? 0} transactions
                </span>
                {(search || method !== 'all' || status !== 'all' || purpose !== 'all' || dateFrom || dateTo) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                      setMethod('all');
                      setStatus('all');
                      setPurpose('all');
                      setDateFrom('');
                      setDateTo('');
                      setPage(1);
                    }}
                    className="underline text-black font-semibold cursor-pointer"
                  >
                    Clear filters
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span>Rows:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className="border border-neutral-300 rounded px-2 py-1 text-xs bg-white font-mono"
                >
                  {[10, 15, 25, 50].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50 border-b border-neutral-200 text-neutral-500">
                <tr>
                  <th className="py-3 px-4 font-semibold">Reference</th>
                  <th className="py-3 px-4 font-semibold">Customer</th>
                  <th className="py-3 px-4 font-semibold">Purpose / Parcel</th>
                  <th className="py-3 px-4 font-semibold">Method</th>
                  <th className="py-3 px-4 font-semibold text-right">Amount</th>
                  <th className="py-3 px-4 font-semibold">Status</th>
                  <th className="py-3 px-4 font-semibold">Date</th>
                  <th className="py-3 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {!txPage || txPage.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-neutral-500">
                      No payment transactions found matching the selected filters.
                    </td>
                  </tr>
                ) : (
                  txPage.items.map((tx) => (
                    <tr key={tx.id} className="hover:bg-neutral-50">
                      <td className="py-3 px-4 font-mono font-bold text-black">
                        {tx.reference}
                        {tx.providerTxId && (
                          <p className="text-[10px] text-neutral-400 font-normal">
                            FLW #{tx.providerTxId}
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-semibold text-black">{tx.customerName || tx.userId}</p>
                        <p className="text-[11px] text-neutral-500">{tx.customerEmail || tx.customerPhone}</p>
                      </td>
                      <td className="py-3 px-4">
                        <p className="capitalize font-medium">{tx.purpose.replace(/_/g, ' ')}</p>
                        {tx.trackingCode && (
                          <p className="font-mono text-[10px] text-neutral-500">{tx.trackingCode}</p>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono uppercase">{tx.paymentMethod.replace(/_/g, ' ')}</td>
                      <td className="py-3 px-4 text-right font-mono font-bold tabular-nums">
                        {formatNaira(tx.amountNgn)}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full font-mono text-[10px] font-bold uppercase ${
                            tx.status === 'paid'
                              ? 'bg-black text-white'
                              : tx.status === 'failed' || tx.status === 'reversed'
                                ? 'border border-black text-black'
                                : 'bg-neutral-200 text-neutral-800'
                          }`}
                        >
                          {tx.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-neutral-500 whitespace-nowrap">
                        {new Date(tx.createdAt).toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setActiveReceipt({
                                reference: tx.reference,
                                title:
                                  tx.purpose === 'wallet_funding'
                                    ? 'Wallet Funding Receipt'
                                    : 'Delivery Payment Receipt',
                                receiptType:
                                  tx.purpose === 'wallet_funding'
                                    ? 'Wallet Funding'
                                    : 'Delivery Payment',
                                amountNgn: tx.amountNgn,
                                status: tx.status,
                                paymentMethod: tx.paymentMethod,
                                createdAt: tx.createdAt,
                                customerName: tx.customerName,
                                customerEmail: tx.customerEmail,
                                customerPhone: tx.customerPhone,
                                trackingCode: tx.trackingCode,
                                providerTxId: tx.providerTxId,
                                transferReference: tx.transferReference,
                                verifiedAt: tx.verifiedAt,
                                description: `${tx.purpose.replace(/_/g, ' ')} via ${tx.paymentMethod.replace(/_/g, ' ')}`,
                              })
                            }
                            className="inline-flex items-center gap-1 border border-neutral-300 hover:border-black px-2 py-1 rounded text-[11px] font-semibold cursor-pointer"
                            title="View / Download Receipt"
                          >
                            <Receipt className="w-3 h-3" />
                            <span>Receipt</span>
                          </button>
                          {tx.provider === 'flutterwave' &&
                            ['pending', 'pending_verification', 'failed'].includes(tx.status) && (
                            <button
                              type="button"
                              disabled={busyActionId === tx.id}
                              onClick={() => handleVerifyPayment(tx.id)}
                              className="bg-black text-white px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer"
                            >
                              {busyActionId === tx.id ? '...' : 'Verify'}
                            </button>
                          )}
                          {tx.status === 'paid' && (
                            <button
                              type="button"
                              onClick={() => {
                                setRefundTarget(tx);
                                setRefundAmount(String(tx.amountNgn));
                                setRefundDestination('wallet');
                                setRefundReason('');
                              }}
                              className="inline-flex items-center gap-1 border border-neutral-300 hover:border-black px-2 py-1 rounded text-[11px] font-semibold cursor-pointer"
                              title="Issue Refund"
                            >
                              <Undo2 className="w-3 h-3" />
                              <span>Refund</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          {txPage && (
            <div className="px-5 py-3.5 border-t border-neutral-200 bg-neutral-50 flex items-center justify-between text-xs">
              <span className="font-mono text-neutral-600">
                Page {txPage.page} of {txPage.totalPages} ({txPage.total} total)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={txPage.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 border border-neutral-300 bg-white px-3 py-1.5 rounded-lg font-semibold disabled:opacity-40 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Prev</span>
                </button>
                <button
                  type="button"
                  disabled={txPage.page >= txPage.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="inline-flex items-center gap-1 border border-neutral-300 bg-white px-3 py-1.5 rounded-lg font-semibold disabled:opacity-40 cursor-pointer"
                >
                  <span>Next</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 2. CUSTOMER WALLETS VIEW */}
      {subTab === 'wallets' && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display font-bold text-base">Customer Wallets & Balances</h3>
              <p className="text-xs text-neutral-500">
                Inspect wallet histories or perform audited manual balance adjustments.
              </p>
            </div>
            <input
              type="text"
              value={walletSearch}
              onChange={(e) => setWalletSearch(e.target.value)}
              placeholder="Search customer..."
              className="border border-neutral-300 rounded-lg px-3 py-2 text-xs w-full sm:w-64"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50 border-b border-neutral-200 text-neutral-500">
                <tr>
                  <th className="py-3 px-4 font-semibold">Customer</th>
                  <th className="py-3 px-4 font-semibold">Email / Phone</th>
                  <th className="py-3 px-4 font-semibold">Status</th>
                  <th className="py-3 px-4 font-semibold text-right">Available Balance</th>
                  <th className="py-3 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {(overview?.wallets || [])
                  .filter((w) => {
                    if (!walletSearch.trim()) return true;
                    const q = walletSearch.toLowerCase();
                    return (
                      (w.customerName || '').toLowerCase().includes(q) ||
                      (w.customerEmail || '').toLowerCase().includes(q) ||
                      w.userId.toLowerCase().includes(q)
                    );
                  })
                  .map((w) => (
                    <tr key={w.id} className="hover:bg-neutral-50">
                      <td className="py-3 px-4 font-semibold text-black">
                        {w.customerName || w.userId}
                      </td>
                      <td className="py-3 px-4 text-neutral-600">
                        {w.customerEmail} · {w.customerPhone}
                      </td>
                      <td className="py-3 px-4 font-mono uppercase text-[10px]">{w.status}</td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-sm tabular-nums">
                        {formatNaira(w.balanceNgn)}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => handleInspectCustomerWallet(w.userId)}
                          className="inline-flex items-center gap-1 border border-neutral-300 hover:border-black px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer"
                        >
                          <Eye className="w-3 h-3" />
                          <span>History</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setAdjustTarget(w);
                            setAdjustDirection('credit');
                            setAdjustAmount('');
                            setAdjustReason('');
                            setAdjustIdempotencyKey(`adj:${w.id}:${crypto.randomUUID()}`);
                          }}
                          className="bg-black text-white px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer"
                        >
                          Adjust
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. CASH & BANK TRANSFER RECONCILIATION */}
      {subTab === 'reconciliation' && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-200">
            <h3 className="font-display font-bold text-base">
              Cash on Delivery & Bank Transfer Reconciliation
            </h3>
            <p className="text-xs text-neutral-500">
              Monitor rider cash collections and verify customer bank transfers before marking deliveries settled.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50 border-b border-neutral-200 text-neutral-500">
                <tr>
                  <th className="py-3 px-4 font-semibold">Tracking</th>
                  <th className="py-3 px-4 font-semibold">Customer / Rider</th>
                  <th className="py-3 px-4 font-semibold">Method & Reference</th>
                  <th className="py-3 px-4 font-semibold text-right">Expected / Collected</th>
                  <th className="py-3 px-4 font-semibold">Status</th>
                  <th className="py-3 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {!overview || overview.cashCollections.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-neutral-500">
                      No cash collections or bank transfers recorded yet.
                    </td>
                  </tr>
                ) : (
                  overview.cashCollections.map((cc) => (
                    <tr key={cc.id} className="hover:bg-neutral-50">
                      <td className="py-3 px-4 font-mono font-bold">{cc.trackingCode}</td>
                      <td className="py-3 px-4">
                        <p className="font-semibold text-black">{cc.customerName || cc.customerId}</p>
                        {cc.riderName && (
                          <p className="text-[11px] text-neutral-500">Rider: {cc.riderName}</p>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-mono uppercase">{cc.paymentMethod.replace(/_/g, ' ')}</p>
                        {cc.transferReference && (
                          <p className="font-mono text-[11px] text-neutral-600">
                            Ref: {cc.transferReference}
                          </p>
                        )}
                        {cc.transferProofNote && (
                          <p className="text-[10px] text-neutral-500">{cc.transferProofNote}</p>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">
                        <p className="font-bold">{formatNaira(cc.expectedAmountNgn)}</p>
                        <p className="text-[10px] text-neutral-500">
                          Collected: {formatNaira(cc.collectedAmountNgn)}
                        </p>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full font-mono text-[10px] font-bold uppercase ${
                            cc.status === 'reconciled'
                              ? 'bg-black text-white'
                              : cc.status === 'disputed'
                                ? 'border border-black text-black'
                                : 'bg-neutral-200 text-neutral-800'
                          }`}
                        >
                          {cc.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                        {cc.status !== 'reconciled' && (
                          <>
                            <button
                              type="button"
                              disabled={busyActionId === cc.id}
                              onClick={() => handleReconcile(cc.id, 'reconcile')}
                              className="bg-black text-white px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer"
                            >
                              Verify & Reconcile
                            </button>
                            <button
                              type="button"
                              disabled={busyActionId === cc.id}
                              onClick={() => handleReconcile(cc.id, 'dispute')}
                              className="border border-neutral-300 hover:border-black px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer"
                            >
                              Dispute
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. REFUNDS, AUDIT LOGS & FLUTTERWAVE WEBHOOKS */}
      {subTab === 'refunds' && (
        <div className="space-y-6">
          <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-200">
              <h3 className="font-display font-bold text-base">Refunds History</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-neutral-50 border-b border-neutral-200 text-neutral-500">
                  <tr>
                    <th className="py-2.5 px-4 font-semibold">Refund Ref</th>
                    <th className="py-2.5 px-4 font-semibold">Customer</th>
                    <th className="py-2.5 px-4 font-semibold">Destination</th>
                    <th className="py-2.5 px-4 font-semibold">Reason</th>
                    <th className="py-2.5 px-4 font-semibold text-right">Amount</th>
                    <th className="py-2.5 px-4 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200">
                  {!overview || overview.refunds.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-neutral-500">
                        No refunds issued yet.
                      </td>
                    </tr>
                  ) : (
                    overview.refunds.map((rf) => (
                      <tr key={rf.id}>
                        <td className="py-2.5 px-4 font-mono font-bold">{rf.reference}</td>
                        <td className="py-2.5 px-4">{rf.customerName || rf.userId}</td>
                        <td className="py-2.5 px-4 font-mono uppercase">{rf.destination}</td>
                        <td className="py-2.5 px-4 text-neutral-700">{rf.reason}</td>
                        <td className="py-2.5 px-4 text-right font-mono font-bold tabular-nums">
                          {formatNaira(rf.amountNgn)}
                        </td>
                        <td className="py-2.5 px-4 font-mono uppercase text-[10px]">
                          {rf.status}
                          {rf.destination === 'flutterwave' && rf.status === 'pending' && (
                            <button type="button" className="ml-2 underline" disabled={verifyingRefund !== null}
                              onClick={() => handleVerifyRefund(rf.id)}>
                              {verifyingRefund === rf.id ? 'Checking…' : 'Verify'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-neutral-200">
                <h3 className="font-display font-bold text-sm">Admin Wallet Adjustment Audit Log</h3>
              </div>
              <div className="divide-y divide-neutral-200 max-h-80 overflow-y-auto">
                {!overview?.auditLogs || overview.auditLogs.length === 0 ? (
                  <p className="p-6 text-xs text-neutral-500 text-center">No manual wallet adjustments logged.</p>
                ) : (
                  overview.auditLogs.map((log) => (
                    <div key={log.id} className="p-3.5 text-xs space-y-1">
                      <div className="flex items-center justify-between font-semibold">
                        <span>
                          {log.customerName} ({log.direction?.toUpperCase()})
                        </span>
                        <span className="font-mono tabular-nums">{formatNaira(log.amountNgn)}</span>
                      </div>
                      <p className="text-neutral-600">Reason: {log.reason}</p>
                      <p className="text-[10px] font-mono text-neutral-400">
                        By {log.actorName || log.actorId} · {new Date(log.createdAt).toLocaleString()}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-neutral-200">
                <h3 className="font-display font-bold text-sm">Flutterwave Webhook Event Log</h3>
              </div>
              <div className="divide-y divide-neutral-200 max-h-80 overflow-y-auto">
                {!overview || overview.webhookEvents.length === 0 ? (
                  <p className="p-6 text-xs text-neutral-500 text-center">No webhook events received yet.</p>
                ) : (
                  overview.webhookEvents.map((ev) => (
                    <div key={ev.id} className="p-3.5 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold">{ev.eventType}</span>
                        <span className="font-mono text-[10px] uppercase px-2 py-0.5 rounded bg-neutral-100">
                          {ev.status} · sig {ev.signatureValid ? 'OK' : 'INVALID'}
                        </span>
                      </div>
                      <p className="font-mono text-[11px] text-neutral-600">
                        Ref: {ev.txRef || '—'} · FLW ID: {ev.flwTxId || '—'}
                      </p>
                      {ev.processingError && (
                        <p className="text-[11px] text-black font-medium">{ev.processingError}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Inspect Individual Customer Wallet Modal */}
      {inspectedWallet && (
        <div className="fixed inset-0 bg-black/65 z-50 flex items-center justify-center p-4">
          <div className="bg-white border-2 border-black rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="bg-black text-white px-6 py-4 flex items-center justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-400">
                  Customer Wallet Inspection
                </p>
                <h3 className="font-display font-bold text-lg">{inspectedWallet.profile.fullName}</h3>
              </div>
              <button
                type="button"
                onClick={() => setInspectedWallet(null)}
                className="p-1.5 rounded-lg hover:bg-white/10 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto space-y-5">
              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs text-neutral-500">Available Wallet Balance</p>
                  <p className="font-display font-extrabold text-3xl tabular-nums mt-0.5">
                    {formatNaira(inspectedWallet.wallet.balanceNgn)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAdjustTarget(inspectedWallet.wallet);
                    setAdjustDirection('credit');
                    setAdjustAmount('');
                    setAdjustReason('');
                    setAdjustIdempotencyKey(`adj:${inspectedWallet.wallet.id}:${crypto.randomUUID()}`);
                  }}
                  className="bg-black text-white px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer"
                >
                  Adjust Balance
                </button>
              </div>

              <div>
                <h4 className="font-mono text-xs uppercase font-bold text-neutral-500 mb-2">
                  Wallet Transaction Ledger ({inspectedWallet.walletTransactions.length})
                </h4>
                <div className="divide-y divide-neutral-200 border border-neutral-200 rounded-xl">
                  {inspectedWallet.walletTransactions.length === 0 ? (
                    <p className="p-6 text-xs text-neutral-500 text-center">No ledger transactions yet.</p>
                  ) : (
                    inspectedWallet.walletTransactions.map((wt) => (
                      <div key={wt.id} className="p-3.5 flex items-center justify-between text-xs gap-3">
                        <div>
                          <p className="font-semibold text-black">{wt.description}</p>
                          <p className="font-mono text-[10px] text-neutral-500">
                            {wt.reference} · {new Date(wt.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="text-right font-mono tabular-nums">
                          <p className="font-bold">
                            {wt.balanceAfterNgn >= wt.balanceBeforeNgn ? '+' : '-'}
                            {formatNaira(wt.amountNgn)}
                          </p>
                          <p className="text-[10px] text-neutral-500">
                            Bal: {formatNaira(wt.balanceAfterNgn)}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Manual Wallet Adjustment Modal */}
      {adjustTarget && (
        <div className="fixed inset-0 bg-black/65 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleWalletAdjustSubmit}
            className="bg-white border-2 border-black rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4" />
                <h3 className="font-display font-bold text-lg">Adjust Customer Wallet</h3>
              </div>
              <button
                type="button"
                onClick={() => setAdjustTarget(null)}
                className="text-xs border border-neutral-300 px-2.5 py-1 rounded-lg cursor-pointer"
              >
                Close
              </button>
            </div>
            <p className="text-xs text-neutral-600">
              Customer: <strong className="text-black">{adjustTarget.customerName || adjustTarget.userId}</strong>{' '}
              · Current Balance:{' '}
              <strong className="font-mono">{formatNaira(adjustTarget.balanceNgn)}</strong>
            </p>
            <div className="grid grid-cols-2 gap-2 p-1 bg-neutral-100 rounded-lg">
              {(['credit', 'debit'] as const).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setAdjustDirection(dir)}
                  className={`py-2 rounded-md text-xs font-bold uppercase cursor-pointer ${
                    adjustDirection === dir ? 'bg-black text-white' : 'text-neutral-600'
                  }`}
                >
                  {dir} Wallet
                </button>
              ))}
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Amount (NGN)</label>
              <input
                type="number"
                min={1}
                step="0.01"
                required
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm font-mono font-bold"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Mandatory Audit Reason</label>
              <textarea
                rows={2}
                required
                minLength={3}
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="e.g. Manual top-up reconciliation or dispute settlement"
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdjustTarget(null)}
                className="px-4 py-2 rounded-lg border border-neutral-300 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={adjustBusy}
                className="px-4 py-2 rounded-lg bg-black text-white text-xs font-bold cursor-pointer"
              >
                {adjustBusy ? 'Processing...' : 'Confirm Adjustment'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Refund Modal */}
      {refundTarget && (
        <div className="fixed inset-0 bg-black/65 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleRefundSubmit}
            className="bg-white border-2 border-black rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-lg">Issue Payment Refund</h3>
              <button
                type="button"
                onClick={() => setRefundTarget(null)}
                className="text-xs border border-neutral-300 px-2.5 py-1 rounded-lg cursor-pointer"
              >
                Close
              </button>
            </div>
            <p className="text-xs text-neutral-600">
              Ref: <strong className="font-mono text-black">{refundTarget.reference}</strong> · Paid:{' '}
              <strong className="font-mono">{formatNaira(refundTarget.amountNgn)}</strong>
            </p>
            <div>
              <label className="block text-xs font-semibold mb-1">Refund Destination</label>
              <select
                value={refundDestination}
                onChange={(e) => setRefundDestination(e.target.value as any)}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs bg-white"
              >
                <option value="wallet">Credit Customer SAQO Wallet (Instant)</option>
                {refundTarget.provider === 'flutterwave' && (
                  <option value="flutterwave">Refund via Flutterwave API</option>
                )}
                <option value="manual">Record Manual Bank Refund</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Refund Amount (NGN)</label>
              <input
                type="number"
                min={1}
                max={refundTarget.amountNgn}
                step="0.01"
                required
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-sm font-mono font-bold"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Refund Reason (Mandatory)</label>
              <textarea
                rows={2}
                required
                minLength={3}
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                placeholder="Reason for refunding customer..."
                className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRefundTarget(null)}
                className="px-4 py-2 rounded-lg border border-neutral-300 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={refundBusy}
                className="px-4 py-2 rounded-lg bg-black text-white text-xs font-bold cursor-pointer"
              >
                {refundBusy ? 'Refunding...' : 'Process Refund'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ReceiptModal receipt={activeReceipt} onClose={() => setActiveReceipt(null)} />
    </div>
  );
};
