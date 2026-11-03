import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Sale } from "../entity/Sale";
import { MpesaTransaction } from "../entity/MpesaTransaction";
import { Setting } from "../entity/Setting";
import { AccountingService } from "../services/AccountingService";
import { verifyPesapalSignature } from "../lib/pesapal";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Product } from "../entity/Product";
import { WarehouseStock } from "../entity/WarehouseStock";
import { ProductBatch } from "../entity/ProductBatch";
import { Shift, ShiftStatus } from "../entity/Shift";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { centsToKesString, parseKesToCents } from "../lib/exactMoney";

interface MpesaCallbackMetadataItem {
    Name?: string;
    Value?: unknown;
}

interface MpesaStkCallback {
    CheckoutRequestID?: unknown;
    MerchantRequestID?: unknown;
    ResultCode?: unknown;
    ResultDesc?: unknown;
    CallbackMetadata?: { Item?: MpesaCallbackMetadataItem[] };
}

export const hashMpesaCallbackToken = (token: string) =>
    createHash("sha256").update(token).digest("hex");

export const verifyMpesaCallbackToken = (token: string, expectedHash: string | null | undefined) => {
    if (!/^[a-f0-9]{64}$/i.test(expectedHash || "")) return false;
    const actualHash = Buffer.from(hashMpesaCallbackToken(token), "hex");
    const storedHash = Buffer.from(expectedHash as string, "hex");
    return timingSafeEqual(actualHash, storedHash);
};

export const verifyMpesaC2bCallbackToken = (token: string, expectedToken: string | undefined) => {
    if (!/^[a-f0-9]{64,128}$/i.test(expectedToken || "") || !token) return false;
    const actualHash = createHash("sha256").update(token).digest();
    const expectedHash = createHash("sha256").update(expectedToken as string).digest();
    return timingSafeEqual(actualHash, expectedHash);
};

export const getMpesaStkConfigurationIssues = (
    environment: NodeJS.ProcessEnv,
    shortcode: string | null | undefined,
    callbackUrlSetting?: string | null,
    accountType?: string | null,
) => {
    const issues: string[] = [];
    const normalizedShortcode = shortcode?.trim() || "";
    const normalizedAccountType = accountType?.trim().toLowerCase() || "till";
    if (normalizedAccountType !== "till" && normalizedAccountType !== "paybill") {
        issues.push("a valid Till or Paybill STK account type in Settings (mpesa_stk_account_type)");
    }
    if (!/^\d{5,7}$/.test(normalizedShortcode)) {
        issues.push("a valid 5 to 7 digit Till Number / Paybill Number in Settings");
    }

    const requiredEnvironment: Array<[string, string]> = [
        ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_KEY (server environment)"],
        ["MPESA_CONSUMER_SECRET", "MPESA_CONSUMER_SECRET (server environment)"],
        ["MPESA_PASSKEY", "MPESA_PASSKEY (server environment)"],
        ["MPESA_API_BASE_URL", "MPESA_API_BASE_URL (server environment)"],
    ];
    for (const [key, label] of requiredEnvironment) {
        if (!environment[key]?.trim()) issues.push(label);
    }

    const apiBaseUrl = environment.MPESA_API_BASE_URL?.trim() || "";
    try {
        const parsedApiBaseUrl = new URL(apiBaseUrl);
        if (parsedApiBaseUrl.protocol !== "https:" || parsedApiBaseUrl.username || parsedApiBaseUrl.password) {
            issues.push("MPESA_API_BASE_URL must be a valid HTTPS URL");
        }
    } catch {
        if (apiBaseUrl) issues.push("MPESA_API_BASE_URL must be a valid HTTPS URL");
    }

    const callbackUrl = callbackUrlSetting?.trim() || environment.MPESA_CALLBACK_URL?.trim() || "";
    if (!callbackUrl) {
        issues.push("a public HTTPS STK callback URL in Settings or MPESA_CALLBACK_URL (server environment)");
    } else {
        try {
            const parsedCallbackUrl = new URL(callbackUrl);
            const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(parsedCallbackUrl.hostname);
            if (parsedCallbackUrl.protocol !== "https:" || parsedCallbackUrl.username ||
                parsedCallbackUrl.password || isLocalHost ||
                !parsedCallbackUrl.pathname.replace(/\/+$/, "").endsWith("/api/webhooks/mpesa/callback")) {
                issues.push("STK callback URL must be public HTTPS and end in /api/webhooks/mpesa/callback");
            }
        } catch {
            issues.push("STK callback URL must be a valid public HTTPS URL");
        }
    }
    return issues;
};

export const getMpesaStkTransactionType = (accountType: string | null | undefined) =>
    accountType?.trim().toLowerCase() === "paybill"
        ? "CustomerPayBillOnline"
        : "CustomerBuyGoodsOnline";

const normalizeMpesaPhone = (value: unknown) => {
    const phone = String(value ?? "").replace(/\D/g, "").replace(/^0/, "254");
    return /^254(?:1|7)\d{8}$/.test(phone) ? phone : null;
};

const getStkCallbackResultCode = (input: unknown): number | null => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const body = (input as Record<string, unknown>).Body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const stkCallback = (body as Record<string, unknown>).stkCallback;
    if (!stkCallback || typeof stkCallback !== "object" || Array.isArray(stkCallback)) return null;
    const resultCode = Number((stkCallback as Record<string, unknown>).ResultCode);
    return Number.isInteger(resultCode) ? resultCode : null;
};

const makeC2bCallbackUrls = () => {
    const baseValue = process.env.MPESA_C2B_CALLBACK_BASE_URL;
    const token = process.env.MPESA_C2B_CALLBACK_TOKEN;
    if (!baseValue || typeof token !== "string" || !/^[a-f0-9]{64,128}$/i.test(token)) {
        throw new Error("M-Pesa C2B callback URL and token are not configured");
    }
    const base = new URL(baseValue);
    if (base.protocol !== "https:" || base.username || base.password ||
        ["localhost", "127.0.0.1", "::1"].includes(base.hostname)) {
        throw new Error("M-Pesa C2B callback base URL must be a public HTTPS URL");
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    const validationUrl = new URL(`${basePath}/api/webhooks/mpesa/c2b/validation`, base.origin);
    const confirmationUrl = new URL(`${basePath}/api/webhooks/mpesa/c2b/confirmation`, base.origin);
    validationUrl.searchParams.set("callback_token", token);
    confirmationUrl.searchParams.set("callback_token", token);
    return { validationUrl: validationUrl.toString(), confirmationUrl: confirmationUrl.toString() };
};

export const parseC2bCallback = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const payload = input as Record<string, unknown>;
    const transactionCode = typeof payload.TransID === "string" ? payload.TransID.trim() : "";
    const accountReference = typeof payload.BillRefNumber === "string"
        ? payload.BillRefNumber.trim().toUpperCase()
        : "";
    const shortcode = String(payload.BusinessShortCode ?? "").replace(/\D/g, "");
    const amountCents = callbackMoneyCents(payload.TransAmount);
    if (amountCents === null) return null;
    const phoneNumber = normalizeMpesaPhone(payload.MSISDN);
    if (!/^[A-Za-z0-9]{1,32}$/.test(transactionCode) ||
        !/^[A-Z0-9]{8,20}$/.test(accountReference) ||
        !/^\d{5,7}$/.test(shortcode) ||
        amountCents <= 0n ||
        !phoneNumber) {
        return null;
    }
    return {
        transactionCode,
        accountReference,
        shortcode,
        amountCents,
        phoneNumber,
    };
};

const paymentAmountCents = (value: unknown, field: string): bigint => {
    if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`${field} must be a non-negative KES amount with at most two decimal places`);
    }
    try {
        return parseKesToCents(String(value));
    } catch {
        throw new Error(`${field} must be a non-negative KES amount with at most two decimal places`);
    }
};

