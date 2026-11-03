# cfi-POS Feature Documentation
**cfi-POS Techiez Limited Company** — Production Retail & Wholesale Point of Sale System

---

## 1. Point of Sale & Checkout (Till Operations)
- **High-Speed Checkout**: Optimized barcode scanning (camera scanner and keyboard wedge) with real-time product search and cart management.
- **Tender Methods**:
  - **Cash**: Automated change calculation, drawer float reconciliation, and cash verification.
  - **M-Pesa STK Push**: Instant checkout prompt sent directly to customer's Safaricom phone with polling and callback confirmation.
  - **M-Pesa Paybill (C2B)**: Automated validation and confirmation callback endpoints with per-request callback token verification.
  - **Store Credit**: Barcode-scanned store credit balance lookup and redemptions.
- **Stock Reservation**: Active reservations during checkout sessions to prevent race conditions and overselling across concurrent tills.
- **Manual Sale Discounts**: Nonzero manual discounts are accepted only when the authenticated cashier is a manager or admin; ordinary cashiers and supervisors cannot add or replay discounted checkout, parked-sale, or sale requests. Voucher redemption remains validated against the customer voucher balance and checkout rules.
- **Timed Product Promotions**: Admins and managers can schedule product offers in East Africa Time using percentage-off, fixed KES-per-unit discounts, or fixed unit prices. Minimum quantity, per-sale caps, and total quota are enforced in exact cents; the start instant is inclusive and the end instant is exclusive. Overlapping offers for the same product unit are rejected transactionally. Checkout refreshes server pricing before tender, records promotion price snapshots on sale lines, and restores quota for approved returns/voids. Below-cost offers require an audited manager reason. Promotion changes have immutable before/after audit events and performance reporting.
- **Parked Sales**: Park active carts for customers retrieving more items, and retrieve when ready.
- **Shift Enforcement**: Cash sales require an active, open shift with a recorded cash float.
- **Receipts**: Thermal-printer-ready receipts. Only a verified fiscal integration can provide KRA-issued receipt identifiers, signatures, and verification data; live VSCU submission is currently disabled. Mock-mode QR codes are test-only and are not KRA verification codes.
- **Offline Promotion Reconciliation**: Offline provisional sales do not assume live offers; reconnect reconciliation blocks when the server's current price or promotion differs so the cashier can review it rather than silently changing the recorded sale.

---

## 2. Returns, Refunds & Store Credit
- **Customer Return Initiation**: Cashiers initiate full or partial returns linked to the original sale and individual line items.
- **Managerial Approval**: Multi-tier review by Supervisors, Managers, or Admins.
- **Inventory Triage**:
  - **Sellable Items**: Automatically returned to inventory with physical stock increments.
  - **Damaged Items**: Written off to inventory shrinkage ledger without restocking damaged goods.
- **Refund Settlement Channels**:
  - **Cash Refund**: Deducted directly from supervisor/manager drawer float.
  - **M-Pesa Refund Settlement**: Recorded as payable, processed through Safaricom, and settled with confirmed M-Pesa receipt code.
  - **Store Credit**: Generates verifiable unique store credit barcodes for customer reuse.
  - **Credit Note Generation**: Produces credit note documents matching KRA fiscal guidelines.

---

