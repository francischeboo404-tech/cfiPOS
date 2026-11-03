import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import {
    InstallmentAgreement,
    InstallmentAgreementItem,
    InstallmentAuditEvent,
    InstallmentCancellationEvent,
    InstallmentPlan,
    InstallmentPayment,
    InstallmentPaymentAllocation as InstallmentPaymentAllocationEntity,
    InstallmentPaymentReversal,
    InstallmentReversalAllocation,
    InstallmentSchedule,
    InstallmentStockEvent,
} from "../entity/InstallmentEntities";
import { Customer } from "../entity/Customer";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { Product } from "../entity/Product";
import { ProductBatch } from "../entity/ProductBatch";
import { Setting } from "../entity/Setting";
import { TaxClass } from "../entity/TaxClass";
import { Warehouse } from "../entity/Warehouse";
import { WarehouseStock } from "../entity/WarehouseStock";
import { AuthenticatedRequest } from "../middleware/auth";
import { calculateInclusiveVatCents, parseKesToCents, percentageToBasisPoints } from "../lib/exactMoney";
import {
    createInstallmentQuote,
    isInstallmentSellingEnabled,
    kesFromCents,
    minimumInstallmentDepositCents,
    isInstallmentUuid,
    sanitizeInstallmentAgreementRequest,
    sanitizeInstallmentQuoteRequest,
    parseStoredInstallmentCents,
} from "../lib/installmentRules";
import {
    allocateInstallmentPayment,
    buildFullPaymentReversalAllocations,
    calculateInstallmentCancellationAmounts,
    calculateInstallmentBalanceCents,
    isInstallmentPaymentMethod,
    sanitizeInstallmentCancellationRequest,
    sanitizeInstallmentPaymentReversalRequest,
    sanitizeInstallmentPaymentRequest,
} from "../lib/installmentPaymentRules";
import { AccountingService } from "../services/AccountingService";
import { getReservedQuantity } from "../services/CheckoutReservationService";
import { PromotionPricingService } from "../services/PromotionPricingService";

class InstallmentQuoteError extends Error {
    constructor(public readonly statusCode: number, message: string) {
        super(message);
    }
}