const callbackMoneyCents = (value: unknown): bigint | null => {
    if (typeof value !== "string" && typeof value !== "number") return null;
    try {
        return parseKesToCents(String(value));
    } catch {
        return null;
    }
};

export const sanitizeMpesaStkPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("M-Pesa STK payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const phone_number = typeof payload.phone_number === "string" ? payload.phone_number.trim().replace(/\s+/g, "") : "";
    const checkout_session_id = typeof payload.checkout_session_id === "string" ? payload.checkout_session_id.trim() : "";
    const amountInput = typeof payload.amount === "string" || typeof payload.amount === "number"
        ? String(payload.amount).trim()
        : "";
    const loyaltyDiscountCents = paymentAmountCents(payload.loyalty_discount ?? "0", "loyalty_discount");
    const cashAmountCents = paymentAmountCents(payload.cash_amount ?? "0", "cash_amount");
    const storeCreditAmountCents = paymentAmountCents(payload.store_credit_amount ?? "0", "store_credit_amount");
    if (payload.warehouse_id !== undefined && payload.warehouse_id !== null && typeof payload.warehouse_id !== "string") {
        throw new Error("warehouse_id must be a string");
    }
    const warehouse_id = typeof payload.warehouse_id === "string" ? payload.warehouse_id.trim() : "";
    const store_credit_barcode = typeof payload.store_credit_barcode === "string"
        ? payload.store_credit_barcode.trim()
        : "";
    const account_reference = typeof payload.account_reference === "string" ? payload.account_reference.trim() : "";
    const items = Array.isArray(payload.items) ? payload.items : [];

    if (!/^254(?:1|7)\d{8}$/.test(phone_number.replace(/^0/, "254").replace(/^\+/, ""))) {
        throw new Error("phone_number is invalid");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkout_session_id)) {
        throw new Error("checkout_session_id must be a valid UUID");
    }
    if (!/^\d+$/.test(amountInput) || !Number.isSafeInteger(Number(amountInput)) || Number(amountInput) <= 0) {
        throw new Error("amount must be a positive whole number of shillings");
    }
    if (items.length > 100) throw new Error("items cannot contain more than 100 products");
    const sanitizedItems = items.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each item must be an object");
        const itemPayload = item as Record<string, unknown>;
        const product_id = typeof itemPayload.product_id === "string" ? itemPayload.product_id.trim() : "";
        const quantity = Number(itemPayload.quantity);
        if (!product_id || !Number.isInteger(quantity) || quantity <= 0) {
            throw new Error("Each item requires a product_id and positive whole-number quantity");
        }
        return { product_id, quantity };
    });
    if (account_reference && account_reference.length > 80) throw new Error("account_reference is too long");
    if (store_credit_barcode.length > 20) throw new Error("store_credit_barcode is too long");

    return {
        phone_number: phone_number.replace(/^0/, "254").replace(/^\+/, ""),
        amount: Number(amountInput),
        checkout_session_id,
        items: sanitizedItems,
        loyaltyDiscountCents,
        cashAmountCents,
        storeCreditAmountCents,
        ...(store_credit_barcode ? { store_credit_barcode } : {}),
        warehouse_id: warehouse_id || undefined,
        account_reference: account_reference || undefined,
    };
};

