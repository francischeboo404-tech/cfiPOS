# cfi-POS - Professional Retail & Wholesale Point of Sale System

## Project Overview

**cfi-POS** (developed by **cfi-POS Techiez Limited Company**) is an enterprise retail and wholesale point-of-sale system engineered for Kenyan retail businesses. It features M-Pesa payments (STK Push and C2B Paybill), a configurable eTIMS provider interface (live VSCU submission is disabled pending KRA test-environment verification), offline-first cashier tills, multi-warehouse inventory management, returns & refunds, store credit, shifts, and double-entry accounting.

## Key Features

- 📱 **Progressive Web App (PWA)** - Installable on desktop and mobile with offline caching
- 🔐 **4-Tier Role-Based Access Control** - Cashier, Supervisor, Manager, and Admin permissions
- 📊 **Real-Time Dashboard & Observability** - Sales metrics, stock alerts, health probes, and structured logging
- 🛒 **Point of Sale** - High-speed checkout, barcode scanning, cart parking, and stock reservations
- 🏷️ **Timed Promotions** - EAT schedules, exact-cent discounts, quantity caps/quotas, immutable change history, and sale performance reporting
- 💰 **Multiple Tender Channels** - Cash, M-Pesa STK Push, M-Pesa Paybill C2B, and Store Credit
- 🔄 **Returns & Refunds Workflow** - Multi-item returns, manager approval, cash/M-Pesa/credit refunds, and sellable/damaged inventory triage
- 📦 **Multi-Warehouse Logistics** - Inter-warehouse stock transfers, physical stock takes, and batch/expiry tracking
- 🧾 **eTIMS Provider Interface** - `off` and clearly labeled `mock` modes; live KRA fiscalization remains disabled until its integration is verified against the KRA test VSCU
- 👥 **Customer & Receivables** - Customer CRM, B2B credit invoicing, receivables tracking, and loyalty rewards
- 🏢 **Procurement & Payables** - Vendor records, purchase orders, 3-way matching goods receiving, manual physical-invoice entry for registered and new suppliers, review-gated payables, and invoice-linked payment history
- ⚖️ **Double-Entry Accounting** - Automated balanced journal entries, chart of accounts, and financial reports
- 🔄 **Offline-First Tills** - Provisional offline cash sales with IndexedDB queue and conflict resolution upon reconnect
- 🧾 **Installment foundations** - Exact-cent plan/quote calculations, manager-configurable plans, Nairobi-date schedules, and expanded customer loyalty/installment visibility

### Installment sales status

Installment selling remains disabled until the full lifecycle, including sale and eTIMS handover, is implemented and validated. Administrators and managers can configure plan terms and global limits at **Installment Plans**. The backend provides plan management and a server-calculated quote endpoint; quotes use the existing timed-promotion pricing service, validate available stock including recorded reservations, and show exact KES amounts and a schedule. The authenticated `POST /api/installments/agreements` endpoint recalculates prices and terms server-side, enforces stock and customer credit limits, snapshots the agreement and schedule, reserves stock, and records an explicitly tendered deposit as a customer advance. Creation retries are idempotent. Quotes and agreement creation both reject products with an active timed promotion until promotion reservations can be reconciled with agreement handover/cancellation. The authenticated `POST /api/installments/payments` endpoint records a payment against an existing agreement, allocates exact cents oldest-first, applies idempotency, writes an audit event, and posts the receipt to the customer-advance liability account rather than recognizing sales revenue. Managers/admins can use `POST /api/installments/payments/:paymentId/reverse` to fully reverse an unhanded-over, uncancelled, non-written-off payment; the reversal copies the original principal/interest allocations and creates the exact opposite customer-advance journal posting. Reversal retries with the same reason are idempotent; a different reason conflicts. `POST /api/installments/agreements/:agreementId/cancel` cancels an agreement before handover, releases its exact stock reservations, refunds collected payments less the configured cancellation fee, and posts the configured fee to cancellation-fee revenue without a tax journal pending confirmation of tax treatment. Managers must attest with `refund_confirmed: true` that the refund has actually been paid; this endpoint records the selected tender and accounting entry but does not initiate a bank or M-Pesa transfer. Non-cash refunds require a reference number, which is retained in the cancellation record and protected against duplicate use per tender. Cancellation retries with matching reason, tender, and refund reference are idempotent. Refund tender, reference, and confirmation are audited. Non-cash payment tenders require a payment reference. Credit checks include interest and subtract the deposit; credit-limit settings are validated as exact integer cents. Minimum deposits round up to the next cent when needed; weekly/fortnightly flat-per-month terms use half-up rounding of plan months to hundredths. Schedule remainders are assigned to the final installment. Dates are computed from the agreement date in Africa/Nairobi.