const nairobiDate = (instant: Date): string => {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(instant);
    const part = (type: "year" | "month" | "day") =>
        parts.find((entry) => entry.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    if (!year || !month || !day) throw new Error("Could not determine the Nairobi business date");
    return `${year}-${month}-${day}`;
};

const readOpenCreditCents = async (
    manager: typeof AppDataSource.manager,
    customerId: string,
): Promise<bigint> => {
    const rows = await manager.query(`
        SELECT COALESCE(SUM(GREATEST(
            agreement.total_payable_cents
            - COALESCE((
                SELECT SUM(payment.amount_cents)
                FROM installment_payments payment
                WHERE payment.agreement_id = agreement.id
                  AND NOT EXISTS (
                    SELECT 1 FROM installment_payment_reversals reversal
                    WHERE reversal.payment_id = payment.id
                  )
            ), 0)
            - COALESCE((
                SELECT SUM(write_off.amount_cents)
                FROM installment_write_off_events write_off
                WHERE write_off.agreement_id = agreement.id
            ), 0),
            0
        )), 0)::text AS open_credit_cents
        FROM installment_agreements agreement
        WHERE agreement.customer_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM installment_cancellation_events cancellation
            WHERE cancellation.agreement_id = agreement.id
          )
    `, [customerId]) as Array<{ open_credit_cents: string }>;
    return BigInt(rows[0]?.open_credit_cents || "0");
};

export class InstallmentController {
    static async createAgreement(req: AuthenticatedRequest, res: Response) {
        if (!req.user?.id) {
            return res.status(401).json({ message: "Authenticated user is required" });
        }
        const actorId = req.user.id;
        try {
            const input = sanitizeInstallmentAgreementRequest(req.body);
            const agreementDate = nairobiDate(new Date());
            const created = await AppDataSource.transaction(async (manager) => {
                const enabled = await manager.findOneBy(Setting, { key: "installments_enabled" });
                if (!isInstallmentSellingEnabled(enabled?.value)) {
                    throw new InstallmentQuoteError(
                        409,
                        "Installment selling is unavailable until agreement, payment, and stock handover controls are complete",
                    );
                }
                await manager.query(
                    "SELECT pg_advisory_xact_lock(hashtext($1))",
                    [input.idempotency_key],
                );
                const prior = await manager.findOne(InstallmentAgreement, {
                    where: { idempotency_key: input.idempotency_key },
                });
                if (prior) {
                    const priorRequest = prior.terms_snapshot.creation_request;
                    if (JSON.stringify(priorRequest) !== JSON.stringify(input)) {
                        throw new InstallmentQuoteError(
                            409,
                            "Idempotency key was already used for a different installment agreement",
                        );
                    }
                    const [schedule, items] = await Promise.all([
                        manager.find(InstallmentSchedule, {
                            where: { agreement_id: prior.id },
                            order: { installment_number: "ASC" },
                        }),
                        manager.find(InstallmentAgreementItem, {
                            where: { agreement_id: prior.id },
                            order: { product_name_snapshot: "ASC" },
                        }),
                    ]);
                    return { agreement: prior, schedule, items, replayed: true };
                }

                const customer = await manager.findOne(Customer, {
                    where: { id: input.customer_id },
                    lock: { mode: "pessimistic_write" },
                });
                if (!customer) throw new InstallmentQuoteError(404, "Customer not found");
                if (!customer.phone.trim() || !customer.national_id?.trim()) {
                    throw new InstallmentQuoteError(
                        400,
                        "Customer phone and national ID are required for installment sales",
                    );
                }
                const plan = await manager.findOne(InstallmentPlan, {
                    where: { id: input.plan_id, active: true },
                    lock: { mode: "pessimistic_read" },
                });
                if (!plan) throw new InstallmentQuoteError(404, "Active installment plan not found");
                if (input.warehouse_id) {
                    const warehouse = await manager.findOne(Warehouse, {
                        where: { id: input.warehouse_id, is_active: true },
                    });
                    if (!warehouse) throw new InstallmentQuoteError(404, "Warehouse not found or inactive");
                }

                const products = new Map<string, Product>();
                for (const item of input.items.slice().sort((left, right) =>
                    left.product_id.localeCompare(right.product_id))) {
                    const product = await manager.findOne(Product, {
                        where: { id: item.product_id },
                        lock: { mode: "pessimistic_write" },
                    });
                    if (!product) throw new InstallmentQuoteError(404, `Product ${item.product_id} not found`);
                    if (product.tax_class_id) {
                        product.tax_class = await manager.findOneBy(TaxClass, { id: product.tax_class_id });
                    }
                    products.set(product.id, product);
                }

                const reservationPredicate = input.warehouse_id
                    ? `AND ("warehouse_id" IS NULL OR "warehouse_id" = $2)`
                    : "";
                const reservationParameters = input.warehouse_id
                    ? [input.items.map((item) => item.product_id), input.warehouse_id]
                    : [input.items.map((item) => item.product_id)];
                const reservedRows = await manager.query(`
                    SELECT "product_id", COALESCE(SUM("quantity_delta"), 0)::integer AS "reserved_quantity"
                    FROM "installment_stock_events"
                    WHERE "product_id" = ANY($1::uuid[])
                      ${reservationPredicate}
                    GROUP BY "product_id"
                `, reservationParameters) as Array<{ product_id: string; reserved_quantity: number }>;
                const installmentReserved = new Map(reservedRows.map((row) =>
                    [row.product_id, Number(row.reserved_quantity)]));
                const activeSessions = await manager.find(PaymentCheckoutSession, {
                    where: { status: "reserved" },
                });

                const pricedItems: Array<{
                    product: Product;
                    quantity: number;
                    taxRateBps: number;
                    unitPriceCents: bigint;
                    lineTotalCents: bigint;
                    priceSnapshot: Record<string, unknown>;
                }> = [];
                let priceTotalCents = 0n;
                for (const item of input.items) {
                    const product = products.get(item.product_id);
                    if (!product) throw new Error("Locked product lookup did not return a requested product");
                    const checkoutReserved = getReservedQuantity(
                        activeSessions,
                        product.id,
                        undefined,
                        input.warehouse_id || undefined,
                    );
                    let availableQuantity = Number(product.stock_on_hand);
                    if (input.warehouse_id) {
                        const stock = await manager.findOne(WarehouseStock, {
                            where: { warehouse_id: input.warehouse_id, product_id: product.id },
                            lock: { mode: "pessimistic_read" },
                        });
                        availableQuantity = Number(stock?.stock_on_hand || 0);
                    }
                    availableQuantity -= checkoutReserved + (installmentReserved.get(product.id) || 0);
                    if (availableQuantity < item.quantity) {
                        throw new InstallmentQuoteError(
                            409,
                            `Insufficient unreserved stock for ${product.name}; available quantity is ${Math.max(0, availableQuantity)}`,
                        );
                    }

                    const batches = await manager.find(ProductBatch, {
                        where: { product_id: product.id },
                    });
                    const blockedStatuses = new Set(["pending", "rejected", "failed", "hold", "on_hold"]);
                    const blockedQuantity = batches
                        .filter((batch) => blockedStatuses.has((batch.quality_check_status ?? "").toLowerCase().trim()))
                        .reduce((sum, batch) => sum + Math.max(0, Number(batch.current_quantity) || 0), 0);
                    const approvedQuantity = batches
                        .filter((batch) => !blockedStatuses.has((batch.quality_check_status ?? "").toLowerCase().trim()))
                        .reduce((sum, batch) => sum + Math.max(0, Number(batch.current_quantity) || 0), 0);
                    if (blockedQuantity > 0 &&
                        approvedQuantity - checkoutReserved - (installmentReserved.get(product.id) || 0) < item.quantity) {
                        throw new InstallmentQuoteError(
                            409,
                            `${product.name} has stock pending a quality check or reservation`,
                        );
                    }

                    const segments = await PromotionPricingService.priceProduct(
                        manager,
                        product,
                        item.quantity,
                        activeSessions,
                        { lock: true },
                    );
                    if (segments.some((segment) => segment.promotionItemId !== null)) {
                        throw new InstallmentQuoteError(
                            409,
                            "Installment agreements cannot reserve products with an active timed promotion; request a new quote after the promotion ends",
                        );
                    }
                    const taxRateBps = percentageToBasisPoints(String(
                        product.tax_class?.rate ?? product.tax_rate ?? 0,
                    ));
                    for (const segment of segments) {
                        const lineTotalCents = segment.unitPriceCents * BigInt(segment.quantity);
                        if (segment.promotionItemId) {
                            const promotionRows = await manager.query(`
                                SELECT item."id", item."used_qty", item."total_quota_qty"
                                FROM "promotion_items" item
                                WHERE item."id" = $1
                                FOR UPDATE
                            `, [segment.promotionItemId]) as Array<{
                                id: string;
                                used_qty: number;
                                total_quota_qty: number | null;
                            }>;
                            const promotion = promotionRows[0];
                            if (!promotion ||
                                (promotion.total_quota_qty !== null &&
                                    promotion.used_qty + segment.quantity > promotion.total_quota_qty)) {
                                throw new InstallmentQuoteError(
                                    409,
                                    `Promotion quota changed for ${product.name}; request a new quote`,
                                );
                            }
                            await manager.query(`
                                UPDATE "promotion_items"
                                SET "used_qty" = "used_qty" + $2
                                WHERE "id" = $1
                            `, [promotion.id, segment.quantity]);
                        }
                        pricedItems.push({
                            product,
                            quantity: segment.quantity,
                            taxRateBps,
                            unitPriceCents: segment.unitPriceCents,
                            lineTotalCents,
                            priceSnapshot: {
                                original_unit_price_cents: segment.originalUnitPriceCents.toString(),
                                discount_per_unit_cents: segment.discountPerUnitCents.toString(),
                                promotion_id: segment.promotionId,
                                promotion_item_id: segment.promotionItemId,
                                promotion_name: segment.promotionName,
                                loss_override_reason: segment.lossOverrideReason,
                            },
                        });
                        priceTotalCents += lineTotalCents;
                    }
                }

                const minimumDepositCents = minimumInstallmentDepositCents(
                    priceTotalCents,
                    plan.min_deposit_percent_bps,
                );
                const depositCents = parseKesToCents(input.deposit_amount!);
                if (depositCents < minimumDepositCents) {
                    throw new InstallmentQuoteError(400, "Deposit is below the plan minimum");
                }
                const quote = createInstallmentQuote({
                    priceTotalCents,
                    depositCents,
                    agreementDate,
                    terms: {
                        number_of_installments: plan.number_of_installments,
                        frequency: plan.frequency as "WEEKLY" | "EVERY_2_WEEKS" | "MONTHLY",
                        min_deposit_percent_bps: plan.min_deposit_percent_bps,
                        interest_type: plan.interest_type as "FLAT_TOTAL" | "FLAT_PER_MONTH",
                        interest_rate_bps: plan.interest_rate_bps,
                    },
                });
                if (quote.price_total_cents > 9_999_999_999n) {
                    throw new InstallmentQuoteError(
                        400,
                        "Installment price total exceeds the maximum supported POS sale amount",
                    );
                }
                if (quote.total_payable_cents > 999_999_999_999_999n) {
                    throw new InstallmentQuoteError(
                        400,
                        "Installment amount exceeds the maximum supported accounting amount",
                    );
                }
                if (plan.min_financed_cents !== null &&
                    quote.financed_cents < BigInt(plan.min_financed_cents)) {
                    throw new InstallmentQuoteError(400, "Financed amount is below the plan minimum");
                }
                if (plan.max_financed_cents !== null &&
                    quote.financed_cents > BigInt(plan.max_financed_cents)) {
                    throw new InstallmentQuoteError(400, "Financed amount exceeds the plan maximum");
                }

                const maxOpenCreditSetting = await manager.findOneBy(Setting, {
                    key: "installment_max_open_credit_cents",
                });
                const maxOpenCreditCents = BigInt(parseStoredInstallmentCents(
                    maxOpenCreditSetting?.value ?? "0",
                    "installment_max_open_credit_cents",
                ));
                const currentOpenCreditCents = await readOpenCreditCents(manager, customer.id);
                const newOpenCreditCents = calculateInstallmentBalanceCents({
                    totalPayableCents: quote.total_payable_cents,
                    allocatedPaymentCents: depositCents,
                    reversedPaymentCents: 0n,
                    writtenOffCents: 0n,
                });
                if (maxOpenCreditCents > 0n &&
                    currentOpenCreditCents + newOpenCreditCents > maxOpenCreditCents) {
                    throw new InstallmentQuoteError(
                        409,
                        "Customer's open installment credit limit would be exceeded",
                    );
                }

                const sequenceRows = await manager.query(
                    `SELECT nextval('"installment_agreement_number_seq"')::text AS sequence`,
                ) as Array<{ sequence: string }>;
                const agreementNumber = `IA-${sequenceRows[0].sequence.padStart(8, "0")}`;
                const agreement = await manager.save(InstallmentAgreement, manager.create(InstallmentAgreement, {
                    agreement_number: agreementNumber,
                    idempotency_key: input.idempotency_key,
                    customer_id: customer.id,
                    plan_id: plan.id,
                    terms_snapshot: {
                        plan_name: plan.name,
                        frequency: plan.frequency,
                        number_of_installments: plan.number_of_installments,
                        min_deposit_percent_bps: plan.min_deposit_percent_bps,
                        interest_type: plan.interest_type,
                        interest_rate_bps: plan.interest_rate_bps,
                        release_mode: plan.release_mode,
                        months_hundredths: quote.months_hundredths,
                        creation_request: input,
                    },
                    customer_name_snapshot: customer.name,
                    customer_phone_snapshot: customer.phone,
                    customer_national_id_snapshot: customer.national_id!,
                    warehouse_id: input.warehouse_id,
                    agreement_date: agreementDate,
                    price_total_cents: quote.price_total_cents.toString(),
                    deposit_cents: quote.deposit_cents.toString(),
                    financed_cents: quote.financed_cents.toString(),
                    interest_cents: quote.interest_cents.toString(),
                    total_payable_cents: quote.total_payable_cents.toString(),
                    release_mode: plan.release_mode,
                    created_by: actorId,
                }));

                const agreementItems: InstallmentAgreementItem[] = [];
                for (const item of pricedItems) {
                    const agreementItem = await manager.save(
                        InstallmentAgreementItem,
                        manager.create(InstallmentAgreementItem, {
                            agreement_id: agreement.id,
                            product_id: item.product.id,
                            product_name_snapshot: item.product.name,
                            sku_snapshot: item.product.sku,
                            unit_of_measure_snapshot: item.product.unit_of_measure,
                            quantity: item.quantity,
                            unit_price_cents: item.unitPriceCents.toString(),
                            line_total_cents: item.lineTotalCents.toString(),
                            tax_rate_bps: item.taxRateBps,
                            price_snapshot: item.priceSnapshot,
                        }),
                    );
                    agreementItems.push(agreementItem);
                    await manager.save(InstallmentStockEvent, manager.create(InstallmentStockEvent, {
                        agreement_id: agreement.id,
                        agreement_item_id: agreementItem.id,
                        product_id: item.product.id,
                        warehouse_id: input.warehouse_id,
                        quantity_delta: item.quantity,
                        event_type: "RESERVE",
                        actor_id: actorId,
                        reason: "Installment agreement stock reservation",
                    }));
                }
                const schedules = await manager.save(
                    InstallmentSchedule,
                    quote.schedule.map((line) => manager.create(InstallmentSchedule, {
                        agreement_id: agreement.id,
                        installment_number: line.installment_number,
                        due_date: line.due_date,
                        principal_cents: line.principal_cents.toString(),
                        interest_cents: line.interest_cents.toString(),
                    })),
                );
                if (depositCents > 0n && input.deposit_payment_method) {
                    const payment = await manager.save(InstallmentPayment, manager.create(InstallmentPayment, {
                        agreement_id: agreement.id,
                        payment_date: agreementDate,
                        amount_cents: depositCents.toString(),
                        payment_method: input.deposit_payment_method,
                        reference_number: input.deposit_reference_number,
                        recorded_by: actorId,
                        idempotency_key: input.idempotency_key,
                    }));
                    await manager.save(InstallmentPaymentAllocationEntity, manager.create(
                        InstallmentPaymentAllocationEntity,
                        {
                            payment_id: payment.id,
                            agreement_id: agreement.id,
                            installment_number: 0,
                            principal_cents: depositCents.toString(),
                            interest_cents: "0",
                        },
                    ));
                    await AccountingService.recordInstallmentAdvance(
                        manager,
                        payment.id,
                        depositCents,
                        input.deposit_payment_method,
                        agreementDate,
                    );
                }
                await manager.save(InstallmentAuditEvent, manager.create(InstallmentAuditEvent, {
                    subject_type: "agreement",
                    subject_id: agreement.id,
                    action: "agreement_created",
                    before_state: null,
                    after_state: {
                        agreement_number: agreement.agreement_number,
                        customer_id: customer.id,
                        price_total_cents: agreement.price_total_cents,
                        deposit_cents: agreement.deposit_cents,
                        financed_cents: agreement.financed_cents,
                        interest_cents: agreement.interest_cents,
                        total_payable_cents: agreement.total_payable_cents,
                        reserved_item_count: agreementItems.length,
                    },
                    reason: null,
                    actor_id: actorId,
                }));
                return { agreement, schedule: schedules, items: agreementItems, replayed: false };
            });
            return res.status(created.replayed ? 200 : 201).json({
                agreement: {
                    id: created.agreement.id,
                    agreement_number: created.agreement.agreement_number,
                    customer_id: created.agreement.customer_id,
                    agreement_date: created.agreement.agreement_date,
                    price_total: kesFromCents(created.agreement.price_total_cents),
                    deposit: kesFromCents(created.agreement.deposit_cents),
                    financed_amount: kesFromCents(created.agreement.financed_cents),
                    interest_amount: kesFromCents(created.agreement.interest_cents),
                    total_payable: kesFromCents(created.agreement.total_payable_cents),
                    release_mode: created.agreement.release_mode,
                },
                items: created.items.map((item) => ({
                    product_id: item.product_id,
                    product_name: item.product_name_snapshot,
                    sku: item.sku_snapshot,
                    quantity: item.quantity,
                    unit_price: kesFromCents(item.unit_price_cents),
                    line_total: kesFromCents(item.line_total_cents),
                })),
                schedule: created.schedule.map((item) => ({
                    installment_number: item.installment_number,
                    due_date: item.due_date,
                    principal: kesFromCents(item.principal_cents),
                    interest: kesFromCents(item.interest_cents),
                })),
                replayed: created.replayed,
            });
        } catch (error) {
            if (error instanceof InstallmentQuoteError) {
                return res.status(error.statusCode).json({ message: error.message });
            }
            if (error instanceof Error &&
                /^(Installment agreement|Installment quote|Installment price total|Installment total payable|Unknown installment agreement field|Unknown installment quote field|Unknown installment item field|Deposit payment details|customer_id|plan_id|warehouse_id|items|Each installment item|Each product_id|Item quantities|Combined item quantity|deposit_amount|deposit_payment_method|deposit_reference_number|idempotency_key)/.test(error.message)) {
                return res.status(400).json({ message: error.message });
            }
            if ((error as { code?: string })?.code === "23505") {
                return res.status(409).json({ message: "Installment agreement idempotency key or payment reference already exists" });
            }
            console.error("Error creating installment agreement:", error);
            return res.status(500).json({ message: "Unable to create installment agreement" });
        }
    }

    static async recordPayment(req: AuthenticatedRequest, res: Response) {
        if (!req.user?.id) {
            return res.status(401).json({ message: "Authenticated user is required" });
        }
        const actorId = req.user.id;
        try {
            const paymentDate = nairobiDate(new Date());
            const input = sanitizeInstallmentPaymentRequest(req.body, paymentDate);
            const amountCents = parseKesToCents(input.amount);
            const result = await AppDataSource.transaction(async (manager) => {
                await manager.query(
                    "SELECT pg_advisory_xact_lock(hashtext($1))",
                    [input.idempotency_key],
                );
                const prior = await manager.findOne(InstallmentPayment, {
                    where: { idempotency_key: input.idempotency_key },
                });
                if (prior) {
                    const sameRequest = prior.agreement_id === input.agreement_id &&
                        prior.payment_date === input.payment_date &&
                        BigInt(prior.amount_cents) === amountCents &&
                        prior.payment_method === input.payment_method &&
                        prior.reference_number === input.reference_number;
                    if (!sameRequest) {
                        throw new InstallmentQuoteError(409, "Idempotency key was already used for a different installment payment");
                    }
                    const allocations = await manager.find(InstallmentPaymentAllocationEntity, {
                        where: { payment_id: prior.id },
                        order: { installment_number: "ASC" },
                    });
                    return { payment: prior, allocations, replayed: true };
                }

                const agreement = await manager.findOne(InstallmentAgreement, {
                    where: { id: input.agreement_id },
                    lock: { mode: "pessimistic_write" },
                });
                if (!agreement) throw new InstallmentQuoteError(404, "Installment agreement not found");
                if (input.payment_date < agreement.agreement_date) {
                    throw new InstallmentQuoteError(400, "payment_date cannot precede the agreement date");
                }

                const terminalRows = await manager.query(`
                    SELECT
                        EXISTS (SELECT 1 FROM installment_cancellation_events WHERE agreement_id = $1) AS cancelled,
                        EXISTS (SELECT 1 FROM installment_write_off_events WHERE agreement_id = $1) AS written_off
                `, [agreement.id]) as Array<{ cancelled: boolean; written_off: boolean }>;
                if (terminalRows[0]?.cancelled) {
                    throw new InstallmentQuoteError(409, "Payments cannot be recorded against a cancelled installment agreement");
                }
                if (terminalRows[0]?.written_off) {
                    throw new InstallmentQuoteError(409, "Payments cannot be recorded after an installment agreement has been written off");
                }

                const schedules = await manager.find(InstallmentSchedule, {
                    where: { agreement_id: agreement.id },
                    order: { installment_number: "ASC" },
                    lock: { mode: "pessimistic_read" },
                });
                const balanceRows = await manager.query(`
                    SELECT allocation.installment_number,
                        SUM(allocation.principal_cents - COALESCE(reversed.principal_cents, 0))::text AS principal_paid_cents,
                        SUM(allocation.interest_cents - COALESCE(reversed.interest_cents, 0))::text AS interest_paid_cents
                    FROM installment_payment_allocations allocation
                    LEFT JOIN (
                        SELECT reversal_allocation.payment_allocation_id,
                            SUM(reversal_allocation.principal_cents)::bigint AS principal_cents,
                            SUM(reversal_allocation.interest_cents)::bigint AS interest_cents
                        FROM installment_reversal_allocations reversal_allocation
                        JOIN installment_payment_reversals reversal
                            ON reversal.id = reversal_allocation.reversal_id
                        GROUP BY reversal_allocation.payment_allocation_id
                    ) reversed ON reversed.payment_allocation_id = allocation.id
                    WHERE allocation.agreement_id = $1
                    GROUP BY allocation.installment_number
                `, [agreement.id]) as Array<{
                    installment_number: number;
                    principal_paid_cents: string;
                    interest_paid_cents: string;
                }>;
                const paidByInstallment = new Map(balanceRows.map((row) => [
                    row.installment_number,
                    {
                        principal: BigInt(row.principal_paid_cents),
                        interest: BigInt(row.interest_paid_cents),
                    },
                ]));
                const scheduleBalances = schedules.map((schedule) => {
                    const paid = paidByInstallment.get(schedule.installment_number);
                    return {
                        installment_number: schedule.installment_number,
                        principal_cents: BigInt(schedule.principal_cents),
                        interest_cents: BigInt(schedule.interest_cents),
                        principal_paid_cents: paid?.principal || 0n,
                        interest_paid_cents: paid?.interest || 0n,
                    };
                });
                const allocated = allocateInstallmentPayment(scheduleBalances, amountCents);
                const payment = await manager.save(InstallmentPayment, manager.create(InstallmentPayment, {
                    agreement_id: agreement.id,
                    payment_date: input.payment_date,
                    amount_cents: amountCents.toString(),
                    payment_method: input.payment_method,
                    reference_number: input.reference_number,
                    recorded_by: actorId,
                    idempotency_key: input.idempotency_key,
                }));
                const allocations: InstallmentPaymentAllocationEntity[] = [];
                for (const allocation of allocated) {
                    allocations.push(await manager.save(
                        InstallmentPaymentAllocationEntity,
                        manager.create(InstallmentPaymentAllocationEntity, {
                            payment_id: payment.id,
                            agreement_id: agreement.id,
                            installment_number: allocation.installment_number,
                            principal_cents: allocation.principal_cents.toString(),
                            interest_cents: allocation.interest_cents.toString(),
                        }),
                    ));
                }
                await AccountingService.recordInstallmentAdvance(
                    manager,
                    payment.id,
                    amountCents,
                    input.payment_method,
                    input.payment_date,
                );
                await manager.save(manager.create(InstallmentAuditEvent, {
                    subject_type: "agreement",
                    subject_id: agreement.id,
                    action: "payment_recorded",
                    before_state: null,
                    after_state: {
                        payment_id: payment.id,
                        amount_cents: amountCents.toString(),
                        payment_method: input.payment_method,
                        payment_date: input.payment_date,
                        allocations: allocated.map((allocation) => ({
                            installment_number: allocation.installment_number,
                            principal_cents: allocation.principal_cents.toString(),
                            interest_cents: allocation.interest_cents.toString(),
                        })),
                    },
                    reason: null,
                    actor_id: actorId,
                }));
                return { payment, allocations, replayed: false };
            });
            return res.status(result.replayed ? 200 : 201).json({
                payment: {
                    id: result.payment.id,
                    agreement_id: result.payment.agreement_id,
                    payment_date: result.payment.payment_date,
                    amount: kesFromCents(result.payment.amount_cents),
                    payment_method: result.payment.payment_method,
                    reference_number: result.payment.reference_number,
                },
                allocations: result.allocations.map((allocation) => ({
                    installment_number: allocation.installment_number,
                    principal: kesFromCents(allocation.principal_cents),
                    interest: kesFromCents(allocation.interest_cents),
                })),
                replayed: result.replayed,
            });
        } catch (error) {
            if (error instanceof InstallmentQuoteError) {
                return res.status(error.statusCode).json({ message: error.message });
            }
            if (error instanceof Error &&
                /^(Installment payment|agreement_id|idempotency_key|payment_date|todayDate|amount|payment_method|reference_number|Unknown installment payment field|Payment amount|Installment numbers|Installment amounts|Paid installment amounts)/.test(error.message)) {
                return res.status(400).json({ message: error.message });
            }
            if ((error as { code?: string })?.code === "23505") {
                return res.status(409).json({ message: "Installment payment reference or idempotency key already exists" });
            }
            console.error("Error recording installment payment:", error);
            return res.status(500).json({ message: "Unable to record installment payment" });
        }
    }

    static async reversePayment(req: AuthenticatedRequest, res: Response) {
        if (!req.user?.id) {
            return res.status(401).json({ message: "Authenticated user is required" });
        }
        if (!isInstallmentUuid(req.params.paymentId)) {
            return res.status(400).json({ message: "paymentId must be a valid UUID" });
        }
        const actorId = req.user.id;
        try {
            const input = sanitizeInstallmentPaymentReversalRequest(req.body);
            const reversalDate = nairobiDate(new Date());
            const result = await AppDataSource.transaction(async (manager) => {
                const payment = await manager.findOne(InstallmentPayment, {
                    where: { id: req.params.paymentId.toLowerCase() },
                    lock: { mode: "pessimistic_write" },
                });
                if (!payment) throw new InstallmentQuoteError(404, "Installment payment not found");

                const priorReversal = await manager.findOne(InstallmentPaymentReversal, {
                    where: { payment_id: payment.id },
                });
                if (priorReversal) {
                    if (priorReversal.reason !== input.reason) {
                        throw new InstallmentQuoteError(
                            409,
                            "Installment payment has already been reversed for a different reason",
                        );
                    }
                    const allocations = await manager.find(InstallmentReversalAllocation, {
                        where: { reversal_id: priorReversal.id },
                        order: { installment_number: "ASC" },
                    });
                    return { reversal: priorReversal, allocations, replayed: true };
                }

                const agreement = await manager.findOne(InstallmentAgreement, {
                    where: { id: payment.agreement_id },
                    lock: { mode: "pessimistic_write" },
                });
                if (!agreement) throw new InstallmentQuoteError(404, "Installment agreement not found");
                const stateRows = await manager.query(`
                    SELECT
                        EXISTS (SELECT 1 FROM installment_handover_events WHERE agreement_id = $1) AS handed_over,
                        EXISTS (SELECT 1 FROM installment_cancellation_events WHERE agreement_id = $1) AS cancelled,
                        EXISTS (SELECT 1 FROM installment_write_off_events WHERE agreement_id = $1) AS written_off
                `, [agreement.id]) as Array<{
                    handed_over: boolean;
                    cancelled: boolean;
                    written_off: boolean;
                }>;
                const state = stateRows[0];
                if (state?.handed_over) {
                    throw new InstallmentQuoteError(
                        409,
                        "Installment payments cannot be reversed after goods have been handed over",
                    );
                }
                if (state?.cancelled) {
                    throw new InstallmentQuoteError(
                        409,
                        "Installment payments cannot be reversed after agreement cancellation",
                    );
                }
                if (state?.written_off) {
                    throw new InstallmentQuoteError(
                        409,
                        "Installment payments cannot be reversed after the agreement has been written off",
                    );
                }
                if (!isInstallmentPaymentMethod(payment.payment_method)) {
                    throw new InstallmentQuoteError(409, "Installment payment has an unsupported tender method");
                }

                const originalAllocations = await manager.find(InstallmentPaymentAllocationEntity, {
                    where: { payment_id: payment.id },
                    order: { installment_number: "ASC" },
                    lock: { mode: "pessimistic_read" },
                });
                const reversalAllocations = buildFullPaymentReversalAllocations(
                    originalAllocations.map((allocation) => ({
                        payment_allocation_id: allocation.id,
                        installment_number: allocation.installment_number,
                        principal_cents: BigInt(allocation.principal_cents),
                        interest_cents: BigInt(allocation.interest_cents),
                    })),
                    BigInt(payment.amount_cents),
                );
                const reversal = await manager.save(InstallmentPaymentReversal, manager.create(
                    InstallmentPaymentReversal,
                    {
                        payment_id: payment.id,
                        agreement_id: agreement.id,
                        amount_cents: payment.amount_cents,
                        reason: input.reason,
                        reversed_by: actorId,
                    },
                ));
                const savedAllocations: InstallmentReversalAllocation[] = [];
                for (const allocation of reversalAllocations) {
                    savedAllocations.push(await manager.save(
                        InstallmentReversalAllocation,
                        manager.create(InstallmentReversalAllocation, {
                            reversal_id: reversal.id,
                            payment_allocation_id: allocation.payment_allocation_id,
                            installment_number: allocation.installment_number,
                            principal_cents: allocation.principal_cents.toString(),
                            interest_cents: allocation.interest_cents.toString(),
                        }),
                    ));
                }
                await AccountingService.reverseInstallmentAdvance(
                    manager,
                    reversal.id,
                    BigInt(payment.amount_cents),
                    payment.payment_method,
                    reversalDate,
                );
                await manager.save(manager.create(InstallmentAuditEvent, {
                    subject_type: "agreement",
                    subject_id: agreement.id,
                    action: "payment_reversed",
                    before_state: { payment_id: payment.id, amount_cents: payment.amount_cents },
                    after_state: {
                        reversal_id: reversal.id,
                        payment_id: payment.id,
                        amount_cents: payment.amount_cents,
                        allocations: reversalAllocations.map((allocation) => ({
                            payment_allocation_id: allocation.payment_allocation_id,
                            installment_number: allocation.installment_number,
                            principal_cents: allocation.principal_cents.toString(),
                            interest_cents: allocation.interest_cents.toString(),
                        })),
                    },
                    reason: input.reason,
                    actor_id: actorId,
                }));
                return { reversal, allocations: savedAllocations, replayed: false };
            });
            return res.status(result.replayed ? 200 : 201).json({
                reversal: {
                    id: result.reversal.id,
                    payment_id: result.reversal.payment_id,
                    agreement_id: result.reversal.agreement_id,
                    amount: kesFromCents(result.reversal.amount_cents),
                    reason: result.reversal.reason,
                    created_at: result.reversal.created_at,
                },
                allocations: result.allocations.map((allocation) => ({
                    payment_allocation_id: allocation.payment_allocation_id,
                    installment_number: allocation.installment_number,
                    principal: kesFromCents(allocation.principal_cents),
                    interest: kesFromCents(allocation.interest_cents),
                })),
                replayed: result.replayed,
            });
        } catch (error) {
            if (error instanceof InstallmentQuoteError) {
                return res.status(error.statusCode).json({ message: error.message });
            }
            if (error instanceof Error &&
                /^(Installment payment reversal|Unknown installment payment reversal field|reason must contain|A reversal requires|Payment allocation|Payment reversal allocation)/.test(error.message)) {
                return res.status(400).json({ message: error.message });
            }
            if ((error as { code?: string })?.code === "23505") {
                return res.status(409).json({ message: "Installment payment has already been reversed" });
            }
            console.error("Error reversing installment payment:", error);
            return res.status(500).json({ message: "Unable to reverse installment payment" });
        }
    }

    static async cancelAgreement(req: AuthenticatedRequest, res: Response) {
        if (!req.user?.id) {
            return res.status(401).json({ message: "Authenticated user is required" });
        }
        if (!isInstallmentUuid(req.params.agreementId)) {
            return res.status(400).json({ message: "agreementId must be a valid UUID" });
        }
        const actorId = req.user.id;
        try {
            const input = sanitizeInstallmentCancellationRequest(req.body);
            const cancellationDate = nairobiDate(new Date());
            const result = await AppDataSource.transaction(async (manager) => {
                const agreement = await manager.findOne(InstallmentAgreement, {
                    where: { id: req.params.agreementId.toLowerCase() },
                    lock: { mode: "pessimistic_write" },
                });
                if (!agreement) throw new InstallmentQuoteError(404, "Installment agreement not found");

                const priorCancellation = await manager.findOne(InstallmentCancellationEvent, {
                    where: { agreement_id: agreement.id },
                });
                if (priorCancellation) {
                    if (priorCancellation.reason !== input.reason ||
                        priorCancellation.refund_method !== input.refund_method ||
                        priorCancellation.refund_reference_number !== input.refund_reference_number) {
                        throw new InstallmentQuoteError(
                            409,
                            "Installment agreement has already been cancelled with different details",
                        );
                    }
                    return { cancellation: priorCancellation, replayed: true };
                }

                const stateRows = await manager.query(`
                    SELECT
                        EXISTS (SELECT 1 FROM installment_handover_events WHERE agreement_id = $1) AS handed_over,
                        EXISTS (SELECT 1 FROM installment_write_off_events WHERE agreement_id = $1) AS written_off
                `, [agreement.id]) as Array<{ handed_over: boolean; written_off: boolean }>;
                if (stateRows[0]?.handed_over) {
                    throw new InstallmentQuoteError(
                        409,
                        "A handed-over installment agreement cannot be cancelled",
                    );
                }
                if (stateRows[0]?.written_off) {
                    throw new InstallmentQuoteError(
                        409,
                        "A written-off installment agreement cannot be cancelled",
                    );
                }

                const stockRows = await manager.query(`
                    SELECT item.id AS agreement_item_id,
                        item.product_id,
                        item.warehouse_id,
                        item.quantity,
                        COALESCE(SUM(stock.quantity_delta), 0)::integer AS reserved_quantity
                    FROM installment_agreement_items item
                    LEFT JOIN installment_stock_events stock
                        ON stock.agreement_item_id = item.id
                    WHERE item.agreement_id = $1
                    GROUP BY item.id
                    ORDER BY item.id
                `, [agreement.id]) as Array<{
                    agreement_item_id: string;
                    product_id: string;
                    warehouse_id: string | null;
                    quantity: number;
                    reserved_quantity: number;
                }>;
                if (stockRows.length === 0 || stockRows.some((item) =>
                    item.reserved_quantity !== item.quantity)) {
                    throw new InstallmentQuoteError(
                        409,
                        "Installment stock reservations are inconsistent; reconcile inventory before cancellation",
                    );
                }

                const paidRows = await manager.query(`
                    SELECT COALESCE(SUM(payment.amount_cents), 0)::text AS paid_cents
                    FROM installment_payments payment
                    WHERE payment.agreement_id = $1
                      AND NOT EXISTS (
                        SELECT 1 FROM installment_payment_reversals reversal
                        WHERE reversal.payment_id = payment.id
                      )
                `, [agreement.id]) as Array<{ paid_cents: string }>;
                const paidCents = BigInt(paidRows[0]?.paid_cents || "0");
                const feeSetting = await manager.findOneBy(Setting, {
                    key: "installment_cancellation_fee_percent_bps",
                });
                const feeBpsText = feeSetting?.value ?? "0";
                if (!/^\d{1,5}$/.test(feeBpsText) || BigInt(feeBpsText) > 10_000n) {
                    throw new Error("Invalid stored installment setting: installment_cancellation_fee_percent_bps");
                }
                const { feeCents, refundCents } = calculateInstallmentCancellationAmounts(
                    paidCents,
                    Number(feeBpsText),
                );
                const cancellation = await manager.save(
                    InstallmentCancellationEvent,
                    manager.create(InstallmentCancellationEvent, {
                        agreement_id: agreement.id,
                        fee_cents: feeCents.toString(),
                        refund_cents: refundCents.toString(),
                        refund_method: input.refund_method,
                        refund_reference_number: input.refund_reference_number,
                        reason: input.reason,
                        cancelled_by: actorId,
                    }),
                );
                for (const item of stockRows) {
                    await manager.save(manager.create(InstallmentStockEvent, {
                        agreement_id: agreement.id,
                        agreement_item_id: item.agreement_item_id,
                        product_id: item.product_id,
                        warehouse_id: item.warehouse_id,
                        quantity_delta: -item.quantity,
                        event_type: "RELEASE",
                        actor_id: actorId,
                        reason: input.reason,
                    }));
                }
                await AccountingService.recordInstallmentCancellation(
                    manager,
                    cancellation.id,
                    paidCents,
                    feeCents,
                    refundCents,
                    input.refund_method,
                    cancellationDate,
                );
                await manager.save(manager.create(InstallmentAuditEvent, {
                    subject_type: "agreement",
                    subject_id: agreement.id,
                    action: "agreement_cancelled",
                    before_state: {
                        paid_cents: paidCents.toString(),
                        reserved_item_count: stockRows.length,
                    },
                    after_state: {
                        cancellation_id: cancellation.id,
                        fee_cents: feeCents.toString(),
                        refund_cents: refundCents.toString(),
                        refund_method: input.refund_method,
                        refund_reference_number: input.refund_reference_number,
                        refund_confirmed: input.refund_confirmed,
                    },
                    reason: input.reason,
                    actor_id: actorId,
                }));
                return { cancellation, replayed: false };
            });
            return res.status(result.replayed ? 200 : 201).json({
                cancellation: {
                    id: result.cancellation.id,
                    agreement_id: result.cancellation.agreement_id,
                    fee: kesFromCents(result.cancellation.fee_cents),
                    refund: kesFromCents(result.cancellation.refund_cents),
                    refund_method: result.cancellation.refund_method,
                    refund_reference_number: result.cancellation.refund_reference_number,
                    reason: result.cancellation.reason,
                },
                replayed: result.replayed,
            });
        } catch (error) {
            if (error instanceof InstallmentQuoteError) {
                return res.status(error.statusCode).json({ message: error.message });
            }
            if (error instanceof Error &&
                /^(Installment cancellation|Unknown installment cancellation field|refund_method must be|refund_confirmed must be|refund_reference_number|reason must contain)/.test(error.message)) {
                return res.status(400).json({ message: error.message });
            }
            if ((error as { code?: string })?.code === "23505") {
                return res.status(409).json({ message: "Installment agreement has already been cancelled" });
            }
            console.error("Error cancelling installment agreement:", error);
            return res.status(500).json({ message: "Unable to cancel installment agreement" });
        }
    }

    static async quote(req: AuthenticatedRequest, res: Response) {
        try {
            const input = sanitizeInstallmentQuoteRequest(req.body);
            const quote = await AppDataSource.transaction(async (manager) => {
                const enabled = await manager.findOneBy(Setting, { key: "installments_enabled" });
                if (!isInstallmentSellingEnabled(enabled?.value)) {
                    throw new InstallmentQuoteError(
                        409,
                        "Installment selling is unavailable until agreement, payment, and stock handover controls are complete",
                    );
                }
                const agreementDate = nairobiDate(new Date());
                const plan = await manager.findOne(InstallmentPlan, {
                    where: { id: input.plan_id, active: true },
                    lock: { mode: "pessimistic_read" },
                });
                if (!plan) throw new InstallmentQuoteError(404, "Active installment plan not found");

                const customer = await manager.findOne(Customer, {
                    where: { id: input.customer_id },
                    lock: { mode: "pessimistic_read" },
                });
                if (!customer) throw new InstallmentQuoteError(404, "Customer not found");
                if (!customer.phone.trim() || !customer.national_id?.trim()) {
                    throw new InstallmentQuoteError(400, "Customer phone and national ID are required for installment sales");
                }

                if (input.warehouse_id) {
                    const warehouse = await manager.findOne(Warehouse, {
                        where: { id: input.warehouse_id, is_active: true },
                    });
                    if (!warehouse) throw new InstallmentQuoteError(404, "Warehouse not found or inactive");
                }

                const products: Product[] = [];
                for (const item of input.items.slice().sort((left, right) =>
                    left.product_id.localeCompare(right.product_id))) {
                    const product = await manager.findOne(Product, {
                        where: { id: item.product_id },
                        lock: { mode: "pessimistic_write" },
                    });
                    if (!product) throw new InstallmentQuoteError(404, `Product ${item.product_id} not found`);
                    if (product.tax_class_id) {
                        product.tax_class = await manager.findOneBy(TaxClass, { id: product.tax_class_id });
                    }
                    products.push(product);
                }

                const activeSessions = await manager.find(PaymentCheckoutSession, {
                    where: { status: "reserved" },
                });
                const installmentReservationPredicate = input.warehouse_id
                    ? `AND ("warehouse_id" IS NULL OR "warehouse_id" = $2)`
                    : "";
                const reservationParameters = input.warehouse_id
                    ? [input.items.map((item) => item.product_id), input.warehouse_id]
                    : [input.items.map((item) => item.product_id)];
                const reservationRows = await manager.query(`
                    SELECT "product_id", COALESCE(SUM("quantity_delta"), 0)::integer AS "reserved_quantity"
                    FROM "installment_stock_events"
                    WHERE "product_id" = ANY($1::uuid[])
                      ${installmentReservationPredicate}
                    GROUP BY "product_id"
                `, reservationParameters) as Array<{ product_id: string; reserved_quantity: number }>;
                const installmentReserved = new Map(reservationRows.map((row) =>
                    [row.product_id, Number(row.reserved_quantity)]));

                let priceTotalCents = 0n;
                let netSubtotalCents = 0n;
                let taxCents = 0n;
                const lines: Array<Record<string, unknown>> = [];
                for (let index = 0; index < input.items.length; index += 1) {
                    const requestedItem = input.items[index];
                    const product = products.find((item) => item.id === requestedItem.product_id);
                    if (!product) throw new Error("Locked product lookup did not return a requested product");
                    const checkoutReserved = getReservedQuantity(
                        activeSessions,
                        product.id,
                        undefined,
                        input.warehouse_id || undefined,
                    );
                    const otherInstallmentReserved = installmentReserved.get(product.id) || 0;
                    let availableQuantity = Number(product.stock_on_hand);
                    if (input.warehouse_id) {
                        const warehouseStock = await manager.findOne(WarehouseStock, {
                            where: { warehouse_id: input.warehouse_id, product_id: product.id },
                            lock: { mode: "pessimistic_read" },
                        });
                        availableQuantity = Number(warehouseStock?.stock_on_hand || 0);
                    }
                    availableQuantity -= checkoutReserved + otherInstallmentReserved;
                    if (availableQuantity < requestedItem.quantity) {
                        throw new InstallmentQuoteError(
                            409,
                            `Insufficient unreserved stock for ${product.name}; available quantity is ${Math.max(0, availableQuantity)}`,
                        );
                    }

                    const segments = await PromotionPricingService.priceProduct(
                        manager,
                        product,
                        requestedItem.quantity,
                        activeSessions,
                        { lock: true },
                    );
                    if (segments.some((segment) => segment.promotionItemId !== null)) {
                        throw new InstallmentQuoteError(
                            409,
                            "Installment agreements cannot reserve products with an active timed promotion; request a new quote after the promotion ends",
                        );
                    }
                    const taxRateBps = percentageToBasisPoints(String(
                        product.tax_class?.rate ?? product.tax_rate ?? 0,
                    ));
                    const segmentLines = segments.map((segment) => {
                        const lineCents = segment.unitPriceCents * BigInt(segment.quantity);
                        const tax = calculateInclusiveVatCents(lineCents, taxRateBps);
                        priceTotalCents += lineCents;
                        netSubtotalCents += tax.netRevenueCents;
                        taxCents += tax.vatCents;
                        return {
                            quantity: segment.quantity,
                            unit_price: kesFromCents(segment.unitPriceCents),
                            line_total: kesFromCents(lineCents),
                            promotion_applied: segment.promotionApplied,
                            promotion_id: segment.promotionId,
                            promotion_name: segment.promotionName,
                            original_unit_price: segment.promotionApplied
                                ? kesFromCents(segment.originalUnitPriceCents)
                                : null,
                            discount_per_unit: segment.promotionApplied
                                ? kesFromCents(segment.discountPerUnitCents)
                                : "0.00",
                        };
                    });
                    lines.push({
                        product_id: product.id,
                        product_name: product.name,
                        sku: product.sku,
                        unit_of_measure: product.unit_of_measure,
                        quantity: requestedItem.quantity,
                        tax_rate_percent: String(product.tax_class?.rate ?? product.tax_rate ?? 0),
                        available_quantity: Math.max(0, availableQuantity),
                        segments: segmentLines,
                    });
                }

                const minimumDepositCents = minimumInstallmentDepositCents(
                    priceTotalCents,
                    plan.min_deposit_percent_bps,
                );
                const depositCents = input.deposit_amount === null
                    ? minimumDepositCents
                    : parseKesToCents(input.deposit_amount);
                if (priceTotalCents <= 0n) {
                    throw new InstallmentQuoteError(400, "Installment items must have a positive total price");
                }
                const calculation = createInstallmentQuote({
                    priceTotalCents,
                    depositCents,
                    agreementDate,
                    terms: {
                        number_of_installments: plan.number_of_installments,
                        frequency: plan.frequency as "WEEKLY" | "EVERY_2_WEEKS" | "MONTHLY",
                        min_deposit_percent_bps: plan.min_deposit_percent_bps,
                        interest_type: plan.interest_type as "FLAT_TOTAL" | "FLAT_PER_MONTH",
                        interest_rate_bps: plan.interest_rate_bps,
                    },
                });
                const financedCents = calculation.financed_cents;
                if (plan.min_financed_cents !== null && financedCents < BigInt(plan.min_financed_cents)) {
                    throw new InstallmentQuoteError(400, "Financed amount is below the plan minimum");
                }
                if (plan.max_financed_cents !== null && financedCents > BigInt(plan.max_financed_cents)) {
                    throw new InstallmentQuoteError(400, "Financed amount exceeds the plan maximum");
                }
                const maxOpenCreditSetting = await manager.findOneBy(Setting, {
                    key: "installment_max_open_credit_cents",
                });
                const maxOpenCreditCents = BigInt(parseStoredInstallmentCents(
                    maxOpenCreditSetting?.value ?? "0",
                    "installment_max_open_credit_cents",
                ));
                const currentOpenCreditCents = await readOpenCreditCents(manager, customer.id);
                const newOpenCreditCents = calculateInstallmentBalanceCents({
                    totalPayableCents: calculation.total_payable_cents,
                    allocatedPaymentCents: depositCents,
                    reversedPaymentCents: 0n,
                    writtenOffCents: 0n,
                });
                const creditLimitExceeded = maxOpenCreditCents > 0n &&
                    currentOpenCreditCents + newOpenCreditCents > maxOpenCreditCents;

                return {
                    agreement_date: agreementDate,
                    customer: {
                        id: customer.id,
                        name: customer.name,
                        phone: customer.phone,
                        national_id: customer.national_id,
                    },
                    plan: {
                        id: plan.id,
                        name: plan.name,
                        number_of_installments: plan.number_of_installments,
                        frequency: plan.frequency,
                        min_deposit_percent_bps: plan.min_deposit_percent_bps,
                        interest_type: plan.interest_type,
                        interest_rate_bps: plan.interest_rate_bps,
                        release_mode: plan.release_mode,
                        months_hundredths: calculation.months_hundredths,
                    },
                    items: lines,
                    price_total: kesFromCents(priceTotalCents),
                    subtotal_exclusive_vat: kesFromCents(netSubtotalCents),
                    vat_amount: kesFromCents(taxCents),
                    minimum_deposit: kesFromCents(minimumDepositCents),
                    deposit: kesFromCents(calculation.deposit_cents),
                    financed_amount: kesFromCents(calculation.financed_cents),
                    interest_amount: kesFromCents(calculation.interest_cents),
                    total_payable: kesFromCents(calculation.total_payable_cents),
                    schedule: calculation.schedule.map((item) => ({
                        installment_number: item.installment_number,
                        due_date: item.due_date,
                        principal: kesFromCents(item.principal_cents),
                        principal_cents: item.principal_cents.toString(),
                        interest: kesFromCents(item.interest_cents),
                        interest_cents: item.interest_cents.toString(),
                        amount: kesFromCents(item.principal_cents + item.interest_cents),
                    })),
                    credit: {
                        current_open_credit: kesFromCents(currentOpenCreditCents),
                        maximum_open_credit: kesFromCents(maxOpenCreditCents),
                        requires_manager_override: creditLimitExceeded,
                    },
                };
            });
            return res.json(quote);
        } catch (error) {
            if (error instanceof InstallmentQuoteError) {
                return res.status(error.statusCode).json({ message: error.message });
            }
            if (error instanceof Error &&
                /^(Installment quote|Installment price total|Installment total payable|Unknown installment quote field|Unknown installment item field|customer_id|plan_id|warehouse_id|items|Each installment item|Each product_id|Item quantities|Combined item quantity|deposit_amount)/.test(error.message)) {
                return res.status(400).json({ message: error.message });
            }
            console.error("Error quoting installment agreement:", error);
            return res.status(500).json({ message: "Error calculating installment agreement quote" });
        }
    }
}
