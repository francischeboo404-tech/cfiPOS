import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Sale, SaleStatus, PaymentMethod, EtimsStatus } from "../entity/Sale";
import { InvoiceStatus } from "../entity/Invoice";
import { SaleItem } from "../entity/SaleItem";
import { Product } from "../entity/Product";
import { Setting } from "../entity/Setting";
import { CustomerVoucher } from "../entity/CustomerVoucher";
import { User } from "../entity/User";
import { Customer } from "../entity/Customer";
import { Warehouse } from "../entity/Warehouse";
import { WarehouseStock } from "../entity/WarehouseStock";
import { ProductBatch } from "../entity/ProductBatch";
import { CreditNote } from "../entity/CreditNote";
import { StoreCredit, StoreCreditStatus } from "../entity/StoreCredit";
import { AccountingService } from "../services/AccountingService";
import { InventoryService } from "../services/InventoryService";
import { EtimsService } from "../services/etims/EtimsService";
import { getEtimsItemMappingSnapshot } from "../services/etims/EtimsItemMapping";
import { SocketService } from "../services/SocketService";
import { MpesaTransaction } from "../entity/MpesaTransaction";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { VoucherService } from "../services/VoucherService";
import { calculateEarnedPoints, calculateRedemptionCents } from "../lib/voucherRules";
import { Shift, ShiftStatus } from "../entity/Shift";
import { getReservedQuantity } from "../services/CheckoutReservationService";
import { PromotionPricingService, PricedPromotionSegment } from "../services/PromotionPricingService";
import { PromotionAuditEvent } from "../entity/PromotionAuditEvent";
import { PromotionItem } from "../entity/PromotionItem";
import { SalePostingService } from "../services/SalePostingService";
import { assertSaleDiscountAuthorized } from "../lib/saleDiscountRules";
import { In, IsNull } from "typeorm";
import {
    allocateDiscountCents,
    allocateQuantityShare,
    calculateInclusiveVatCents,
    centsToKesString,
    divideRoundHalfUp,
    parseKesToCents,
    percentageToBasisPoints,
} from "../lib/exactMoney";

const saleRepository = AppDataSource.getRepository(Sale);
const saleItemRepository = AppDataSource.getRepository(SaleItem);
const productRepository = AppDataSource.getRepository(Product);

const SALE_ALLOWED_PAYMENT_METHODS = new Set(Object.values(PaymentMethod));
const BLOCKED_BATCH_QUALITY_STATUSES = new Set(["pending", "rejected", "failed", "hold", "on_hold"]);

const isBatchBlockedForSale = (batch: ProductBatch): boolean => {
    const status = (batch.quality_check_status ?? "").toLowerCase().trim();
    return status.length > 0 && BLOCKED_BATCH_QUALITY_STATUSES.has(status);
};

export interface SanitizedSaleItemPayload {
    product_id: string;
    quantity: number;
}

export interface SanitizedSalePayload {
    items: SanitizedSaleItemPayload[];
    payment_method?: PaymentMethod;
    customer_id?: string;
    warehouse_id?: string;
    loyalty_discount?: number;
    voucher_number?: string;
    voucher_points_redeemed?: number;
    idempotency_key?: string;
    cash_amount?: number;
    mpesa_amount?: number;
    store_credit_amount?: number;
    store_credit_barcode?: string;
    mpesa_transaction_ids?: string[];
    checkout_session_id?: string;
    expected_total_amount?: number;
    offline_created_at?: Date;
}

export const calculateCashChange = (
    cashAmount: number,
    mpesaAmount: number,
    storeCreditAmount: number,
    totalAmount: number,
) => {
    const cashCents = parseKesToCents(String(cashAmount));
    const paidCents = cashCents + parseKesToCents(String(mpesaAmount)) +
        parseKesToCents(String(storeCreditAmount));
    const totalCents = parseKesToCents(String(totalAmount));
    const changeCents = paidCents > totalCents ? paidCents - totalCents : 0n;
    return Number(centsToKesString(cashCents < changeCents ? cashCents : changeCents));
};

export const calculateSaleItemCogsCents = (
    item: Pick<SaleItem, "cogs_total_cents" | "cogs_total" | "unit_cost" | "quantity">,
    productUnitCost: number | null | undefined,
): bigint => {
    if (item.cogs_total_cents !== null && item.cogs_total_cents !== undefined) {
        return BigInt(item.cogs_total_cents);
    }
    if (item.cogs_total !== null && item.cogs_total !== undefined) {
        return parseKesToCents(String(item.cogs_total));
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
        throw new Error("Sale item quantity must be a positive whole number");
    }
    const unitCostCents = parseKesToCents(String(item.unit_cost ?? productUnitCost ?? 0));
    return unitCostCents * BigInt(item.quantity);
};

export const deriveSalePaymentMethod = (
    cashAmount: number,
    mpesaAmount: number,
    storeCreditAmount: number,
): PaymentMethod => {
    const tenderMethods = [
        cashAmount > 0 ? PaymentMethod.CASH : null,
        mpesaAmount > 0 ? PaymentMethod.MPESA : null,
        storeCreditAmount > 0 ? PaymentMethod.STORE_CREDIT : null,
    ].filter((method): method is PaymentMethod => method !== null);
    if (tenderMethods.length > 1) return PaymentMethod.HYBRID;
    if (tenderMethods.length === 1) return tenderMethods[0];
    throw new Error("At least one payment tender is required");
};

export const sanitizeSalePayload = (input: unknown): SanitizedSalePayload => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Sale payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        throw new Error("At least one sale item is required");
    }

    const sanitizedItems: SanitizedSaleItemPayload[] = payload.items.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Each sale item must be an object");
        }

        const itemPayload = item as Record<string, unknown>;
        const product_id = typeof itemPayload.product_id === "string" ? itemPayload.product_id.trim() : "";
        const quantity = Number(itemPayload.quantity);

        if (!product_id) throw new Error("Each sale item requires a product_id");
        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
            throw new Error("Each sale item quantity must be a positive safe whole number");
        }

        return { product_id, quantity };
    });

    const sanitized: SanitizedSalePayload = { items: sanitizedItems };

    if (payload.payment_method !== undefined) {
        const payment_method = typeof payload.payment_method === "string" ? payload.payment_method.trim().toLowerCase() : "";
        if (!SALE_ALLOWED_PAYMENT_METHODS.has(payment_method as PaymentMethod)) {
            throw new Error("payment_method is invalid");
        }
        sanitized.payment_method = payment_method as PaymentMethod;
    }

    [
        ["customer_id", payload.customer_id],
        ["warehouse_id", payload.warehouse_id],
        ["store_credit_barcode", payload.store_credit_barcode],
        ["voucher_number", payload.voucher_number],
    ].forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (typeof value !== "string") throw new Error(`${key} must be a string`);
        const trimmed = value.trim();
        if (!trimmed) return;
        sanitized[key as keyof SanitizedSalePayload] = trimmed as never;
    });

    if (sanitized.voucher_number && !/^\d{10}$/.test(sanitized.voucher_number)) {
        throw new Error("voucher_number must contain exactly 10 digits");
    }
    if (payload.voucher_points_redeemed !== undefined) {
        const points = Number(payload.voucher_points_redeemed);
        if (!Number.isSafeInteger(points) || points < 0) {
            throw new Error("voucher_points_redeemed must be a non-negative whole number");
        }
        sanitized.voucher_points_redeemed = points;
    }
    if ((sanitized.voucher_points_redeemed || 0) > 0 && !sanitized.voucher_number) {
        throw new Error("A voucher number is required to redeem voucher points");
    }

    [
        ["loyalty_discount", payload.loyalty_discount],
        ["cash_amount", payload.cash_amount],
        ["mpesa_amount", payload.mpesa_amount],
        ["store_credit_amount", payload.store_credit_amount],
    ].forEach(([key, value]) => {
        if (value === undefined) return;
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric < 0) {
            throw new Error(`${key} must be a non-negative number`);
        }
        sanitized[key as keyof SanitizedSalePayload] = numeric as never;
    });

    if (payload.idempotency_key !== undefined) {
        const idempotency_key = typeof payload.idempotency_key === "string" ? payload.idempotency_key.trim() : "";
        if (!idempotency_key) throw new Error("idempotency_key is required when provided");
        if (idempotency_key.length > 200) throw new Error("idempotency_key must be 200 characters or less");
        sanitized.idempotency_key = idempotency_key;
    }

    if (payload.mpesa_transaction_ids !== undefined) {
        if (!Array.isArray(payload.mpesa_transaction_ids) ||
            payload.mpesa_transaction_ids.length === 0 ||
            payload.mpesa_transaction_ids.length > 10 ||
            payload.mpesa_transaction_ids.some((id) => typeof id !== "string" || !id.trim())) {
            throw new Error("mpesa_transaction_ids must contain 1 to 10 transaction IDs");
        }
        const ids = payload.mpesa_transaction_ids.map((id) => (id as string).trim());
        if (new Set(ids).size !== ids.length) throw new Error("M-Pesa transaction IDs must be unique");
        sanitized.mpesa_transaction_ids = ids;
    }

    if (payload.checkout_session_id !== undefined) {
        const checkout_session_id = typeof payload.checkout_session_id === "string" ? payload.checkout_session_id.trim() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkout_session_id)) {
            throw new Error("checkout_session_id must be a valid UUID");
        }
        sanitized.checkout_session_id = checkout_session_id;
    }

    if (payload.expected_total_amount !== undefined) {
        const expectedTotal = Number(payload.expected_total_amount);
        if (!Number.isFinite(expectedTotal) || expectedTotal <= 0) {
            throw new Error("expected_total_amount must be a positive number");
        }
        sanitized.expected_total_amount = expectedTotal;
    }

    if (payload.offline_created_at !== undefined) {
        if (typeof payload.offline_created_at !== "string") {
            throw new Error("offline_created_at must be a valid ISO date");
        }
        const offlineCreatedAt = new Date(payload.offline_created_at);
        if (!Number.isFinite(offlineCreatedAt.getTime())) {
            throw new Error("offline_created_at must be a valid ISO date");
        }
        sanitized.offline_created_at = offlineCreatedAt;
    }

    if (
        (sanitized.offline_created_at && sanitized.expected_total_amount === undefined) ||
        (!sanitized.offline_created_at && sanitized.expected_total_amount !== undefined)
    ) {
        throw new Error("Offline sale metadata must include both offline_created_at and expected_total_amount");
    }
    if (sanitized.offline_created_at && !sanitized.idempotency_key) {
        throw new Error("Offline sales require an idempotency_key");
    }

    return sanitized;
};

