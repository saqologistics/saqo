import { useEffect, useLayoutEffect, useState } from 'react';
import { ApiError, apiRequest, getStoredToken, setStoredToken } from './lib/api';
import { staticPreview } from './lib/deployment';
import { useRealtime } from './hooks/useRealtime';
import { DEFAULT_PLATFORM_SETTINGS } from './shared/pricing';
import type { PlatformSettings, Profile, RiderProfile } from './shared/types';
import { AdminDashboard } from './components/AdminDashboard';
import { AuthView } from './components/AuthView';
import { ClientDashboard } from './components/ClientDashboard';
import { LandingPage, type QuickDraft } from './components/LandingPage';
import { RiderDashboard } from './components/RiderDashboard';
import { SupportChatWidget } from './components/SupportChatWidget';

const createEmptyKatsinaDraft = (): QuickDraft => ({
  pickupState: 'Katsina', pickupAddress: '', destinationState: 'Katsina', destinationAddress: '',
});

type Screen = 'landing' | 'auth' | 'dashboard';

const SCREEN_STORAGE_KEY = 'saqo_active_screen';

function getStoredScreen(): 'landing' | 'dashboard' | null {
  try {
    const val = window.sessionStorage.getItem(SCREEN_STORAGE_KEY) ?? window.localStorage.getItem(SCREEN_STORAGE_KEY);
    return val === 'landing' || val === 'dashboard' ? val : null;
  } catch {
    return null;
  }
}