export class PaymentController {
    static async initiateMpesaStk(req: AuthenticatedRequest, res: Response) {
        let transaction: MpesaTransaction | null = null;
        let stkRequestStarted = false;
        try {
            const {
                phone_number,
                amount,
                checkout_session_id,
                items,
                loyaltyDiscountCents,
                cashAmountCents,
                storeCreditAmountCents,
                store_credit_barcode,
                warehouse_id,
                account_reference,
            } = sanitizeMpesaStkPayload(req.body ?? {});
            const parsedAmount = amount;
            if (!req.user?.id) return res.status(401).json({ error: "Authenticated cashier is required" });
            const openShift = await AppDataSource.getRepository(Shift).findOneBy({
                cashier_id: req.user!.id,
                status: ShiftStatus.OPEN,
            });
            if (!openShift) return res.status(400).json({ error: "Open a shift before requesting an M-Pesa payment" });
            const checkoutSession = await AppDataSource.getRepository(PaymentCheckoutSession).findOneBy({
                id: checkout_session_id,
                cashier_id: req.user!.id,
                status: "reserved",
            });
            if (!checkoutSession) return res.status(409).json({ error: "Reserve stock for this checkout before requesting M-Pesa" });
            const sameItems = checkoutSession.items.length === items.length &&
                checkoutSession.items.every((reservedItem) =>
                    items.some((item) => item.product_id === reservedItem.product_id &&
                        item.quantity === reservedItem.quantity));
            if ((checkoutSession.purpose === "voucher_renewal" &&
                    (items.length !== 0 || loyaltyDiscountCents !== 0n || storeCreditAmountCents !== 0n ||
                        store_credit_barcode || warehouse_id)) ||
                (checkoutSession.purpose === "sale" && items.length === 0)) {
                return res.status(400).json({ error: "M-Pesa request does not match the checkout type" });
            }
            if (!sameItems || parseKesToCents(String(checkoutSession.loyalty_discount)) !== loyaltyDiscountCents ||
                checkoutSession.warehouse_id !== (warehouse_id || null) ||
                parseKesToCents(String(checkoutSession.cash_amount)) !== cashAmountCents ||
                parseKesToCents(String(checkoutSession.store_credit_amount)) !== storeCreditAmountCents ||
                checkoutSession.store_credit_barcode !== (store_credit_barcode || null)) {
                return res.status(400).json({ error: "M-Pesa request details do not match the reserved checkout" });
            }
            const formattedPhone = String(phone_number || "").replace(/\s+/g, "").replace(/^0/, "254").replace(/^\+/, "");
            if (!/^254(?:1|7)\d{8}$/.test(formattedPhone)) {
                return res.status(400).json({ error: "Valid Kenyan phone number is required" });
            }

            const productRepository = AppDataSource.getRepository(Product);
            let subtotalCents = 0n;
            for (const item of items) {
                const product = await productRepository.findOne({
                    where: { id: item.product_id },
                    relations: ["tax_class"],
                });
                if (!product) return res.status(400).json({ error: "One or more sale products no longer exist" });
                if (warehouse_id) {
                    const branchStock = await AppDataSource.getRepository(WarehouseStock).findOneBy({
                        warehouse_id,
                        product_id: product.id,
                    });
                    if (!branchStock || Number(branchStock.stock_on_hand) < item.quantity) {
                        return res.status(400).json({ error: `${product.name} no longer has enough stock at this branch` });
                    }
                } else if (Number(product.stock_on_hand) < item.quantity) {
                    return res.status(400).json({ error: `${product.name} is out of stock` });
                }
                const batches = await AppDataSource.getRepository(ProductBatch).find({
                    where: { product_id: product.id },
                });
                const blockedStatuses = new Set(["pending", "rejected", "failed", "hold", "on_hold"]);
                const blockedQuantity = batches
                    .filter((batch) => blockedStatuses.has((batch.quality_check_status ?? "").toLowerCase().trim()))
                    .reduce((sum, batch) => sum + Math.max(0, Number(batch.current_quantity) || 0), 0);
                const approvedQuantity = batches
                    .filter((batch) => !blockedStatuses.has((batch.quality_check_status ?? "").toLowerCase().trim()))
                    .reduce((sum, batch) => sum + Math.max(0, Number(batch.current_quantity) || 0), 0);
                if (blockedQuantity > 0 && approvedQuantity < item.quantity) {
                    return res.status(400).json({ error: `${product.name} has stock pending a quality check` });
                }
                const checkoutItem = checkoutSession.items.find((reservedItem) => reservedItem.product_id === product.id);
                if (!checkoutItem) {
                    return res.status(400).json({ error: "Checkout item no longer matches the reserved sale" });
                }
                const segmentGrossCents = checkoutItem.price_segments?.length
                    ? checkoutItem.price_segments.reduce(
                        (sum, segment) =>
                            sum + parseKesToCents(segment.unit_price) * BigInt(segment.quantity),
                        0n,
                    )
                    : parseKesToCents(String(checkoutItem.unit_price)) * BigInt(item.quantity);
                subtotalCents += segmentGrossCents;
            }
            if (loyaltyDiscountCents > subtotalCents) {
                return res.status(400).json({ error: "Discount exceeds sale subtotal" });
            }

            const settingRepository = AppDataSource.getRepository(Setting);
            const [
                shortcodeSetting,
                legacyTillSetting,
                callbackSetting,
                paybillSetting,
                accountTypeSetting,
            ] = await Promise.all([
                settingRepository.findOneBy({ key: "mpesa_shortcode" }),
                settingRepository.findOneBy({ key: "mpesa_till_number" }),
                settingRepository.findOneBy({ key: "mpesa_callback_url" }),
                settingRepository.findOneBy({ key: "mpesa_paybill" }),
                settingRepository.findOneBy({ key: "mpesa_stk_account_type" }),
            ]);
            const stkAccountType = accountTypeSetting?.value?.trim().toLowerCase() === "paybill"
                ? "paybill"
                : "till";
            const shortcode = stkAccountType === "paybill"
                ? paybillSetting?.value?.trim() || ""
                : shortcodeSetting?.value?.trim() || legacyTillSetting?.value?.trim() || "";
            const callbackUrl = callbackSetting?.value?.trim() || process.env.MPESA_CALLBACK_URL?.trim() || "";
            const configurationIssues = getMpesaStkConfigurationIssues(
                process.env,
                shortcode,
                callbackUrl,
                stkAccountType,
            );
            if (configurationIssues.length > 0) {
                return res.status(503).json({
                    error: `M-Pesa STK Push is not configured: ${configurationIssues.join("; ")}.`,
                    configuration_issues: configurationIssues,
                });
            }

            const consumerKey = process.env.MPESA_CONSUMER_KEY?.trim() || "";
            const consumerSecret = process.env.MPESA_CONSUMER_SECRET?.trim() || "";
            const passkey = process.env.MPESA_PASSKEY?.trim() || "";
            const apiBaseUrl = process.env.MPESA_API_BASE_URL?.trim().replace(/\/+$/, "") || "";
            const callbackUrlWithToken = new URL(callbackUrl);
            const callbackToken = randomBytes(32).toString("hex");
            callbackUrlWithToken.searchParams.set("callback_token", callbackToken);

            const reservationResult = await AppDataSource.transaction(async (manager) => {
                const shift = await manager.findOne(Shift, {
                    where: { cashier_id: req.user!.id, status: ShiftStatus.OPEN },
                    lock: { mode: "pessimistic_write" },
                });
                if (!shift) {
                    return { ok: false as const, error: "Open a shift before requesting an M-Pesa payment", status: 409 };
                }
                const lockedSession = await manager.findOne(PaymentCheckoutSession, {
                    where: { id: checkout_session_id, cashier_id: req.user!.id, status: "reserved" },
                    lock: { mode: "pessimistic_write" },
                });
                if (!lockedSession) {
                    return { ok: false as const, error: "Checkout is no longer active", status: 409 };
                }
                if (parseKesToCents(String(lockedSession.cash_amount)) !== cashAmountCents ||
                    parseKesToCents(String(lockedSession.store_credit_amount)) !== storeCreditAmountCents ||
                    lockedSession.store_credit_barcode !== (store_credit_barcode || null)) {
                    return { ok: false as const, error: "Payment amounts do not match the reserved checkout", status: 400 };
                }
                const existingTransactions = await manager.find(MpesaTransaction, {
                    where: { checkout_session_id, cashier_id: req.user!.id },
                });
                if (existingTransactions.some((item) => item.status === "pending")) {
                    return { ok: false as const, error: "An M-Pesa request is already pending for this checkout", status: 409 };
                }
                if (lockedSession.purpose === "voucher_renewal" &&
                    existingTransactions.some((item) => item.status === "needs_review")) {
                    return {
                        ok: false as const,
                        error: "An M-Pesa payment is under review; an administrator must resolve it before another request",
                        status: 409,
                    };
                }
                const paidMpesaCents = existingTransactions
                    .filter((item) => item.status === "completed")
                    .reduce((sum, item) => sum + parseKesToCents(String(item.amount)), 0n);
                const remainingCents = parseKesToCents(String(lockedSession.total_amount)) -
                    parseKesToCents(String(lockedSession.cash_amount)) -
                    parseKesToCents(String(lockedSession.store_credit_amount)) -
                    paidMpesaCents;
                const maximumPushCents = remainingCents / 100n * 100n;
                if (BigInt(parsedAmount) * 100n > maximumPushCents) {
                    return { ok: false as const, error: "STK amount exceeds the remaining sale balance", status: 400 };
                }
                const pendingTransaction = manager.create(MpesaTransaction, {
                    sale_id: null,
                    cashier_id: req.user!.id,
                    checkout_session_id,
                    phone_number: formattedPhone,
                    amount: parsedAmount,
                    transaction_code: `STK_${randomUUID()}`,
                    status: "pending",
                    callback_token_hash: hashMpesaCallbackToken(callbackToken),
                });
                return { ok: true as const, transaction: await manager.save(pendingTransaction) };
            });
            if (!reservationResult.ok) {
                return res.status(reservationResult.status).json({ error: reservationResult.error });
            }
            transaction = reservationResult.transaction;

            const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
            const tokenResponse = await fetch(`${apiBaseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
                headers: { Authorization: `Basic ${auth}` },
            });
            if (!tokenResponse.ok) {
                transaction.status = "failed";
                transaction.result_desc = "Failed to authenticate with M-Pesa";
                await AppDataSource.getRepository(MpesaTransaction).save(transaction);
                return res.status(502).json({ error: "Failed to authenticate with M-Pesa" });
            }
            const tokenData = await tokenResponse.json() as { access_token?: string };
            if (!tokenData.access_token) {
                transaction.status = "failed";
                transaction.result_desc = "M-Pesa authentication token missing";
                await AppDataSource.getRepository(MpesaTransaction).save(transaction);
                return res.status(502).json({ error: "M-Pesa authentication token missing" });
            }

            const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
            const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
            stkRequestStarted = true;
            const stkResponse = await fetch(`${apiBaseUrl}/mpesa/stkpush/v1/processrequest`, {
                method: "POST",
                headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    BusinessShortCode: shortcode,
                    Password: password,
                    Timestamp: timestamp,
                    TransactionType: getMpesaStkTransactionType(stkAccountType),
                    Amount: parsedAmount,
                    PartyA: formattedPhone,
                    PartyB: shortcode,
                    PhoneNumber: formattedPhone,
                    CallBackURL: callbackUrlWithToken.toString(),
                    AccountReference: account_reference || `POS-${checkout_session_id.slice(0, 8)}`,
                    TransactionDesc: `POS checkout ${checkout_session_id.slice(0, 8)}`,
                }),
            });
            const stkData = await stkResponse.json() as {
                ResponseCode?: string;
                errorMessage?: string;
                ResponseDescription?: string;
                CheckoutRequestID?: string;
                MerchantRequestID?: string;
            };
            if (stkData.ResponseCode !== "0") {
                transaction.status = "failed";
                transaction.result_desc = stkData.errorMessage || stkData.ResponseDescription || "STK Push failed";
                await AppDataSource.getRepository(MpesaTransaction).save(transaction);
                return res.status(400).json({ error: stkData.errorMessage || stkData.ResponseDescription || "STK Push failed" });
            }
            if (!stkData.CheckoutRequestID || !stkData.MerchantRequestID) {
                console.error("M-Pesa accepted request but returned no request identifiers:", transaction.transaction_code);
                return res.status(202).json({ success: true, pending: true, checkout_session_id });
            }

            const identifierUpdate = await AppDataSource.getRepository(MpesaTransaction).update(
                { id: transaction.id },
                {
                    checkout_request_id: stkData.CheckoutRequestID,
                    merchant_request_id: stkData.MerchantRequestID,
                },
            );
            if (!identifierUpdate.affected) {
                throw new Error("M-Pesa request was accepted but its transaction record could not be updated");
            }

            res.json({ success: true, checkout_request_id: stkData.CheckoutRequestID, merchant_request_id: stkData.MerchantRequestID });
        } catch (error) {
            if (transaction && !stkRequestStarted) {
                transaction.status = "failed";
                transaction.result_desc = "M-Pesa authentication failed before an STK request was sent";
                await AppDataSource.getRepository(MpesaTransaction).save(transaction);
                return res.status(502).json({ error: transaction.result_desc });
            }
            if (transaction && !transaction.checkout_request_id) {
                console.error("M-Pesa STK outcome is uncertain; retaining pending transaction:", transaction.transaction_code);
                const driverError = (error as { driverError?: { code?: string } })?.driverError;
                if (driverError?.code !== "23505") {
                    return res.status(202).json({
                        success: true,
                        pending: true,
                        checkout_session_id: transaction.checkout_session_id,
                    });
                }
            }
            const driverError = (error as { driverError?: { code?: string } })?.driverError;
            if (driverError?.code === "23505") {
                return res.status(409).json({ error: "An STK request is already pending for this checkout" });
            }
            console.error("M-Pesa STK error:", error);
            res.status(500).json({ error: "Failed to initiate M-Pesa payment" });
        }
    }

    static async getMpesaPaymentConfig(_req: Request, res: Response) {
        try {
            const settings = AppDataSource.getRepository(Setting);
            const [
                paybill,
                registeredShortcode,
                shortcode,
                legacyTill,
                callbackUrl,
                accountType,
            ] = await Promise.all([
                settings.findOneBy({ key: "mpesa_paybill" }),
                settings.findOneBy({ key: "mpesa_c2b_registered_shortcode" }),
                settings.findOneBy({ key: "mpesa_shortcode" }),
                settings.findOneBy({ key: "mpesa_till_number" }),
                settings.findOneBy({ key: "mpesa_callback_url" }),
                settings.findOneBy({ key: "mpesa_stk_account_type" }),
            ]);
            const callbackConfigured = Boolean(
                process.env.MPESA_C2B_CALLBACK_BASE_URL &&
                /^[a-f0-9]{64,128}$/i.test(process.env.MPESA_C2B_CALLBACK_TOKEN || ""),
            );
            const stkAccountType = accountType?.value?.trim().toLowerCase() === "paybill"
                ? "paybill"
                : "till";
            const savedShortcode = stkAccountType === "paybill"
                ? paybill?.value?.trim() || ""
                : shortcode?.value?.trim() || legacyTill?.value?.trim() || "";
            const stkPushIssues = getMpesaStkConfigurationIssues(
                process.env,
                savedShortcode,
                callbackUrl?.value,
                stkAccountType,
            );
            return res.json({
                paybill_number: paybill?.value || null,
                paybill_c2b_enabled: Boolean(callbackConfigured && paybill?.value === registeredShortcode?.value),
                stk_account_type: stkAccountType,
                stk_push_enabled: stkPushIssues.length === 0,
                stk_push_issues: stkPushIssues,
            });
        } catch (error) {
            console.error("M-Pesa configuration read error:", error);
            return res.status(500).json({ message: "Failed to load M-Pesa payment options" });
        }
    }

    static async registerMpesaC2bUrls(req: AuthenticatedRequest, res: Response) {
        try {
            const repository = AppDataSource.getRepository(Setting);
            const paybill = await repository.findOneBy({ key: "mpesa_paybill" });
            if (!paybill?.value || !/^\d{5,7}$/.test(paybill.value.trim())) {
                return res.status(400).json({ message: "Configure a valid Paybill number in Settings first" });
            }
            const consumerKey = process.env.MPESA_CONSUMER_KEY;
            const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
            const apiBaseUrl = process.env.MPESA_API_BASE_URL?.replace(/\/+$/, "");
            if (!consumerKey || !consumerSecret || !apiBaseUrl) {
                return res.status(503).json({ message: "M-Pesa Daraja credentials are not configured" });
            }
            let callbackUrls: { validationUrl: string; confirmationUrl: string };
            try {
                callbackUrls = makeC2bCallbackUrls();
            } catch (error) {
                return res.status(503).json({ message: error instanceof Error ? error.message : "C2B callback configuration is invalid" });
            }

            const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
            const tokenResponse = await fetch(`${apiBaseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
                headers: { Authorization: `Basic ${auth}` },
            });
            if (!tokenResponse.ok) {
                return res.status(502).json({ message: "Could not authenticate with M-Pesa" });
            }
            const tokenData = await tokenResponse.json() as { access_token?: string };
            if (!tokenData.access_token) {
                return res.status(502).json({ message: "M-Pesa did not return an access token" });
            }

            const registrationResponse = await fetch(`${apiBaseUrl}/mpesa/c2b/v1/registerurl`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${tokenData.access_token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    ShortCode: paybill.value.trim(),
                    ResponseType: "Completed",
                    ConfirmationURL: callbackUrls.confirmationUrl,
                    ValidationURL: callbackUrls.validationUrl,
                    CommandID: "RegisterURL",
                }),
            });
            const registration = await registrationResponse.json() as {
                ResponseCode?: string;
                ResponseDescription?: string;
            };
            if (!registrationResponse.ok || registration.ResponseCode !== "0") {
                return res.status(502).json({
                    message: registration.ResponseDescription || "M-Pesa did not accept the C2B callback registration",
                });
            }

