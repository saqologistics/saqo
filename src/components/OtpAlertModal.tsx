import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface Props {
  open: boolean;
  title?: string;
  message: string;
  trackingCode?: string;
  onClose: () => void;
}

export const OtpAlertModal: React.FC<Props> = ({
  open,
  title = 'Invalid Delivery OTP',
  message,
  trackingCode,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="saqo-otp-alert-title"
      aria-describedby="saqo-otp-alert-desc"
    >
      <div className="w-full max-w-md rounded-2xl bg-white border-2 border-black shadow-2xl overflow-hidden">
        <div className="bg-black text-white px-5 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4" />
            </span>
            <div>
              <h3 id="saqo-otp-alert-title" className="font-display font-bold text-base">
                {title}
              </h3>
              {trackingCode && (
                <p className="font-mono text-[11px] text-neutral-300">{trackingCode}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close OTP error popup"
            className="p-1.5 rounded-lg text-neutral-300 hover:text-white hover:bg-white/10 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p id="saqo-otp-alert-desc" className="text-sm font-semibold text-black leading-relaxed">
            {message}
          </p>
          <div className="rounded-xl bg-neutral-100 border border-neutral-200 p-3.5 text-xs text-neutral-700 space-y-1">
            <p className="font-semibold text-black">How to fix this:</p>
            <p>Check the 4-digit delivery handoff OTP shown on the sender&apos;s or recipient&apos;s parcel card and re-enter all 4 digits carefully.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-full bg-black text-white py-3 rounded-xl text-sm font-bold hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  );
};