## 3. Inventory & Warehouse Logistics
- **Multi-Warehouse & Branch Support**: Isolate inventory per physical warehouse or store location, with a designated unique Main Warehouse. Admins manage warehouse records; managers and supervisors can create inventory adjustments, transfers, and stock takes; admins and managers manage catalog records.
- **Purchase Costing & Stock Valuation**: Received purchases are retained with supplier invoice references and cent-precise unit costs, updating weighted-average product cost per warehouse; sale lines retain immutable sale-time cost, net revenue, and VAT snapshots.
- **Stock Movements & Tracking**: Full audit trail of stock additions, sales deductions, transfers, returns, and write-offs.
- **Inter-Warehouse Transfers**: Two-phase transfer workflow: Draft → In-Transit (stock deduction from origin) → Received (incremented at destination) or Cancelled.
- **Physical Stock Takes & Cycle Counts**: Reconcile physical warehouse stock against system counts with automatic discrepancy calculation and approval.
- **Inventory Adjustments**: Manual stock adjustments for breakages, theft, expired items, or count corrections with audit notes.
- **Inventory Period Close**: Manager/admin close checks stock-value reconciliation before recording an immutable close. Historical costing is only closeable from the migration baseline onward; earlier dates lack complete movement history. A failed reconciliation blocks close.
- **Profitability & Inventory Reports**: Filter profitability by date, warehouse, product, category, or supplier; report by product, category, day, month, supplier, and overall alongside stock valuation and purchase history. Profitability is withheld for periods before a verified costing baseline or where exact snapshots are missing; supplier FIFO analysis is likewise withheld until its opening stock valuation is verified. The supplier view uses report-only FIFO purchase-lot attribution; official sale COGS and stock valuation remain pooled weighted average.
- **Stock Protection**: Selling below zero is blocked by default. Administrators may enable an audited override; oversold units use the warehouse average cost, falling back to the product cost when warehouse quantity is zero. If receipts, returns, transfers, or approved adjustments clear a negative balance to exactly zero with a residual cost, that value is posted as an audited inventory adjustment and zero-quantity stock is valued at zero.
- **Batch & Expiry Date Management**: Track product batches, lot numbers, manufacturing dates, and expiration alerts.
- **Reorder Recommendations**: Configurable minimum stock levels and automated reorder alerts for purchasing managers.
- **Spreadsheet Import**: Bulk catalog onboarding from CSV and Excel spreadsheets with header aliasing, unit-of-measure validation, and tax matching.

---

## 4. Purchasing & Supplier Procurement
- **Vendor Management**: Comprehensive vendor database with contact information, payment terms, and purchase histories.
- **Purchase Orders (PO)**: Multi-line procurement order creation, approval workflows, and status tracking (Draft, Sent, Partially Received, Received, Cancelled).
- **Goods Receiving & 3-Way Match**: Record goods received against POs with supplier invoice/reference, automatic warehouse stock updates, and cent-precise unit cost tracking; supplier invoice totals and PO/receipt reconciliation use integer cents. Matched invoice tax is checked per received line using its product tax-class rate (or legacy product rate) and rounded to cents per line; unsupported tax amounts remain discrepant/rejected rather than being silently booked.
- **Supplier Invoices & Accounts Payable**: Three-way-matched invoices retain exact-cent balances and due dates. Admins and managers can also manually enter physical supplier invoices for registered or new suppliers; new supplier records are independently flagged for review. For manual entry, optional browser-local English OCR can suggest invoice number, supplier, dates, and amounts from JPEG/PNG/WebP images (up to 10 MB); the image is not uploaded or retained, while Tesseract worker/language assets are downloaded from jsDelivr and may be browser-cached. OCR output is fallible and every value must be checked against the physical invoice; it never approves an invoice or enables payment. A manager/admin must choose eligible active asset/expense debit accounts for the subtotal and tax (when present) before review; review posts a balanced journal debiting those chosen accounts and crediting Accounts Payable. Tax treatment is an explicit reviewer choice, not an assumed recoverable VAT claim. Legacy reviewed manual invoices missing this entry can be classified from the invoice screen, and the payment API blocks any manual invoice without recognition accounting. Invoice totals must match subtotal plus tax exactly for manual-invoice recognition. Supplier verification remains a separate approval and is still required before payment. Payables show outstanding and review-held totals. Invoice-linked partial/final payments include method, reference, date, notes, payer history, and idempotent retries; retries with the same key and unchanged supplied details return the original payment, including its server-assigned date when the request omitted one, while conflicting key reuse is rejected. Journal postings debit accounts payable and credit Cash, M-Pesa Clearing, or Bank according to method. Partial payments retain invoice match status while the UI derives partial/overdue states. Supplier advances and payment reversals are not supported.

---

## 5. Customer Management, Invoicing & Receivables
- **Customer CRM**: Maintain customer database, credit limits, loyalty standing, and purchase history.
- **B2B Invoicing & Accounts Receivable**: Issue formal credit invoices for corporate clients with customizable payment terms.
- **Payment Receipts**: Record partial or full invoice payments with real-time outstanding balance calculation.

---

