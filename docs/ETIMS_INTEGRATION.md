# Kenya Revenue Authority (KRA) eTIMS Integration Guide

> [!IMPORTANT]
> **LIVE FISCALIZATION IS DISABLED.** Mock receipts are test artifacts and must not be represented as KRA-validated tax invoices. This guide is technical documentation, not legal advice. Enable live mode only after an authorized business representative approves the integration and its behavior has been verified with KRA or the selected accredited provider.

---

## 1. Architectural Options (Decision Required)

KRA provides three official avenues for fiscal electronic tax invoice management:

| Architecture | Description | Pros | Cons / Requirements |
|---|---|---|---|
| **Option A: OSCU (Online Sales Control Unit)** | Physical ESD (Electronic Signature Device) hardware connected locally to the till via USB or LAN. | • Autonomous offline fiscal signing.<br>• Certified by KRA hardware labs.<br>• Instant invoice signing without WAN latency. | • Requires physical certified hardware purchase per till.<br>• Local driver / daemon installation on till machine. |
| **Option B: VSCU (Virtual Sales Control Unit)** | KRA-approved JAR deployed on a local web server, exposing REST/JSON services to the Trader Invoicing System and communicating with KRA. | • No physical ESD required per till.<br>• Local signing workflow with upstream synchronization. | • Requires KRA approval and deployment-specific configuration.<br>• The published VSCU v2.0 specification says receipt issuance stops after 24 hours without internet. |
| **Option C: Accredited KRA Technical Integrator / Direct eTIMS API** | Integration through a provider or API route explicitly approved for the business. The exact API, deployment model, credentials, and operating requirements depend on that route. | • May suit cloud-hosted POS deployments. | • Requires the selected provider's current contract, onboarding, and sandbox validation. Do not assume a provider API is the same as the VSCU local service. |

---

## 2. Information & Credentials Required From Human

The required configuration depends on the selected, approved integration route. Do not create or populate guessed credentials:

1. **For the KRA VSCU route:** obtain the approved VSCU JAR and test-environment setup, registered taxpayer PIN, branch ID, and device serial. The published v2.0 spec describes a local server URL and initialization inputs, but the exact installed service routes and any additional authentication must be verified against the test VSCU.
2. **For an accredited provider:** obtain that provider's current API contract, sandbox access, onboarding credentials, and receipt-verification requirements directly from the provider.
3. **For either route:** configure secrets only through the deployment secret manager. Do not put credentials in source control or chat. Determine the exact QR/receipt data from the verified success response; do not assume it is a public URL.

---

## 3. Supported Modes in cfi-POS

The system supports three explicit operating modes configured via `ETIMS_MODE`:

1. **`off` (Pilot / Exempt Mode)**:
   - Receipts are issued as ordinary commercial sales receipts.
   - Invoices and receipts display the clear legal notice: `CUSTOMER RECEIPT - NOT A KRA TAX INVOICE`.
   - Sales are never blocked by network latency or KRA downtime.
   - `etims_status` is stored as `not_applicable`.
2. **`mock` (Simulation Mode)**:
   - Simulates KRA latency and generates distinct test identifiers: `TEST-ETIMS-******` and `TEST-CN-ETIMS-******`.
   - Receipts display: `*** TEST RECEIPT - NOT A VALID TAX INVOICE ***`.
   - Allowed in development, testing, and staging environments.
