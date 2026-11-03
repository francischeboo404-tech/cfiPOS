# 🚀 Production Deployment Checklist - Secure POS System

## ✅ Pre-Deployment Verification

### 1. Database Provisioning and Migrations
- [ ] For a new deployment, provision a dedicated empty PostgreSQL database and run `npm run db:bootstrap` from `server` with `POS_DB_BOOTSTRAP_CONFIRM=CREATE_SCHEMA_IN_EMPTY_DATABASE`. It refuses non-empty public schemas and applies the TypeORM entity baseline plus all TypeORM migrations.
- [ ] For an empty PostgreSQL deployment, keep the API out of service until bootstrap completes and `npm run migration:show` confirms no pending migrations.
- [ ] For an existing deployment, confirm the supported baseline schema and take a verified backup. Never run the bootstrap command against an existing database.
- [ ] Before migrations or recovery exercises, restore the selected archive with `scripts/restore-test.sh` using `RESTORE_TEST_DATABASE_URL` for a dedicated non-production PostgreSQL server; require a successful exit and cleanup confirmation.
- [ ] From `server`, run `npm run migration:show` against the backend database and confirm which TypeORM migrations are pending.
- [ ] Back up the backend database, review the pending migrations, then run `npm run migration:run`; run `npm run migration:show` again and confirm no pending migrations remain.
- [ ] Do not run Supabase migrations or `database_migrations.sql` for this PostgreSQL-only deployment.

### 2. Environment Variables Configured
- [ ] Update `.env` with real production values:
  - [ ] `DATABASE_URL` (dedicated PostgreSQL database; never expose to the frontend)
  - [ ] `JWT_SECRET` (strong random secret)
  - [ ] `MPESA_CONSUMER_KEY` (production credentials)
  - [ ] `MPESA_CONSUMER_SECRET` (production credentials)
  - [ ] `MPESA_PASSKEY` (production credentials)
  - [ ] `MPESA_C2B_CALLBACK_BASE_URL` (public HTTPS origin for Paybill callbacks)
  - [ ] `MPESA_C2B_CALLBACK_TOKEN` (64–128 hexadecimal characters; store as a secret)
  - [ ] Preserve callback query parameters and redact callback tokens from proxy/access logs
  - [ ] Drain or expire pending M-Pesa STK requests before deploying callback-token migration
  - [ ] `RESEND_API_KEY` (required in production for login OTP)
  - [ ] `RESEND_FROM_EMAIL` (sender verified in the configured Resend account)
  - [ ] `GEMINI_API_KEY` (if using AI features)
  - [ ] `ENCRYPTION_KEY` (64-character hex key, 32 bytes; not a `VITE_` variable)
  - [ ] Keep `ETIMS_MODE=off` unless the business's approved fiscalization route has been implemented and verified; VSCU placeholders do not make live fiscalization ready.
  - [ ] Do not configure VSCU PINs, device identifiers, or endpoints in frontend variables or source control; follow [ETIMS_INTEGRATION.md](./docs/ETIMS_INTEGRATION.md) and verify the API host can reach the authorized VSCU before configuring secrets.

### 3. Security Configuration
- [ ] Verify CSP headers in `vite.config.ts`
- [ ] Confirm PWA manifest is properly linked
- [ ] Check service worker security features
- [ ] Verify PostgreSQL network restrictions, TLS, backups, and least-privilege application credentials
- [ ] Configure production `RESEND_API_KEY` and a Resend-verified `RESEND_FROM_EMAIL` on the API host, then redeploy/restart the API; production startup and login OTP require both.

## 🚀 Deployment Steps

### Supported Deployment Shapes for Cookie Authentication

cfi-POS stores session JWT tokens in secure, `httpOnly` cookies (`jwt_token`) to safeguard POS credentials against XSS. Modern browsers restrict third-party and cross-site cookies, so deployments must follow one of two supported architectural shapes:

#### Shape A: Same-Origin / Shared Parent Domain (Recommended)
Host the frontend and backend under the same registered parent domain:
- **Frontend:** `https://app.example.co.ke` (Vercel or CDN)
- **Backend API:** `https://api.example.co.ke` (Render, Fly.io, or VPS)
- **Environment Configuration:**
  - **Backend API:**
    - `COOKIE_DOMAIN=.example.co.ke` (leading dot scopes authentication to all subdomains)
    - `COOKIE_SAMESITE=lax` (or `strict` if using a single domain reverse proxy)
    - `FRONTEND_URL=https://app.example.co.ke`
    - `CORS_ORIGINS=https://app.example.co.ke`
  - **Frontend (Vercel):**
    - `VITE_API_URL=https://api.example.co.ke/api`
  - **WebSockets:** Full native bidirectional WebSocket connections to `https://api.example.co.ke`.

#### Shape B: Vercel Proxying `/api` (Zero-Config Subdomains)
Frontend on Vercel (`https://pos.vercel.app` or custom domain) with backend on Render (`https://pos-api.onrender.com`):
- All browser requests target the Vercel origin. Vercel rewrites `/api/*` and `/socket.io/*` to Render so the browser treats API requests as same-origin.
- **Environment Configuration:**
  - **Vercel (`vercel.json`):**
    ```json
    {
      "rewrites": [
        { "source": "/api/:match*", "destination": "https://your-pos-api.onrender.com/api/:match*" },
        { "source": "/socket.io/:match*", "destination": "https://your-pos-api.onrender.com/socket.io/:match*" },
        { "source": "/(.*)", "destination": "/index.html" }
      ]
    }
    ```
  - **Frontend (Vercel):**
    - `VITE_API_URL=/api`
  - **Backend API (Render):**
    - `FRONTEND_URL=https://your-pos-app.vercel.app`
    - `CORS_ORIGINS=https://your-pos-app.vercel.app`
    - `COOKIE_SAMESITE=strict` (or `lax`)
  - **WebSockets Fallback:** Vercel serverless rewrites do not support WebSocket upgrades. The Socket.IO client automatically and gracefully falls back to HTTP long-polling. For native WebSocket performance at busy tills, use Shape A.

### ⚠️ Troubleshooting: "Logged out immediately"
If users complete login and OTP verification but are immediately redirected back to the login screen:
1. **Third-Party Cookie Blocking (Different Sites):**
   - If the frontend is on `*.vercel.app` and the API is on `*.onrender.com`, browsers block cross-site cookies under default privacy settings.
   - **Resolution:** Adopt **Shape A** (custom parent domain) or **Shape B** (`vercel.json` proxy rewrites with `VITE_API_URL=/api`).
2. **Missing `COOKIE_DOMAIN` on Subdomains:**
   - If using `app.example.co.ke` and `api.example.co.ke` without `COOKIE_DOMAIN`, the cookie is restricted to `api.example.co.ke` and not transmitted by `app.example.co.ke`.
   - **Resolution:** Configure `COOKIE_DOMAIN=.example.co.ke` on the backend API.
3. **`SameSite=None` without HTTPS:**
   - Browsers reject `SameSite=None` if `Secure` is false.
   - **Resolution:** Ensure the backend is accessed via HTTPS (the backend enforces `secure: true` when `COOKIE_SAMESITE=none`).