export const sanitizeVoidSalePayload = (input: unknown): { reason: string } => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Void sale payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    if (payload.reason !== undefined && typeof payload.reason !== "string") {
        throw new Error("reason must be a string");
    }

    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (reason.length > 500) {
        throw new Error("reason must be 500 characters or less");
    }

    return { reason: reason || "Customer Return/Void" };
};

export interface SanitizedParkedSalePayload {
    items: SanitizedSaleItemPayload[];
    customer_id?: string;
    warehouse_id?: string;
    loyalty_discount?: number;
}

export const sanitizeParkedSalePayload = (input: unknown): SanitizedParkedSalePayload => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Parked sale payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        throw new Error("At least one parked sale item is required");
    }

    const sanitizedItems: SanitizedSaleItemPayload[] = payload.items.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Each parked sale item must be an object");
        }

        const itemPayload = item as Record<string, unknown>;
        const product_id = typeof itemPayload.product_id === "string" ? itemPayload.product_id.trim() : "";
        const quantity = Number(itemPayload.quantity);

        if (!product_id) throw new Error("Each parked sale item requires a product_id");
        if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new Error("Each parked sale item quantity must be a positive whole number");
        }

        return { product_id, quantity };
    });

    const sanitized: SanitizedParkedSalePayload = { items: sanitizedItems };

    ["customer_id", "warehouse_id"].forEach((key) => {
        const value = payload[key];
        if (value === undefined || value === null) return;
        if (typeof value !== "string") throw new Error(`${key} must be a string`);
        const trimmed = value.trim();
        if (!trimmed) return;
        sanitized[key as keyof SanitizedParkedSalePayload] = trimmed as never;
    });

    if (payload.loyalty_discount !== undefined) {
        const loyaltyDiscount = Number(payload.loyalty_discount);
        if (!Number.isFinite(loyaltyDiscount) || loyaltyDiscount < 0) {
            throw new Error("loyalty_discount must be a non-negative number");
        }
        sanitized.loyalty_discount = loyaltyDiscount;
    }

    return sanitized;
};

export class SalesController {
    static async getAllSales(req: AuthenticatedRequest, res: Response) {
        try {
            const etimsStatus = typeof req.query.etims_status === "string" ? req.query.etims_status.trim().toLowerCase() : undefined;
            const whereClause: Record<string, unknown> = {};
            if (etimsStatus && etimsStatus !== "all") {
                whereClause.etims_status = etimsStatus;
            }
            if (req.user?.role === "cashier") {
                whereClause.cashier = { id: req.user.id };
            }
            const sales = await saleRepository.find({
                where: Object.keys(whereClause).length > 0 ? whereClause : undefined,
                relations: ["items", "items.product", "cashier", "customer"],
                order: { created_at: "DESC" },
                take: 100,
            });
            res.json(sales);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching sales" });
        }
    }

    static async getSaleById(req: Request, res: Response) {
        try {
            const sale = await saleRepository.findOne({
                where: { id: req.params.id as string },
                relations: ["items", "items.product", "cashier", "cashier.profile", "customer"],
            });
            if (!sale) return res.status(404).json({ message: "Sale not found" });

            const mpesaTransaction = await AppDataSource.getRepository(MpesaTransaction).findOne({
                where: { sale_id: sale.id, status: "completed" },
                order: { created_at: "DESC" },
            });
            const voucher = sale.voucher_id
                ? await AppDataSource.getRepository(CustomerVoucher).findOneBy({ id: sale.voucher_id })
                : null;
            res.json({
                sale: {
                    ...sale,
                    voucher_number: voucher?.voucher_number ?? null,
                },
                mpesaTransaction,
            });
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching sale" });
        }
    }

    static async getStoreCreditBalance(req: Request, res: Response) {
        try {
            const barcode = typeof req.params.barcode === "string"
                ? req.params.barcode.trim()
                : "";
            if (!barcode || barcode.length > 20) {
                return res.status(400).json({ message: "A valid store credit barcode is required" });
            }

            const storeCredit = await AppDataSource.getRepository(StoreCredit).findOne({
                where: { barcode, status: StoreCreditStatus.ACTIVE },
            });
            if (!storeCredit ||
                (storeCredit.expires_at && storeCredit.expires_at <= new Date()) ||
                Number(storeCredit.current_balance) <= 0) {
                return res.status(404).json({
                    message: "Store credit barcode is invalid, expired, inactive, or has no balance",
                });
            }

            return res.json({
                barcode: storeCredit.barcode,
                current_balance: Number(storeCredit.current_balance),
            });
        } catch (error) {
            console.error("Error checking store credit barcode:", error);
            return res.status(500).json({ message: "Unable to check store credit balance" });
        }
    }