function setStoredScreen(next: Screen | null) {
  try {
    if (next === 'landing' || next === 'dashboard') {
      window.sessionStorage.setItem(SCREEN_STORAGE_KEY, next);
      window.localStorage.setItem(SCREEN_STORAGE_KEY, next);
    } else {
      window.sessionStorage.removeItem(SCREEN_STORAGE_KEY);
      window.localStorage.removeItem(SCREEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota or private-mode restrictions.
  }
}

function clearDashboardTabStorage() {
  try {
    const prefixes = ['saqo_client_tab_', 'saqo_rider_tab_', 'saqo_admin_section_'];
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const key = window.sessionStorage.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore storage errors.
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(() =>
    getStoredToken() && getStoredScreen() === 'dashboard' ? 'dashboard' : 'landing',
  );
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authRole, setAuthRole] = useState<'client' | 'rider'>('client');
  const [quickDraft, setQuickDraft] = useState<QuickDraft | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [_rider, setRider] = useState<RiderProfile | null>(null);
  const [whatsappNumber, setWhatsappNumber] = useState(
    DEFAULT_PLATFORM_SETTINGS.whatsappSupportNumber
  );
  const [initialTrackCode] = useState<string>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return (params.get('track') || '').trim().toUpperCase();
    } catch {
      return '';
    }
  });
  const [supportChatSignal, setSupportChatSignal] = useState<{
    nonce: number;
    trackingCode?: string;
  } | null>(null);
  const [showDeliveryStateSelectors, setShowDeliveryStateSelectors] = useState(false);
  const [whatsAppOrderNumber, setWhatsAppOrderNumber] = useState<string | null>(null);

  useRealtime((event) => {
    if (event.type === 'settings:updated') {
      const settings = event.payload as PlatformSettings;
      setShowDeliveryStateSelectors(settings.showDeliveryStateSelectors);
    }
  });

  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (staticPreview) {
      setBooting(false);
      return;
    }
    const boot = async () => {
      const params = new URLSearchParams(window.location.search);
      const order = params.get('order') === '1';
      if (order) {
        setQuickDraft(createEmptyKatsinaDraft());
        setScreen('auth');
      }
      const token = getStoredToken();
      await Promise.all([
        apiRequest<{ whatsappSupportNumber: string; showDeliveryStateSelectors: boolean; whatsAppOrderNumber: string | null }>('/api/settings/public', { signal: AbortSignal.timeout(8000) })
          .then((settings) => {
            if (settings.whatsappSupportNumber) setWhatsappNumber(settings.whatsappSupportNumber);
            setShowDeliveryStateSelectors(settings.showDeliveryStateSelectors);
            setWhatsAppOrderNumber(settings.whatsAppOrderNumber);
          })
          .catch(() => {
            // The app can start with its default support number.
          }),
        token
          ? apiRequest<{ profile: Profile; rider: RiderProfile | null }>('/api/auth/me', {
              signal: AbortSignal.timeout(8000),
            }).then((session) => {
              setProfile(session.profile);
              setRider(session.rider);
              const forceDashboard =
                (order && session.profile.role === 'client') ||
                params.get('autostart') === '1' ||
                params.get('flw_callback') === '1' ||
                params.has('tx_ref') ||
                window.location.pathname.startsWith('/dashboard');
              if (forceDashboard || (!params.has('track') && getStoredScreen() === 'dashboard')) {
                setStoredScreen('dashboard');
                setScreen('dashboard');
              }
            }).catch((error: unknown) => {
              if (error instanceof ApiError && [401, 403].includes(error.status)) {
                setStoredToken(null);
                setStoredScreen(null);
                clearDashboardTabStorage();
              }
              setScreen('landing');
            })
          : Promise.resolve(),
      ]);
      setBooting(false);
    };
    boot();
  }, []);

  useLayoutEffect(() => {
    if (!booting) {
      document.getElementById('saqo-startup')?.remove();
    }
  }, [booting]);

  const handleNavigateAuth = (
    mode: 'login' | 'register' = 'login',
    role: 'client' | 'rider' = 'client',
    draft?: QuickDraft
  ) => {
    if (staticPreview) {
      document.getElementById('saqo-preview-notice')?.scrollIntoView({ block: 'center' });
      return;
    }
    setAuthMode(mode);
    setAuthRole(role);
    setQuickDraft(draft || null);
    setScreen('auth');
  };

  const handleAuthenticated = (nextProfile: Profile, nextRider: RiderProfile | null) => {
    setProfile(nextProfile);
    setRider(nextRider);
    setStoredScreen('dashboard');
    setScreen('dashboard');
  };

  const handleLogout = () => {
    setStoredToken(null);
    setStoredScreen(null);
    clearDashboardTabStorage();
    setProfile(null);
    setRider(null);
    setQuickDraft(null);
    setScreen('landing');
  };

  const goHome = () => {
    setStoredScreen('landing');
    setScreen('landing');
  };

  if (booting) {
    return null;
  }

  return (
    <>
      {staticPreview && (
        <p id="saqo-preview-notice" role="note" className="bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-950">
          SAQO preview. Sign-in, booking, payments, tracking, and live support will be available after launch.
        </p>
      )}
      {screen === 'landing' && (
        <LandingPage
          currentUser={profile}
          showDeliveryStateSelectors={showDeliveryStateSelectors}
          whatsAppOrderNumber={whatsAppOrderNumber}
          whatsappNumber={whatsappNumber}
          initialTrackCode={initialTrackCode}
          onNavigateAuth={handleNavigateAuth}
          onOpenDashboard={(draft) => {
            setQuickDraft(draft || null);
            setStoredScreen('dashboard');
            setScreen('dashboard');
          }}
          onOpenSupportChat={(code) =>
            setSupportChatSignal({ nonce: Date.now(), trackingCode: code })
          }
        />
      )}

      {screen === 'auth' && (
        <AuthView
          initialMode={authMode}
          initialRole={authRole}
          onBack={() => setScreen('landing')}
          onAuthenticated={handleAuthenticated}
        />
      )}

      {screen === 'dashboard' && profile?.role === 'client' && (
        <ClientDashboard
          profile={profile}
          showDeliveryStateSelectors={showDeliveryStateSelectors}
          whatsappNumber={whatsappNumber}
          initialDraft={quickDraft}
          onGoHome={goHome}
          onLogout={handleLogout}
          onProfileUpdated={(nextProfile) => setProfile(nextProfile)}
        />
      )}

      {screen === 'dashboard' && profile?.role === 'rider' && (
        <RiderDashboard
          profile={profile}
          onGoHome={goHome}
          onLogout={handleLogout}
          onProfileUpdated={(nextProfile) => setProfile(nextProfile)}
        />
      )}

      {screen === 'dashboard' && profile?.role === 'admin' && (
        <AdminDashboard
          profile={profile}
          onGoHome={goHome}
          onLogout={handleLogout}
          onSettingsChanged={(s: PlatformSettings) => {
            setWhatsappNumber(s.whatsappSupportNumber);
            setShowDeliveryStateSelectors(s.showDeliveryStateSelectors);
          }}
        />
      )}

      {/* Persistent Live Support Chat connected to SAQO Admin across customer-facing pages */}
      {!staticPreview && (screen === 'landing' || (screen === 'dashboard' && profile?.role === 'client')) && (
        <SupportChatWidget
          key={profile?.id || 'visitor'}
          currentUser={profile}
          whatsappNumber={whatsappNumber}
          openSignal={supportChatSignal}
        />
      )}

    </>
  );
}