### Vercel frontend with GitHub auto-deploy
- [ ] Import the GitHub repository into Vercel and set the project root to the folder containing `vercel.json` and the root `package.json`.
- [ ] Set `VITE_API_URL` (HTTPS API URL ending in `/api`) for Production and any Preview environments.
- [ ] Deploy `render.yaml` as a Render Blueprint using the existing POS PostgreSQL database, encryption key, and Vercel production origin. Keep the API on an always-on paid instance for Socket.IO and scheduled jobs.
- [ ] Configure Render `FRONTEND_URL` and `CORS_ORIGINS` for the exact Vercel production origin and custom domains; add only known stable preview origins that need API access.
- [ ] Keep database credentials and runtime secrets on Render, not in Vercel frontend variables or GitHub.
- [ ] Check pending backend TypeORM migrations with `npm run migration:show`, take a verified backup, apply reviewed migrations with `npm run migration:run`, and confirm none remain before releasing backend changes.
- [ ] Verify a GitHub push creates the intended Preview or Production deployment and verify login, API requests, and real-time updates against the persistent API.
- [ ] If using multiple API instances, confirm the shared PostgreSQL `LISTEN`/`NOTIFY` channel connects on every instance and the load balancer supports WebSocket upgrades. Understand that rate-limit counters are per-instance; configure a shared store if one global limit is required.
- [ ] Set `PG_POOL_MAX` so the total pool budget plus one PostgreSQL notification connection per API instance stays within the database connection limit with operational headroom.
- [ ] Verify the production HTTPS certificate, PWA manifest/icons, and service-worker registration in a supported browser; install and launch from a pilot workstation.
- [ ] Follow [INSTALLATION_GUIDE.md](./INSTALLATION_GUIDE.md) to prepare each till online, rehearse offline cash capture and same-cashier reconnect in a test environment, and approve the manual outage/reconciliation fallback before rollout.

### Docker deployment
- [ ] Set `POSTGRES_PASSWORD` to an independently generated 64-character hexadecimal secret; the default Compose stack persists PostgreSQL in the `postgres-data` volume and does not expose its database port to the host.
- [ ] Start `postgres`, confirm its health, and run the guarded bootstrap exactly once for its new empty volume before starting the full application.
- [ ] For a new, dedicated empty database only, run the guarded `docker compose run --rm -e POS_DB_BOOTSTRAP_CONFIRM=CREATE_SCHEMA_IN_EMPTY_DATABASE api npm run db:bootstrap:docker` command. For an existing database, use the migration status and apply commands below.
- [ ] Configure `POSTGRES_PASSWORD`, `JWT_SECRET`, a fresh 64-character hexadecimal `ENCRYPTION_KEY`, `PUBLIC_ORIGIN`, `RESEND_API_KEY`, and verified `RESEND_FROM_EMAIL` in the untracked `.env` copied from `docker-compose.env.example`. No Supabase settings are required. Set `DATABASE_URL` only to intentionally override the bundled database with an external PostgreSQL instance.
- [ ] Back up the PostgreSQL volume to storage outside the Docker host and test restore; the named volume alone does not protect against host or disk loss.
- [ ] Set `PG_POOL_MAX` based on the PostgreSQL connection budget divided across the maximum number of API instances; leave capacity for migrations, monitoring, and administration.
- [ ] For existing databases, back up, inspect pending TypeORM migrations with `docker compose run --rm api npm run migration:show:docker`, apply reviewed pending migrations with `docker compose run --rm api npm run migration:run:docker`, and confirm none remain.
- [ ] Build and start with `docker compose up --build -d`; verify both services are healthy with `docker compose ps`.
- [ ] Terminate public HTTPS at a trusted reverse proxy, set `PUBLIC_ORIGIN` to its exact origin, and configure provider callbacks to preserve query parameters.

### PostgreSQL-only application environment

For Vercel + a persistent API host, configure `VITE_API_URL` on Vercel and the server variables on the API host. For Docker Compose, copy `docker-compose.env.example` to `.env`. Do not add any Supabase variables; PostgreSQL is the application's database.

The required API values are:
```
DATABASE_URL=your_postgresql_connection_url
JWT_SECRET=your_long_random_secret
ENCRYPTION_KEY=64_hex_characters
FRONTEND_URL=https://your-frontend.example.com
CORS_ORIGINS=https://your-frontend.example.com
PORT=your_backend_port
```

Optional payment, email, tax, and AI integrations require their own provider settings. They are not PostgreSQL or Supabase database requirements; leave them unset only if those associated features are not being used. Before deploying encryption migrations, take a verified backup. If audit/offline encrypted rows exist, set their original key as the session-only `app.legacy_encryption_key` for the migration connection; the migration aborts rather than silently lose data when legacy decryption fails. Preserve the backup and stop if the prior key cannot be verified.