    static async createSale(req: AuthenticatedRequest, res: Response) {
        // Run as a database transaction
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const {
                items,
                payment_method,
                customer_id,
                warehouse_id,
                loyalty_discount,
                voucher_number,
                voucher_points_redeemed = 0,
                idempotency_key,
                cash_amount,
                mpesa_amount,
                store_credit_amount,
                store_credit_barcode,
                mpesa_transaction_ids,
                checkout_session_id,
                expected_total_amount,
                offline_created_at,
            } = sanitizeSalePayload(req.body);
            assertSaleDiscountAuthorized(req.user?.role, loyalty_discount || 0);

            const normalizedIdempotencyKey = typeof idempotency_key === "string"
                ? idempotency_key.trim()
                : "";
            const cashier = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            if (!cashier) throw new Error("Cashier not found");
            assertSaleDiscountAuthorized(req.user?.role, loyalty_discount || 0);

            if (normalizedIdempotencyKey) {
                await queryRunner.query(
                    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
                    [cashier.id, normalizedIdempotencyKey],
                );
                const existingSale = await queryRunner.manager.findOne(Sale, {
                    where: {
                        cashier: { id: cashier.id },
                        idempotency_key: normalizedIdempotencyKey,
                    },
                    relations: ["items", "items.product", "customer", "warehouse"],
                });
                if (existingSale) {
                    const requestedItems = items
                        .map((item) => `${item.product_id}:${item.quantity}`)
                        .sort();
                    const existingItems = (existingSale.items || [])
                        .map((item) => `${item.product?.id}:${item.quantity}`)
                        .sort();
                    const amountInCents = (value: unknown) =>
                        parseKesToCents(String(value ?? 0));
                    const requestedPaymentMethod =
                        (amountInCents(cash_amount) > 0 || amountInCents(mpesa_amount) > 0 || amountInCents(store_credit_amount) > 0)
                            ? deriveSalePaymentMethod(cash_amount || 0, mpesa_amount || 0, store_credit_amount || 0)
                            : (payment_method || existingSale.payment_method);
                    const sameSaleRequest =
                        JSON.stringify(requestedItems) === JSON.stringify(existingItems) &&
                        existingSale.payment_method === requestedPaymentMethod &&
                        amountInCents(existingSale.cash_amount) === amountInCents(cash_amount) &&
                        amountInCents(existingSale.mpesa_amount) === amountInCents(mpesa_amount) &&
                        amountInCents(existingSale.store_credit_amount) === amountInCents(store_credit_amount) &&
                        amountInCents(existingSale.total_amount) === amountInCents(expected_total_amount ?? existingSale.total_amount) &&
                        amountInCents(existingSale.loyalty_discount) === amountInCents(loyalty_discount) &&
                        (existingSale.offline_created_at?.toISOString() || null) === (offline_created_at?.toISOString() || null) &&
                        (existingSale.customer?.id || null) === (customer_id || null) &&
                        (existingSale.warehouse?.id || null) === (warehouse_id || null) &&
                        (existingSale.voucher_points_redeemed || "0") === String(voucher_points_redeemed) &&
                        (existingSale.store_credit_barcode || null) === (store_credit_barcode || null);
                    if (!sameSaleRequest) {
                        await queryRunner.rollbackTransaction();
                        return res.status(409).json({
                            message: "Idempotency key was already used for a different sale",
                        });
                    }

                    const existingTransactions = await queryRunner.manager.find(MpesaTransaction, {
                        where: { sale_id: existingSale.id },
                    });
                    const requestedTransactionIds = [...(mpesa_transaction_ids || [])].sort();
                    const existingTransactionIds = existingTransactions
                        .map((transaction) => transaction.id)
                        .sort();
                    if (JSON.stringify(requestedTransactionIds) !== JSON.stringify(existingTransactionIds) ||
                        (checkout_session_id &&
                            existingTransactions.some((transaction) =>
                                transaction.checkout_session_id !== checkout_session_id))) {
                        await queryRunner.rollbackTransaction();
                        return res.status(409).json({
                            message: "Idempotency key was already used for a different sale",
                        });
                    }

                    await queryRunner.commitTransaction();
                    return res.status(200).json({ message: "Sale already processed", sale: existingSale });
                }
            }

            // Enforce open shift
            const openShift = await queryRunner.manager.findOne(Shift, {
                where: { cashier_id: cashier.id, status: ShiftStatus.OPEN },
                lock: { mode: "pessimistic_write" },
            });
            if (!openShift) {
                throw new Error("You must open a shift before processing a sale.");
            }

            let checkoutSession: PaymentCheckoutSession | null = null;
            if (checkout_session_id) {
                checkoutSession = await queryRunner.manager.findOne(PaymentCheckoutSession, {
                    where: { id: checkout_session_id, cashier_id: cashier.id, status: "reserved" },
                    lock: { mode: "pessimistic_write" },
                });
                if (!checkoutSession) throw new Error("Reserved checkout session was not found or is no longer active");
                const itemsMatch = checkoutSession.items.length === items.length &&
                    checkoutSession.items.every((reservedItem) =>
                        items.some((item) => item.product_id === reservedItem.product_id &&
                            item.quantity === reservedItem.quantity));
                if (!itemsMatch || checkoutSession.warehouse_id !== (warehouse_id || null) ||
                    checkoutSession.customer_id !== (customer_id || null) ||
                    checkoutSession.store_credit_barcode !== (store_credit_barcode || null) ||
                    checkoutSession.voucher_number !== (voucher_number || null) ||
                    BigInt(checkoutSession.voucher_points_redeemed || "0") !== BigInt(voucher_points_redeemed) ||
                    parseKesToCents(String(checkoutSession.loyalty_discount || 0)) !==
                        parseKesToCents(String(loyalty_discount || 0))) {
                    throw new Error("Sale details do not match the reserved checkout session");
                }
            }

            const productIds = Array.from(new Set(items.map((item) => item.product_id))).sort();
            for (const productId of productIds) {
                const lockedProduct = await queryRunner.manager.findOne(Product, {
                    where: { id: productId },
                    lock: { mode: "pessimistic_write" },
                });
                if (!lockedProduct) throw new Error(`Product with id ${productId} not found`);
            }
            const reservedSessions = await queryRunner.manager.find(PaymentCheckoutSession, {
                where: { status: "reserved" },
            });
            const checkoutItems = new Map(checkoutSession?.items.map((item) => [item.product_id, item]) || []);
            const negativeStockSetting = await queryRunner.manager.findOneBy(Setting, {
                key: "allow_negative_stock",
            });
            const allowNegativeStock = negativeStockSetting?.value === "true";

            let customer = null;
            if (customer_id) {
                customer = await queryRunner.manager.findOne(Customer, {
                    where: { id: customer_id },
                    lock: { mode: "pessimistic_write" },
                });
                if (!customer) throw new Error("Customer not found");
            }

            let voucher: CustomerVoucher | null = null;
            if (voucher_number) {
                voucher = await queryRunner.manager.findOne(CustomerVoucher, {
                    where: { voucher_number },
                    relations: ["customer"],
                    lock: { mode: "pessimistic_write" },
                });
                if (!voucher) throw new Error("Voucher not found");
                if (customer && customer.id !== voucher.customer.id) {
                    throw new Error("Voucher does not belong to the selected customer");
                }
                customer = voucher.customer;
                if (voucher_points_redeemed > 0 &&
                    VoucherService.voucherState(voucher).expired) {
                    throw new Error("Voucher is expired; renew it before redeeming points");
                }
            } else if (voucher_points_redeemed > 0) {
                throw new Error("A voucher number is required to redeem points");
            }

            let warehouse = null;
            if (warehouse_id) {
                warehouse = await queryRunner.manager.findOne(Warehouse, {
                    where: { id: warehouse_id, is_active: true },
                });
                if (!warehouse) throw new Error("Warehouse not found or inactive");
            }

            let calculatedSubtotal = 0;
            let calculatedTaxAmount = 0;
            let calculatedTotalCogs = 0;
            let calculatedTotalCogsCents = 0n;
            const saleItems: SaleItem[] = [];
            const batchDeductionLog: { saleItem: SaleItem; batch: ProductBatch; deducted: number }[] = [];
            const lineGrossCents: bigint[] = [];
            const promotionUsage = new Map<string, {
                item: PromotionItem;
                quantity: number;
                lossOverride: {
                    reason: string;
                    promoPriceCents: bigint;
                    costCents: bigint;
                } | null;
            }>();
            
            // Queue for socket updates after successful transaction
            const inventoryUpdates: { productId: string; newStockLevel: number; warehouseId: string | null }[] = [];
            const inventoryMovementInputs: Array<{
                productId: string;
                quantityBefore: number;
                quantityChange: number;
                locationId: string | null;
                unitCost: number;
                valueChangeCents: bigint;
                allowNegativeBalance?: boolean;
                negativeStockOverride?: boolean;
            }> = [];

            for (const item of items) {
                const product = await queryRunner.manager.findOne(Product, { 
                    where: { id: item.product_id },
                    relations: ["tax_class"]
                });
                if (!product) {
                    throw new Error(`Product with id ${item.product_id} not found`);
                }

                // Check and decrement branch-specific stock if warehouse provided
                let movementQuantityBefore = Number(product.stock_on_hand);
                let branchStockAfter: number | null = null;
                const reservedGlobal = getReservedQuantity(reservedSessions, product.id, checkout_session_id);
                let negativeStockOverride = false;
                const globalQuantity = Number(product.stock_on_hand);
                if (!warehouse_id) {
                    if (globalQuantity - reservedGlobal < item.quantity &&
                        (globalQuantity >= item.quantity || reservedGlobal > 0 || !allowNegativeStock)) {
                        throw new Error(`Insufficient unreserved global stock for product ${product.name}`);
                    }
                    if (globalQuantity < item.quantity) negativeStockOverride = true;
                }
                if (warehouse_id) {
                    const branchStock = await queryRunner.manager.findOne(WarehouseStock, {
                        where: { warehouse_id, product_id: item.product_id },
                        lock: { mode: "pessimistic_write" },
                    });
                    const reservedBranch = getReservedQuantity(reservedSessions, product.id, checkout_session_id, warehouse_id);
                    const branchQuantity = Number(branchStock?.stock_on_hand || 0);
                    if (branchQuantity - reservedBranch < item.quantity &&
                        (branchQuantity >= item.quantity || reservedBranch > 0 || !allowNegativeStock)) {
                        throw new Error(`Insufficient unreserved branch stock for product ${product.name}`);
                    }
                    if (branchQuantity < item.quantity) negativeStockOverride = true;
                    movementQuantityBefore = branchQuantity;
                } else {
                    product.stock_on_hand -= item.quantity;
                    await queryRunner.manager.save(product);
                }

                const checkoutItem = checkoutItems.get(product.id);
                const taxRate = checkoutItem
                    ? Number(checkoutItem.tax_rate)
                    : product.tax_class ? Number(product.tax_class.rate) : Number(product.tax_rate) || 0;
                const pricedSegments: PricedPromotionSegment[] = checkoutItem?.price_segments
                    ? checkoutItem.price_segments.map((segment) => ({
                        quantity: segment.quantity,
                        unitPriceCents: parseKesToCents(segment.unit_price),
                        originalUnitPriceCents: parseKesToCents(segment.original_unit_price),
                        discountPerUnitCents: BigInt(segment.discount_per_unit_cents),
                        promotionApplied: Boolean(segment.promotion_item_id),
                        promotionId: segment.promotion_id,
                        promotionItemId: segment.promotion_item_id,
                        promotionName: segment.promotion_name,
                        lossOverrideReason: segment.loss_override_reason || null,
                    }))
                    : await PromotionPricingService.priceProduct(
                        queryRunner.manager,
                        product,
                        item.quantity,
                        reservedSessions,
                        { excludeSessionId: checkout_session_id, lock: true },
                    );
                if (pricedSegments.reduce((sum, segment) => sum + segment.quantity, 0) !== item.quantity) {
                    throw new Error(`Promotion pricing for ${product.name} does not match the sale quantity`);
                }
                const segmentSaleItems: SaleItem[] = pricedSegments.map((segment) => {
                    const grossCents = segment.unitPriceCents * BigInt(segment.quantity);
                    const saleItem = new SaleItem();
                    saleItem.product = product;
                    saleItem.etims_item_snapshot = getEtimsItemMappingSnapshot(product);
                    saleItem.quantity = segment.quantity;
                    saleItem.unit_price = Number(centsToKesString(segment.unitPriceCents));
                    saleItem.tax_rate = taxRate;
                    saleItem.line_total = Number(centsToKesString(grossCents));
                    saleItem.line_total_cents = String(grossCents);
                    saleItem.promotion_id = segment.promotionId;
                    saleItem.promotion_item_id = segment.promotionItemId;
                    saleItem.promotion_name = segment.promotionName;
                    saleItem.original_unit_price_cents = segment.promotionApplied
                        ? String(segment.originalUnitPriceCents)
                        : null;
                    saleItem.promotion_discount_per_unit_cents = segment.promotionApplied
                        ? String(segment.discountPerUnitCents)
                        : null;
                    saleItem.promotion_quantity = segment.promotionApplied ? segment.quantity : null;
                    saleItems.push(saleItem);
                    lineGrossCents.push(grossCents);
                    return saleItem;
                });

                // Setup FEFO Batch Deduction
                let qtyToDeduct = item.quantity;
                const batchSegmentQuantities = pricedSegments.map((segment) => segment.quantity);
                const batches = await queryRunner.manager.find(ProductBatch, {
                    where: { product_id: product.id },
                    order: {
                        expiry_date: "ASC",
                        created_at: "ASC"
                    }
                });
                const saleableBatches = batches.filter((batch) => !isBatchBlockedForSale(batch));
                const blockedBatchQuantity = batches
                    .filter((batch) => isBatchBlockedForSale(batch))
                    .reduce((sum, batch) => sum + Math.max(0, Number(batch.current_quantity) || 0), 0);
                const approvedBatchQuantity = saleableBatches.reduce((sum, batch) => sum + Math.max(0, Number(batch.current_quantity) || 0), 0);

                if (blockedBatchQuantity > 0 && approvedBatchQuantity < item.quantity) {
                    throw new Error(`Product ${product.name} has pending or rejected QC stock and cannot be sold until cleared.`);
                }

                for (const batch of saleableBatches) {
                    if (qtyToDeduct <= 0) break;
                    if (batch.current_quantity > 0) {
                        const deductAmount = Math.min(batch.current_quantity, qtyToDeduct);
                        batch.current_quantity -= deductAmount;
                        qtyToDeduct -= deductAmount;
                        await queryRunner.manager.save(batch);
                        let remainingBatchQuantity = deductAmount;
                        for (let index = 0; index < segmentSaleItems.length && remainingBatchQuantity > 0; index += 1) {
                            const segmentQuantity = Math.min(
                                batchSegmentQuantities[index],
                                remainingBatchQuantity,
                            );
                            if (segmentQuantity === 0) continue;
                            batchSegmentQuantities[index] -= segmentQuantity;
                            remainingBatchQuantity -= segmentQuantity;
                            batchDeductionLog.push({
                                saleItem: segmentSaleItems[index],
                                batch,
                                deducted: segmentQuantity,
                            });
                        }
                    }
                }
                let cogsCents: bigint;
                let costBasisCents: bigint;
                let costBasisQuantity: number;
                if (warehouse_id) {
                    const allocation = await InventoryService.consumeValuedStock(
                        queryRunner.manager,
                        warehouse_id,
                        product.id,
                        item.quantity,
                        allowNegativeStock,
                    );
                    cogsCents = allocation.cogsCents;
                    costBasisCents = allocation.costBasisCents;
                    costBasisQuantity = allocation.quantityBefore;
                    branchStockAfter = allocation.quantityAfter;
                    movementQuantityBefore = allocation.quantityBefore;
                    product.stock_on_hand -= item.quantity;
                } else {
                    if (product.unit_cost === null || product.unit_cost === undefined) {
                        throw new Error(`Cost data is unavailable for product ${product.name}; sale cannot be valued accurately`);
                    }
                    const unitCostCents = parseKesToCents(String(product.unit_cost));
                    cogsCents = unitCostCents * BigInt(item.quantity);
                    costBasisCents = unitCostCents;
                    costBasisQuantity = 1;
                }
                const unitCostCents = divideRoundHalfUp(cogsCents, BigInt(item.quantity));
                const unitCostKes = Number(centsToKesString(unitCostCents));
                let allocatedQuantity = 0;
                for (let index = 0; index < segmentSaleItems.length; index += 1) {
                    const saleItem = segmentSaleItems[index];
                    const segmentCogsCents = allocateQuantityShare(
                        cogsCents,
                        item.quantity,
                        allocatedQuantity,
                        saleItem.quantity,
                    );
                    allocatedQuantity += saleItem.quantity;
                    const segmentUnitCostCents = divideRoundHalfUp(
                        segmentCogsCents,
                        BigInt(saleItem.quantity),
                    );
                    saleItem.unit_cost = Number(centsToKesString(segmentUnitCostCents));
                    saleItem.unit_cost_cents = String(segmentUnitCostCents);
                    saleItem.unit_cost_basis_cents = String(costBasisCents);
                    saleItem.unit_cost_basis_quantity = String(costBasisQuantity);
                    saleItem.cogs_total_cents = String(segmentCogsCents);
                    saleItem.cogs_total = Number(centsToKesString(segmentCogsCents));
                    const pricedSegment = pricedSegments[index];
                    if (pricedSegment.promotionApplied) {
                        const promotionItemId = pricedSegment.promotionItemId;
                        const promotionId = pricedSegment.promotionId;
                        if (!promotionItemId || !promotionId) {
                            throw new Error("Promotion pricing snapshot is incomplete");
                        }
                        let usage = promotionUsage.get(promotionItemId);
                        if (!usage) {
                            const promotionItem = await queryRunner.manager.findOne(PromotionItem, {
                                where: { id: promotionItemId },
                                relations: ["promotion", "product"],
                                lock: { mode: "pessimistic_write" },
                            });
                            if (!promotionItem || promotionItem.promotion.id !== promotionId) {
                                throw new Error("Reserved promotion no longer exists; refresh checkout pricing");
                            }
                            usage = { item: promotionItem, quantity: 0, lossOverride: null };
                            promotionUsage.set(promotionItem.id, usage);
                        }
                        if (pricedSegment.unitPriceCents < unitCostCents) {
                            const overrideReason = pricedSegment.lossOverrideReason ||
                                usage.item.loss_override_reason;
                            if (!overrideReason) {
                                throw new Error(`${product.name} promotion is below weighted-average cost and requires an audited manager reason`);
                            }
                            usage.lossOverride = {
                                reason: overrideReason,
                                promoPriceCents: pricedSegment.unitPriceCents,
                                costCents: unitCostCents,
                            };
                        }
                        usage.quantity += saleItem.quantity;
                    }
                }
                calculatedTotalCogsCents += cogsCents;
                calculatedTotalCogs = Number(centsToKesString(calculatedTotalCogsCents));
                inventoryMovementInputs.push({
                    productId: product.id,
                    quantityBefore: movementQuantityBefore,
                    quantityChange: -item.quantity,
                    locationId: warehouse_id ?? null,
                    unitCost: unitCostKes,
                    valueChangeCents: -cogsCents,
                    allowNegativeBalance: negativeStockOverride,
                    negativeStockOverride,
                });

                // Push inventory update event
                inventoryUpdates.push({
                    productId: product.id,
                    newStockLevel: branchStockAfter ?? Number(product.stock_on_hand),
                    warehouseId: warehouse_id || null
                });
            }

            const grossSubtotalCents = lineGrossCents.reduce((sum, amount) => sum + amount, 0n);
            const cashierDiscount = loyalty_discount || 0;
            const cashierDiscountCents = parseKesToCents(String(cashierDiscount));
            if (cashierDiscountCents > grossSubtotalCents) {
                throw new Error("Discount exceeds the sale total");
            }
            let redeemedPoints = 0n;
            let voucherDiscountCents = 0n;
            if (voucher) {
                const balance = await VoucherService.getBalance(queryRunner.manager, voucher.id);
                redeemedPoints = BigInt(voucher_points_redeemed);
                voucherDiscountCents = calculateRedemptionCents(
                    redeemedPoints,
                    balance,
                    grossSubtotalCents - cashierDiscountCents,
                );
            }
            const appliedDiscountCents = cashierDiscountCents + voucherDiscountCents;
            const appliedDiscount = Number(centsToKesString(appliedDiscountCents));
            const lineDiscounts = allocateDiscountCents(lineGrossCents, appliedDiscountCents);
            let netRevenueCents = 0n;
            let vatCents = 0n;
            for (let index = 0; index < saleItems.length; index += 1) {
                const saleItem = saleItems[index];
                const discountedGrossCents = lineGrossCents[index] - lineDiscounts[index];
                const tax = calculateInclusiveVatCents(
                    discountedGrossCents,
                    percentageToBasisPoints(String(saleItem.tax_rate)),
                );
                saleItem.discount_cents = String(lineDiscounts[index]);
                saleItem.net_revenue_cents = String(tax.netRevenueCents);
                saleItem.vat_cents = String(tax.vatCents);
                netRevenueCents += tax.netRevenueCents;
                vatCents += tax.vatCents;
            }
            calculatedSubtotal = Number(centsToKesString(netRevenueCents));
            calculatedTaxAmount = Number(centsToKesString(vatCents));
            const subtotalWithDiscount = calculatedSubtotal;
            const calculatedTotalCents = grossSubtotalCents - appliedDiscountCents;
            const calculatedTotal = Number(centsToKesString(calculatedTotalCents));

            if (offline_created_at) {
                if (
                    payment_method !== PaymentMethod.CASH ||
                    Boolean(customer_id) ||
                    Number(loyalty_discount || 0) !== 0 ||
                    Number(mpesa_amount || 0) !== 0 ||
                    Number(store_credit_amount || 0) !== 0 ||
                    Boolean(store_credit_barcode) ||
                    Boolean(checkout_session_id) ||
                    Boolean(mpesa_transaction_ids?.length)
                ) {
                    throw new Error("Offline captures are restricted to walk-in cash sales without discounts");
                }
                if (
                    expected_total_amount === undefined ||
                    parseKesToCents(String(expected_total_amount)) !== calculatedTotalCents
                ) {
                    await queryRunner.rollbackTransaction();
                    return res.status(409).json({
                        message: "Current server price or tax differs from the provisional offline sale. Review it before recording a replacement sale.",
                    });
                }
            }

            const paymentCents = [cash_amount, mpesa_amount, store_credit_amount]
                .map((value) => parseKesToCents(String(value || 0)));
            const paymentAmounts = paymentCents.map((value) => Number(centsToKesString(value)));
            if (checkoutSession) {
                if (parseKesToCents(String(checkoutSession.cash_amount)) !== paymentCents[0] ||
                    parseKesToCents(String(checkoutSession.store_credit_amount)) !== paymentCents[2]) {
                    throw new Error("Sale payment amounts do not match the reserved checkout");
                }
                const checkoutTransactions = await queryRunner.manager.find(MpesaTransaction, {
                    where: { checkout_session_id: checkoutSession.id, cashier_id: cashier.id },
                    lock: { mode: "pessimistic_write" },
                });
                if (checkoutTransactions.some((transaction) => transaction.status === "pending")) {
                    throw new Error("An M-Pesa payment is still pending for this checkout");
                }
                const confirmedTransactionIds = checkoutTransactions
                    .filter((transaction) => transaction.status === "completed")
                    .map((transaction) => transaction.id)
                    .sort();
                const requestedTransactionIds = [...(mpesa_transaction_ids || [])].sort();
                if (confirmedTransactionIds.length !== requestedTransactionIds.length ||
                    confirmedTransactionIds.some((id, index) => id !== requestedTransactionIds[index])) {
                    throw new Error("Sale must include every confirmed M-Pesa payment for this checkout");
                }
            }
            const totalPaidCents = paymentCents.reduce((sum, value) => sum + value, 0n);
            if (totalPaidCents < calculatedTotalCents) {
                throw new Error("Payment is less than the sale total");
            }
            if (paymentCents[1] + paymentCents[2] > calculatedTotalCents) {
                throw new Error("M-Pesa and store credit cannot exceed the sale total");
            }
            if (paymentAmounts[1] > 0 && (!checkout_session_id || !mpesa_transaction_ids?.length)) {
                throw new Error("M-Pesa payments require confirmed checkout transactions");
            }
            if (paymentAmounts[1] === 0 && mpesa_transaction_ids?.length) {
                throw new Error("M-Pesa transaction references were provided without an M-Pesa payment");
            }

            if (!payment_method || !Object.values(PaymentMethod).includes(payment_method)) {
                throw new Error("Invalid payment method");
            }

            let confirmedMpesaTransactions: MpesaTransaction[] = [];
            if (paymentAmounts[1] > 0) {
                confirmedMpesaTransactions = await queryRunner.manager.find(MpesaTransaction, {
                    where: {
                        id: In(mpesa_transaction_ids as string[]),
                        checkout_session_id,
                        cashier_id: cashier.id,
                        status: "completed",
                        sale_id: IsNull(),
                    },
                    lock: { mode: "pessimistic_write" },
                });
                const confirmedAmountCents = confirmedMpesaTransactions.reduce(
                    (sum, transaction) => sum + parseKesToCents(String(transaction.amount)),
                    0n,
                );
                if (confirmedMpesaTransactions.length !== mpesa_transaction_ids?.length ||
                    confirmedAmountCents !== paymentCents[1]) {
                    throw new Error("Confirmed M-Pesa transactions do not match the sale payment");
                }
            }

            const sale = new Sale();
            sale.cashier = cashier;
            sale.customer = customer;
            sale.warehouse = warehouse;
            sale.payment_method = deriveSalePaymentMethod(
                paymentAmounts[0],
                paymentAmounts[1],
                paymentAmounts[2],
            );
            sale.subtotal = calculatedSubtotal;
            sale.tax_amount = calculatedTaxAmount;
            sale.total_amount = calculatedTotal;
            sale.voucher_id = voucher?.id ?? null;
            sale.voucher_points_redeemed = String(redeemedPoints);
            sale.cash_amount = paymentAmounts[0];
            sale.mpesa_amount = paymentAmounts[1];
            sale.store_credit_amount = paymentAmounts[2];
            sale.store_credit_barcode = null;
            sale.change_amount = calculateCashChange(
                sale.cash_amount,
                sale.mpesa_amount,
                sale.store_credit_amount,
                calculatedTotal,
            );
            sale.payment_status = "paid";
            sale.loyalty_discount = appliedDiscount;
            sale.idempotency_key = normalizedIdempotencyKey || null;
            sale.offline_created_at = offline_created_at || null;
            sale.status = SaleStatus.COMPLETED;

            // Handle Store Credit deductions
            if (sale.store_credit_amount > 0) {
                if (store_credit_barcode) {
                    const sc = await queryRunner.manager.findOne(StoreCredit, {
                        where: { barcode: store_credit_barcode, status: StoreCreditStatus.ACTIVE },
                        lock: { mode: "pessimistic_write" },
                    });
                    const currentBalanceCents = sc
                        ? parseKesToCents(String(sc.current_balance))
                        : 0n;
                    if (!sc || (sc.expires_at && sc.expires_at <= new Date()) ||
                        currentBalanceCents < paymentCents[2]) {
                        throw new Error("Invalid or insufficient store credit barcode");
                    }
                    const remainingBalanceCents = currentBalanceCents - paymentCents[2];
                    sc.current_balance = Number(centsToKesString(remainingBalanceCents));
                    if (remainingBalanceCents === 0n) sc.status = StoreCreditStatus.REDEEMED;
                    await queryRunner.manager.save(sc);
                    sale.store_credit_barcode = sc.barcode;
                } else if (customer) {
                    const account = await queryRunner.manager.findOne(Customer, {
                        where: { id: customer.id },
                        lock: { mode: "pessimistic_write" },
                    });
                    if (!account || Number(account.store_credit_balance) < sale.store_credit_amount) {
                        throw new Error("Insufficient customer store credit balance");
                    }
                    account.store_credit_balance =
                        Number(account.store_credit_balance) - sale.store_credit_amount;
                    await queryRunner.manager.save(account);
                } else {
                    throw new Error("Insufficient store credit balance");
                }
            }

            // Initialize eTIMS fiscal tracking fields
            const etimsMode = EtimsService.resolveEtimsMode();
            sale.etims_status = etimsMode === "off" ? EtimsStatus.NOT_APPLICABLE : EtimsStatus.PENDING;
            sale.etims_attempts = 0;
            sale.etims_last_error = null;
            sale.etims_submitted_at = null;
            sale.etims_receipt_no = null;
            sale.etims_qr_code = null;
            sale.etims_signature = null;

            await queryRunner.manager.save(sale);

            const activePromotionSessions = await queryRunner.manager.find(PaymentCheckoutSession, {
                where: { status: "reserved" },
            });
            for (const usage of promotionUsage.values()) {
                const heldByOtherSessions = activePromotionSessions
                    .filter((session) => session.id !== checkout_session_id)
                    .reduce((total, session) => total + session.items.reduce(
                        (sessionTotal, reservedItem) => sessionTotal +
                            (reservedItem.price_segments || [])
                                .filter((segment) =>
                                    segment.promotion_item_id === usage.item.id)
                                .reduce((quantity, segment) => quantity + segment.quantity, 0),
                        0,
                    ), 0);
                const usedQtyAfterSale = usage.item.used_qty + usage.quantity;
                if (usage.item.total_quota_qty !== null &&
                    usedQtyAfterSale + heldByOtherSessions > usage.item.total_quota_qty) {
                    throw new Error("Promotion quota changed before the sale could be finalized; refresh checkout pricing");
                }
                const usedQtyBeforeSale = usage.item.used_qty;
                usage.item.used_qty = usedQtyAfterSale;
                await queryRunner.manager.save(usage.item);
                await queryRunner.manager.save(queryRunner.manager.create(PromotionAuditEvent, {
                    promotion: usage.item.promotion,
                    actor: cashier,
                    action: usage.lossOverride ? "loss_override_used" : "sale_redeemed",
                    before_state: {
                        promotion_item_id: usage.item.id,
                        used_qty: usedQtyBeforeSale,
                        total_quota_qty: usage.item.total_quota_qty,
                    },
                    after_state: {
                        promotion_item_id: usage.item.id,
                        sale_id: sale.id,
                        quantity: usage.quantity,
                        used_qty: usedQtyAfterSale,
                        total_quota_qty: usage.item.total_quota_qty,
                        ...(usage.lossOverride ? {
                            promotional_unit_price: centsToKesString(usage.lossOverride.promoPriceCents),
                            weighted_average_cost: centsToKesString(usage.lossOverride.costCents),
                        } : {}),
                    },
                    reason: usage.lossOverride?.reason || null,
                }));
            }

            if (voucher && redeemedPoints > 0n) {
                await VoucherService.append(queryRunner.manager, {
                    voucherId: voucher.id,
                    type: "redeem",
                    points: -redeemedPoints,
                    actorId: cashier.id,
                    saleId: sale.id,
                    reference: "sale redemption",
                });
            }
            if (voucher && !VoucherService.voucherState(voucher).expired) {
                const rateSetting = await queryRunner.manager.findOneBy(Setting, {
                    key: "voucher_points_per_100_kes",
                });
                const pointsPerHundredKes = BigInt(rateSetting?.value || "1");
                if (pointsPerHundredKes < 0n) throw new Error("Voucher earning rate setting is invalid");
                const earnedPoints = calculateEarnedPoints(
                    calculatedTotalCents,
                    pointsPerHundredKes,
                );
                if (earnedPoints > 0n) {
                    await VoucherService.append(queryRunner.manager, {
                        voucherId: voucher.id,
                        type: "earn",
                        points: earnedPoints,
                        actorId: cashier.id,
                        saleId: sale.id,
                        reference: "sale earn",
                    });
                }
                sale.voucher_points_earned = String(earnedPoints);
                await queryRunner.manager.save(sale);
            }
            if (voucher) {
                sale.voucher_balance_after = String(
                    await VoucherService.getBalance(queryRunner.manager, voucher.id),
                );
                sale.voucher_expiry_date = voucher.expiry_date;
                await queryRunner.manager.save(sale);
            }

            await SalePostingService.postPreparedSale(queryRunner.manager, {
                sale,
                cashier,
                customer,
                saleItems,
                batchDeductions: batchDeductionLog,
                inventoryMovements: inventoryMovementInputs,
                confirmedMpesaTransactions,
                checkoutSession,
                invoice: {
                    subtotal: calculatedSubtotal,
                    taxAmount: calculatedTaxAmount,
                    discountAmount: appliedDiscount,
                    totalAmount: calculatedTotal,
                    paidAmount: calculatedTotal,
                    balanceDue: 0,
                    status: InvoiceStatus.PAID,
                },
                accounting: {
                    totalAmount: calculatedTotal,
                    subtotal: subtotalWithDiscount,
                    taxAmount: calculatedTaxAmount,
                    totalCogs: calculatedTotalCogs,
                    cashAmount: Math.max(0, Number(sale.cash_amount) - Number(sale.change_amount)),
                    mpesaAmount: sale.mpesa_amount,
                    storeCreditAmount: sale.store_credit_amount,
                    isCash: payment_method === "cash",
                },
                shift: openShift,
            });

            await queryRunner.commitTransaction();

            let finalSale = sale;
            if (sale.etims_status === EtimsStatus.PENDING) {
                try {
                    const signed = await EtimsService.processSaleSigning(sale.id);
                    if (signed) {
                        finalSale = signed;
                    }
                } catch (err) {
                    console.error("Asynchronous eTIMS sale signing failed:", err);
                }
            }
            
            // Emit Socket events after success
            try {
                SocketService.emitNewSale(sale.id);
                for (const update of inventoryUpdates) {
                    SocketService.emitInventoryUpdated(update.productId, update.newStockLevel, update.warehouseId || undefined);
                }
            } catch (err) {
                console.error("Socket emit failed", err);
            }

            res.status(201).json(finalSale);

        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error(error);
            res.status(400).json({ message: error instanceof Error ? error.message : "Error creating sale" });
        } finally {
            await queryRunner.release();
        }
    }

    static async voidSale(req: AuthenticatedRequest, res: Response) {
        const saleId = req.params.id;
        const { reason } = sanitizeVoidSalePayload(req.body ?? {});

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const sale = await queryRunner.manager.findOne(Sale, {
                where: { id: saleId },
                relations: ["items", "items.product", "cashier", "customer", "warehouse"]
            });

            if (!sale) throw new Error("Sale not found");
            if (sale.status === SaleStatus.VOIDED) throw new Error("Sale is already voided");

            const cashier = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            if (!cashier) throw new Error("Cashier not found");

            let calculatedTotalCogs = 0;
            let calculatedTotalCogsCents = 0n;
            const inventoryUpdates: { productId: string; newStockLevel: number; warehouseId: string | null }[] = [];

            // Reverse Items
            for (const item of sale.items) {
                const product = item.product;
                
                const itemCogsCents = calculateSaleItemCogsCents(item, product.unit_cost);
                calculatedTotalCogsCents += itemCogsCents;
                calculatedTotalCogs = Number(centsToKesString(calculatedTotalCogsCents));
                let branchStockAfter: number | null = null;
                if (sale.warehouse) {
                    branchStockAfter = await InventoryService.restoreValuedStock(
                        queryRunner.manager,
                        sale.warehouse.id,
                        product.id,
                        item.quantity,
                        itemCogsCents,
                    );
                    product.stock_on_hand += item.quantity;
                    await InventoryService.recordMovement(queryRunner.manager, {
                        productId: product.id,
                        movementType: "sale_void",
                        quantityChange: item.quantity,
                        quantityBefore: branchStockAfter - item.quantity,
                        locationId: sale.warehouse.id,
                        unitCost: Number(centsToKesString(divideRoundHalfUp(itemCogsCents, BigInt(item.quantity)))),
                        valueChangeCents: itemCogsCents,
                        referenceType: "sale_void",
                        referenceId: sale.id,
                        allowNegativeBalance: branchStockAfter - item.quantity < 0 ||
                            branchStockAfter < 0,
                        createdBy: cashier.id,
                    });
                    await InventoryService.recordZeroQuantityCostAdjustment(
                        queryRunner.manager,
                        sale.warehouse.id,
                        product.id,
                        cashier.id,
                        "sale_void",
                        sale.id,
                    );
                } else {
                    const quantityBefore = Number(product.stock_on_hand);
                    product.stock_on_hand += item.quantity;
                    await InventoryService.recordMovement(queryRunner.manager, {
                        productId: product.id,
                        movementType: "sale_void",
                        quantityChange: item.quantity,
                        quantityBefore,
                        locationId: null,
                        unitCost: Number(centsToKesString(divideRoundHalfUp(itemCogsCents, BigInt(item.quantity)))),
                        valueChangeCents: itemCogsCents,
                        referenceType: "sale_void",
                        referenceId: sale.id,
                        allowNegativeBalance: quantityBefore < 0 ||
                            quantityBefore + item.quantity < 0,
                        createdBy: cashier.id,
                    });
                }
                await queryRunner.manager.save(product);

                // Revert ProductBatch (just put it back in the newest active batch)
                const batch = await queryRunner.manager.findOne(ProductBatch, {
                    where: { product_id: product.id },
                    order: { created_at: "DESC" }
                });
                if (batch) {
                    batch.current_quantity += item.quantity;
                    await queryRunner.manager.save(batch);
                }

                inventoryUpdates.push({
                    productId: product.id,
                    newStockLevel: branchStockAfter ?? Number(product.stock_on_hand),
                    warehouseId: sale.warehouse ? sale.warehouse.id : null
                });
            }

            if (sale.voucher_id) {
                const earned = BigInt(sale.voucher_points_earned || "0");
                const redeemed = BigInt(sale.voucher_points_redeemed || "0");
                if (earned > 0n) {
                    await VoucherService.append(queryRunner.manager, {
                        voucherId: sale.voucher_id,
                        type: "reversal",
                        points: -earned,
                        actorId: cashier.id,
                        saleId: sale.id,
                        reference: "sale void: earned points",
                        reason,
                    });
                }
                if (redeemed > 0n) {
                    await VoucherService.append(queryRunner.manager, {
                        voucherId: sale.voucher_id,
                        type: "reversal",
                        points: redeemed,
                        actorId: cashier.id,
                        saleId: sale.id,
                        reference: "sale void: redeemed points",
                        reason,
                    });
                }
            }
            const promotionQuantities = new Map<string, number>();
            for (const item of sale.items) {
                if (item.promotion_item_id && item.promotion_quantity) {
                    promotionQuantities.set(
                        item.promotion_item_id,
                        (promotionQuantities.get(item.promotion_item_id) || 0) + item.promotion_quantity,
                    );
                }
            }
            for (const [promotionItemId, quantity] of promotionQuantities) {
                const promotionItem = await queryRunner.manager.findOne(PromotionItem, {
                    where: { id: promotionItemId },
                    relations: ["promotion"],
                    lock: { mode: "pessimistic_write" },
                });
                if (!promotionItem || promotionItem.used_qty < quantity) {
                    throw new Error("Promotion quota cannot be restored accurately for this void");
                }
                const usedQtyBeforeVoid = promotionItem.used_qty;
                promotionItem.used_qty -= quantity;
                await queryRunner.manager.save(promotionItem);
                await queryRunner.manager.save(queryRunner.manager.create(PromotionAuditEvent, {
                    promotion: promotionItem.promotion,
                    actor: cashier,
                    action: "sale_reversed",
                    before_state: {
                        promotion_item_id: promotionItem.id,
                        used_qty: usedQtyBeforeVoid,
                    },
                    after_state: {
                        promotion_item_id: promotionItem.id,
                        sale_id: sale.id,
                        quantity_restored: quantity,
                        used_qty: promotionItem.used_qty,
                    },
                    reason,
                }));
            }
            sale.status = SaleStatus.VOIDED;
            await queryRunner.manager.save(sale);

            // Create Credit Note
            const creditNote = new CreditNote();
            creditNote.sale = sale;
            creditNote.amount = sale.total_amount;
            creditNote.reason = reason || "Customer Return/Void";
            creditNote.cashier = cashier;
            const etimsMode = EtimsService.resolveEtimsMode();
            creditNote.etims_status = etimsMode === "off" ? EtimsStatus.NOT_APPLICABLE : EtimsStatus.PENDING;
            creditNote.etims_attempts = 0;
            creditNote.etims_last_error = null;
            creditNote.etims_submitted_at = null;
            creditNote.etims_note_no = null;
            creditNote.etims_qr_code = null;
            creditNote.etims_signature = null;
            await queryRunner.manager.save(creditNote);

            const settlement = {
                cash: Math.max(0, Number(sale.cash_amount || 0) - Number(sale.change_amount || 0)),
                mpesa: Number(sale.mpesa_amount || 0),
                storeCredit: Number(sale.store_credit_amount || 0),
            };
            if (settlement.storeCredit > 0) {
                if (sale.store_credit_barcode) {
                    const storeCredit = await queryRunner.manager.findOne(StoreCredit, {
                        where: { barcode: sale.store_credit_barcode },
                        lock: { mode: "pessimistic_write" },
                    });
                    if (!storeCredit) throw new Error("Redeemed store credit voucher could not be found for restoration");
                    storeCredit.current_balance = Number(storeCredit.current_balance) + settlement.storeCredit;
                    storeCredit.status = storeCredit.expires_at && storeCredit.expires_at <= new Date()
                        ? StoreCreditStatus.EXPIRED
                        : StoreCreditStatus.ACTIVE;
                    await queryRunner.manager.save(storeCredit);
                } else if (sale.customer) {
                    const customer = await queryRunner.manager.findOne(Customer, {
                        where: { id: sale.customer.id },
                        lock: { mode: "pessimistic_write" },
                    });
                    if (!customer) throw new Error("Customer store credit balance could not be restored");
                    customer.store_credit_balance = Number(customer.store_credit_balance) + settlement.storeCredit;
                    await queryRunner.manager.save(customer);
                } else {
                    throw new Error("Redeemed store credit source is missing and cannot be safely restored");
                }
            }
            await AccountingService.recordSaleReversal(
                queryRunner.manager,
                sale.id,
                sale.total_amount,
                sale.subtotal,
                sale.tax_amount,
                calculatedTotalCogs,
                settlement
            );

            await queryRunner.commitTransaction();

            let finalCreditNote = creditNote;
            if (creditNote.etims_status === EtimsStatus.PENDING) {
                try {
                    const signed = await EtimsService.processCreditNoteSigning(creditNote.id);
                    if (signed) {
                        finalCreditNote = signed;
                    }
                } catch (err) {
                    console.error("Asynchronous eTIMS void credit note signing failed:", err);
                }
            }

            try {
                for (const update of inventoryUpdates) {
                    SocketService.emitInventoryUpdated(update.productId, update.newStockLevel, update.warehouseId || undefined);
                }
            } catch (err) {
                console.error("Socket emit failed", err);
            }

            res.status(200).json({ message: "Sale voided successfully", creditNote: finalCreditNote });

        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error(error);
            res.status(400).json({ message: error instanceof Error ? error.message : "Error voiding sale" });
        } finally {
            await queryRunner.release();
        }
    }

    static async parkSale(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        try {
            const { items, customer_id, warehouse_id, loyalty_discount = 0 } =
                sanitizeParkedSalePayload(req.body ?? {});
            await queryRunner.connect();
            await queryRunner.startTransaction();

            const cashier = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            if (!cashier) throw new Error("Cashier not found");

            const customer = customer_id
                ? await queryRunner.manager.findOneBy(Customer, { id: customer_id })
                : null;
            if (customer_id && !customer) throw new Error("Customer not found");

            const warehouse = warehouse_id
                ? await queryRunner.manager.findOne(Warehouse, {
                    where: { id: warehouse_id, is_active: true },
                })
                : null;
            if (warehouse_id && !warehouse) throw new Error("Warehouse not found or inactive");

            const products = await queryRunner.manager.find(Product, {
                where: { id: In(items.map((item) => item.product_id)) },
                relations: ["tax_class"],
            });
            const productsById = new Map(products.map((product) => [product.id, product]));
            const missingProduct = items.find((item) => !productsById.has(item.product_id));
            if (missingProduct) throw new Error(`Product ${missingProduct.product_id} not found`);

            const lineGrossCents = items.map((item) => {
                const product = productsById.get(item.product_id)!;
                return parseKesToCents(String(product.retail_price)) * BigInt(item.quantity);
            });
            const grossSubtotalCents = lineGrossCents.reduce((sum, amount) => sum + amount, 0n);
            const discountCents = parseKesToCents(String(loyalty_discount || 0));
            if (discountCents > grossSubtotalCents) {
                throw new Error("Loyalty discount cannot exceed the parked sale subtotal");
            }
            const lineDiscountCents = allocateDiscountCents(lineGrossCents, discountCents);
            let netSubtotalCents = 0n;
            let taxTotalCents = 0n;
            const saleItems: SaleItem[] = items.map((item, index): SaleItem => {
                const product = productsById.get(item.product_id)!;
                const unitPriceCents = parseKesToCents(String(product.retail_price));
                const unitPrice = Number(centsToKesString(unitPriceCents));
                const taxRate = product.tax_class
                    ? Number(product.tax_class.rate)
                    : Number(product.tax_rate) || 0;
                const lineTax = calculateInclusiveVatCents(
                    lineGrossCents[index] - lineDiscountCents[index],
                    percentageToBasisPoints(String(taxRate)),
                );
                netSubtotalCents += lineTax.netRevenueCents;
                taxTotalCents += lineTax.vatCents;
                const lineTotal = Number(centsToKesString(lineGrossCents[index]));
                return queryRunner.manager.create(SaleItem, {
                    product,
                    quantity: item.quantity,
                    unit_price: unitPrice,
                    unit_cost: Number(product.unit_cost || 0),
                    tax_rate: taxRate,
                    line_total: lineTotal,
                    line_total_cents: String(lineGrossCents[index]),
                    discount_cents: String(lineDiscountCents[index]),
                    net_revenue_cents: String(lineTax.netRevenueCents),
                    vat_cents: String(lineTax.vatCents),
                });
            });
            const subtotal = Number(centsToKesString(netSubtotalCents));
            const taxAmount = Number(centsToKesString(taxTotalCents));
            const totalAmount = Number(centsToKesString(grossSubtotalCents - discountCents));
            const sale: Sale = queryRunner.manager.create(Sale, {
                cashier,
                customer,
                warehouse,
                payment_method: PaymentMethod.CASH,
                subtotal,
                tax_amount: taxAmount,
                total_amount: totalAmount,
                loyalty_discount: Number(centsToKesString(discountCents)),
                status: SaleStatus.PARKED,
            });
            const savedSale: Sale = await queryRunner.manager.save(sale);
            saleItems.forEach((item) => {
                item.sale = savedSale;
            });
            const savedItems: SaleItem[] = await queryRunner.manager.save(saleItems);
            await queryRunner.commitTransaction();

            res.status(201).json({
                ...savedSale,
                warehouse,
                items: savedItems,
            });
        } catch (error) {
            if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
            console.error(error);
            res.status(400).json({ message: error instanceof Error ? error.message : "Error parking sale" });
        } finally {
            await queryRunner.release();
        }
    }

    static async getParkedSales(req: AuthenticatedRequest, res: Response) {
        try {
            const isManagerial = ["supervisor", "manager", "admin"].includes(req.user?.role || "");
            const whereClause = isManagerial
                ? { status: SaleStatus.PARKED }
                : { status: SaleStatus.PARKED, cashier: { id: req.user!.id } };
            const sales = await saleRepository.find({
                where: whereClause,
                relations: ["items", "items.product", "customer", "warehouse"]
            });
            res.json(sales);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching parked sales" });
        }
    }
}