Customer profiles now support nullable national ID, alternative phone and address fields. The Customers screen exposes loyalty enrollment, voucher dates/status/points, installment summary columns, filters and CSV export. Existing customer-created vouchers continue to be issued automatically to preserve the pre-existing customer workflow; the migration backfills loyalty-enrolment provenance for existing vouchers.

The agreement and payment endpoints remain blocked by the lifecycle fail-closed guard until stock release/handover through normal sale, inventory, invoice, accounting and eTIMS posting is complete. Payment reversals, cancellation/refunds, write-off, archive, reports and installment customer detail/checkout screens are also not yet implemented. Do not enable installment selling in production until those lifecycle controls are delivered. Interest VAT remains an accountant-confirmation setting and is not yet used by the payment/accounting lifecycle.

## Technologies Used

This project is built with modern web technologies:

- **React** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and development server
- **Tailwind CSS** - Utility-first styling
- **shadcn/ui** - Component library
- **Express + TypeORM + PostgreSQL** - Backend API, database, and application authentication
- **PWA** - Progressive Web App capabilities

## Getting Started

### Prerequisites

- Node.js & npm installed ([install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating))
- Git for version control

### Installation

```sh
# Step 1: Clone the repository
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory
cd Retail-store-pos-system-main

# Step 3: Install dependencies
npm install

# Step 4: Start the development server
npm run dev
```

The application will be available at `http://localhost:8080`

## Deployment

To deploy your application:

1. Run `npm run build` to create a production build
2. Deploy the `dist` folder to your hosting provider
3. Configure environment variables for production

### Required environment variables

Frontend:

- `VITE_API_URL`: Public Express API URL, including `/api`

Server:

- `DATABASE_URL`: PostgreSQL connection URL
- `PG_POOL_MAX`: Maximum PostgreSQL connections per API instance (default `10`; set based on the database plan's connection limit and maximum API replica count)
- `PG_CONNECTION_TIMEOUT_MS`: Maximum wait to acquire a PostgreSQL connection (default `5000`)
- `JWT_SECRET`: Long random signing secret
- `PORT`: Backend TCP port
- `FRONTEND_URL`: Allowed frontend origin
- `CORS_ORIGINS`: Optional comma-separated list of allowed browser origins
- `TYPEORM_SYNCHRONIZE=false`: Keep schema changes migration-controlled in production
- `RESEND_API_KEY`: Required for OTP and purchase-order email delivery
- `RESEND_FROM_EMAIL`: Verified sender identity for Resend
- `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`: Daraja credentials
- `MPESA_API_BASE_URL`: Daraja sandbox or production API base URL
- `MPESA_CALLBACK_URL`: Public HTTPS URL for `/api/webhooks/mpesa/callback`; it must preserve query parameters
- `MPESA_C2B_CALLBACK_BASE_URL`: Public HTTPS origin used to build authenticated Paybill validation/confirmation callback URLs
- `MPESA_C2B_CALLBACK_TOKEN`: 64–128 character hexadecimal secret used to authenticate Paybill callbacks
- `PESAPAL_IPN_SECRET`: Provider-issued secret used to verify Pesapal IPN signatures
- `GEMINI_API_KEY`: Required for AI inventory predictions
- `AI_GATEWAY_URL`, `AI_MODEL`: AI-compatible chat endpoint and model identifier
- `PESAPAL_MOCK_IFRAME_URL`: redirect base used by the Pesapal mock service

Database encryption requires `ENCRYPTION_KEY` to be a 64-character hexadecimal value (32 bytes). The TypeORM backend supplies it as the PostgreSQL `app.encryption_key` session setting; never expose this value as a `VITE_` variable. The migration fails closed when the setting is absent. This is the only application database path required for the PostgreSQL-only deployment.

Apply backend TypeORM migrations before starting a production server after an update:

```sh
cd server
npm run migration:show
npm run migration:run
npm run migration:show
```

Review pending migrations and take a verified backup before applying changes. Confirm the final `migration:show` output has no pending migrations. The main-warehouse migration keeps the oldest existing main warehouse and demotes any duplicate main locations before adding a unique database index. To revert the most recent backend migration, run `npm run migration:revert` from `server` only after reviewing its `down` migration and the resulting data impact.

For existing installations, take a verified backup before applying the encryption migration. It refreshes customer and M-Pesa phone ciphertext from their retained plaintext columns. If audit-log or offline-queue ciphertext exists, supply its original key only for the migration session using `app.legacy_encryption_key`; the migration re-encrypts those rows under `app.encryption_key` and aborts if the legacy key is absent or incorrect. If that key is unavailable, stop the migration and preserve the backup; the new key cannot recover old ciphertext.

Configure `mpesa_shortcode` through the authenticated admin Settings page. Do not commit `.env` files or provider credentials.

New-account registration creates the cashier account; the OTP is sent when that new user is automatically signed in after registration (or on their next login). Production startup requires both `RESEND_API_KEY` and `RESEND_FROM_EMAIL`; the sender must be verified with Resend. Set them as backend runtime secrets, not Vite/Vercel frontend variables, then redeploy or restart the API to apply them. If OTP delivery fails during registration, the account remains registered; after the administrator fixes delivery, sign in with that account rather than registering again. If Resend rejects a message, the API logs the provider's error without logging the OTP, invalidates the unsent code, and returns an explicit delivery error instead of presenting a successful OTP step. A Resend message ID means the provider accepted the message, not that it reached the inbox; also check Resend delivery events, recipient address, and spam filtering.

M-Pesa callback URLs include a random per-request token; server request logs omit query strings. Configure reverse proxies and provider-side logs to redact callback query parameters. Before deploying the callback-token column migration, allow all existing pending STK requests to complete or expire; older rows have no callback token hash and their callbacks will be rejected.

### Docker deployment

The repository includes production-oriented API, web, and PostgreSQL containers managed by Compose. PostgreSQL stores data in the persistent `postgres-data` named volume, is health-checked before the API starts, and is not published on a host port. The web container serves the built frontend and proxies `/api` and `/socket.io` (including WebSocket upgrades) to the API, so the browser uses one origin. Terminate public HTTPS at a trusted reverse proxy or load balancer in front of the web container.

By default, the API connects to the Compose PostgreSQL service using `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`. The password must be URL-safe; the recommended 64-character hexadecimal secret is URL-safe. `DATABASE_URL` can optionally override this to connect the API to a separately managed PostgreSQL service. For a new, dedicated empty database, use the guarded Docker bootstrap command below; for an existing database, back it up and apply only reviewed pending TypeORM migrations.

For a **new, dedicated PostgreSQL database only**, the backend provides a guarded bootstrap command. It refuses maintenance/template databases, any non-empty `public` schema, and databases with recorded TypeORM migrations. It builds the current baseline from TypeORM entity metadata and applies every TypeORM migration; the regular API startup never synchronizes the schema. This flow ensures schema repeatability across local Docker, VPS, and cloud environments without manual DDL execution.

```powershell
cd server
# Set DATABASE_URL, ENCRYPTION_KEY, and the one-time confirmation in the environment.
$env:POS_DB_BOOTSTRAP_CONFIRM = "CREATE_SCHEMA_IN_EMPTY_DATABASE"
npm run db:bootstrap
Remove-Item Env:POS_DB_BOOTSTRAP_CONFIRM
npm run migration:show
```

In POSIX shells, set the confirmation only for the command: `POS_DB_BOOTSTRAP_CONFIRM=CREATE_SCHEMA_IN_EMPTY_DATABASE npm run db:bootstrap`.

Set `POS_DB_BOOTSTRAP_CONFIRM=CREATE_SCHEMA_IN_EMPTY_DATABASE` only after verifying that `DATABASE_URL` points to the intended **new and empty** database. The bootstrap will not provision a database containing existing data or Supabase objects. If it fails partway, do not start the API; inspect the failure and either finish the pending migrations with `npm run migration:run` or create a new empty database and repeat the guarded bootstrap. Never drop an existing database to retry. For existing installations, use the backup/review/`migration:show`/`migration:run` procedure above, not the bootstrap command.

1. Copy `docker-compose.env.example` to `.env` and set `POSTGRES_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`, and `PUBLIC_ORIGIN`. Generate independent random secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and use the output for `POSTGRES_PASSWORD`, `JWT_SECRET`, and `ENCRYPTION_KEY`. Never commit `.env`.
2. Start PostgreSQL and wait until it is healthy:

   ```sh
   docker compose up -d postgres
   docker compose ps
   ```

3. Build the API image, then create the application schema in the new empty database:

   ```sh
   docker compose build api
   docker compose run --rm -e POS_DB_BOOTSTRAP_CONFIRM=CREATE_SCHEMA_IN_EMPTY_DATABASE api npm run db:bootstrap:docker
   ```

   Use that one-time guarded command only for a brand-new empty database. For an already initialized database, inspect and apply only pending migrations after taking a backup:

   ```sh
   docker compose run --rm api npm run migration:show:docker
   docker compose run --rm api npm run migration:run:docker
   docker compose run --rm api npm run migration:show:docker
   ```

4. Build and start the application:

   ```sh
   docker compose up --build -d
   ```

5. Open `http://localhost:8080` (or the configured `HTTP_PORT`) and check `docker compose ps` for healthy services. Set `PUBLIC_ORIGIN` to the exact external origin, such as `https://pos.example.com`, when using a TLS-terminating proxy.

The Compose API and PostgreSQL containers are not published directly to the host; PostgreSQL and the API are reachable only on the private Compose network, and the API is reached through the web proxy. `TYPEORM_SYNCHRONIZE` is explicitly disabled. Keep runtime credentials in a protected environment file or deployment secret manager. No Supabase URL, key, project, or account is needed for this deployment. Configure provider callback URLs to use the public HTTPS origin and preserve their query strings.

The named volume preserves PostgreSQL data across container recreation, but it is not a backup, replication, or high-availability system. Back up the database regularly to storage outside the Docker host and rehearse restoring it. This single-host Compose database is intended for standalone/small deployments; use managed PostgreSQL or a separately designed HA PostgreSQL cluster for larger production availability requirements. Do not run the one-time bootstrap against a database/volume containing business data.

### Vercel frontend with GitHub auto-deploy

Vercel serves the Vite frontend. Keep the Express API on a persistent HTTPS host (for example, the Docker deployment above): the API uses Socket.IO and a scheduled job, which require a long-lived Node process and are not supported as persistent services by Vercel Functions.

#### Deploy the API on Render

The repository includes a Render Blueprint at `render.yaml`. It builds the existing API Dockerfile as an always-on paid web service, enables GitHub auto-deploy, checks `/health`, and keeps database/schema synchronization disabled.

1. Push the repository to GitHub. In Render, choose **New → Blueprint** and select the repository containing `render.yaml`.
2. When prompted, provide `DATABASE_URL` for the dedicated PostgreSQL database, the 64-hex-character `ENCRYPTION_KEY`, and the production Vercel frontend origin for both `FRONTEND_URL` and `CORS_ORIGINS`. For a new empty database, run the guarded TypeORM bootstrap procedure above from a secure environment that can reach this database before using the API; for an existing database, back it up and apply reviewed pending migrations. The blueprint generates a separate `JWT_SECRET`; keep it stable after users have logged in. Never put these private values in Vercel or GitHub.
3. Create the service and wait for it to become healthy. Copy its public HTTPS URL, for example `https://cfi-pos-api.onrender.com`. Render sets the listening `PORT`; do not hard-code one.
4. From a secure environment with access to the same database and encryption key, apply pending backend TypeORM migrations before using new backend code. Migrations are not automatically run at service startup.

Use an always-on paid Render instance for production. A sleeping/free service can interrupt active Socket.IO clients and scheduled work. Configure `DATABASE_URL` to any supported, reachable PostgreSQL service (managed PostgreSQL or self-hosted). Supabase is not required; Render hosts the API and does not provision or copy your database.

#### Capacity and horizontal-scaling limits

The API is stateless for ordinary HTTP requests and can use multiple instances behind a load balancer when all instances share the same PostgreSQL database and stable `JWT_SECRET`/`ENCRYPTION_KEY`. Socket.IO inventory/sale broadcasts are relayed between instances through PostgreSQL `LISTEN`/`NOTIFY`; WebSocket upgrades must be supported by the load balancer. HTTP rate-limit counters remain process-local, so the effective limit multiplies with the number of replicas and resets when a process restarts; use an external shared rate-limit store if a globally consistent limit is required. Size the DB pool across all replicas: `PG_POOL_MAX × maximum API instances` plus one dedicated notification connection per instance must stay below the PostgreSQL connection budget after reserving connections for administration, migrations, monitoring, and other services.

The midnight auto-reorder job uses a PostgreSQL advisory lock so multiple API replicas do not all generate the same scheduled requisitions. Graceful SIGTERM/SIGINT handling stops the scheduler, closes Socket.IO/HTTP and the notification connection, and drains TypeORM connections. These measures improve safe scale-out and deploy behavior but do not establish a production concurrency limit; run a representative load test against the chosen hosting plan and database before increasing users or replicas.

#### Connect Vercel to the API (Two Supported Deployment Shapes)

cfi-POS protects credentials against XSS by storing session tokens in secure `httpOnly` cookies (`jwt_token`). Since modern browsers restrict third-party cross-site cookies, select one of the two supported shapes:

##### Shape A: Same-Origin / Shared Parent Domain (Recommended)
Host the frontend and backend under a shared parent domain:
- **Frontend:** `https://app.example.co.ke` (Vercel)
- **Backend API:** `https://api.example.co.ke` (Render / VPS)
- **Settings:**
  - Vercel Environment Variable: `VITE_API_URL=https://api.example.co.ke/api`
  - Render Environment Variables:
    - `COOKIE_DOMAIN=.example.co.ke` (leading dot scopes cookie to all subdomains)
    - `COOKIE_SAMESITE=lax`
    - `FRONTEND_URL=https://app.example.co.ke`
    - `CORS_ORIGINS=https://app.example.co.ke`
  - WebSockets: Direct bidirectional connection to `https://api.example.co.ke`.

##### Shape B: Vercel Proxying `/api` (Zero-Config Subdomains)
Frontend on Vercel (`https://pos.vercel.app` or custom domain) with backend on Render (`https://pos-api.onrender.com`):
- All requests target Vercel; Vercel reverse-proxies `/api/*` and `/socket.io/*` to Render so the browser treats the API as same-origin.
- **Settings:**
  - Vercel Environment Variable: `VITE_API_URL=/api`
  - Vercel `vercel.json` rewrites:
    ```json
    {
      "rewrites": [
        { "source": "/api/:match*", "destination": "https://your-pos-api.onrender.com/api/:match*" },
        { "source": "/socket.io/:match*", "destination": "https://your-pos-api.onrender.com/socket.io/:match*" },
        { "source": "/(.*)", "destination": "/index.html" }
      ]
    }
    ```
  - Render Environment Variables:
    - `FRONTEND_URL=https://your-pos-app.vercel.app`
    - `CORS_ORIGINS=https://your-pos-app.vercel.app`
    - `COOKIE_SAMESITE=strict` (or `lax`)
  - WebSockets: Vercel serverless rewrites do not support WebSocket upgrades; Socket.IO client automatically falls back to HTTP long-polling.

##### ⚠️ Troubleshooting: "Logged out immediately"
If users log in, verify OTP, but are immediately redirected back to the login screen:
1. **Third-Party Cookie Blocking (Different Sites):** If the frontend is on `*.vercel.app` and API is on `*.onrender.com`, modern browsers block cross-site cookies. Switch to **Shape A** (custom parent domain) or **Shape B** (`vercel.json` proxy rewrites with `VITE_API_URL=/api`).
2. **Missing `COOKIE_DOMAIN` on Subdomains:** If using `app.example.co.ke` and `api.example.co.ke` without `COOKIE_DOMAIN`, the cookie is restricted to `api.example.co.ke`. Set `COOKIE_DOMAIN=.example.co.ke` on the backend API.
3. **`SameSite=None` without HTTPS:** Browsers reject `SameSite=None` without `Secure=true`. Serve the API over HTTPS (the backend enforces `secure: true` when `COOKIE_SAMESITE=none`).

1. Push this repository to GitHub and import it into Vercel using **Add New → Project**. Select the repository and set the **Root Directory** to `Retail-store-pos-system-main` if this folder is nested inside the GitHub repository; otherwise use the repository root.
2. Keep the project framework as **Vite** and use the build settings in `vercel.json` (`npm ci`, `npm run build:vercel`, output `dist`). Do not configure the API's `server` directory as the Vercel project root.
3. Add these values under **Project Settings → Environment Variables** for Production and Preview as appropriate:
   - `VITE_API_URL`: the public HTTPS API base URL ending in `/api` (for Shape A, e.g. `https://pos-api.example.com/api`), or `/api` (for Shape B proxying).
4. Set `FRONTEND_URL` and `CORS_ORIGINS` on Render to the exact Vercel production origin and any custom frontend domains, comma-separated. Add only known stable Vercel preview origins that need API access; do not allow arbitrary `*.vercel.app` origins.
5. Deploy from Vercel once. After that, Vercel automatically builds and deploys each push to the connected GitHub repository. Review Vercel's deployment status/checks on GitHub.

The Vercel build deliberately fails with an actionable error if `VITE_API_URL` is missing, is not HTTPS (unless using relative `/api`), or does not end in `/api`. Vite embeds this public API URL at build time, so changing it requires a new deployment. Database credentials, `JWT_SECRET`, `ENCRYPTION_KEY`, and payment-provider secrets belong only on the API host and must never be added as `VITE_` variables. Deploy backend migrations on the API host using the existing TypeORM migration instructions before releasing backend updates.

For Shape B, replace both `your-pos-api.onrender.com` rewrite destinations in `vercel.json` with the real HTTPS backend host before deploying. The Vercel build verifies that `/api` and `/socket.io` rewrites are present, use HTTPS, target a non-placeholder host, and share the same backend origin. Shape A uses the HTTPS API URL directly and does not rely on those rewrites for API or Socket.IO traffic.

### Paybill and checkout-reservation deployment

Paybill automatic confirmation uses Safaricom C2B validation and confirmation URLs. Set both `MPESA_C2B_CALLBACK_BASE_URL` and `MPESA_C2B_CALLBACK_TOKEN` on the backend, apply the backend TypeORM migrations in order, configure the Paybill shortcode in Settings, then have an admin register the callbacks. Use a public HTTPS origin; keep the C2B token secret and redact callback query strings from proxy/access logs. Paybill is offered only when the registered shortcode matches the configured shortcode. Till payments use STK Push, not manual Till C2B.

Before applying migration `1791020000000-AddMpesaPaybillReferences`, inspect existing receipt duplicates and reconcile them before creating the unique index:

```sql
SELECT mpesa_receipt_number, COUNT(*)
FROM mpesa_transactions
WHERE mpesa_receipt_number IS NOT NULL
GROUP BY mpesa_receipt_number
HAVING COUNT(*) > 1;
```

Do not delete duplicate financial records just to make the migration succeed; determine the correct reconciliation with the payment provider and accounting records first. The migration must be applied to the backend database using `cd server && npm run migration:run`; the legacy `database_migrations.sql` is not a substitute for these TypeORM migrations.

Checkout reservations intentionally remain active until a checkout is completed or safely cancelled. Monitor unresolved payments and reconcile them with Safaricom before manually releasing stock; there is no automatic timeout or live provider-query recovery yet. Payment callback and gateway behavior has been mock-tested only and must be verified in the Safaricom test environment before production.

M-Pesa return approval does not send a payout. It records the customer refund as payable; a supervisor, manager, or admin must complete the payout through Safaricom and then record the successful receipt on the Returns page. Only that receipt confirmation settles the payable and adjusts the confirming user's open-shift M-Pesa total. Migration `1791030000001-AddMpesaRefundSettlement` marks legacy approved M-Pesa returns as pending; reconcile those records against Safaricom before recording receipts.

## User Roles & Access Control

### Cashier
- Point of sale checkout and barcode scanning
- Catalogue search and stock availability
- Walk-in customer registration
- Initiate customer return requests
- Open/close assigned cashier shift and cash drawer

### Supervisor
- All Cashier capabilities
- Managerial override for return and refund approvals
- Return inventory triage (sellable restock vs damaged shrinkage)
- Shift float oversight and discrepancy auditing

### Manager
- All Supervisor capabilities
- Catalog updates (products, categories, pricing, units of measure)
- Inventory management (transfers, stock takes, manual adjustments)
- Procurement (purchase orders, receiving, supplier invoices)
- Customer accounts receivable and credit limits

### Admin
- Unrestricted access across the application
- System settings, store configuration, tax rates, and branding
- Staff provisioning and role assignment
- Double-entry accounting chart of accounts and journal logs
- Security logs and operational monitoring

## Offline Functionality

The installed PWA caches the application shell and keeps the POS product catalogue and queued sales in browser IndexedDB. Offline access is available only on a device where the cashier has already signed in online. The queue is scoped to that cashier and each sale is replayed with the same verified identity and idempotency key when connectivity returns.

Offline checkout is deliberately limited to provisional walk-in cash sales using cached product prices and tax rates. M-Pesa, Paybill, store credit, customer accounts, loyalty discounts, and checkout reservations require a live server. A provisional receipt is not a confirmed sale or official invoice.

When reconnecting, the server rechecks current prices, tax, stock, warehouse, and shift requirements. A changed total or other server-side validation failure is held for review rather than silently recorded or discarded; resolve the issue and retry as the original cashier. The online/offline indicator shows queued and conflicted sales.

Before deploying the offline-sale backend support, back up the database and apply pending TypeORM migrations from `server` with `npm run migration:run`. This includes `1791090000000-AddOfflineSaleAudit`, which adds the audit timestamp for when an offline sale was captured.

For workstation and mobile installation, per-device offline preparation, outage recovery, and a controlled rollout checklist, see [INSTALLATION_GUIDE.md](./INSTALLATION_GUIDE.md).

## Security Features

- **4-Tier RBAC**: Granular permission enforcement at HTTP endpoint and middleware layers
- **Two-Factor Authentication**: Single-use, time-limited 6-digit email OTP via Resend with brute-force attempt limits
- **Secure Session Management**: Tamper-proof, httpOnly, SameSite cookies (`jwt_token`) safeguarding tokens against XSS
- **At-Rest Column Encryption**: AES-256 (`pgcrypto`) encryption for sensitive customer and transaction PII
- **Hardened HTTP Headers**: Strict Content-Security-Policy (CSP), framing protection, and origin filtering
- **Rate Limiting**: Multi-tiered rate limiters for login, OTP verification, and high-frequency endpoints
- **Fail-Fast Startup Validation**: Production configuration audit halting startup if weak secrets are detected

## Support & Documentation

For support or enterprise deployment inquiries about cfi-POS:
- **Organization**: cfi-POS Techiez Limited Company
- **Email**: support@cfipos.techiez.co.ke
- **Guides**: [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) | [BACKUP_AND_RECOVERY.md](./docs/BACKUP_AND_RECOVERY.md) | [FEATURES.md](./FEATURES.md)

## License

© 2026 cfi-POS Techiez Limited Company. All rights reserved.

---

**Built with pride by cfi-POS Techiez Limited Company**