## 6. Customer Loyalty Program
- **Loyalty Accrual**: Automated calculation of loyalty points earned per transaction based on store reward rules.
- **Redemption at Checkout**: Redeem accrued loyalty points as direct discount amounts during checkout.
- **Voucher Ledger & Validity**: Voucher balances are derived from append-only ledger entries; managers/admins can renew vouchers from the customer screen without changing the number or balance, and expired vouchers cannot earn or redeem until renewed.
- **Paid Voucher Renewal Checkout**: Admins can configure a renewal fee in cents. Nonzero fees are collected in a separate, productless POS checkout using cash and/or confirmed M-Pesa; the configured fee is VAT-inclusive at Standard VAT 16%. Renewal is finalized only after the full exact amount is confirmed. The checkout and immutable renewal record retain payment references, and VAT/revenue, shift totals, and accounting journals are updated atomically. Unpaid checkouts with only failed M-Pesa attempts can be cancelled; recorded cash and pending, completed, or review-required M-Pesa payments prevent cancellation. Review-required payments also block additional tenders and renewal completion until an administrator resolves them. Shifts cannot close while M-Pesa transactions are pending, flagged for review, or completed but not yet finalized to a sale or renewal. Paid renewal checkouts do not create inventory movements or loyalty points.
- **Voucher Cards & Receipts**: Print single or batch Code 128 voucher cards; sales receipts include voucher number, points earned/redeemed, resulting balance, and expiry.
- **Membership Tiers**: Tier thresholds do not change the fixed 1-point-to-KES-1 redemption value.

---

## 7. Double-Entry Accounting Engine
- **Chart of Accounts**: Standardized accounts structure (Assets, Liabilities, Equity, Revenue, Cost of Goods Sold, Expenses).
- **Automatic Journal Entries**: Balanced debits and credits posted on sales, returns, payments, shrinkage, transfers, and inventory receipts.
- **Financial Integrity**: Verification checks prevent unbalanced journal entries from being committed.
- **General Ledger & Financial Reporting**: Trial balance, P&L, balance sheet, and revenue analytics.
- **Electronic Payment Fee Evidence**: Admins can record an actual M-Pesa provider fee against each eligible sale from a provider statement, including the incurred date, statement/transaction references, and recoverable input VAT. Records are immutable and unique per sale. The posting debits processing-fee expense for the non-recoverable amount, debits recoverable input VAT, and credits M-Pesa clearing; all journal values are stored in whole cents. A recorded fee is attributed to its sale in P&L reporting. Net profit remains unavailable if any M-Pesa payment in the report period has no recorded fee evidence. Historical fees must be taken from provider statements; the system does not estimate them.
- **Provider Fee Corrections**: Admins can correct an evidenced fee with a mandatory reason. The original fee and every correction remain append-only. The system reverses the current journal posting and posts the replacement in the correction date period (the current UTC date), avoiding edits to closed historical periods. P&L keeps the original sale-period fee intact and recognizes each correction's net expense change in the correction period. Fee history displays the latest corrected values and retains the full correction history.
- **Profitability & Demand Analytics**: Filtered sales, discounts, refunds, product margins, recorded expenses, cashier comparisons, and sales-by-hour/day views. Profit figures remain unavailable before a verified inventory-costing baseline or when required exact snapshots are missing; reports identify missing revenue, VAT, and COGS snapshots. Net profit also remains unavailable when applicable processing fees are not recorded.
- **Exact P&L and Period Comparisons**: Financial summary P&L and selected-vs-prior-period sales amounts are represented as integer-cent strings. Server calculations parse PostgreSQL decimal strings directly into `bigint`; financial totals are not converted to JavaScript floating-point values before P&L or comparison arithmetic. The reports and dashboard format those cents without performing money calculations in the browser. Other operational charts and cashier/product-ranking fields retain their existing metric formats and have not yet all been converted to a cents-string API.
- **Role-Restricted Reports**: Detailed P&L and cashier performance are returned only to managers and administrators; supervisors retain the existing operational report.

---

## 8. KRA eTIMS Tax Compliance Engine
- **Pluggable Architecture**: Configurable via `ETIMS_MODE` environment setting:
  - **`off`**: Produces ordinary commercial receipts without a fiscal submission. This mode alone does not establish that a business is exempt from tax-invoice requirements.
  - **`mock`**: Generates random test identifiers and QR URLs. These are simulated and must not be treated as KRA signatures, control codes, or verification links.
  - **`live`**: Currently unavailable. The VSCU client scaffold does not implement the published KRA VSCU v2.0 contract and has not been verified with a KRA test VSCU.
- **Product Mapping Preparation**: Product records can store configured eTIMS item mappings; mapping values must be confirmed against the taxpayer's KRA/VSCU setup. They are not automatically inferred from POS categories or tax rates.
- **Credit Note Fiscalization**: Live credit-note submission is not implemented. Mock credit-note identifiers are test artifacts only.

---

