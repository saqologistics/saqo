import React, { useState } from 'react';
import { ArrowLeft, BadgeCheck, Lock, ShieldCheck, Truck, User } from 'lucide-react';
import { apiRequest, setStoredToken } from '../lib/api';
import type { Profile, RiderProfile } from '../shared/types';
import { SaqoLogo } from './SaqoLogo';

interface AuthViewProps {
  initialMode?: 'login' | 'register';
  initialRole?: 'client' | 'rider';
  onBack: () => void;
  onAuthenticated: (profile: Profile, rider: RiderProfile | null) => void;
}

export const AuthView: React.FC<AuthViewProps> = ({
  initialMode = 'login',
  initialRole = 'client',
  onBack,
  onAuthenticated,
}) => {
  const [mode, setMode] = useState<'login' | 'register'>(
    initialRole === 'rider' ? 'login' : initialMode
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submitLogin = async (loginEmail: string, loginPass: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{
        token: string;
        profile: Profile;
        rider: RiderProfile | null;
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail, password: loginPass }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.profile, res.rider);
    } catch (err: any) {
      setError(err.message || 'Sign in failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'login') {
      await submitLogin(email, password);
      return;
    }

    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      setError('Please enter a valid phone number (at least 10 digits).');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{
        token: string;
        profile: Profile;
        rider: RiderProfile | null;
      }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          fullName,
          phone,
          role: 'client',
        }),
      });
      setStoredToken(res.token);
      onAuthenticated(res.profile, res.rider);
    } catch (err: any) {
      setError(err.message || 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-black flex flex-col">
      <header className="border-b border-neutral-200 px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm font-medium text-neutral-700 hover:text-black cursor-pointer shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Back to SAQO</span>
          <span className="sm:hidden">Back</span>
        </button>
        <SaqoLogo showLogisticsSub />
        <div className="w-12 sm:w-24" />
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-12 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">
        {/* Form Column */}
        <div className="lg:col-span-7 bg-white border border-neutral-200 rounded-xl p-6 sm:p-8">
          <div className="flex items-center gap-2 border-b border-neutral-200 pb-4 mb-6">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer ${
                mode === 'login'
                  ? 'bg-black text-white'
                  : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setError(null);
              }}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer ${
                mode === 'register'
                  ? 'bg-black text-white'
                  : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              Create Account
            </button>
          </div>

          <h1 className="font-display font-bold text-2xl">
            {mode === 'login' ? 'Sign in to SAQO' : 'Create a Customer Account'}
          </h1>
          <p className="text-sm text-neutral-600 mt-1 mb-6">
            {mode === 'login'
              ? 'Sign in with your Customer, Rider, or SAQO Operations credentials.'
              : 'Send and track parcels across Nigeria with real-time rider updates and OTP confirmation.'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="auth-fullname" className="block text-xs font-semibold mb-1.5">
                    Full Name
                  </label>
                  <input
                    id="auth-fullname"
                    type="text"
                    required
                    autoComplete="name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Amina Bello"
                    className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label htmlFor="auth-phone" className="block text-xs font-semibold mb-1.5">
                    Phone Number <span className="text-neutral-500 font-normal">(Required)</span>
                  </label>
                  <input
                    id="auth-phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+234 803 000 0000"
                    className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className="block text-xs font-semibold mb-1.5">
                Email Address
              </label>
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>

            <div>
              <label htmlFor="auth-password" className="block text-xs font-semibold mb-1.5">
                Password
              </label>
              <input
                id="auth-password"
                type="password"
                required
                minLength={6}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                className="w-full border border-neutral-300 rounded-lg px-3.5 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>

            {error && (
              <div role="alert" className="bg-neutral-100 border border-black rounded-lg px-4 py-2.5 text-sm font-medium">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-black text-white py-3 rounded-lg text-sm font-bold hover:bg-neutral-800 transition-colors cursor-pointer"
            >
              {loading
                ? 'Please wait...'
                : mode === 'login'
                ? 'Sign In'
                : 'Create Customer Account'}
            </button>
          </form>
        </div>

        {/* Production Onboarding & Account Policy Panel */}
        <div className="lg:col-span-5 bg-neutral-50 border border-neutral-200 rounded-xl p-6 space-y-5">
          <div>
            <p className="text-[11px] font-mono uppercase tracking-wider text-neutral-500">
              SAQO Account Access
            </p>
            <h2 className="font-display font-bold text-lg mt-1">
              Onboarding & Verification Policy
            </h2>
            <p className="text-xs text-neutral-600 mt-1 leading-relaxed">
              SAQO maintains verified courier dispatch across Katsina and all Nigerian states.
            </p>
          </div>

          <div className="space-y-3">
            <div className="bg-white border border-neutral-200 rounded-lg p-4 space-y-1.5">
              <p className="font-display font-bold text-sm flex items-center gap-2">
                <User className="w-4 h-4 shrink-0" />
                <span>Customer Accounts</span>
              </p>
              <p className="text-xs text-neutral-600 leading-relaxed">
                Register directly with your full name, active Nigerian phone number, and email to send parcels, track live rider movement, and submit support tickets.
              </p>
            </div>

            <div className="bg-white border border-neutral-200 rounded-lg p-4 space-y-1.5">
              <p className="font-display font-bold text-sm flex items-center gap-2">
                <Truck className="w-4 h-4 shrink-0" />
                <span>Dispatch Rider Accounts</span>
              </p>
              <p className="text-xs text-neutral-600 leading-relaxed">
                Rider accounts are issued exclusively by SAQO Operations Admin after onboarding checks. Riders with an active account should sign in on the left with their issued email and password.
              </p>
            </div>

            <div className="bg-black text-white rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2 font-display font-bold text-sm">
                <BadgeCheck className="w-4 h-4 shrink-0" />
                <span>Verified Rider Tick & OTP Handoff</span>
              </div>
              <p className="text-xs text-neutral-300 leading-relaxed">
                Only riders with an Admin-enabled verification tick can go online and accept parcel offers. Every handoff requires a 4-digit recipient OTP.
              </p>
              <div className="flex items-center gap-4 pt-1 text-[11px] text-neutral-300 font-mono">
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Admin Verified</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <Lock className="w-3.5 h-3.5" />
                  <span>4-Digit OTP</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
