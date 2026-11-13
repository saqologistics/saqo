import { useEffect, useState } from 'react';
import { apiRequest, getStoredToken, setStoredToken } from './lib/api';
import { DEFAULT_PLATFORM_SETTINGS } from './shared/pricing';
import type { PlatformSettings, Profile, RiderProfile } from './shared/types';
import { AdminDashboard } from './components/AdminDashboard';
import { AuthView } from './components/AuthView';
import { ClientDashboard } from './components/ClientDashboard';
import { LandingPage, type QuickDraft } from './components/LandingPage';
import { OfflineIndicator } from './components/OfflineIndicator';
import { RiderDashboard } from './components/RiderDashboard';
import { SupportChatWidget } from './components/SupportChatWidget';

type Screen = 'landing' | 'auth' | 'dashboard';

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');
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
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const boot = async () => {
      try {
        const pub = await apiRequest<{ whatsappSupportNumber: string }>(
          '/api/settings/public'
        );
        if (pub.whatsappSupportNumber) {
          setWhatsappNumber(pub.whatsappSupportNumber);
        }
      } catch {
        // fallback to default whatsapp number
      }

      const token = getStoredToken();
      if (token) {
        try {
          const me = await apiRequest<{
            profile: Profile;
            rider: RiderProfile | null;
          }>('/api/auth/me');
          setProfile(me.profile);
          setRider(me.rider);
          if (window.location.search.includes('autostart=1')) {
            setScreen('dashboard');
          }
        } catch {
          setStoredToken(null);
        }
      }
      setBooting(false);
    };
    boot();
  }, []);

  const handleNavigateAuth = (
    mode: 'login' | 'register' = 'login',
    role: 'client' | 'rider' = 'client',
    draft?: QuickDraft
  ) => {
    setAuthMode(mode);
    setAuthRole(role);
    setQuickDraft(draft || null);
    setScreen('auth');
  };

  const handleAuthenticated = (nextProfile: Profile, nextRider: RiderProfile | null) => {
    setProfile(nextProfile);
    setRider(nextRider);
    setScreen('dashboard');
  };

  const handleLogout = () => {
    setStoredToken(null);
    setProfile(null);
    setRider(null);
    setQuickDraft(null);
    setScreen('landing');
  };

  if (booting) {
    return (
      <div className="min-h-screen bg-white text-black flex items-center justify-center">
        <p className="font-display font-bold text-lg tracking-tight">Loading SAQO...</p>
      </div>
    );
  }

  return (
    <>
      {screen === 'landing' && (
        <LandingPage
          currentUser={profile}
          whatsappNumber={whatsappNumber}
          initialTrackCode={initialTrackCode}
          onNavigateAuth={handleNavigateAuth}
          onOpenDashboard={() => setScreen('dashboard')}
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
          whatsappNumber={whatsappNumber}
          initialDraft={quickDraft}
          onGoHome={() => setScreen('landing')}
          onLogout={handleLogout}
        />
      )}

      {screen === 'dashboard' && profile?.role === 'rider' && (
        <RiderDashboard
          profile={profile}
          onGoHome={() => setScreen('landing')}
          onLogout={handleLogout}
        />
      )}

      {screen === 'dashboard' && profile?.role === 'admin' && (
        <AdminDashboard
          profile={profile}
          onGoHome={() => setScreen('landing')}
          onLogout={handleLogout}
          onSettingsChanged={(s: PlatformSettings) =>
            setWhatsappNumber(s.whatsappSupportNumber)
          }
        />
      )}

      {/* Persistent Live Support Chat connected to SAQO Admin across customer-facing pages */}
      {(screen === 'landing' || (screen === 'dashboard' && profile?.role === 'client')) && (
        <SupportChatWidget
          currentUser={profile}
          whatsappNumber={whatsappNumber}
          openSignal={supportChatSignal}
        />
      )}

      <OfflineIndicator />
    </>
  );
}