## 9. Offline-First PWA Architecture
- **Installable PWA**: Service worker caching of application shell, assets, and catalog for offline operation.
- **Scoped Offline Queue**: Cashiers who previously signed in can process provisional walk-in cash sales offline into browser IndexedDB.
- **Reconnection Sync & Conflict Detection**: When connectivity is restored, sales sync to the backend with original idempotency keys. Any discrepancies (price changes, deleted products, depleted stock) are flagged in conflict review states for cashier resolution.

---

## 10. Security & Authorization Architecture
- **4-Tier Role-Based Access Control (RBAC)**: Strictly enforced across all backend routes and frontend UI:
  - **Cashier**: POS checkout, search catalogue, register walk-in customer, initiate return, view own shift.
  - **Supervisor**: Tills + shift overrides, approve returns, triage inventory conditions, issue store credit.
  - **Manager**: Supervisor permissions + product/category updates, stock takes, inventory adjustments, purchase orders, customer credit terms.
  - **Admin**: Full system access, company branding, tax settings, user provisioning, role assignments, audit logs, and accounting.
- **Two-Factor Authentication (Email OTP)**: Staff login protected by time-limited, single-use 6-digit OTPs sent via Resend API with brute-force attempt limits.
- **httpOnly Session Cookies**: Session tokens stored in secure, tamper-proof `httpOnly` cookies (`jwt_token`) to safeguard credentials against Cross-Site Scripting (XSS).
- **PII Data Encryption**: Customer and payment phone numbers encrypted at rest using AES-256 (`pgcrypto` / `crypto`).
- **Strict Content Security Policy (CSP)**: Hardened headers with sensitive endpoint rate-limiting and audit logging.
- **Startup Configuration Guard**: Fails fast in production if security keys, encryption secrets, or CORS origins are unconfigured or weak.

---

## 11. Operational Readiness & Reliability
- **Automated Backup & Verification Scripts**: Compressed, credential-free `pg_dump` backups (`scripts/backup.sh`) with automated scratch-database restoration test verification (`scripts/restore-test.sh`).
- **Health & Readiness Probes**: Unauthenticated `/health` liveness probe and database-probing `/ready` readiness probe.
- **Structured Observability**: Request ID propagation (`X-Request-Id`) across logs, sanitized query-string logging, and optional error tracking hook (`SENTRY_DSN`).
- **Graceful Shutdown**: Database pool draining and connection cleanup on SIGTERM and SIGINT signals.

