import React, { useState } from 'react';
import { MessageCircle, ArrowUpRight, X } from 'lucide-react';

interface WhatsAppWidgetProps {
  whatsappNumber: string;
  contextMessage?: string;
}

export function buildWhatsAppUrl(phoneNumber: string, message: string): string {
  const digits = (phoneNumber || '2348007276000').replace(/[^\d]/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export const WhatsAppWidget: React.FC<WhatsAppWidgetProps> = ({
  whatsappNumber,
  contextMessage = 'Hello SAQO Support, I need assistance with a parcel delivery.',
}) => {
  const [open, setOpen] = useState(false);
  const href = buildWhatsAppUrl(whatsappNumber, contextMessage);

  return (
    <div className="fixed bottom-20 md:bottom-5 right-4 md:right-5 z-40 flex flex-col items-end gap-3">
      {open && (
        <div
          role="dialog"
          aria-label="SAQO WhatsApp Support"
          className="w-80 bg-white text-black border border-black/15 rounded-xl shadow-2xl p-5"
        >
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <p className="font-display font-bold text-base leading-snug">
                SAQO Parcel Support
              </p>
              <p className="text-xs text-neutral-500 mt-0.5">
                Direct WhatsApp dispatch desk
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close support popover"
              className="p-1.5 rounded-md hover:bg-neutral-100 text-neutral-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-sm text-neutral-700 leading-relaxed mb-4">
            Need help with a pickup, inter-state corridor, or delivery OTP? Message our dispatch team directly on WhatsApp.
          </p>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full inline-flex items-center justify-center gap-2 bg-black text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-neutral-800 transition-colors whitespace-nowrap"
          >
            <span>Open WhatsApp Chat</span>
            <ArrowUpRight className="w-4 h-4" />
          </a>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="WhatsApp Support"
        aria-expanded={open}
        className="inline-flex items-center justify-center gap-2 bg-black text-white border border-white/25 w-12 h-12 sm:w-auto sm:h-auto sm:px-4 sm:py-3 rounded-full shadow-lg hover:bg-neutral-800 transition-transform active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
      >
        <MessageCircle className="w-5 h-5 sm:w-4 sm:h-4" />
        <span className="hidden sm:inline text-sm font-semibold">WhatsApp Support</span>
      </button>
    </div>
  );
};