3. **`live` (Production Fiscalization Mode)**:
   - **Currently disabled.** The existing `LiveEtimsProvider` and `EtimsVscuClient` are an unverified scaffold and do not implement the KRA VSCU v2.0 contract. Do not enable live mode or treat its request/response tests as sandbox verification.
   - The KRA [VSCU Specification Document v2.0 (April 2023)](https://www.kra.go.ke/images/publications/VSCU_Specification_Document_v2.0.pdf) lists `/initializer/selectInitInfo` and `/trnsSales/saveSales`. Initialization uses `tin`, `bhfId`, and `dvcSrlNo`; the sales contract uses fields including `trdInvcNo`, `invcNo`, `orgInvcNo`, `salesTyCd`, `rcptTyCd`, `pmtTyCd`, `salesSttsCd`, `cfmDt`, `salesDt`, per-tax-type amounts and rates, and a nested item list. Its success response sample includes `rcptNo`, `intrlData`, `rcptSign`, `totRcptNo`, `VSCURcptPbctDate`, `sdcId`, and `mrcNo`. This differs from the scaffold's `/api/v1/...` paths, `bhId`/`dvcId` fields, and `intrLnk`/`totInvcNo` response assumptions.
   - The specification's code tables define normal sales with `salesTyCd: "N"` and sale receipt type `rcptTyCd: "S"`; credit notes use receipt type `"R"`. `salesSttsCd: "03"` means credit note requested, not the credit-note type itself. Payment method codes include `"01"` cash, `"02"` credit, and `"06"` mobile money. Confirm the required transition/status sequence with the test VSCU before sending transactions.
   - The published spec has details that still require validation against the actual KRA test VSCU: its initialization guide shows a root-level `/selectInitInfo` URL while the route table specifies `/initializer/selectInitInfo`; the item schema table names `totTaxAmt` while its JSON sample uses `taxAmt`; and `cmcKey` is listed in initialization data without specifying that it must be sent as an HTTP header. Do not guess these behaviors or add undocumented authentication, routes, or payload fields.
   - The separate KRA [TIS specification for OSCU/VSCU v2.0 (April 2023)](https://www.kra.go.ke/images/publications/TIS-for-OSCU--VSCU-Technical-Specifications-v2.0.pdf) requires an uninterrupted receipt-number series per receipt type and describes item registration and journal-data transfer. The current single database counter does not yet model the distinct trader invoice and VSCU invoice fields or receipt-type series; reconcile both counters with initialization data before implementing allocation.
   - The VSCU specification says receipt issuance stops after 24 hours without internet. The current implementation does not implement the complete initialization, code-data, branch, item-registration, and journal-sync workflows. These are blockers to production readiness, not optional optimizations.
   - Do not send a live request until the exact local routes, required fields, receipt-number semantics, item registration, response mapping, and offline behavior have been verified against the KRA test VSCU. Keep `ETIMS_LIVE_MODE_AVAILABLE` false until implementation and sandbox tests cover those requirements.
   - The current allocator reserves a number from one shared database counter and persists it on the sale before submission. It is atomic across API instances, but it is not yet proven to represent the correct KRA `invcNo`/TIS `trdInvcNo` sequence. Do not reset or reuse reserved numbers; reconcile them with daemon and sale records.
   - The PostgreSQL integration suite exercises 50 simultaneous reservations for distinct sales and ten concurrent reservations for one sale, checking uniqueness, continuity, sale persistence, counter advancement, and reuse. Run `npm run test:etims-integration` with a local PostgreSQL `DATABASE_URL` and `ENCRYPTION_KEY` in the server/root environment. It creates and drops a uniquely named temporary database; remote database hosts are refused unless `ALLOW_REMOTE_INTEGRATION_DB=true`. The broader integration suite remains separate.
   - A live submission error is marked failed with a reconciliation warning and is not automatically retried, because a timeout may occur after the daemon accepted the invoice. Check the daemon and reconcile the stored invoice number before any manual retry.
   - The unreachable scaffold currently attempts to accept single-tender cash, M-Pesa, and store-credit sales using configured `ETIMS_PAYMENT_TYPE_*` values, rejects hybrid tender, and sends a blank buyer PIN because the POS does not capture a KRA PIN. These are not verified KRA mappings or supported live capabilities. Credit-note submission is not implemented.
   - KRA's [approved eTIMS third-party integrator list (24 March 2025)](https://www.kra.go.ke/images/publications/List-of-Approved-eTIMS-3rd-party-integrators-as-at-24th-March-2025.pdf) is a provider directory, not a VSCU service endpoint or API specification. It does not document the direct VSCU daemon's routes, authentication, payloads, offline behavior, or receipts.
   - The request/response TypeScript interfaces and local mock tests are not proof that the daemon enforces the contract. Obtain the KRA test VSCU package and deployment guidance, then verify before changing the live-mode gate.
   - In Docker, `localhost` inside the API container refers to that container, not a daemon running on the host. The Compose API service maps `host.docker.internal` to the Docker host gateway; on Docker Desktop this is the standard host name, and the Compose mapping also supports Linux Engine versions that recognize the `host-gateway` value. If using another runtime, configure the equivalent host-gateway mapping. A host daemon bound only to loopback may not accept bridge-network connections; configure a restricted, reachable host interface or an approved host-network deployment rather than exposing the daemon publicly.
   - Set `ETIMS_VSCU_BASE_URL` only to the address provided in the authorized VSCU deployment instructions; this project does not assume a VSCU port or publish a default endpoint. For Docker, verify API-container connectivity to that approved address before configuring it, and do not expose the daemon publicly.
   - Credit-note handling, item-registration workflow, customer KRA PIN capture, and end-to-end sandbox verification are not implemented. Do not enable live mode until the official contract and credentials are verified and sandbox tests cover these flows.
   - Do not store VSCU secrets in source control or share them in chat. Configure them only through the deployment secret manager after approval.

## 4. Product Mapping Preparation

After applying the `AddEtimsProductMapping1792440000000` database migration, administrators and managers can set the explicit KRA eTIMS item mapping from the Product Catalog. The same values are available when creating a product; each sellable variant has its own unique KRA item code.

The configured mapping fields include item code, item-classification code, product type, country of origin, packaging unit, quantity unit, and tax type. The application validates configured field lengths and selected code values, but does not infer KRA classifications from POS categories, tax percentages, origin, or units. Confirm each value against the business's KRA/VSCU setup before entering it.

New sale lines store a snapshot of the product mapping used at checkout. Historical sale lines created before the migration have no mapping snapshot and are not eligible for retroactive fiscal submission. Although the scaffold reads mapping and exact-cent tax/discount snapshots, its request model does not match the published v2.0 sales contract and must not be used for fiscal submission.
