import crypto from 'node:crypto';
import express, { type Express } from 'express';
import { calculateDeliveryQuote, formatNaira, isValidNigerianPhone } from '../shared/pricing';
import { searchSmartAddresses, type AddressSuggestion } from '../shared/nigeria';
import { addSupportMessage, createSupportConversation, db, getDeliveryById, getPlatformSettings, getSupportConversationById, hashPassword } from './db';
import { createBookingRows } from './deliveryBooking';
import { broadcastWsEvent, dispatchWaitingDeliveries } from './dispatchEngine';
import { createDeliveryPaymentRecords, getPaymentMethods, withImmediateTransaction } from './paymentService';

export const TWILIO_WHATSAPP_PATH = '/api/webhooks/twilio/whatsapp';

export function registerTwilioWhatsAppWebhook(app: Express): void {
  app.post(TWILIO_WHATSAPP_PATH, express.urlencoded({ extended: false, limit: '24kb', parameterLimit: 150 }), (req, res) => {
    if (!req.is('application/x-www-form-urlencoded')) {
      res.status(415).send('Expected a Twilio form request.');
      return;
    }
    const outcome = handleTwilioWhatsApp(req.body, req.get('X-Twilio-Signature') || '', req.originalUrl);
    res.status(outcome.status).type(outcome.status === 200 ? 'text/xml' : 'text/plain').send(outcome.text);
  });
}

const state = 'Katsina';
const dayMs = 24 * 60 * 60 * 1000;
const locationPrompt = 'Send a Katsina landmark, street name, or town.';
const whatsappAddress = /^whatsapp:\+([1-9]\d{7,14})$/;

function getConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const sender = process.env.TWILIO_WHATSAPP_FROM?.trim();
  const configuredUrl = process.env.APP_URL?.trim();
  const configuredWebhookOrigin = process.env.TWILIO_WEBHOOK_ORIGIN?.trim();
  if (!accountSid || !/^AC[\da-f]{32}$/i.test(accountSid) || !authToken || !sender || !whatsappAddress.test(sender) || !configuredUrl) return null;
  try {
    const appUrl = new URL(configuredUrl);
    const webhook = new URL(configuredWebhookOrigin || appUrl.origin);
    if (appUrl.protocol !== 'https:' || webhook.protocol !== 'https:' || webhook.username || webhook.password ||
        webhook.pathname !== '/' || webhook.search || webhook.hash) return null;
    return { accountSid, authToken, sender, appUrl: appUrl.origin, webhookOrigin: webhook.origin };
  } catch {
    return null;
  }
}

export function getWhatsAppOrderNumber(): string | null {
  const config = getConfig();
  return config ? whatsappAddress.exec(config.sender)?.[1] ?? null : null;
}

type TwilioFields = Record<string, string | string[]>;

