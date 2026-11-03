# M-Pesa Daraja Sandbox Manual Testing Guide

> **NOTICE: MANUAL / HUMAN-EXECUTED TEST SCRIPT**
> 
> The test procedures below are designed for manual execution against the **Safaricom Daraja Sandbox** environment. Automated unit and integration tests simulate Daraja payloads in isolation, but end-to-end sandbox verification requires physical or simulated SIM interaction via Safaricom's test numbers.

---

## 1. Prerequisites and Environment Setup

### 1.1 Safaricom Developer Account
1. Register or log in at [Safaricom Daraja Developer Portal](https://developer.safaricom.co.ke/).
2. Create an App under **My Apps** and enable **Lipa na M-Pesa Sandbox**.
3. Note your credentials:
   - **Consumer Key**
   - **Consumer Secret**
   - **Passkey** (found under Lipa na M-Pesa Sandbox test credentials)
   - **Shortcode** (default sandbox test shortcode is typically `174379`)

### 1.2 Webhook Expose (Tunneling)
Safaricom's sandbox servers must reach your local backend over a public HTTPS endpoint.
Run `ngrok` or `cloudflared`:
```bash
ngrok http 3000
```
Note your public HTTPS URL, e.g. `https://xyz-pos.ngrok-free.app`.

### 1.3 Server Configuration (`server/.env`)
Set the following environment variables:
```env
MPESA_API_BASE_URL="https://sandbox.safaricom.co.ke"
MPESA_CONSUMER_KEY="<your-consumer-key>"
MPESA_CONSUMER_SECRET="<your-consumer-secret>"
MPESA_PASSKEY="<your-passkey>"
MPESA_CALLBACK_URL="https://xyz-pos.ngrok-free.app/api/webhooks/mpesa/callback"

# Optional reconciliation tuning (minutes)
MPESA_PENDING_QUERY_TIMEOUT_MINUTES="2"
MPESA_PENDING_MAX_AGE_MINUTES="15"
CHECKOUT_RESERVATION_TTL_MINUTES="15"
```
In **Settings > MPESA Configuration**, select the account type that matches the
Daraja shortcode and enter its number:
- **Till (Buy Goods):** STK uses `CustomerBuyGoodsOnline`.
- **Paybill:** STK uses `CustomerPayBillOnline`.

The Till number is saved as `mpesa_shortcode` (legacy
`mpesa_till_number` is still accepted); the STK account type is saved as
`mpesa_stk_account_type`. For example, sandbox shortcode `174379` is normally
configured as a Till. A separate Paybill number can be saved for manual C2B
checkout and callback registration.

---

## 2. Test Procedures

### Test Case 1: STK Push Success (Normal Checkout)
- **Goal:** Verify that a standard STK Push prompt is sent to the phone, approved, and automatically updates the checkout session to `completed`.
- **Steps:**
  1. Open POS UI or initiate an STK push via API:
     ```bash
     POST /api/payments/mpesa/stk-push
     {
       "phone_number": "254708374149",
       "amount": 10,
       "checkout_session_id": "<active-session-uuid>",
       "items": [...]
     }
     ```
  2. The mobile phone (or sandbox simulator) receives the STK prompt for the configured Till or Paybill account.
  3. Enter the test M-Pesa PIN (`1234` or sandbox default).
  4. Wait 5–10 seconds for Safaricom to deliver the webhook callback to `/api/webhooks/mpesa/callback`.
- **Expected Result:**
  - Safaricom delivers `ResultCode: 0`.
  - In `mpesa_transactions`, `status` changes from `pending` to `completed`.
  - `mpesa_receipt_number` is populated (e.g. `NLJ7RT61SV`).
  - POS cashier screen updates from "Waiting for customer PIN..." to "Payment Received: KES 10.00".
  - Completing the sale produces a receipt and posts the corresponding double-entry accounting entry to the general ledger.

  Repeat this test with a valid Paybill configured as the STK account type and
  verify Daraja receives `CustomerPayBillOnline`. A Till must use
  `CustomerBuyGoodsOnline`; the account number and selected type must match the
  Safaricom Daraja account.

---

### Test Case 2: STK Push Cancelled by Customer
- **Goal:** Verify handling when a customer presses "Cancel" on the phone prompt.
- **Steps:**
  1. Initiate an STK Push for KES 50.
  2. When the USSD prompt appears on the phone, select **Cancel**.
  3. Safaricom sends callback with `ResultCode: 1032` ("Request cancelled by user").
- **Expected Result:**
  - `mpesa_transactions.status` updates to `failed`.
  - `result_desc` records `"Request cancelled by user"`.
  - POS UI informs the cashier that the customer cancelled, allowing retry or selection of an alternative payment method (Cash/Store Credit).

---

### Test Case 3: STK Push Timeout / Unreachable
- **Goal:** Verify handling when the customer's phone is off, out of network, or prompt expires.
- **Steps:**
  1. Initiate an STK Push to an unreachable or non-responding number.
  2. Wait ~60 seconds without entering a PIN.
  3. Safaricom sends callback with `ResultCode: 1037` ("DS timeout user cannot be reached").
- **Expected Result:**
  - `mpesa_transactions.status` transitions to `failed`.
  - `result_desc` records `"DS timeout user cannot be reached"`.
  - POS UI unblocks and displays payment timeout.

---

### Test Case 4: Lost-Callback Reconciliation (Daraja STK Query)
- **Goal:** Verify that if Safaricom fails to deliver the webhook callback, the background cron queries Daraja STK Push Query and completes the transaction automatically.
- **Steps:**
  1. Temporarily disable or misconfigure the callback tunnel (e.g. stop ngrok or set an invalid callback URL).
  2. Initiate an STK Push for KES 10.
  3. Enter PIN on the phone. The customer's money is deducted, but the POS server never receives the webhook callback.
  4. The transaction remains `status: 'pending'` in the database.
  5. Wait for the reconciliation cron job (runs every 2 minutes) or trigger it programmatically:
     ```typescript
     await CronService.reconcilePendingMpesaTransactions({ queryTimeoutMinutes: 1 });
     ```
- **Expected Result:**
  - The reconciliation worker queries `https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query`.
  - Daraja responds with `ResultCode: 0` ("The service request is processed successfully").
  - The transaction is updated to `status: 'completed'`.
  - No synthetic receipt number is created. The M-Pesa receipt remains blank until Safaricom's callback supplies it.
  - The cashier's till UI recovers on the next polling cycle, showing the payment as completed.
  - If neither the callback nor a matching authoritative Daraja query confirms the outcome before the configured maximum age, the transaction is flagged `needs_review`, not marked failed. An administrator must verify the result in Safaricom and resolve it with evidence notes; marking it completed also requires the actual Safaricom receipt number.

---

### Test Case 5: Callback Mismatch Handling (`needs_review`)
- **Goal:** Verify that if the received amount or phone number does not match the pending checkout details, the system flags the transaction as `needs_review` rather than discarding it or silently approving an incorrect amount.
- **Steps:**
  1. Create a checkout session for KES 1,000.
  2. Initiate payment or simulate a callback where `Amount` in `CallbackMetadata` is `500` instead of `1000`.
- **Expected Result:**
  - Callback returns HTTP 200 with `{ ResultCode: 0, ResultDesc: "Accepted for review" }`.
  - In `mpesa_transactions`:
    - `status` is set to `"needs_review"`.
    - `mismatch_reason` is recorded (e.g., `"Amount mismatch: expected KES 1000, received KES 500"`).
    - `mpesa_receipt_number` is saved from the callback so the funds can be audited.
  - The sale is **NOT** credited or finalized automatically.
  - Navigating to `GET /api/admin/mpesa/unresolved` lists the transaction under the supervisor review queue.
  - The administrator can review the discrepancy and resolve it via `POST /api/admin/mpesa/:id/resolve`. Resolution requires source notes; `mark_completed` also requires the verified Safaricom `receipt_number`, for example `{ "action": "mark_completed", "receipt_number": "NLJ7RT61SV", "notes": "Verified in Daraja portal, statement ref ..." }`. A receipt already recorded on another transaction is rejected.

---

### Test Case 6: Duplicate Callback Idempotency
- **Goal:** Verify that if Safaricom retransmits the same callback (e.g. due to temporary network lag), duplicate ledger entries or double-crediting do NOT occur.
- **Steps:**
  1. Complete a successful STK payment.
  2. Replay the exact same webhook HTTP POST payload to `/api/webhooks/mpesa/callback`.
- **Expected Result:**
  - The controller detects that `transaction.status === "completed"` and the receipt matches.
  - Returns HTTP 200 with `{ ResultCode: 0, ResultDesc: "Accepted" }`.
  - No new ledger entries are created in the accounting system.
  - The database remains consistent.

---

### Test Case 7: Paybill C2B Validation and Confirmation
- **Goal:** Verify Paybill C2B payments where customer manually navigates to Lipa na M-Pesa -> Paybill.
- **Steps:**
  1. Cashier generates a Paybill payment intent for checkout:
     ```bash
     POST /api/payments/mpesa/paybill-intent
     { "checkout_session_id": "<uuid>", "phone_number": "254712345678", "amount": 250 }
     ```
     System generates account reference, e.g. `POS1234567890`.
  2. Trigger C2B Validation callback to `/api/webhooks/mpesa/c2b/validation`.
     - Returns `{ ResultCode: 0, ResultDesc: "Accepted" }` if account reference and amount match.
     - Returns `{ ResultCode: 1, ResultDesc: "C2B payment does not match an active checkout" }` if reference does not exist.
  3. Trigger C2B Confirmation callback to `/api/webhooks/mpesa/c2b/confirmation`.
- **Expected Result:**
  - If details match: `status` becomes `"completed"`, receipt is recorded.
  - If details mismatch: `status` becomes `"needs_review"`, `mismatch_reason` is populated.

---

### Test Case 8: Stock Reservation Expiry
- **Goal:** Verify that abandoned checkout sessions release their stock reservations automatically.
- **Steps:**
  1. Cashier initiates a checkout for 5 units of Product X (stock drops by 5 in reservation calculations).
  2. Customer abandons the checkout. No payment is initiated or STK push fails.
  3. Allow `CHECKOUT_RESERVATION_TTL_MINUTES` (e.g. 15 minutes) to pass.
  4. Trigger reservation expiry cron:
     ```typescript
     await CronService.expireAbandonedCheckoutReservations();
     ```
- **Expected Result:**
  - `payment_checkout_sessions.status` transitions from `"reserved"` to `"cancelled"`.
  - `getReservedQuantity()` no longer counts the session's items.
  - Unreserved stock is immediately returned to shelf availability for other tills.
  - Sessions with pending or completed payments are safely skipped and NOT cancelled.

---

## 3. Summary of API Endpoints for M-Pesa Operations

| Endpoint | Method | Role | Description |
| :--- | :--- | :--- | :--- |
| `/api/payments/mpesa/stk-push` | POST | Cashier / Admin | Triggers Lipa na M-Pesa STK push prompt |
| `/api/payments/mpesa/config` | GET | Cashier / Admin | Returns active Till / Paybill configuration |
| `/api/payments/mpesa/session/:checkoutSessionId` | GET | Cashier / Admin | Polls payment status for a specific till checkout session |
| `/api/payments/mpesa/:checkoutRequestId` | GET | Cashier / Admin | Polls payment status by Daraja checkout request ID |
| `/api/payments/mpesa/paybill-intent` | POST | Cashier / Admin | Pre-registers Paybill account reference for manual payment |
| `/api/webhooks/mpesa/callback` | POST | Public (Webhook) | Safaricom STK Push callback destination |
| `/api/webhooks/mpesa/c2b/validation` | POST | Public (Webhook) | Safaricom C2B validation hook |
| `/api/webhooks/mpesa/c2b/confirmation` | POST | Public (Webhook) | Safaricom C2B confirmation hook |
| `/api/admin/mpesa/unresolved` | GET | Admin | Lists transactions flagged as `needs_review` or pending |
| `/api/admin/mpesa/:id/resolve` | POST | Admin | Manually marks a flagged transaction as completed or failed |
