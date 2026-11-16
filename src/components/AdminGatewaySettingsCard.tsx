import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, CreditCard, ShieldCheck } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useRealtime } from '../hooks/useRealtime';
import type { PaymentGatewayAdminView, PaymentMethodCode } from '../shared/types';

export const AdminGatewaySettingsCard: React.FC<{
  onNotify: (msg: string) => void;
}> = ({ onNotify }) => {
  const [gateway, setGateway] = useState<PaymentGatewayAdminView | null>(null);
  const [publicKey, setPublicKey] = useState('');
  const [secretKeyInput, setSecretKeyInput] = useState('');
  const [encryptionKeyInput, setEncryptionKeyInput] = useState('');
  const [webhookHashInput, setWebhookHashInput] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [mode, setMode] = useState<'test' | 'live'>('test');
  const [isEnabled, setIsEnabled] = useState(false);
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankInstructions, setBankInstructions] = useState('');
  const [methodToggles, setMethodToggles] = useState<Record<PaymentMethodCode, boolean>>({
    wallet: true,
    flutterwave: true,
    cash: true,
    bank_transfer: true,
  });
  const [saving, setSaving] = useState(false);
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGatewaySettings = useCallback(async () => {
    try {
      const data = await apiRequest<PaymentGatewayAdminView>('/api/admin/gateway-settings');
      setGateway(data);
      setPublicKey(data.publicKey || '');
      setWebhookUrl(data.webhookUrl || '');
      setMode(data.mode);
      setIsEnabled(data.isEnabled);
      setBankName(data.bankName || '');
      setBankAccountName(data.bankAccountName || '');
      setBankAccountNumber(data.bankAccountNumber || '');
      setBankInstructions(data.bankInstructions || '');
      const toggles: Record<PaymentMethodCode, boolean> = {
        wallet: true,
        flutterwave: true,
        cash: true,
        bank_transfer: true,
      };
      data.methods.forEach((m) => {
        toggles[m.code] = m.isEnabled;
      });
      setMethodToggles(toggles);
      setSecretKeyInput('');
      setEncryptionKeyInput('');
      setWebhookHashInput('');
    } catch (err: any) {
      setError(err.message || 'Failed to load payment gateway settings.');
    }
  }, []);

  useEffect(() => {
    loadGatewaySettings();
  }, [loadGatewaySettings]);

  useRealtime((evt) => {
    if (evt.type === 'gateway:updated' || evt.type === 'notifications:refresh') {
      loadGatewaySettings();
    }
  });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        publicKey: publicKey.trim(),
        webhookUrl: webhookUrl.trim(),
        mode,
        isEnabled,
        bankName: bankName.trim(),
        bankAccountName: bankAccountName.trim(),
        bankAccountNumber: bankAccountNumber.trim(),
        bankInstructions: bankInstructions.trim(),
        methods: (Object.keys(methodToggles) as PaymentMethodCode[]).map((code) => ({
          code,
          isEnabled: methodToggles[code],
        })),
      };
      if (secretKeyInput.trim()) payload.secretKey = secretKeyInput.trim();
      if (encryptionKeyInput.trim()) payload.encryptionKey = encryptionKeyInput.trim();
      if (webhookHashInput.trim()) payload.webhookSecretHash = webhookHashInput.trim();

      const updated = await apiRequest<PaymentGatewayAdminView>('/api/admin/gateway-settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setGateway(updated);
      setSecretKeyInput('');
      setEncryptionKeyInput('');
      setWebhookHashInput('');
      onNotify('Payment gateway & bank settings saved securely.');
    } catch (err: any) {
      setError(err.message || 'Unable to save payment gateway settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSave}
      className="bg-white border border-neutral-200 rounded-xl p-6 max-w-3xl space-y-6 mt-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4" />
            <h2 className="font-display font-bold text-lg">
              Payment Gateway Settings (Flutterwave)
            </h2>
          </div>
          <p className="text-xs text-neutral-600 mt-1">
            Configure Flutterwave API keys, webhook verification, Test/Live mode, and bank transfer details.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`px-2.5 py-1 rounded-full font-mono text-[10px] font-bold uppercase ${
              gateway?.configured ? 'bg-black text-white' : 'border border-black text-black'
            }`}
          >
            {gateway?.configured ? 'Configured' : 'Needs Keys'}
          </span>
          <span className="px-2.5 py-1 rounded-full font-mono text-[10px] font-bold uppercase bg-neutral-100 border border-neutral-300">
            {mode === 'live' ? 'Live Mode' : 'Test Mode'}
          </span>
          <span
            className={`px-2.5 py-1 rounded-full font-mono text-[10px] font-bold uppercase ${
              isEnabled ? 'bg-black text-white' : 'bg-neutral-200 text-neutral-600'
            }`}
          >
            {isEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-black bg-neutral-50 px-3.5 py-2.5 text-xs font-medium">
          {error}
        </div>
      )}

      {/* Webhook Endpoint Box */}
      <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-neutral-700">
            Auto-Generated Flutterwave Webhook Endpoint URL
          </span>
          <button
            type="button"
            onClick={async () => {
              const target = webhookUrl || gateway?.webhookUrl || '';
              if (!target) return;
              try {
                await navigator.clipboard?.writeText(target);
                setCopiedWebhook(true);
                setTimeout(() => setCopiedWebhook(false), 1800);
              } catch {
                // Ignore clipboard permission errors in non-HTTPS/restricted contexts
              }
            }}
            className="inline-flex items-center gap-1.5 bg-black text-white px-3 py-1 rounded-lg text-[11px] font-semibold cursor-pointer"
          >
            {copiedWebhook ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            <span>{copiedWebhook ? 'Copied' : 'Copy Webhook URL'}</span>
          </button>
        </div>
        <input
          type="text"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-xs font-mono"
        />
        <p className="text-[11px] text-neutral-500">
          Register this endpoint URL in your Flutterwave Dashboard (Settings → Webhooks) and paste the matching Secret Hash below.
        </p>
      </div>

      {/* Mode & Status Switches */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-semibold mb-1.5">Environment Mode</p>
          <div className="grid grid-cols-2 gap-2 p-1 bg-neutral-100 rounded-lg">
            {(['test', 'live'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`py-2 rounded-md text-xs font-bold uppercase cursor-pointer ${
                  mode === m ? 'bg-black text-white' : 'text-neutral-600'
                }`}
              >
                {m} Mode
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold mb-1.5">Gateway Status</p>
          <div className="grid grid-cols-2 gap-2 p-1 bg-neutral-100 rounded-lg">
            <button
              type="button"
              onClick={() => setIsEnabled(true)}
              className={`py-2 rounded-md text-xs font-bold uppercase cursor-pointer ${
                isEnabled ? 'bg-black text-white' : 'text-neutral-600'
              }`}
            >
              Enabled
            </button>
            <button
              type="button"
              onClick={() => setIsEnabled(false)}
              className={`py-2 rounded-md text-xs font-bold uppercase cursor-pointer ${
                !isEnabled ? 'bg-black text-white' : 'text-neutral-600'
              }`}
            >
              Disabled
            </button>
          </div>
        </div>
      </div>

      {/* Flutterwave Keys (Secret keys strictly masked) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="flw-pub-key" className="block text-xs font-semibold mb-1">
            Flutterwave Public Key
          </label>
          <input
            id="flw-pub-key"
            type="text"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="FLWPUBK_TEST-..."
            className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs font-mono"
          />
        </div>
        <div>
          <label htmlFor="flw-sec-key" className="block text-xs font-semibold mb-1">
            Flutterwave Secret Key{' '}
            {gateway?.hasSecretKey && (
              <span className="font-mono text-[10px] text-neutral-500">
                (Saved: {gateway.secretKeyMasked})
              </span>
            )}
          </label>
          <input
            id="flw-sec-key"
            type="password"
            autoComplete="new-password"
            value={secretKeyInput}
            onChange={(e) => setSecretKeyInput(e.target.value)}
            placeholder={
              gateway?.hasSecretKey
                ? 'Leave blank to keep saved secret key'
                : 'FLWSECK_TEST-...'
            }
            className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs font-mono"
          />
        </div>
        <div>
          <label htmlFor="flw-enc-key" className="block text-xs font-semibold mb-1">
            Flutterwave Encryption Key (Optional){' '}
            {gateway?.hasEncryptionKey && (
              <span className="font-mono text-[10px] text-neutral-500">
                (Saved: {gateway.encryptionKeyMasked})
              </span>
            )}
          </label>
          <input
            id="flw-enc-key"
            type="password"
            autoComplete="new-password"
            value={encryptionKeyInput}
            onChange={(e) => setEncryptionKeyInput(e.target.value)}
            placeholder={
              gateway?.hasEncryptionKey
                ? 'Leave blank to keep saved encryption key'
                : 'FLWSECK_TEST...'
            }
            className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs font-mono"
          />
        </div>
        <div>
          <label htmlFor="flw-wh-hash" className="block text-xs font-semibold mb-1">
            Webhook Secret Hash (`verif-hash`){' '}
            {gateway?.hasWebhookSecretHash && (
              <span className="font-mono text-[10px] text-neutral-500">
                (Saved: {gateway.webhookSecretHashMasked})
              </span>
            )}
          </label>
          <input
            id="flw-wh-hash"
            type="password"
            autoComplete="new-password"
            value={webhookHashInput}
            onChange={(e) => setWebhookHashInput(e.target.value)}
            placeholder={
              gateway?.hasWebhookSecretHash
                ? 'Leave blank to keep saved webhook hash'
                : 'Enter secret hash string'
            }
            className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs font-mono"
          />
        </div>
      </div>

      {/* Bank Transfer Details & Checkout Method Toggles */}
      <div className="border-t border-neutral-200 pt-5 space-y-4">
        <p className="font-display font-bold text-sm">Bank Transfer Account Details</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="bank-name" className="block text-xs font-semibold mb-1">
              Bank Name
            </label>
            <input
              id="bank-name"
              type="text"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs"
            />
          </div>
          <div>
            <label htmlFor="bank-acc-name" className="block text-xs font-semibold mb-1">
              Account Name
            </label>
            <input
              id="bank-acc-name"
              type="text"
              value={bankAccountName}
              onChange={(e) => setBankAccountName(e.target.value)}
              className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs"
            />
          </div>
          <div>
            <label htmlFor="bank-acc-num" className="block text-xs font-semibold mb-1">
              Account Number
            </label>
            <input
              id="bank-acc-num"
              type="text"
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
              className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs font-mono"
            />
          </div>
        </div>
        <div>
          <label htmlFor="bank-inst" className="block text-xs font-semibold mb-1">
            Transfer Instructions Shown to Customers
          </label>
          <input
            id="bank-inst"
            type="text"
            value={bankInstructions}
            onChange={(e) => setBankInstructions(e.target.value)}
            className="w-full border border-neutral-300 rounded-lg px-3 py-2 text-xs"
          />
        </div>

        <div className="pt-2">
          <p className="text-xs font-semibold mb-2">Active Customer Payment Methods</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(['wallet', 'flutterwave', 'cash', 'bank_transfer'] as PaymentMethodCode[]).map(
              (code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() =>
                    setMethodToggles((prev) => ({ ...prev, [code]: !prev[code] }))
                  }
                  className={`px-3 py-2 rounded-lg border text-xs font-semibold capitalize cursor-pointer ${
                    methodToggles[code]
                      ? 'bg-black text-white border-black'
                      : 'bg-white text-neutral-500 border-neutral-300'
                  }`}
                >
                  {code.replace(/_/g, ' ')}: {methodToggles[code] ? 'ON' : 'OFF'}
                </button>
              )
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 pt-4">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-neutral-500">
          <ShieldCheck className="w-4 h-4 text-black shrink-0" />
          Secret credentials are encrypted server-side with AES-256-GCM and never sent to the browser.
        </span>
        <button
          type="submit"
          disabled={saving}
          className="bg-black text-white px-6 py-2.5 rounded-lg text-xs font-bold hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
        >
          {saving ? 'Saving Credentials...' : 'Save Payment Gateway Settings'}
        </button>
      </div>
    </form>
  );
};
