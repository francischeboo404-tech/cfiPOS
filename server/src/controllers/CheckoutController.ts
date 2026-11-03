import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { randomUUID } from "node:crypto";
import { AppDataSource } from "../data-source";
import { PaymentCheckoutItem, PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { Product } from "../entity/Product";
import { ProductBatch } from "../entity/ProductBatch";
import { TaxClass } from "../entity/TaxClass";
import { Shift, ShiftStatus } from "../entity/Shift";
import { WarehouseStock } from "../entity/WarehouseStock";
import { MpesaTransaction } from "../entity/MpesaTransaction";
import { getReservedQuantity } from "../services/CheckoutReservationService";
import { CustomerVoucher } from "../entity/CustomerVoucher";
import { VoucherService } from "../services/VoucherService";
import { PromotionPricingService } from "../services/PromotionPricingService";
import { calculateRedemptionCents, canCancelVoucherRenewalCheckout } from "../lib/voucherRules";
import { assertSaleDiscountAuthorized } from "../lib/saleDiscountRules";
import {
    allocateDiscountCents,
    calculateInclusiveVatCents,
    centsToKesString,
    parseKesToCents,
    percentageToBasisPoints,
} from "../lib/exactMoney";

const blockedBatchStatuses = new Set(["pending", "rejected", "failed", "hold", "on_hold"]);
const MAX_CHECKOUT_MONEY_CENTS = 9_999_999_999n;

const sanitizeCheckoutMoneyAmount = (value: unknown, field: string): number => {
    if (value === undefined || value === null || value === "") return 0;
    if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`${field} must be a non-negative KES amount with at most two decimal places`);
    }
    let amountCents: bigint;
    try {
        amountCents = parseKesToCents(String(value));
    } catch {
        throw new Error(`${field} must be a non-negative KES amount with at most two decimal places`);
    }
    if (amountCents > MAX_CHECKOUT_MONEY_CENTS) {
        throw new Error(`${field} exceeds the maximum supported checkout amount`);
    }
    return Number(centsToKesString(amountCents));
};

