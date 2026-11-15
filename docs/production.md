# Running SAQO in production

## Deploy

Use a Docker host with Compose, DNS pointing the SAQO hostname to that host, and inbound ports 80 and 443 available to Caddy. Keep one application replica for the SQLite-backed dispatch queue.

1. Copy `.env.example` to `.env` and set `SAQO_DOMAIN`, `SAQO_SESSION_SECRET`, `SAQO_ADMIN_EMAIL`, and `SAQO_ADMIN_PASSWORD`. Set provider credentials and the alert endpoint in this file.
2. Run `docker compose up -d --build` on the host.
3. Check `docker compose ps` and `curl --fail https://YOUR_DOMAIN/api/health`. The browser connects to `wss://YOUR_DOMAIN/ws`.

Caddy obtains the HTTPS certificate and forwards WebSocket upgrades. The application port stays inside the Compose network. The application trusts one proxy hop in this topology. Leave `SAQO_TRUST_PROXY` disabled when running the server directly.

### Vercel frontend preview

`vercel.json` builds the Vite frontend as a static, non-indexed preview without a backend. It does not submit bookings, accept logins or payments, or connect to the dispatch WebSocket. Use a preview deployment for review. Before launching from Vercel, provision the persistent backend and verify HTTPS routing for `/api` and WebSocket routing for `/ws` from the frontend, then remove the static preview build flag and the indexing block.

## Test the Twilio WhatsApp webhook before deployment

1. Install `cloudflared` and set the trial account's `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_WHATSAPP_FROM` in the ignored local `.env`. The Auth Token must belong to the account that owns the Sandbox.
2. Run `npm run test:whatsapp:tunnel`. Wait for the HTTPS check and copy the printed URL. This run exposes only the webhook and uses a disposable database. It will read changes to `.env` on the next request. App, tracking, and live agent links are outside this test.
3. In the Sandbox dedicated to SAQO, set **When a message comes in** to the printed URL with `POST`. Join the Sandbox from a test phone and send `MENU`, then `ORDER` using fictional details. Each new tunnel gets a different URL. Stop it with Ctrl+C when done.

For a live deployment, set `APP_URL` to the public HTTPS origin that customers open from WhatsApp. If Twilio calls a separate API host, set `TWILIO_WEBHOOK_ORIGIN` to its HTTPS origin. Configure the registered production sender to `POST` to `/api/webhooks/twilio/whatsapp` on the API host. The origin must match the URL in Twilio for signature verification. The current API and dispatch worker use SQLite for their primary reads and writes, even when Supabase Realtime and payment mirroring are enabled. Moving the live API to Supabase requires migrating those reads and writes and deploying the API and queue processing.

## Back up and restore

The SQLite database lives in the `sqlite` volume. The backup service writes a consistent snapshot every six hours by default using SQLite’s online backup API. Each snapshot passes integrity and foreign key checks before publication. The `sqlite_backups` volume keeps 28 snapshots by default. Copy verified snapshots off the host as part of the backup schedule.

```sh
docker compose exec backup ls -l /backups
docker compose exec backup node --import tsx scripts/sqliteBackup.ts health
```

To restore, choose a snapshot filename and stop both writers before switching databases. Restore to a **new** filename so the current database and its sidecars remain available for rollback.

```sh
docker compose stop app backup
docker compose run --rm --no-deps backup node --import tsx scripts/sqliteBackup.ts restore /backups/SNAPSHOT.sqlite /data/saqo-recovered.db
export SAQO_DB_FILE=saqo-recovered.db
docker compose up -d
```

Set `SAQO_DB_FILE` in `.env` once the restored instance is verified so later deployments use the same database. To roll back, switch it to the previous filename and recreate the services. A restore refuses to overwrite existing files. Keep the production session and encryption secrets when restoring to another host.

## Alerts and verification

Set `SAQO_ALERT_WEBHOOK_URL` to an HTTPS receiver that routes alerts to the operations team. Optionally set `SAQO_ALERT_WEBHOOK_TOKEN` for bearer authentication. Each request contains a JSON object with `service`, `type`, `timestamp`, and `details`. Configure the receiver to alert on `payment_failure`, `dispatch_delay`, and `backup_failure`. Configure host monitoring for container downtime and stale backups so the team is notified even if SAQO cannot send an alert. Alert events also appear in the container logs.

The queue monitor defaults to five minutes for dispatchable orders awaiting a rider. Sign-in throttles one email/source pair after five attempts and a source after 30 attempts in 15 minutes. Limits persist in SQLite across application restarts.

GitHub Actions runs a clean `npm ci`, type checking, tests, and the production build. It also runs `node scripts/restartSmoke.mjs` with isolated data and checks HTTPS, WebSocket upgrades, and the scheduled backup service through Docker Compose.
