import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  inverted?: boolean;
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  inverted = false,
  compact = false,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const baseClass = inverted
    ? 'inline-flex items-center gap-1.5 border border-white/25 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-white/10 transition-colors whitespace-nowrap shrink-0 cursor-pointer'
    : 'inline-flex items-center gap-1.5 border border-neutral-300 text-black px-3 py-1.5 rounded-lg text-xs font-semibold hover:border-black transition-colors whitespace-nowrap shrink-0 cursor-pointer';

  if (isInstallable) {
    return (
      <button type="button" onClick={install} className={baseClass} aria-label="Install SAQO App">
        <Download className="w-3.5 h-3.5" />
        <span>{compact ? 'Install' : 'Install App'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className={baseClass}
          aria-label="Install SAQO on iOS"
        >
          <Share className="w-3.5 h-3.5" />
          <span>{compact ? 'Install' : 'Add to Home'}</span>
        </button>

        {showIOSGuide && (
          <div
            role="dialog"
            aria-label="Install SAQO on iPhone or iPad"
            className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-4"
          >
            <div className="w-full max-w-sm bg-white text-black rounded-2xl p-6 space-y-4 border border-black">
              <div className="flex items-center justify-between">
                <h3 className="font-display font-bold text-lg">Install SAQO on iOS</h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close install guide"
                  className="p-1 text-neutral-500 hover:text-black cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ol className="text-sm text-neutral-700 space-y-2 list-decimal pl-4">
                <li>
                  Tap the <strong>Share</strong> button in the Safari toolbar.
                </li>
                <li>
                  Scroll down and tap <strong>Add to Home Screen</strong>.
                </li>
                <li>
                  Tap <strong>Add</strong> to launch SAQO like a native app.
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full bg-black text-white py-2.5 rounded-lg text-sm font-semibold cursor-pointer"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