Apply backend TypeORM migrations from `server` with `npm run migration:run` (do not substitute the Supabase SQL script). Before applying `1791020000000-AddMpesaPaybillReferences`, run the duplicate-receipt query in README and reconcile any results against Safaricom and accounting records. After deploying the API, configure the Paybill shortcode in Settings and use the admin callback-registration action; confirm Safaricom accepted the registration before enabling Paybill at the POS. Till payments use STK Push.

Migration `1791030000001-AddMpesaRefundSettlement` marks previously approved M-Pesa returns as awaiting payout confirmation. Reconcile those legacy returns against Safaricom before entering receipts; the POS does not initiate M-Pesa refunds. For new returns, complete the payout through Safaricom first, then record its successful receipt from the Returns page while the confirming user's shift is open.

Reservations protect stock while payment is pending and do not expire automatically. Monitor unresolved transactions and reconcile with Safaricom before manually releasing reserved stock. All current provider tests are mocked; complete sandbox verification before production.

## 📊 Monitoring & Alerting Setup

### Optional: Supabase Edge Functions

These functions are separate optional extensions. Do not deploy them or configure Supabase to run the PostgreSQL-only POS application.
```bash
# Deploy monitoring functions
supabase functions deploy send-inventory-alerts
supabase functions deploy send-scheduled-reports
```

### Step 2: Configure Cron Jobs (Scheduled Reports)
In Supabase Dashboard → Edge Functions:
- Set up daily/weekly report scheduling
- Configure inventory alert triggers

### Step 3: Set Up Error Monitoring
- Enable error logging in database
- Configure alert thresholds
- Set up email notifications for critical errors

### Step 4: Performance Monitoring
- Enable application performance monitoring
- Set up uptime monitoring
- Configure alerting for downtime

## 🔒 Security Audit Checklist

### Pre-Production Security Audit
- [ ] Run final security test: `node security_test.js`
- [ ] Verify all environment variables are production-ready
- [ ] Confirm no sensitive data in client-side code
- [ ] Test authentication flows
- [ ] Validate authorization policies
- [ ] Check encryption functionality
- [ ] Test input validation
- [ ] Verify rate limiting
- [ ] Confirm CSRF protection
- [ ] Test session management

### Production Security Validation
- [ ] SSL/TLS certificate properly configured
- [ ] Security headers active (CSP, HSTS, etc.)
- [ ] Database backups configured
- [ ] Access logging enabled
- [ ] Intrusion detection systems active
- [ ] Regular security updates scheduled

## 🎯 Post-Deployment Tasks

### 1. User Management Setup
- Create admin user accounts
- Assign appropriate roles
- Configure user permissions
- Set up password policies

### 2. System Configuration
- Configure store settings
- Set up product categories
- Configure payment methods
- Set up inventory alerts

### 3. Testing & Validation
- Test complete sales workflow
- Verify offline functionality
- Test PWA installation
- Validate mobile responsiveness
- Check cross-browser compatibility

### 4. Monitoring Activation
- Enable real-time error monitoring
- Set up performance dashboards
- Configure alerting rules
- Establish incident response procedures

## 📞 Support & Maintenance

### Ongoing Security Maintenance
- Regular security updates
- Dependency vulnerability scanning
- Security patch management
- Access review procedures

### Performance Optimization
- Database query optimization
- Caching strategy implementation
- CDN configuration
- Load balancing setup

---

## 🎉 Deployment Complete!

Once all steps are completed, your **enterprise-grade secure POS system** will be live with:
- ✅ Zero-trust security architecture
- ✅ AES-256 encryption
- ✅ Comprehensive monitoring
- ✅ Automated alerting
- ✅ Production-ready performance
- ✅ PWA offline capabilities

**Your retail business is now protected by enterprise-level security!** 🛡️✨</content>
<parameter name="filePath">DEPLOYMENT_CHECKLIST.md