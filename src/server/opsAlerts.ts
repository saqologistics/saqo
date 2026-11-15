type AlertType = 'payment_failure' | 'dispatch_delay' | 'backup_failure';
type Details = Record<string, string | number>;

const lastAlert = new Map<string, number>();
const cooldown = 5 * 60 * 1000;

export async function sendOpsAlert(type: AlertType, details: Details): Promise<void> {
  const now = Date.now();
  for (const [key, timestamp] of lastAlert) {
    if (timestamp + cooldown <= now) lastAlert.delete(key);
  }
  const key = type + ':' + (details.reference ?? details.reason ?? '');
  if (lastAlert.has(key)) return;
  if (lastAlert.size >= 256) lastAlert.delete(lastAlert.keys().next().value!);
  lastAlert.set(key, now);

  const event = { service: 'saqo-dispatch', type, timestamp: new Date(now).toISOString(), details };
  console.warn(JSON.stringify(event));
  const endpoint = process.env.SAQO_ALERT_WEBHOOK_URL;
  if (!endpoint) return;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('Alert webhook must use HTTPS.');
    const token = process.env.SAQO_ALERT_WEBHOOK_TOKEN;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(event), signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!res.ok) throw new Error('Alert webhook returned HTTP ' + res.status);
  } catch {
    // Allow the next observation of this condition to retry delivery.
    lastAlert.delete(key);
    console.error(JSON.stringify({ service: 'saqo-dispatch', type: 'alert_webhook_failed', alertType: type }));
  }
}