export const sanitizeCheckoutPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Checkout payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const id = typeof payload.checkout_session_id === "string" ? payload.checkout_session_id.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error("checkout_session_id must be a valid UUID");
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > 100) {
        throw new Error("items must contain between 1 and 100 products");
    }
    const itemQuantities = new Map<string, number>();
    payload.items.forEach((value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("Each checkout item must be an object");
        }
        const item = value as Record<string, unknown>;
        const product_id = typeof item.product_id === "string" ? item.product_id.trim() : "";
        const quantity = Number(item.quantity);
        if (!product_id || !Number.isSafeInteger(quantity) || quantity <= 0) {
            throw new Error("Each checkout item requires a product and positive safe whole-number quantity");
        }
        const combinedQuantity = (itemQuantities.get(product_id) || 0) + quantity;
        if (!Number.isSafeInteger(combinedQuantity)) {
            throw new Error("Combined checkout item quantity is too large");
        }
        itemQuantities.set(product_id, combinedQuantity);
    });
    const items = Array.from(itemQuantities, ([product_id, quantity]) => ({ product_id, quantity }));
    const optionalString = (key: string) => {
        const value = payload[key];
        if (value === undefined || value === null || value === "") return null;
        if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a valid string`);
        return value.trim();
    };
    const loyalty_discount = sanitizeCheckoutMoneyAmount(payload.loyalty_discount, "loyalty_discount");
    const cash_amount = sanitizeCheckoutMoneyAmount(payload.cash_amount, "cash_amount");
    const store_credit_amount = sanitizeCheckoutMoneyAmount(payload.store_credit_amount, "store_credit_amount");
    const store_credit_barcode = optionalString("store_credit_barcode");
    const voucher_number = optionalString("voucher_number");
    const voucher_points_redeemed = Number(payload.voucher_points_redeemed || 0);
    if (store_credit_barcode && store_credit_barcode.length > 20) {
        throw new Error("store_credit_barcode cannot exceed 20 characters");
    }
    if (voucher_number && !/^\d{10}$/.test(voucher_number)) {
        throw new Error("voucher_number must contain exactly 10 digits");
    }
    if (!Number.isSafeInteger(voucher_points_redeemed) || voucher_points_redeemed < 0 ||
        (voucher_points_redeemed > 0 && !voucher_number)) {
        throw new Error("Voucher redemption requires a valid number of whole points");
    }

    return {
        id,
        items,
        warehouse_id: optionalString("warehouse_id"),
        customer_id: optionalString("customer_id"),
        store_credit_barcode,
        voucher_number,
        voucher_points_redeemed,
        loyalty_discount,
        cash_amount,
        store_credit_amount,
    };
};

export class CheckoutController {
    static async reserve(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            if (!req.user?.id) throw new Error("Authenticated cashier is required");
            const payload = sanitizeCheckoutPayload(req.body);
            assertSaleDiscountAuthorized(req.user?.role, payload.loyalty_discount);
            const shift = await queryRunner.manager.findOneBy(Shift, {
                cashier_id: req.user!.id,
                status: ShiftStatus.OPEN,
            });
            if (!shift) throw new Error("Open a shift before reserving stock for checkout");

            const existing = await queryRunner.manager.findOne(PaymentCheckoutSession, {
                where: { id: payload.id },
                lock: { mode: "pessimistic_write" },
            });
            let existingSession: PaymentCheckoutSession | null = null;
            if (existing) {
                const sameItems = existing.items.length === payload.items.length &&
                    existing.items.every((item, index) =>
                        item.product_id === payload.items[index].product_id &&
                        item.quantity === payload.items[index].quantity);
                if (existing.cashier_id !== req.user!.id || existing.status !== "reserved" ||
                    !sameItems || existing.warehouse_id !== payload.warehouse_id ||
                    existing.customer_id !== payload.customer_id ||
                    existing.store_credit_barcode !== payload.store_credit_barcode ||
                    existing.voucher_number !== payload.voucher_number ||
                    BigInt(existing.voucher_points_redeemed || "0") !== BigInt(payload.voucher_points_redeemed) ||
                    Number(existing.loyalty_discount) !== payload.loyalty_discount ||
                    Number(existing.cash_amount) !== payload.cash_amount ||
                    Number(existing.store_credit_amount) !== payload.store_credit_amount) {
                    throw new Error("Checkout session already exists and cannot be changed");
                }
                if (existing.purpose === "voucher_renewal") {
                    await queryRunner.commitTransaction();
                    return res.json(existing);
                }
                const existingTransactions = await queryRunner.manager.find(MpesaTransaction, {
                    where: { checkout_session_id: existing.id },
                    lock: { mode: "pessimistic_write" },
                });
                if (existingTransactions.some((transaction) =>
                    transaction.status === "pending" ||
                    transaction.status === "completed" ||
                    transaction.status === "needs_review")) {
                    await queryRunner.commitTransaction();
                    return res.json(existing);
                }
                existingSession = existing;
            }

            const productIds = Array.from(new Set(payload.items.map((item) => item.product_id))).sort();
            const products = new Map<string, Product>();
            for (const productId of productIds) {
                const product = await queryRunner.manager.findOne(Product, {
                    where: { id: productId },
                    lock: { mode: "pessimistic_write" },
                });
                if (!product) throw new Error("One or more checkout products no longer exist");
                products.set(productId, product);
            }

            const activeSessions = await queryRunner.manager.find(PaymentCheckoutSession, {
                where: { status: "reserved" },
            });
            const snapshot: PaymentCheckoutItem[] = [];
            const grossLines: Array<{ cents: bigint; taxRate: number }> = [];
            for (const item of payload.items) {
                const product = products.get(item.product_id);
                if (!product) throw new Error("One or more checkout products no longer exist");
                const reservedGlobal = getReservedQuantity(activeSessions, product.id, payload.id);
                if (Number(product.stock_on_hand) - reservedGlobal < item.quantity) {
                    throw new Error(`${product.name} does not have enough unreserved stock`);
                }

                if (payload.warehouse_id) {
                    const branchStock = await queryRunner.manager.findOne(WarehouseStock, {
                        where: { warehouse_id: payload.warehouse_id, product_id: product.id },
                        lock: { mode: "pessimistic_write" },
                    });
                    const reservedBranch = getReservedQuantity(activeSessions, product.id, payload.id, payload.warehouse_id);
                    if (!branchStock || Number(branchStock.stock_on_hand) - reservedBranch < item.quantity) {
                        throw new Error(`${product.name} does not have enough unreserved stock at this branch`);
                    }
                }

                const batches = await queryRunner.manager.find(ProductBatch, {
                    where: { product_id: product.id },
                });
                const blockedQuantity = batches
                    .filter((batch) => blockedBatchStatuses.has((batch.quality_check_status ?? "").toLowerCase().trim()))
                    .reduce((sum, batch) => sum + Math.max(0, Number(batch.current_quantity) || 0), 0);
                const approvedQuantity = batches
                    .filter((batch) => !blockedBatchStatuses.has((batch.quality_check_status ?? "").toLowerCase().trim()))
                    .reduce((sum, batch) => sum + Math.max(0, Number(batch.current_quantity) || 0), 0);
                if (blockedQuantity > 0 && approvedQuantity - reservedGlobal < item.quantity) {
                    throw new Error(`${product.name} has stock pending a quality check or reservation`);
                }

                const unitPrice = Number(product.retail_price);
                const taxClass = product.tax_class_id
                    ? await queryRunner.manager.findOneBy(TaxClass, { id: product.tax_class_id })
                    : null;
                const taxRate = taxClass ? Number(taxClass.rate) : Number(product.tax_rate) || 0;
                const pricedSegments = await PromotionPricingService.priceProduct(
                    queryRunner.manager,
                    product,
                    item.quantity,
                    activeSessions,
                    { excludeSessionId: payload.id, lock: true },
                );
                const unitCostCents = parseKesToCents(String(product.unit_cost));
                if (pricedSegments.some((segment) =>
                    segment.promotionApplied &&
                    segment.unitPriceCents < unitCostCents &&
                    !segment.lossOverrideReason)) {
                    throw new Error(`${product.name} promotion is now below weighted-average cost and requires a manager loss reason`);
                }
                const lineTotalCents = PromotionPricingService.getSegmentGrossCents(pricedSegments);
                snapshot.push({
                    product_id: product.id,
                    quantity: item.quantity,
                    unit_price: unitPrice,
                    tax_rate: taxRate,
                    sku: product.sku,
                    barcode: product.barcode ?? null,
                    name: product.name,
                    unit_of_measure: product.unit_of_measure,
                    price_segments: pricedSegments.map((segment) => ({
                        quantity: segment.quantity,
                        unit_price: centsToKesString(segment.unitPriceCents),
                        original_unit_price: centsToKesString(segment.originalUnitPriceCents),
                        discount_per_unit_cents: String(segment.discountPerUnitCents),
                        promotion_id: segment.promotionId,
                        promotion_item_id: segment.promotionItemId,
                        promotion_name: segment.promotionName,
                        loss_override_reason: segment.lossOverrideReason,
                    })),
                });
                grossLines.push({ cents: lineTotalCents, taxRate });
            }

            const grossTotalCents = grossLines.reduce((sum, line) => sum + line.cents, 0n);
            const cashierDiscountCents = parseKesToCents(String(payload.loyalty_discount));
            if (cashierDiscountCents > grossTotalCents) throw new Error("Discount exceeds checkout total");
            let voucherDiscountCents = 0n;
            if (payload.voucher_number) {
                const voucher = await queryRunner.manager.findOne(CustomerVoucher, {
                    where: { voucher_number: payload.voucher_number },
                    relations: ["customer"],
                    lock: { mode: "pessimistic_write" },
                });
                if (!voucher) throw new Error("Voucher not found");
                if (payload.customer_id && voucher.customer.id !== payload.customer_id) {
                    throw new Error("Voucher does not belong to the selected customer");
                }
                if (payload.voucher_points_redeemed > 0 &&
                    VoucherService.voucherState(voucher).expired) {
                    throw new Error("Voucher is expired; renew it before redeeming points");
                }
                voucherDiscountCents = calculateRedemptionCents(
                    BigInt(payload.voucher_points_redeemed),
                    await VoucherService.getBalance(queryRunner.manager, voucher.id),
                    grossTotalCents - cashierDiscountCents,
                );
            }
            const discountCents = cashierDiscountCents + voucherDiscountCents;
            const checkoutTotalCents = grossTotalCents - discountCents;
            if (checkoutTotalCents > MAX_CHECKOUT_MONEY_CENTS) {
                throw new Error("Checkout total exceeds the maximum supported amount");
            }
            const requestedStoreCreditCents = parseKesToCents(String(payload.store_credit_amount));
            const cashAmountCents = parseKesToCents(String(payload.cash_amount));
            const maxStoreCreditCents = checkoutTotalCents > cashAmountCents
                ? checkoutTotalCents - cashAmountCents
                : 0n;
            const storeCreditCents = requestedStoreCreditCents > maxStoreCreditCents
                ? maxStoreCreditCents
                : requestedStoreCreditCents;
            const lineDiscounts = allocateDiscountCents(grossLines.map((line) => line.cents), discountCents);
            let subtotalCents = 0n;
            let taxAmountCents = 0n;
            grossLines.forEach((line, index) => {
                const split = calculateInclusiveVatCents(
                    line.cents - lineDiscounts[index],
                    percentageToBasisPoints(String(line.taxRate)),
                );
                subtotalCents += split.netRevenueCents;
                taxAmountCents += split.vatCents;
            });
            const subtotal = Number(centsToKesString(subtotalCents));
            const taxAmount = Number(centsToKesString(taxAmountCents));
            const session = queryRunner.manager.create(PaymentCheckoutSession, {
                ...(existingSession || {}),
                id: payload.id || randomUUID(),
                cashier_id: req.user!.id,
                warehouse_id: payload.warehouse_id,
                customer_id: payload.customer_id,
                store_credit_barcode: payload.store_credit_barcode,
                voucher_number: payload.voucher_number,
                voucher_points_redeemed: String(payload.voucher_points_redeemed),
                items: snapshot,
                subtotal,
                tax_amount: taxAmount,
                total_amount: Number(centsToKesString(checkoutTotalCents)),
                loyalty_discount: payload.loyalty_discount,
                cash_amount: payload.cash_amount,
                store_credit_amount: Number(centsToKesString(storeCreditCents)),
                status: "reserved",
            });
            await queryRunner.manager.save(session);
            await queryRunner.commitTransaction();
            return res.status(201).json(session);
        } catch (error) {
            await queryRunner.rollbackTransaction();
            const message = error instanceof Error ? error.message : "Failed to reserve checkout stock";
            if (message.includes("duplicate key")) {
                return res.status(409).json({ message: "Checkout session already exists" });
            }
            return res.status(400).json({ message });
        } finally {
            await queryRunner.release();
        }
    }

    static async get(req: AuthenticatedRequest, res: Response) {
        try {
            const sessionId = String(req.params.checkoutSessionId || "");
            const session = await AppDataSource.getRepository(PaymentCheckoutSession).findOneBy({ id: sessionId });
            if (!session) return res.status(404).json({ message: "Checkout session not found" });
            if (session.cashier_id !== req.user?.id && req.user?.role !== "admin") {
                return res.status(403).json({ message: "Not authorized for this checkout session" });
            }
            const transactions = await AppDataSource.getRepository(MpesaTransaction).find({
                where: { checkout_session_id: session.id },
                order: { created_at: "ASC" },
            });
            if (session.purpose === "voucher_renewal") {
                return res.json(await VoucherService.renewalCheckoutStatus(
                    AppDataSource.manager,
                    session,
                    session.cashier_id,
                ));
            }
            return res.json({
                ...session,
                mpesa_transactions: transactions.map((transaction) => ({
                    id: transaction.id,
                    status: transaction.status,
                    amount: Number(transaction.amount),
                    mpesa_receipt_number: transaction.mpesa_receipt_number,
                    checkout_request_id: transaction.checkout_request_id,
                    account_reference: transaction.account_reference,
                    mismatch_reason: transaction.mismatch_reason,
                })),
            });
        } catch (error) {
            console.error("Checkout session fetch error:", error);
            return res.status(500).json({ message: "Failed to fetch checkout session" });
        }
    }

    static async confirmCash(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            const session = await queryRunner.manager.findOne(PaymentCheckoutSession, {
                where: { id: String(req.params.checkoutSessionId || "") },
                lock: { mode: "pessimistic_write" },
            });
            if (!session) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Checkout session not found" });
            }
            if (session.cashier_id !== req.user?.id && req.user?.role !== "admin") {
                await queryRunner.rollbackTransaction();
                return res.status(403).json({ message: "Not authorized for this checkout session" });
            }
            if (session.status !== "reserved" || session.purpose !== "sale") {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Checkout session is no longer active" });
            }
            if (parseKesToCents(String(session.store_credit_amount)) !== 0n) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Exact cash confirmation is unavailable for checkout sessions using store credit" });
            }
            const transactions = await queryRunner.manager.find(MpesaTransaction, {
                where: { checkout_session_id: session.id },
                lock: { mode: "pessimistic_write" },
            });
            if (transactions.length > 0) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Exact cash confirmation is unavailable after an M-Pesa payment has been started" });
            }

            session.cash_amount = Number(centsToKesString(parseKesToCents(String(session.total_amount))));
            await queryRunner.manager.save(session);
            await queryRunner.commitTransaction();
            return res.json(session);
        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error("Exact cash checkout confirmation error:", error);
            return res.status(500).json({ message: "Failed to confirm exact cash checkout" });
        } finally {
            await queryRunner.release();
        }
    }

    static async cancel(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            const session = await queryRunner.manager.findOne(PaymentCheckoutSession, {
                where: { id: String(req.params.checkoutSessionId || "") },
                lock: { mode: "pessimistic_write" },
            });
            if (!session) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Checkout session not found" });
            }
            if (session.cashier_id !== req.user?.id && req.user?.role !== "admin") {
                await queryRunner.rollbackTransaction();
                return res.status(403).json({ message: "Not authorized for this checkout session" });
            }
            if (session.status !== "reserved") {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Checkout session is no longer active" });
            }
            const transactions = await queryRunner.manager.find(MpesaTransaction, {
                where: { checkout_session_id: session.id },
            }) as Array<{ status: string }>;
            if (session.purpose === "voucher_renewal" &&
                !canCancelVoucherRenewalCheckout(
                    parseKesToCents(String(session.cash_amount)),
                    transactions.map((transaction) => transaction.status),
                )) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({
                    message: "A voucher renewal with recorded cash or an unresolved/successful M-Pesa payment cannot be cancelled",
                });
            }
            if (transactions.some((transaction) => transaction.status === "pending" || transaction.status === "completed")) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "A pending or completed M-Pesa payment prevents releasing this stock reservation" });
            }
            session.status = "cancelled";
            await queryRunner.manager.save(session);
            await queryRunner.commitTransaction();
            return res.json({ success: true });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error("Checkout session cancellation error:", error);
            return res.status(500).json({ message: "Failed to cancel checkout session" });
        } finally {
            await queryRunner.release();
        }
    }
}
