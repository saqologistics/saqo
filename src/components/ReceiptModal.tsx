import React from 'react';
import { Download, FileText, Printer, X } from 'lucide-react';
import {
  downloadReceiptPdf,
  downloadReceiptPng,
  printReceipt,
  type SaqoReceiptData,
} from '../lib/receipt';
import { formatNaira } from '../shared/pricing';

interface Props {
  receipt: SaqoReceiptData | null;
  onClose: () => void;
}

export const ReceiptModal: React.FC<Props> = ({ receipt, onClose }) => {
  if (!receipt) return null;

  const formattedDate = new Date(receipt.createdAt).toLocaleString('en-NG', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const statusLabel = receipt.status.replace(/_/g, ' ').toUpperCase();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="SAQO Official Payment Receipt"
    >
      <div className="relative w-full max-w-lg rounded-2xl border-2 border-neutral-900 bg-white text-neutral-950 shadow-2xl overflow-hidden">
        {/* Header Bar */}
        <div className="flex items-start justify-between bg-neutral-950 px-6 py-5 text-white">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-neutral-400">
              SAQO Logistics · Official Receipt
            </p>
            <h3 className="mt-1 font-display text-xl font-bold tracking-tight">{receipt.title}</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-white px-3 py-1 font-mono text-[11px] font-bold tracking-wider text-neutral-950">
              {statusLabel}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-neutral-300 hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Close receipt"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Receipt Body */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-5 py-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
              Total Amount
            </p>
            <p className="mt-1 font-display text-3xl sm:text-4xl font-bold tracking-tight tabular-nums text-neutral-950">
              {formatNaira(receipt.amountNgn)}
            </p>
          </div>

          <div className="divide-y divide-neutral-200 text-xs sm:text-sm">
            <div className="flex items-center justify-between py-2.5 gap-3">
              <span className="font-mono uppercase text-[11px] text-neutral-500">Reference</span>
              <span className="font-mono font-bold text-neutral-950 break-all text-right">
                {receipt.reference}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5 gap-3">
              <span className="font-mono uppercase text-[11px] text-neutral-500">Receipt Type</span>
              <span className="font-semibold text-neutral-900">{receipt.receiptType}</span>
            </div>
            <div className="flex items-center justify-between py-2.5 gap-3">
              <span className="font-mono uppercase text-[11px] text-neutral-500">Method</span>
              <span className="font-mono font-semibold uppercase text-neutral-900">
                {receipt.paymentMethod.replace(/_/g, ' ')}
              </span>
            </div>
            <div className="flex items-center justify-between py-2.5 gap-3">
              <span className="font-mono uppercase text-[11px] text-neutral-500">Date & Time</span>
              <span className="font-mono text-neutral-900">{formattedDate}</span>
            </div>
            {receipt.customerName && (
              <div className="flex items-center justify-between py-2.5 gap-3">
                <span className="font-mono uppercase text-[11px] text-neutral-500">Customer</span>
                <span className="font-medium text-neutral-900">{receipt.customerName}</span>
              </div>
            )}
            {receipt.customerEmail && (
              <div className="flex items-center justify-between py-2.5 gap-3">
                <span className="font-mono uppercase text-[11px] text-neutral-500">Email</span>
                <span className="font-mono text-xs text-neutral-800">{receipt.customerEmail}</span>
              </div>
            )}
            {receipt.trackingCode && (
              <div className="flex items-center justify-between py-2.5 gap-3">
                <span className="font-mono uppercase text-[11px] text-neutral-500">Tracking Code</span>
                <span className="font-mono font-bold text-neutral-950">{receipt.trackingCode}</span>
              </div>
            )}
            {receipt.providerTxId && (
              <div className="flex items-center justify-between py-2.5 gap-3">
                <span className="font-mono uppercase text-[11px] text-neutral-500">Gateway Tx ID</span>
                <span className="font-mono text-neutral-900">{receipt.providerTxId}</span>
              </div>
            )}
            {receipt.transferReference && (
              <div className="flex items-center justify-between py-2.5 gap-3">
                <span className="font-mono uppercase text-[11px] text-neutral-500">Transfer Ref</span>
                <span className="font-mono text-neutral-900">{receipt.transferReference}</span>
              </div>
            )}
            {receipt.balanceBeforeNgn !== undefined && (
              <div className="flex items-center justify-between py-2.5 gap-3">
                <span className="font-mono uppercase text-[11px] text-neutral-500">Balance Before</span>
                <span className="font-mono tabular-nums text-neutral-800">
                  {formatNaira(receipt.balanceBeforeNgn)}
                </span>
              </div>
            )}
            {receipt.balanceAfterNgn !== undefined && (
              <div className="flex items-center justify-between py-2.5 gap-3">
                <span className="font-mono uppercase text-[11px] text-neutral-500">Balance After</span>
                <span className="font-mono font-bold tabular-nums text-neutral-950">
                  {formatNaira(receipt.balanceAfterNgn)}
                </span>
              </div>
            )}
            {receipt.description && (
              <div className="py-2.5">
                <p className="font-mono uppercase text-[11px] text-neutral-500">Description</p>
                <p className="mt-1 text-xs text-neutral-800">{receipt.description}</p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 bg-neutral-50 px-6 py-4">
          <button
            type="button"
            onClick={() => printReceipt(receipt)}
            className="inline-flex items-center gap-2 rounded-xl border border-neutral-300 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-900 hover:bg-neutral-100 transition-colors"
          >
            <Printer className="h-3.5 w-3.5" />
            Print
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => downloadReceiptPng(receipt)}
              className="inline-flex items-center gap-2 rounded-xl border border-neutral-900 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-100 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Download PNG
            </button>
            <button
              type="button"
              onClick={() => downloadReceiptPdf(receipt)}
              className="inline-flex items-center gap-2 rounded-xl bg-neutral-950 px-3.5 py-2 text-xs font-semibold text-white hover:bg-neutral-800 transition-colors"
            >
              <FileText className="h-3.5 w-3.5" />
              Download PDF
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