            await repository.save(repository.create({
                key: "mpesa_c2b_registered_shortcode",
                value: paybill.value.trim(),
            }));
            return res.json({ success: true, message: "Paybill C2B callback URLs registered" });
        } catch (error) {
            console.error("M-Pesa C2B registration error:", error);
            return res.status(502).json({ message: "Failed to register Paybill C2B callback URLs" });
        }
    }

    static async initiateMpesaPaybill(req: AuthenticatedRequest, res: Response) {
        try {
            if (!req.user?.id) return res.status(401).json({ message: "Authenticated cashier is required" });
            const checkoutSessionId = typeof req.body?.checkout_session_id === "string"
                ? req.body.checkout_session_id.trim()
                : "";
            const phoneNumber = normalizeMpesaPhone(req.body?.phone_number);
            const amountInput = typeof req.body?.amount === "string" || typeof req.body?.amount === "number"
                ? String(req.body.amount).trim()
                : "";
            let cashAmountCents: bigint;
            let storeCreditAmountCents: bigint;
            try {
                cashAmountCents = paymentAmountCents(req.body?.cash_amount ?? "0", "cash_amount");
                storeCreditAmountCents = paymentAmountCents(req.body?.store_credit_amount ?? "0", "store_credit_amount");
            } catch (error) {
                return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid payment amount" });
            }
            const amount = /^\d+$/.test(amountInput) ? Number(amountInput) : NaN;
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkoutSessionId)) {
                return res.status(400).json({ message: "checkout_session_id must be a valid UUID" });
            }
            if (!phoneNumber) return res.status(400).json({ message: "Valid Kenyan phone number is required" });
            if (!Number.isSafeInteger(amount) || amount <= 0) {
                return res.status(400).json({ message: "Paybill amount must be a positive whole number of shillings" });
            }

            const settingRepository = AppDataSource.getRepository(Setting);
            const [paybill, registeredShortcode] = await Promise.all([
                settingRepository.findOneBy({ key: "mpesa_paybill" }),
                settingRepository.findOneBy({ key: "mpesa_c2b_registered_shortcode" }),
            ]);
            if (!paybill?.value || paybill.value !== registeredShortcode?.value) {
                return res.status(503).json({ message: "Paybill callback URLs must be registered before accepting manual payments" });
            }
            try {
                makeC2bCallbackUrls();
            } catch {
                return res.status(503).json({ message: "Paybill callback configuration is incomplete" });
            }

            const accountReference = `POS${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
            const intentResult = await AppDataSource.transaction(async (manager) => {
                const shift = await manager.findOne(Shift, {
                    where: { cashier_id: req.user!.id, status: ShiftStatus.OPEN },
                    lock: { mode: "pessimistic_write" },
                });
                if (!shift) {
                    return { ok: false as const, error: "Open a shift before accepting an M-Pesa payment", status: 409 };
                }
                const session = await manager.findOne(PaymentCheckoutSession, {
                    where: { id: checkoutSessionId, cashier_id: req.user!.id, status: "reserved" },
                    lock: { mode: "pessimistic_write" },
                });
                if (!session) {
                    return { ok: false as const, error: "Reserve stock for this checkout before accepting payment", status: 409 };
                }
                if (parseKesToCents(String(session.cash_amount)) !== cashAmountCents ||
                    parseKesToCents(String(session.store_credit_amount)) !== storeCreditAmountCents) {
                    return { ok: false as const, error: "Payment amounts do not match the reserved checkout", status: 400 };
                }
                const transactions = await manager.find(MpesaTransaction, {
                    where: { checkout_session_id: checkoutSessionId, cashier_id: req.user!.id },
                });
                if (transactions.some((item) => item.status === "pending")) {
                    return { ok: false as const, error: "An M-Pesa payment is already pending for this checkout", status: 409 };
                }
                const paidMpesaCents = transactions
                    .filter((item) => item.status === "completed")
                    .reduce((sum, item) => sum + parseKesToCents(String(item.amount)), 0n);
                const remainingCents = parseKesToCents(String(session.total_amount)) -
                    parseKesToCents(String(session.cash_amount)) -
                    parseKesToCents(String(session.store_credit_amount)) -
                    paidMpesaCents;
                if (BigInt(amount) * 100n > remainingCents) {
                    return { ok: false as const, error: "Paybill amount exceeds the remaining sale balance", status: 400 };
                }
                const transaction = manager.create(MpesaTransaction, {
                    sale_id: null,
                    cashier_id: req.user!.id,
                    checkout_session_id: checkoutSessionId,
                    transaction_code: `C2B_${randomUUID()}`,
                    phone_number: phoneNumber,
                    amount,
                    status: "pending",
                    account_reference: accountReference,
                    callback_received: false,
                });
                return { ok: true as const, transaction: await manager.save(transaction) };
            });
            if (!intentResult.ok) {
                return res.status(intentResult.status).json({ message: intentResult.error });
            }
            const transaction = intentResult.transaction;
            return res.status(201).json({
                success: true,
                transaction_id: transaction.id,
                amount,
                paybill_number: paybill.value,
                account_reference: accountReference,
            });
        } catch (error) {
            const driverError = (error as { driverError?: { code?: string } })?.driverError;
            if (driverError?.code === "23505") {
                return res.status(409).json({ message: "An M-Pesa request is already pending for this checkout" });
            }
            console.error("Paybill intent error:", error);
            return res.status(500).json({ message: "Failed to create Paybill payment reference" });
        }
    }

    static async mpesaC2bValidation(req: Request, res: Response) {
        const callbackToken = typeof req.query.callback_token === "string"
            ? req.query.callback_token
            : typeof req.headers["x-callback-token"] === "string"
                ? req.headers["x-callback-token"]
                : "";
        if (!verifyMpesaC2bCallbackToken(callbackToken, process.env.MPESA_C2B_CALLBACK_TOKEN)) {
            console.warn(`[SECURITY ALERT] Rejected unauthorized M-Pesa C2B validation callback from IP ${req.ip}`);
            return res.status(401).json({ ResultCode: 1, ResultDesc: "Unauthorized callback" });
        }
        const callback = parseC2bCallback(req.body);
        if (!callback) return res.json({ ResultCode: 1, ResultDesc: "Invalid C2B payment details" });

        try {
            const settings = AppDataSource.getRepository(Setting);
            const [paybill, registeredShortcode] = await Promise.all([
                settings.findOneBy({ key: "mpesa_paybill" }),
                settings.findOneBy({ key: "mpesa_c2b_registered_shortcode" }),
            ]);
            const transaction = await AppDataSource.getRepository(MpesaTransaction).findOneBy({
                account_reference: callback.accountReference,
                status: "pending",
            });
            const valid = paybill?.value === registeredShortcode?.value &&
                callback.shortcode === paybill?.value &&
                transaction &&
                parseKesToCents(String(transaction.amount)) === callback.amountCents &&
                transaction.phone_number === callback.phoneNumber;
            return res.json(valid
                ? { ResultCode: 0, ResultDesc: "Accepted" }
                : { ResultCode: 1, ResultDesc: "C2B payment does not match an active checkout" });
        } catch (error) {
            console.error("M-Pesa C2B validation error:", error);
            return res.status(500).json({ ResultCode: 1, ResultDesc: "Validation failed" });
        }
    }

    static async mpesaC2bConfirmation(req: Request, res: Response) {
        const callbackToken = typeof req.query.callback_token === "string"
            ? req.query.callback_token
            : typeof req.headers["x-callback-token"] === "string"
                ? req.headers["x-callback-token"]
                : "";
        if (!verifyMpesaC2bCallbackToken(callbackToken, process.env.MPESA_C2B_CALLBACK_TOKEN)) {
            console.warn(`[SECURITY ALERT] Rejected unauthorized M-Pesa C2B confirmation callback from IP ${req.ip}`);
            return res.status(401).json({ ResultCode: 1, ResultDesc: "Unauthorized callback" });
        }
        const callback = parseC2bCallback(req.body);
        if (!callback) return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid C2B payment details" });

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            const paybill = await queryRunner.manager.findOneBy(Setting, { key: "mpesa_paybill" });
            const registeredShortcode = await queryRunner.manager.findOneBy(Setting, { key: "mpesa_c2b_registered_shortcode" });
            if (paybill?.value !== registeredShortcode?.value || callback.shortcode !== paybill?.value) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ ResultCode: 1, ResultDesc: "C2B Paybill shortcode does not match" });
            }

            const transaction = await queryRunner.manager.findOne(MpesaTransaction, {
                where: { account_reference: callback.accountReference },
                lock: { mode: "pessimistic_write" },
            });
            if (!transaction) {
                await queryRunner.rollbackTransaction();
                console.warn("Unmatched Paybill callback reference:", callback.accountReference, callback.transactionCode);
                return res.status(404).json({ ResultCode: 1, ResultDesc: "No matching checkout reference" });
            }
            if (transaction.status === "completed" &&
                transaction.mpesa_receipt_number === callback.transactionCode &&
                parseKesToCents(String(transaction.amount)) === callback.amountCents &&
                transaction.phone_number === callback.phoneNumber) {
                await queryRunner.rollbackTransaction();
                return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
            }
            if (transaction.status !== "pending" && transaction.status !== "needs_review") {
                await queryRunner.rollbackTransaction();
                console.warn("Rejected mismatched Paybill callback:", callback.accountReference, callback.transactionCode);
                return res.status(400).json({ ResultCode: 1, ResultDesc: "Payment details do not match the pending checkout" });
            }

            const duplicateReceipt = await queryRunner.manager.findOneBy(MpesaTransaction, {
                mpesa_receipt_number: callback.transactionCode,
            });
            if (duplicateReceipt && duplicateReceipt.id !== transaction.id) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ ResultCode: 1, ResultDesc: "M-Pesa receipt was already processed" });
            }

            const mismatchReasons: string[] = [];
            if (parseKesToCents(String(transaction.amount)) !== callback.amountCents) {
                mismatchReasons.push(`Amount mismatch: expected KES ${transaction.amount}, received KES ${centsToKesString(callback.amountCents)}`);
            }
            if (transaction.phone_number !== callback.phoneNumber) {
                mismatchReasons.push(`Phone mismatch: expected ${transaction.phone_number}, received ${callback.phoneNumber}`);
            }

            if (mismatchReasons.length > 0) {
                transaction.status = "needs_review";
                transaction.mismatch_reason = mismatchReasons.join("; ");
                transaction.mpesa_receipt_number = callback.transactionCode;
                transaction.result_desc = "Paybill C2B confirmed with discrepancies";
                transaction.callback_data = req.body as Record<string, unknown>;
                await queryRunner.manager.save(transaction);
                await queryRunner.commitTransaction();
                console.warn(`[MPESA C2B MISMATCH] Transaction ${transaction.transaction_code} flagged as needs_review: ${transaction.mismatch_reason}`);
                return res.status(400).json({ ResultCode: 1, ResultDesc: "Payment details do not match the pending checkout" });
            }

            transaction.status = "completed";
            transaction.mismatch_reason = null;
            transaction.mpesa_receipt_number = callback.transactionCode;
            transaction.phone_number = callback.phoneNumber;
            transaction.callback_received = true;
            transaction.result_desc = "Paybill C2B callback confirmed";
            transaction.callback_data = req.body as Record<string, unknown>;
            await queryRunner.manager.save(transaction);
            await queryRunner.commitTransaction();
            return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            const driverError = (error as { driverError?: { code?: string } })?.driverError;
            if (driverError?.code === "23505") {
                return res.status(409).json({ ResultCode: 1, ResultDesc: "M-Pesa receipt was already processed" });
            }
            console.error("M-Pesa C2B confirmation error:", error);
            return res.status(500).json({ ResultCode: 1, ResultDesc: "Processing failed" });
        } finally {
            await queryRunner.release();
        }
    }

    static async mpesaCallback(req: Request, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            const callback: Record<string, unknown> = req.body;
            const callbackBody = callback.Body;
            const stkCallback = callbackBody && typeof callbackBody === "object" && !Array.isArray(callbackBody)
                ? (callbackBody as Record<string, unknown>).stkCallback as MpesaStkCallback | undefined
                : undefined;
            const checkoutRequestId = stkCallback?.CheckoutRequestID;
            const callbackToken = typeof req.query.callback_token === "string" ? req.query.callback_token : "";
            const merchantRequestId = stkCallback?.MerchantRequestID;
            if (!stkCallback || typeof checkoutRequestId !== "string" || !checkoutRequestId.trim() ||
                (merchantRequestId !== undefined &&
                    (typeof merchantRequestId !== "string" || !merchantRequestId.trim()))) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid callback" });
            }

            let transaction = await queryRunner.manager.findOne(MpesaTransaction, {
                where: { checkout_request_id: checkoutRequestId },
                lock: { mode: "pessimistic_write" },
            });
            if (!transaction && callbackToken) {
                transaction = await queryRunner.manager.findOne(MpesaTransaction, {
                    where: { callback_token_hash: hashMpesaCallbackToken(callbackToken) },
                    lock: { mode: "pessimistic_write" },
                });
            }
            if (!transaction) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ ResultCode: 1, ResultDesc: "No matching M-Pesa request" });
            }

            if (!verifyMpesaCallbackToken(callbackToken, transaction.callback_token_hash)) {
                await queryRunner.rollbackTransaction();
                console.warn(`[SECURITY ALERT] Rejected unauthorized M-Pesa STK callback from IP ${req.ip} for CheckoutRequestID: ${checkoutRequestId}`);
                return res.status(401).json({ ResultCode: 1, ResultDesc: "Unauthorized callback" });
            }

            if ((transaction.checkout_request_id && transaction.checkout_request_id !== checkoutRequestId) ||
                (transaction.merchant_request_id && merchantRequestId !== transaction.merchant_request_id)) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ ResultCode: 1, ResultDesc: "M-Pesa request identifiers do not match" });
            }
            transaction.checkout_request_id = checkoutRequestId;
            if (typeof merchantRequestId === "string") {
                transaction.merchant_request_id = merchantRequestId;
            }

            const resultCode = Number(stkCallback.ResultCode);
            if (!Number.isInteger(resultCode)) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid callback result" });
            }

            if (transaction.callback_received || transaction.status === "completed") {
                let duplicateMatches = false;
                if (transaction.status === "completed" && resultCode === 0) {
                    const metadata = stkCallback.CallbackMetadata?.Item || [];
                    const receipt = metadata.find((item) => item.Name === "MpesaReceiptNumber")?.Value;
                    const callbackAmountCents = callbackMoneyCents(metadata.find((item) => item.Name === "Amount")?.Value);
                    const callbackPhone = metadata.find((item) => item.Name === "PhoneNumber")?.Value;
                    const normalizedPhone = normalizeMpesaPhone(callbackPhone);
                    const receiptNumber = typeof receipt === "string" ? receipt.trim() : "";
                    const callbackMatches = receiptNumber.length > 0 &&
                        callbackAmountCents !== null &&
                        callbackAmountCents === parseKesToCents(String(transaction.amount)) &&
                        normalizedPhone === transaction.phone_number;
                    if (callbackMatches &&
                        (!transaction.mpesa_receipt_number || transaction.mpesa_receipt_number.startsWith("RECON_"))) {
                        const duplicateReceipt = await queryRunner.manager.findOne(MpesaTransaction, {
                            where: { mpesa_receipt_number: receiptNumber },
                        });
                        if (!duplicateReceipt || duplicateReceipt.id === transaction.id) {
                            transaction.mpesa_receipt_number = receiptNumber;
                            transaction.callback_received = true;
                            transaction.callback_data = callback;
                            transaction.result_desc = typeof stkCallback.ResultDesc === "string"
                                ? stkCallback.ResultDesc
                                : transaction.result_desc;
                            await queryRunner.manager.save(transaction);
                            await queryRunner.commitTransaction();
                            return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
                        }
                    }
                    duplicateMatches = callbackMatches && receiptNumber === transaction.mpesa_receipt_number;
                } else if (transaction.status === "failed") {
                    duplicateMatches = getStkCallbackResultCode(transaction.callback_data) === resultCode;
                }
                await queryRunner.rollbackTransaction();
                return duplicateMatches
                    ? res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" })
                    : res.status(409).json({ ResultCode: 1, ResultDesc: "Conflicting duplicate callback" });
            }

            transaction.callback_data = callback;
            transaction.result_desc = typeof stkCallback.ResultDesc === "string" ? stkCallback.ResultDesc : null;
            if (resultCode !== 0) {
                transaction.callback_received = true;
                transaction.status = "failed";
                await queryRunner.manager.save(transaction);
                await queryRunner.commitTransaction();
                return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
            }

            const metadata = stkCallback.CallbackMetadata?.Item || [];
            const receipt = metadata.find((item) => item.Name === "MpesaReceiptNumber")?.Value;
            const callbackAmount = metadata.find((item) => item.Name === "Amount")?.Value;
            const callbackPhone = metadata.find((item) => item.Name === "PhoneNumber")?.Value;
            const parsedCallbackAmountCents = callbackMoneyCents(callbackAmount);
            const normalizedCallbackPhone = normalizeMpesaPhone(callbackPhone);

            if (typeof receipt !== "string" || !receipt.trim()) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ ResultCode: 1, ResultDesc: "Callback receipt is invalid" });
            }

            const duplicateReceipt = await queryRunner.manager.findOne(MpesaTransaction, {
                where: { mpesa_receipt_number: String(receipt).trim() },
            });
            if (duplicateReceipt && duplicateReceipt.id !== transaction.id) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ ResultCode: 1, ResultDesc: "M-Pesa receipt was already processed" });
            }

            const mismatchReasons: string[] = [];
            if (parsedCallbackAmountCents === null || parsedCallbackAmountCents <= 0n ||
                parsedCallbackAmountCents % 100n !== 0n ||
                parsedCallbackAmountCents !== parseKesToCents(String(transaction.amount))) {
                mismatchReasons.push(`Amount mismatch: expected KES ${transaction.amount}, received KES ${parsedCallbackAmountCents === null ? String(callbackAmount) : centsToKesString(parsedCallbackAmountCents)}`);
            }
            if (!normalizedCallbackPhone || normalizedCallbackPhone !== transaction.phone_number) {
                mismatchReasons.push(`Phone mismatch: expected ${transaction.phone_number}, received ${normalizedCallbackPhone || callbackPhone}`);
            }

            if (mismatchReasons.length > 0) {
                transaction.status = "needs_review";
                transaction.mismatch_reason = mismatchReasons.join("; ");
                transaction.mpesa_receipt_number = receipt.trim();
                await queryRunner.manager.save(transaction);
                await queryRunner.commitTransaction();
                console.warn(`[MPESA STK MISMATCH] Transaction ${transaction.transaction_code} flagged as needs_review: ${transaction.mismatch_reason}`);
                return res.status(400).json({ ResultCode: 1, ResultDesc: "Callback amount, phone, or receipt is invalid" });
            }

            transaction.status = "completed";
            transaction.mismatch_reason = null;
            transaction.callback_received = true;
            transaction.mpesa_receipt_number = receipt.trim();
            await queryRunner.manager.save(transaction);

            if (transaction.sale_id) {
                const sale = await queryRunner.manager.findOne(Sale, {
                    where: { id: transaction.sale_id },
                    lock: { mode: "pessimistic_write" },
                });
                if (sale) {
                    const mpesaAmountCents = parseKesToCents(String(sale.mpesa_amount || 0)) +
                        parseKesToCents(String(transaction.amount));
                    const totalPaidCents = parseKesToCents(String(sale.cash_amount || 0)) +
                        mpesaAmountCents +
                        parseKesToCents(String(sale.store_credit_amount || 0));
                    const totalAmountCents = parseKesToCents(String(sale.total_amount));
                    sale.mpesa_amount = Number(centsToKesString(mpesaAmountCents));
                    sale.change_amount = Number(centsToKesString(
                        totalPaidCents > totalAmountCents ? totalPaidCents - totalAmountCents : 0n,
                    ));
                    sale.payment_status = totalPaidCents >= totalAmountCents ? "paid" : "partially_paid";
                    await queryRunner.manager.save(sale);

                    await AccountingService.recordMpesaReceivablePayment(
                        queryRunner.manager,
                        sale.id,
                        Number(transaction.amount),
                    );
                }
            }

            await queryRunner.commitTransaction();
            res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            const driverError = (error as { driverError?: { code?: string } })?.driverError;
            if (driverError?.code === "23505") {
                return res.status(409).json({ ResultCode: 1, ResultDesc: "M-Pesa receipt was already processed" });
            }
            console.error("M-Pesa callback error:", error);
            res.status(500).json({ ResultCode: 1, ResultDesc: "Processing failed" });
        } finally {
            await queryRunner.release();
        }
    }

    static async getMpesaStatus(req: AuthenticatedRequest, res: Response) {
        try {
            const transaction = await AppDataSource.getRepository(MpesaTransaction).findOne({
                where: { checkout_request_id: req.params.checkoutRequestId as string },
            });
            if (!transaction) return res.status(404).json({ message: "M-Pesa transaction not found" });

            let authorized = transaction.cashier_id === req.user?.id || req.user?.role === "admin";
            if (transaction.sale_id) {
                const sale = await AppDataSource.getRepository(Sale).findOne({
                    where: { id: transaction.sale_id },
                    relations: ["cashier"],
                });
                authorized ||= sale?.cashier?.id === req.user?.id;
            }
            if (!authorized) return res.status(403).json({ message: "Not authorized for this transaction" });

            res.json({
                id: transaction.id,
                status: transaction.status,
                amount: Number(transaction.amount),
                result_desc: transaction.result_desc,
                mismatch_reason: transaction.mismatch_reason,
                mpesa_receipt_number: transaction.mpesa_receipt_number,
                checkout_request_id: transaction.checkout_request_id,
                phone_number: transaction.phone_number,
                account_reference: transaction.account_reference,
            });
        } catch (error) {
            console.error("M-Pesa status error:", error);
            res.status(500).json({ message: "Failed to fetch M-Pesa status" });
        }
    }

    static async getMpesaSessionStatus(req: AuthenticatedRequest, res: Response) {
        try {
            const sessionId = String(req.params.checkoutSessionId || "");
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
                return res.status(400).json({ message: "Invalid checkout session" });
            }
            const transactionRepository = AppDataSource.getRepository(MpesaTransaction);
            const pendingTransaction = await transactionRepository.findOne({
                where: { checkout_session_id: sessionId, cashier_id: req.user?.id, status: "pending" },
                order: { created_at: "DESC" },
            });
            const latestTransaction = pendingTransaction || await transactionRepository.findOne({
                where: { checkout_session_id: sessionId, cashier_id: req.user?.id },
                order: { created_at: "DESC" },
            });
            if (!latestTransaction) return res.status(404).json({ message: "M-Pesa transaction not found" });

            return res.json({
                id: latestTransaction.id,
                status: latestTransaction.status,
                amount: Number(latestTransaction.amount),
                result_desc: latestTransaction.result_desc,
                mismatch_reason: latestTransaction.mismatch_reason,
                mpesa_receipt_number: latestTransaction.mpesa_receipt_number,
                checkout_request_id: latestTransaction.checkout_request_id,
                phone_number: latestTransaction.phone_number,
                account_reference: latestTransaction.account_reference,
            });
        } catch (error) {
            console.error("M-Pesa session status error:", error);
            return res.status(500).json({ message: "Failed to fetch M-Pesa session status" });
        }
    }

    static async pesapalWebhook(req: Request, res: Response) {
        const isProduction = process.env.NODE_ENV === "production";
        const isExplicitlyDisabled = process.env.ENABLE_PESAPAL_PAYMENTS === "false";
        const isExplicitlyEnabled = process.env.ENABLE_PESAPAL_PAYMENTS === "true";

        if (isExplicitlyDisabled || (isProduction && !isExplicitlyEnabled)) {
            return res.status(503).json({
                message: "Pesapal card payments are disabled on this instance. Configure ENABLE_PESAPAL_PAYMENTS=true to enable.",
            });
        }

        try {
            const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
            const payload = (
                req.body && typeof req.body === "object" && Object.keys(req.body).length > 0
                    ? req.body
                    : req.query
            ) as Record<string, unknown>;

            const orderTrackingId = typeof payload.OrderTrackingId === "string"
                ? payload.OrderTrackingId.trim()
                : typeof payload.pesapal_transaction_tracking_id === "string"
                    ? payload.pesapal_transaction_tracking_id.trim()
                    : "";
            const orderNotificationType = typeof payload.OrderNotificationType === "string"
                ? payload.OrderNotificationType.trim()
                : typeof payload.pesapal_notification_type === "string"
                    ? payload.pesapal_notification_type.trim()
                    : "";
            const orderMerchantReference = typeof payload.OrderMerchantReference === "string"
                ? payload.OrderMerchantReference.trim()
                : typeof payload.pesapal_merchant_reference === "string"
                    ? payload.pesapal_merchant_reference.trim()
                    : "";

            const signingKey = (
                req.headers["x-pesapal-signature"] ||
                req.headers["x-pesapal-ipn-signature"] ||
                req.headers["x-signature"] ||
                payload.pesapal_ipn_signature ||
                payload.signature ||
                payload.Signature ||
                req.query.pesapal_ipn_signature ||
                req.query.signature
            );

            if (!orderTrackingId || !orderNotificationType || !orderMerchantReference) {
                console.warn(`[SECURITY ALERT] Rejected Pesapal webhook from IP ${req.ip} - missing required callback fields.`);
                return res.status(400).json({ message: "Missing required Pesapal callback fields" });
            }

            const signatureString = typeof signingKey === "string" ? signingKey.trim() : "";
            if (!verifyPesapalSignature(payload, signatureString, rawBody)) {
                console.warn(`[SECURITY ALERT] Rejected unauthenticated Pesapal IPN from IP ${req.ip} for OrderTrackingId: ${orderTrackingId}`);
                return res.status(401).json({ message: "Unauthorized: Invalid or missing Pesapal IPN signature" });
            }

            if (orderNotificationType === "IPNCHANGE") {
                const queryRunner = AppDataSource.createQueryRunner();
                await queryRunner.connect();
                await queryRunner.startTransaction();
                try {
                    const saleRepo = queryRunner.manager.getRepository(Sale);
                    const sale = await saleRepo.findOne({
                        where: { pesapal_tracking_id: orderTrackingId },
                        lock: { mode: "pessimistic_write" },
                    });
                    
                    if (!sale) {
                        await queryRunner.rollbackTransaction();
                        return res.status(404).json({ message: "Sale not found for tracking id " + orderTrackingId });
                    }
                    
                    if (sale.pesapal_status === "completed") {
                        await queryRunner.rollbackTransaction();
                        return res.status(200).json({ message: "Already processed" });
                    }

                    sale.pesapal_status = "completed";
                    const pesapal_amount = sale.mpesa_amount > 0 ? sale.mpesa_amount : sale.total_amount;
                    sale.mpesa_amount = pesapal_amount;
                    
                    await queryRunner.manager.save(sale);

                    await AccountingService.recordMpesaReceivablePayment(
                        queryRunner.manager,
                        sale.id,
                        Number(pesapal_amount),
                        "PESAPAL_PAYMENT",
                    );

                    await queryRunner.commitTransaction();

                    return res.status(200).json({
                        orderNotificationType,
                        orderTrackingId,
                        orderMerchantReference,
                        status: 200
                    });

                } catch (innerError) {
                    await queryRunner.rollbackTransaction();
                    throw innerError;
                } finally {
                    await queryRunner.release();
                }
            } else {
                return res.status(200).json({ message: "Ignored notification type" });
            }
        } catch (error) {
            console.error("Error processing Pesapal webhook:", error);
            return res.status(500).json({ message: "Error processing Pesapal webhook" });
        }
    }

    static async getUnresolvedMpesaTransactions(req: AuthenticatedRequest, res: Response) {
        try {
            const statusFilter = typeof req.query.status === "string" ? req.query.status.trim() : null;
            const whereClause = statusFilter
                ? { status: statusFilter }
                : [{ status: "needs_review" }, { status: "pending" }];

            const transactions = await AppDataSource.getRepository(MpesaTransaction).find({
                where: whereClause,
                order: { created_at: "DESC" },
                take: 100,
            });

            return res.json({
                count: transactions.length,
                transactions: transactions.map((tx) => ({
                    id: tx.id,
                    transaction_code: tx.transaction_code,
                    status: tx.status,
                    amount: Number(tx.amount),
                    phone_number: tx.phone_number,
                    mpesa_receipt_number: tx.mpesa_receipt_number,
                    checkout_request_id: tx.checkout_request_id,
                    checkout_session_id: tx.checkout_session_id,
                    sale_id: tx.sale_id,
                    mismatch_reason: tx.mismatch_reason,
                    result_desc: tx.result_desc,
                    account_reference: tx.account_reference,
                    created_at: tx.created_at,
                    updated_at: tx.updated_at,
                })),
            });
        } catch (error) {
            console.error("Failed to fetch unresolved M-Pesa transactions:", error);
            return res.status(500).json({ message: "Failed to fetch unresolved M-Pesa transactions" });
        }
    }

    static async resolveMpesaTransaction(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            const transactionId = String(req.params.id || "");
            const { action, notes } = req.body || {};

            if (!["mark_completed", "mark_failed"].includes(action)) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Action must be mark_completed or mark_failed" });
            }
            const resolutionNotes = typeof notes === "string" ? notes.trim() : "";
            if (resolutionNotes.length < 5 || resolutionNotes.length > 500) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Resolution notes must include the verification source (5–500 characters)" });
            }
            const receiptNumber = typeof req.body?.receipt_number === "string"
                ? req.body.receipt_number.trim().toUpperCase()
                : "";
            if (action === "mark_completed" && !/^[A-Z0-9]{8,20}$/.test(receiptNumber)) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "A verified Safaricom receipt number is required to mark a payment completed" });
            }

            const transaction = await queryRunner.manager.findOne(MpesaTransaction, {
                where: { id: transactionId },
                lock: { mode: "pessimistic_write" },
            });

            if (!transaction) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "M-Pesa transaction not found" });
            }

            if (transaction.status !== "needs_review" && transaction.status !== "pending") {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: `Cannot resolve transaction with status ${transaction.status}` });
            }

            if (action === "mark_completed") {
                const duplicateReceipt = await queryRunner.manager.findOne(MpesaTransaction, {
                    where: { mpesa_receipt_number: receiptNumber },
                });
                if (duplicateReceipt && duplicateReceipt.id !== transaction.id) {
                    await queryRunner.rollbackTransaction();
                    return res.status(409).json({ message: "M-Pesa receipt was already recorded against another transaction" });
                }
                transaction.status = "completed";
                transaction.mpesa_receipt_number = receiptNumber;
                transaction.mismatch_reason = null;
                transaction.result_desc = `Admin resolved after provider verification: ${resolutionNotes}`;

                if (transaction.sale_id) {
                    const sale = await queryRunner.manager.findOne(Sale, {
                        where: { id: transaction.sale_id },
                        lock: { mode: "pessimistic_write" },
                    });
                    if (sale) {
                        const mpesaAmountCents = parseKesToCents(String(sale.mpesa_amount || 0)) +
                            parseKesToCents(String(transaction.amount));
                        const totalPaidCents = parseKesToCents(String(sale.cash_amount || 0)) +
                            mpesaAmountCents +
                            parseKesToCents(String(sale.store_credit_amount || 0));
                        const totalAmountCents = parseKesToCents(String(sale.total_amount));
                        sale.mpesa_amount = Number(centsToKesString(mpesaAmountCents));
                        sale.change_amount = Number(centsToKesString(
                            totalPaidCents > totalAmountCents ? totalPaidCents - totalAmountCents : 0n,
                        ));
                        sale.payment_status = totalPaidCents >= totalAmountCents ? "paid" : "partially_paid";
                        await queryRunner.manager.save(sale);

                        await AccountingService.recordMpesaReceivablePayment(
                            queryRunner.manager,
                            sale.id,
                            Number(transaction.amount),
                        );
                    }
                }
            } else {
                transaction.status = "failed";
                transaction.mismatch_reason = resolutionNotes;
                transaction.result_desc = `Admin resolved as failed after provider verification: ${resolutionNotes}`;
            }

            await queryRunner.manager.save(transaction);
            await queryRunner.commitTransaction();
            return res.json({ success: true, transaction });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error("M-Pesa transaction resolution error:", error);
            return res.status(500).json({ message: "Failed to resolve M-Pesa transaction" });
        } finally {
            await queryRunner.release();
        }
    }
}