function isValidSignature(url: string, fields: TwilioFields, signature: string, authToken: string): boolean {
  const data = Object.keys(fields).sort().reduce((input, key) => {
    const values = Array.isArray(fields[key]) ? [...new Set(fields[key])].sort() : [fields[key]];
    return input + values.map((value) => key + value).join('');
  }, url);
  const expected = Buffer.from(crypto.createHmac('sha1', authToken).update(data).digest('base64'));
  const received = Buffer.from(signature);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

type Step = 'pickup' | 'destination' | 'name' | 'phone' | 'parcel' | 'weight' | 'confirm' | 'support';
interface Draft {
  step: Step;
  pickup?: AddressSuggestion;
  destination?: AddressSuggestion;
  choices?: AddressSuggestion[];
  recipientName?: string;
  recipientPhone?: string;
  parcelDescription?: string;
  weightKg?: number;
  quotedFee?: number;
}

interface Session {
  draft: string | null;
  profile_id: string | null;
  support_conversation_id: string | null;
  last_inbound_at: string;
}

function saveDraft(phone: string, draft: Draft | null): void {
  db.prepare('UPDATE whatsapp_sessions SET draft = ? WHERE phone = ?')
    .run(draft ? JSON.stringify(draft) : null, phone);
}

function getWhatsAppCustomer(phone: string, profileName: string, session: Session) {
  if (session.profile_id) {
    const current = db.prepare(`
      SELECT c.id AS customerId, p.id AS profileId, p.email, p.full_name AS name, p.account_status
      FROM profiles p JOIN customers c ON c.profile_id = p.id WHERE p.id = ?
    `).get(session.profile_id) as { customerId: string; profileId: string; email: string; name: string; account_status: string } | undefined;
    if (current?.account_status === 'active') return current;
    throw new Error('WhatsApp customer account is unavailable.');
  }
  const profileId = 'prof-' + crypto.randomUUID();
  const customerId = 'cust-' + crypto.randomUUID();
  const email = `${crypto.randomUUID()}@whatsapp.saqo.invalid`;
  const name = profileName || 'WhatsApp Customer';
  db.prepare(`
    INSERT INTO profiles (id, email, password_hash, full_name, phone, role, account_status, created_at)
    VALUES (?, ?, ?, ?, ?, 'client', 'active', ?)
  `).run(profileId, email, hashPassword(crypto.randomUUID()), name, phone, new Date().toISOString());
  db.prepare('INSERT INTO customers (id, profile_id, default_state) VALUES (?, ?, ?)').run(customerId, profileId, state);
  db.prepare('UPDATE whatsapp_sessions SET profile_id = ? WHERE phone = ?').run(profileId, phone);
  return { customerId, profileId, email, name };
}

function processMessage(input: {
  phone: string; profileName: string; body: string; appUrl: string; sid: string; session: Session;
}): { reply: string; deliveryId?: string; support?: ReturnType<typeof createSupportConversation> } {
  const { phone, profileName, body, appUrl, session, sid } = input;
  const command = body.toUpperCase();
  const appLink = `${appUrl}/?order=1`;
  const menu = `Welcome to SAQO Logistics. Reply ORDER to book in Katsina, STATUS to recover your latest booking, SUPPORT to chat with an agent, or open the SAQO app: ${appLink}`;
  const draft = session.draft && Date.now() - Date.parse(session.last_inbound_at) < dayMs
    ? JSON.parse(session.draft) as Draft : null;
  const cashEnabled = () => getPaymentMethods().some((method) => method.code === 'cash' && method.isEnabled);

  if (command === 'APP' || command === 'OPEN APP') return { reply: `Open the SAQO booking app: ${appLink}` };
  if (command === 'STATUS') {
    const latest = session.profile_id && db.prepare(`
      SELECT d.tracking_code, d.status, d.delivery_otp FROM delivery_requests d
      JOIN customers c ON c.id = d.customer_id WHERE c.profile_id = ?
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1
    `).get(session.profile_id) as { tracking_code: string; status: string; delivery_otp: string } | undefined;
    if (!latest) return { reply: 'You do not have a WhatsApp booking yet. Reply ORDER to start.' };
    const handoff = ['delivered', 'cancelled'].includes(latest.status)
      ? '' : `\nHandoff code: ${latest.delivery_otp}. Share it only with the recipient.`;
    return { reply: `Latest booking • ${latest.tracking_code}\nTrack: ${appUrl}/?track=${latest.tracking_code}${handoff}` };
  }
  if (command === 'MENU' || command === 'CANCEL') {
    saveDraft(phone, null);
    return { reply: command === 'CANCEL' ? `Current conversation flow cleared. ${menu}` : menu };
  }
  if (command === 'ORDER') {
    if (!cashEnabled()) return { reply: `WhatsApp orders use cash on delivery. To choose another payment method, open the app: ${appLink}` };
    saveDraft(phone, { step: 'pickup' });
    return { reply: `Where should the rider collect your parcel? ${locationPrompt}` };
  }
  if (command === 'SUPPORT') {
    saveDraft(phone, { step: 'support' });
    return { reply: 'Type your message for SAQO Support. You can return to booking any time by sending ORDER.' };
  }
  if (!draft) return { reply: menu };
  if (draft.step === 'support') {
    if (!body) return { reply: 'Please type a message for support.' };
    const conversation = session.support_conversation_id && getSupportConversationById(session.support_conversation_id);
    const name = profileName || 'WhatsApp Customer';
    const support = conversation
      ? addSupportMessage({ conversationId: conversation.id, senderRole: 'visitor', senderName: name, body })
      : createSupportConversation({
          visitorToken: 'wa-' + crypto.randomUUID(), userId: session.profile_id, visitorName: name,
          visitorEmail: null, visitorPhone: phone, trackingCode: null, initialMessage: body, senderRole: 'visitor',
        });
    db.prepare('UPDATE whatsapp_sessions SET support_conversation_id = ? WHERE phone = ?').run(support.conversation.id, phone);
    return { reply: conversation ? '' : 'Your message is with the SAQO support team. An agent can reply here.', support };
  }
  if (draft.step === 'pickup' || draft.step === 'destination') {
    const index = /^\d+$/.test(body) ? Number(body) - 1 : -1;
    const place = draft.choices?.[index];
    if (!place) {
      const opposite = draft.step === 'destination' ? draft.pickup?.label : undefined;
      const choices = body.length >= 2 && index < 0 ? searchSmartAddresses(state, body, opposite).slice(0, 5) : [];
      if (!choices.length) {
        if (index < 0) saveDraft(phone, { ...draft, choices: [] });
        return { reply: `I couldn't find that location. ${locationPrompt} You can also use the map in the app: ${appLink}` };
      }
      saveDraft(phone, { ...draft, choices });
      return { reply: ['Reply with the matching number, or enter another location.', ...choices.map((item, i) => `${i + 1}. ${item.label}`)].join('\n') };
    }
    if (draft.step === 'pickup') {
      saveDraft(phone, { step: 'destination', pickup: place });
      return { reply: `Pickup set to ${place.label}. Where should we deliver it? ${locationPrompt}` };
    }
    if (draft.pickup?.lat === place.lat && draft.pickup.lng === place.lng) {
      return { reply: 'Choose a destination different from your pickup location.' };
    }
    saveDraft(phone, { step: 'name', pickup: draft.pickup, destination: place });
    return { reply: 'What is the recipient’s full name?' };
  }
  if (draft.step === 'name') {
    if (body.length < 2 || body.length > 100) return { reply: 'Enter the recipient’s full name.' };
    saveDraft(phone, { ...draft, step: 'phone', recipientName: body });
    return { reply: 'What is the recipient’s phone number?' };
  }
  if (draft.step === 'phone') {
    if (!isValidNigerianPhone(body) || !/^\+?[\d ()-]+$/.test(body)) return { reply: 'Enter a valid recipient phone number.' };
    saveDraft(phone, { ...draft, step: 'parcel', recipientPhone: body });
    return { reply: 'Briefly describe the parcel.' };
  }
  if (draft.step === 'parcel') {
    if (!body || body.length > 160) return { reply: 'Describe the parcel in 160 characters or fewer.' };
    saveDraft(phone, { ...draft, step: 'weight', parcelDescription: body });
    return { reply: 'How much does the parcel weigh in kilograms? Reply with a number, such as 1.5.' };
  }

  const pickup = draft.pickup!;
  const destination = draft.destination!;
  const weight = draft.step === 'weight' ? Number(body) : draft.weightKg!;
  if (!Number.isFinite(weight) || weight < 0.5 || weight > 50) return { reply: 'Enter a weight between 0.5 and 50 kg.' };
  const settings = getPlatformSettings();
  const quote = calculateDeliveryQuote({
    pickupState: state, pickupLat: pickup.lat, pickupLng: pickup.lng,
    destinationState: state, destinationLat: destination.lat, destinationLng: destination.lng,
    weightKg: weight, settings,
  });
  if (draft.step === 'weight' || draft.quotedFee !== quote.deliveryFeeNgn) {
    saveDraft(phone, { ...draft, step: 'confirm', weightKg: weight, quotedFee: quote.deliveryFeeNgn });
    const heading = draft.step === 'confirm' ? 'The delivery fee has changed. Please confirm the new total.' : 'Review your parcel request.';
    return { reply: `${heading}\nFrom: ${pickup.label}\nTo: ${destination.label}\nRecipient: ${draft.recipientName} (${draft.recipientPhone})\nParcel: ${draft.parcelDescription} (${weight} kg)\nCash on delivery: ${formatNaira(quote.deliveryFeeNgn)}\n\nReply CONFIRM to book or CANCEL to discard.` };
  }
  if (command !== 'CONFIRM') return { reply: 'Reply CONFIRM to book or CANCEL to discard.' };
  if (!cashEnabled()) return { reply: `Cash booking is currently unavailable. Open the app for other payment options: ${appLink}` };
  const customer = getWhatsAppCustomer(phone, profileName, session);
  const { deliveryId, trackingCode, otp } = createBookingRows({
    customerId: customer.customerId, pickupState: state, pickupAddress: pickup.label, pCoords: pickup,
    destinationState: state, destinationAddress: destination.label, dCoords: destination,
    recipientName: draft.recipientName!, recipientPhone: draft.recipientPhone!, parcelDescription: draft.parcelDescription!,
    weightKg: weight, paymentMethod: 'cash', quote, riderCommissionPercent: settings.riderCommissionPercent,
  });
  const payment = createDeliveryPaymentRecords({
    deliveryId, trackingCode, customerProfileId: customer.profileId, customerName: customer.name,
    customerEmail: customer.email, customerPhone: phone, amountNgn: quote.deliveryFeeNgn,
    paymentMethod: 'cash', idempotencyKey: `whatsapp:${sid}`,
  });
  db.prepare('UPDATE delivery_requests SET payment_reference = ? WHERE id = ?').run(payment.paymentReference, deliveryId);
  saveDraft(phone, null);
  return {
    deliveryId,
    reply: `Booked • ${trackingCode}\nCash on delivery: ${formatNaira(quote.deliveryFeeNgn)}\nTrack: ${appUrl}/?track=${trackingCode}\nHandoff code: ${otp}. Share it only with the recipient. They should use it when they receive the parcel.`,
  };
}

export function handleTwilioWhatsApp(fields: TwilioFields, signature: string, requestPath: string) {
  const config = getConfig();
  if (!config) return { status: 503, text: 'WhatsApp ordering is unavailable.' };
  if (!isValidSignature(config.webhookOrigin + requestPath, fields, signature, config.authToken) ||
      fields.AccountSid !== config.accountSid || fields.To !== config.sender) {
    return { status: 403, text: 'Invalid Twilio request.' };
  }
  const phone = typeof fields.From === 'string' && whatsappAddress.test(fields.From) ? fields.From.slice('whatsapp:'.length) : null;
  const sid = fields.MessageSid;
  if (!phone || typeof sid !== 'string' || !/^(SM|MM)[\da-f]{32}$/i.test(sid)) {
    return { status: 400, text: 'Invalid WhatsApp message.' };
  }
  const now = new Date().toISOString();
  const result = withImmediateTransaction(() => {
    const claimed = db.prepare('INSERT OR IGNORE INTO whatsapp_inbound_messages (message_sid, received_at) VALUES (?, ?)').run(sid, now);
    if (!claimed.changes) return { reply: '' };
    db.prepare('INSERT OR IGNORE INTO whatsapp_sessions (phone, last_inbound_at) VALUES (?, ?)').run(phone, now);
    const session = db.prepare('SELECT * FROM whatsapp_sessions WHERE phone = ?').get(phone) as unknown as Session;
    db.prepare('UPDATE whatsapp_sessions SET last_inbound_at = ? WHERE phone = ?').run(now, phone);
    if (session.draft && Date.now() - Date.parse(session.last_inbound_at) >= dayMs) saveDraft(phone, null);
    return processMessage({
      phone, sid, session, appUrl: config.appUrl,
      profileName: typeof fields.ProfileName === 'string' ? fields.ProfileName.trim().slice(0, 100) : '',
      body: typeof fields.Body === 'string' ? fields.Body.trim().slice(0, 1600) : '',
    });
  });
  if (result.deliveryId) {
    try {
      broadcastWsEvent('delivery:created', getDeliveryById(result.deliveryId));
      dispatchWaitingDeliveries();
    } catch (error) {
      // The periodic queue sweep can dispatch this committed order after a transient failure.
      console.error('WhatsApp booking persisted, but dispatch notification failed.', error);
    }
  }
  if (result.support) {
    broadcastWsEvent('support:conversation', result.support.conversation);
    broadcastWsEvent('support:message', result.support.message);
  }
  const escaped = result.reply.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
  return { status: 200, text: `<?xml version="1.0" encoding="UTF-8"?><Response>${escaped ? `<Message>${escaped}</Message>` : ''}</Response>` };
}

export async function sendWhatsAppSupportReply(conversationId: string, message: string): Promise<void> {
  const session = db.prepare('SELECT phone, last_inbound_at FROM whatsapp_sessions WHERE support_conversation_id = ?')
    .get(conversationId) as Pick<Session, 'last_inbound_at'> & { phone: string } | undefined;
  if (!session) return;
  const config = getConfig();
  if (!config) throw new Error('Twilio WhatsApp is unavailable.');
  if (Date.now() - Date.parse(session.last_inbound_at) >= dayMs) {
    throw new Error('The WhatsApp reply window has closed. The customer must send another message first.');
  }
  if (message.length > 1600) throw new Error('WhatsApp replies must be 1,600 characters or fewer.');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(config.accountSid + ':' + config.authToken).toString('base64') },
    body: new URLSearchParams({ From: config.sender, To: 'whatsapp:' + session.phone, Body: message }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Twilio did not accept the WhatsApp reply. Please try again.');
}