## Costing & Voucher Implementation Notes
- Supplier profitability is a report-only FIFO allocation of sale revenue and purchase cost to source lots; it does not change the official weighted-average sale COGS or stock valuation. Baseline-opening stock is shown under an unattributed/unknown-supplier row, with any known FIFO cost and revenue still visible and supplier attribution separately flagged. Negative-stock sales and sales/returns missing exact revenue remain explicitly unattributed or incomplete.
- Legacy sales/returns without exact net-revenue, VAT, or COGS snapshots are marked incomplete rather than reconstructed from historical tax and discount values whose line-level semantics cannot be proven; inventory periods before the costing baseline cannot be closed. P&L, product, cashier, and supplier-profitability reports do not treat legacy product-cost estimates as verified COGS; these values remain withheld for dates before the verified physical opening valuation.
- Original historical sales, purchase-source attribution, and electronic-payment fee amounts remain unresolved where source invoices, till records, or provider statements are unavailable. No exact historical backfill is possible without those source documents; supplying estimates would make profit, tax, and supplier reporting misleading.
- Supplier report financial completeness is separate from supplier provenance: revenue and FIFO cost are shown independently when known, while missing values remain unavailable and unknown supplier origin is flagged separately. Exact historical supplier provenance and missing sale snapshots still require original receiving/invoice records; the system does not fabricate them.
- A migrated baseline using `legacy_product_unit_cost_snapshot` is explicitly unverified: stock valuation is labelled provisional, reconciliation is withheld, and period close is blocked. A new automatic baseline is marked verified only when warehouse quantities, values, product aggregates, and the complete valued movement ledger reconcile exactly. Admins can establish a new, current opening valuation from an evidence-referenced physical stocktake in Costing & Profitability. The workflow requires a complete warehouse/product row set, exact integer-cent values, and physical quantities matching the book; count differences must first use stock adjustments. It records an immutable audit snapshot, posts value differences through inventory adjustment movements/accounting, and starts future period coverage at the new snapshot time. It is disabled after any period close to protect immutable close history. This does not recover historical sale snapshots or supplier origin and cannot certify periods before the new baseline.
- Financial summary API amounts for P&L, period comparison, product profitability, payment totals, time-bucket sales/refunds, and cashier sales/discount/refund/profit contribution are represented as integer-cent strings and calculated with integer arithmetic. Reports and dashboard render exact amounts from those strings; chart-only KES numeric projections are used for visualization and never feed financial calculations. Legacy missing sale/return snapshots remain unavailable rather than being treated as zero.
- Dashboard sales totals, payment-method amounts, recent transactions, weekly sales, and top-product revenue are also serialized and accumulated as integer-cent strings. Product rankings include completed sales only; chart projections are display-only.
- Shift opening floats, cash counts, expected cash, M-Pesa totals, and shift sales are parsed, accumulated, and persisted from exact decimal strings; the Shift screen submits text amounts and calculates drawer variance in integer cents.
- POS tender entry, persisted checkout state/recovery, checkout totals, M-Pesa reservations, cash/store-credit matching, remaining-balance checks, STK/Paybill callback comparisons, and legacy-sale settlement totals use exact decimal parsing and integer cents. Fractional-cent inputs are rejected; STK and manual Paybill requests retain their provider-required whole-shilling amount.
- POS cart unit and extended prices preserve catalog, resumed-checkout, and parked-sale decimals; cart line totals are rendered from integer cents without floating-point multiplication.
- Fiscal and thermal receipts preserve server decimal amounts as strings and format line items, totals, discounts, and payment breakdowns from exact integer cents.
- Mobile cashier shows a provisional catalog total until the server reserves the cart and calculates its authoritative promotion-adjusted, tax-inclusive total. Cash checkout requires confirmation at that exact reserved amount, sent in canonical decimal form.
- Return requests expose remaining and already-approved quantities per sale line, and estimated refunds use the original sale's stored cents, discount, and VAT allocations.
- Accounts receivable aging, customer balances, and summary totals aggregate invoice balances in integer cents and render with exact KES formatting.
- Supplier portal purchase-order totals and invoice amounts retain API decimals and use exact-cent formatting, including the aggregate order value.
- Customer invoice balances and payments preserve API decimal values, validate payment limits in cents, and render invoice and payment amounts with exact KES formatting.
- Supplier payable summaries and invoice listings aggregate balances in integer cents, and provider-fee reports format M-Pesa sale portions from exact cents.
- Goods-received note details and downloadable GRN invoices preserve decimal values and format unit costs, line totals, and receipt totals from integer cents.
- Customer invoice receipts and supplier invoice payments validate amounts at cent precision, lock invoices during settlement, and update paid/balance amounts and payment journals from integer cents; both payment screens submit and display exact decimal amounts.
- Supplier invoice creation validates subtotal, tax, and total at cent precision and reconciles invoice, goods-receipt, and PO amounts in cents.
- Purchase-order entry and receiving previews calculate line and order values in cents; receipt journal entries are posted from the exact received-value cents.
- Purchase-order list totals and generated barcode-label prices preserve decimal values and display from integer cents.
- Product catalog costs and retail prices preserve API decimals and display using exact-cent KES formatting.
- Customer purchase totals and credit balances preserve API decimals, render at cent precision, and test positive balances in cents.
- Sales catalog/history totals and provisional offline receipts preserve decimal amounts and format line, sale, and order totals from cents, including legacy cached numeric values.
- Loyalty spending totals, member balances, tier thresholds, and progress are aggregated or compared in cents and displayed with exact KES formatting.
- Inventory sales-forecast estimates and daily averages remain canonical decimal strings from cent-based server calculations through display.
- Product and variant price entry, product API writes, and spreadsheet-imported unit costs and retail prices require exact cent precision and respect the database amount range.
- Voiding older sales without persisted COGS snapshots restores inventory value by multiplying unit-cost cents by quantity, avoiding floating-point rounding.
- Inventory sales forecasts aggregate daily revenue and calculate averages, horizon estimates, and trend thresholds using integer cents.
- Voucher renewal fees default to KES 0. Configured nonzero fees are collected through the paid renewal checkout with confirmed full settlement; renewal expiry updates are blocked until payment is complete.

---

## Support & Contact
**cfi-POS Techiez Limited Company**
- System: cfi-POS Production Suite
- Inquiries & Support: support@cfipos.techiez.co.ke
- Documentation: [README.md](./README.md) | [INSTALLATION_GUIDE.md](./INSTALLATION_GUIDE.md) | [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md)

© 2026 cfi-POS Techiez Limited Company. All rights reserved.
