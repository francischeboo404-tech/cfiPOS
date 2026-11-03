import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { CreditNote } from "../entity/CreditNote";
import { JournalLine } from "../entity/JournalLine";
import { Product } from "../entity/Product";
import { ReturnItem } from "../entity/ReturnItem";
import { ReturnStatus } from "../entity/ReturnRequest";
import { PaymentMethod, Sale, SaleStatus } from "../entity/Sale";
import { SaleItem } from "../entity/SaleItem";
import { InventoryService } from "../services/InventoryService";
import { AccountingService } from "../services/AccountingService";
import { SaleProcessingFee } from "../entity/SaleProcessingFee";
import { SaleProcessingFeeCorrection } from "../entity/SaleProcessingFeeCorrection";
import { centsToKesString, divideRoundHalfUp, parseKesDecimalToCents } from "../lib/exactMoney";
import {
    calculateNetProductProfitability,
    calculateProfitability,
    canViewFinancialReports,
    mergeSalesAndRefundBuckets,
    parseReportDateFilter,
    ReportDateFilter,
    summarizeHourlyDemand,
} from "./ReportAnalytics";
import { ObjectLiteral, SelectQueryBuilder } from "typeorm";

const numeric = (value: unknown): number => {
    const result = Number(value ?? 0);
    return Number.isFinite(result) ? result : 0;
};

interface ProductReturnAggregate {
    product_id: string;
    name: string;
    sku: string;
    quantity: number;
    net_revenue_cents: string;
    cogs_cents: string;
    missing_cost_count: number;
    missing_revenue_count: number;
}

export class ReportController {
    private static isUniqueConstraintViolation(error: unknown): boolean {
        if (typeof error !== "object" || error === null) return false;
        if ("code" in error && error.code === "23505") return true;
        if (!("driverError" in error) || typeof error.driverError !== "object" || error.driverError === null) {
            return false;
        }
        return "code" in error.driverError && error.driverError.code === "23505";
    }

    private static parseUtcDate(value: unknown): string | null {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
    }

    static async listUnrecordedProcessingFees(req: AuthenticatedRequest, res: Response) {
        const startDate = this.parseUtcDate(req.query.start_date);
        const endDate = this.parseUtcDate(req.query.end_date);
        if (!startDate || !endDate || startDate > endDate) {
            return res.status(400).json({ message: "Valid start_date and end_date are required." });
        }
        const endExclusive = new Date(`${endDate}T00:00:00.000Z`);
        endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

        try {
            const rows = await AppDataSource.query(
                `SELECT s.id AS sale_id, s.created_at, s.payment_method, s.mpesa_amount, s.total_amount
                 FROM sales s
                 WHERE s.created_at >= $1 AND s.created_at < $2
                   AND (s.payment_method = $3 OR s.mpesa_amount > 0)
                   AND (
                     s.status IN ($4, $5)
                     OR (s.status = $6 AND EXISTS (
                       SELECT 1 FROM credit_notes cn WHERE cn.sale_id = s.id
                     ))
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM sale_processing_fees f WHERE f.sale_id = s.id
                   )
                 ORDER BY s.created_at, s.id`,
                [
                    `${startDate}T00:00:00.000Z`,
                    endExclusive.toISOString(),
                    PaymentMethod.MPESA,
                    SaleStatus.COMPLETED,
                    SaleStatus.PARTIALLY_REFUNDED,
                    SaleStatus.VOIDED,
                ],
            );
            return res.json({ sales: rows });
        } catch (error) {
            console.error("Unable to list unrecorded electronic payment fees:", error);
            return res.status(500).json({ message: "Unable to load unrecorded electronic payment fees." });
        }
    }

    static async recordProcessingFee(req: AuthenticatedRequest, res: Response) {
        const body = req.body && typeof req.body === "object"
            ? req.body as Record<string, unknown>
            : {};
        const saleId = typeof body.sale_id === "string" ? body.sale_id : "";
        const incurredDate = this.parseUtcDate(body.incurred_date);
        const feeCentsText = typeof body.fee_cents === "string" ? body.fee_cents : "";
        const recoverableVatCentsText = typeof body.recoverable_vat_cents === "string"
            ? body.recoverable_vat_cents
            : "";
        const statementReference = typeof body.statement_reference === "string"
            ? body.statement_reference.trim()
            : "";
        const transactionReference = typeof body.transaction_reference === "string"
            ? body.transaction_reference.trim()
            : "";
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const centsPattern = /^(0|[1-9]\d{0,14})$/;

        if (!uuidPattern.test(saleId) || !incurredDate || !centsPattern.test(feeCentsText)
            || !centsPattern.test(recoverableVatCentsText)
            || incurredDate > new Date().toISOString().slice(0, 10)
            || !statementReference || statementReference.length > 120
            || transactionReference.length > 120) {
            return res.status(400).json({ message: "Provide a sale, valid fee date, whole-cent amounts, and a statement reference." });
        }

        const feeCents = BigInt(feeCentsText);
        const recoverableVatCents = BigInt(recoverableVatCentsText);
        if (recoverableVatCents > feeCents) {
            return res.status(400).json({ message: "Recoverable VAT cannot exceed the total processing fee." });
        }

        try {
            const recorded = await AppDataSource.transaction(async (manager) => {
                const [sale] = await manager.query(
                    `SELECT id FROM sales s
                     WHERE s.id = $1
                       AND (s.payment_method = $2 OR s.mpesa_amount > 0)
                       AND (
                         s.status IN ($3, $4)
                         OR (s.status = $5 AND EXISTS (
                           SELECT 1 FROM credit_notes cn WHERE cn.sale_id = s.id
                         ))
                       )
                     FOR UPDATE`,
                    [saleId, PaymentMethod.MPESA, SaleStatus.COMPLETED, SaleStatus.PARTIALLY_REFUNDED, SaleStatus.VOIDED],
                );
                if (!sale) return false;

                const fee = manager.create(SaleProcessingFee, {
                    sale_id: saleId,
                    fee_cents: feeCents.toString(),
                    recoverable_vat_cents: recoverableVatCents.toString(),
                    incurred_date: incurredDate,
                    statement_reference: statementReference,
                    transaction_reference: transactionReference || null,
                    recorded_by: req.user!.id,
                });
                await manager.save(fee);
                await AccountingService.recordSaleProcessingFee(
                    manager, saleId, incurredDate, feeCents, recoverableVatCents, statementReference,
                );
                return true;
            });
            if (!recorded) return res.status(404).json({ message: "Eligible electronic-payment sale was not found." });
            return res.status(201).json({ message: "Provider fee recorded and posted to the accounting ledger." });
        } catch (error) {
            if (this.isUniqueConstraintViolation(error)) {
                return res.status(409).json({ message: "A fee record already exists for this sale." });
            }
            console.error("Unable to record electronic payment fee:", error);
            return res.status(500).json({ message: "Unable to record electronic payment fee." });
        }
    }

    static async listRecordedProcessingFees(req: AuthenticatedRequest, res: Response) {
        const startDate = this.parseUtcDate(req.query.start_date);
        const endDate = this.parseUtcDate(req.query.end_date);
        if (!startDate || !endDate || startDate > endDate) {
            return res.status(400).json({ message: "Valid start_date and end_date are required." });
        }
        const endExclusive = new Date(`${endDate}T00:00:00.000Z`);
        endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

        try {
            const fees = await AppDataSource.query(
                `SELECT s.id AS sale_id, f.id AS fee_id,
                        COALESCE(c.fee_cents, f.fee_cents)::text AS fee_cents,
                        COALESCE(c.recoverable_vat_cents, f.recoverable_vat_cents)::text AS recoverable_vat_cents,
                        COALESCE(c.incurred_date, f.incurred_date)::text AS incurred_date,
                        COALESCE(c.statement_reference, f.statement_reference) AS statement_reference,
                        COALESCE(c.transaction_reference, f.transaction_reference) AS transaction_reference,
                        COALESCE(c.revision, 0) AS revision
                 FROM sale_processing_fees f
                 JOIN sales s ON s.id = f.sale_id
                 LEFT JOIN LATERAL (
                    SELECT correction.fee_cents, correction.recoverable_vat_cents,
                           correction.incurred_date, correction.statement_reference,
                           correction.transaction_reference, correction.revision
                    FROM sale_processing_fee_corrections correction
                    WHERE correction.fee_id = f.id
                    ORDER BY correction.revision DESC
                    LIMIT 1
                 ) c ON true
                 WHERE s.created_at >= $1 AND s.created_at < $2
                 ORDER BY s.created_at, s.id`,
                [`${startDate}T00:00:00.000Z`, endExclusive.toISOString()],
            );
            return res.json({ fees });
        } catch (error) {
            console.error("Unable to list recorded electronic payment fees:", error);
            return res.status(500).json({ message: "Unable to load recorded electronic payment fees." });
        }
    }

    static async correctProcessingFee(req: AuthenticatedRequest, res: Response) {
        const body = req.body && typeof req.body === "object"
            ? req.body as Record<string, unknown>
            : {};
        const saleId = typeof req.params.sale_id === "string" ? req.params.sale_id : "";
        const incurredDate = this.parseUtcDate(body.incurred_date);
        const feeCentsText = typeof body.fee_cents === "string" ? body.fee_cents : "";
        const recoverableVatCentsText = typeof body.recoverable_vat_cents === "string"
            ? body.recoverable_vat_cents
            : "";
        const statementReference = typeof body.statement_reference === "string"
            ? body.statement_reference.trim()
            : "";
        const transactionReference = typeof body.transaction_reference === "string"
            ? body.transaction_reference.trim()
            : "";
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const centsPattern = /^(0|[1-9]\d{0,14})$/;
        if (!uuidPattern.test(saleId) || !incurredDate || !centsPattern.test(feeCentsText)
            || !centsPattern.test(recoverableVatCentsText)
            || incurredDate > new Date().toISOString().slice(0, 10)
            || !statementReference || statementReference.length > 120
            || transactionReference.length > 120 || reason.length < 5 || reason.length > 1000) {
            return res.status(400).json({
                message: "Provide a valid fee date, whole-cent amounts, statement reference, and correction reason (5-1000 characters).",
            });
        }

        const feeCents = BigInt(feeCentsText);
        const recoverableVatCents = BigInt(recoverableVatCentsText);
        if (recoverableVatCents > feeCents) {
            return res.status(400).json({ message: "Recoverable VAT cannot exceed the total processing fee." });
        }

        try {
            const corrected = await AppDataSource.transaction(async (manager) => {
                const fee = await manager.findOne(SaleProcessingFee, {
                    where: { sale_id: saleId },
                    lock: { mode: "pessimistic_write" },
                });
                if (!fee) return "missing" as const;

                const [latest] = await manager.query(
                    `SELECT revision, fee_cents, recoverable_vat_cents, incurred_date,
                            statement_reference, transaction_reference, corrected_journal_entry_id
                     FROM sale_processing_fee_corrections
                     WHERE fee_id = $1
                     ORDER BY revision DESC
                     LIMIT 1`,
                    [fee.id],
                );
                const current = latest || fee;
                if (String(current.fee_cents) === feeCentsText
                    && String(current.recoverable_vat_cents) === recoverableVatCentsText
                    && String(current.incurred_date).slice(0, 10) === incurredDate
                    && current.statement_reference === statementReference
                    && (current.transaction_reference || "") === (transactionReference || "")) {
                    return "unchanged" as const;
                }

                const previousJournalEntryId = latest
                    ? latest.corrected_journal_entry_id as string | null
                    : ((await manager.query(
                        `SELECT id FROM journal_entries
                         WHERE reference_id = $1 AND reference_type = 'SALE_PROCESSING_FEE'
                         ORDER BY created_at DESC LIMIT 1`,
                        [saleId],
                    ))[0]?.id as string | undefined) || null;
                const correctionDate = new Date().toISOString().slice(0, 10);
                const journals = await AccountingService.correctSaleProcessingFee(
                    manager,
                    saleId,
                    correctionDate,
                    previousJournalEntryId,
                    feeCents,
                    recoverableVatCents,
                    statementReference,
                );
                const correction = manager.create(SaleProcessingFeeCorrection, {
                    fee_id: fee.id,
                    revision: Number(latest?.revision ?? 0) + 1,
                    fee_cents: feeCents.toString(),
                    recoverable_vat_cents: recoverableVatCents.toString(),
                    incurred_date: incurredDate,
                    statement_reference: statementReference,
                    transaction_reference: transactionReference || null,
                    reason,
                    reversal_journal_entry_id: journals.reversalJournalEntryId,
                    corrected_journal_entry_id: journals.correctedJournalEntryId,
                    recorded_by: req.user!.id,
                });
                await manager.save(correction);
                return "corrected" as const;
            });
            if (corrected === "missing") {
                return res.status(404).json({ message: "Recorded provider fee was not found for this sale." });
            }
            if (corrected === "unchanged") {
                return res.status(409).json({ message: "The supplied fee values match the current record; no correction was posted." });
            }
            return res.status(201).json({
                message: "Fee correction was recorded. The prior posting was reversed and the corrected fee was posted in the correction period.",
            });
        } catch (error) {
            console.error("Unable to correct electronic payment fee:", error);
            return res.status(500).json({ message: "Unable to correct electronic payment fee." });
        }
    }

    private static withHourFilter<T extends ObjectLiteral>(
        query: SelectQueryBuilder<T>,
        filter: ReportDateFilter,
        column: string,
    ): SelectQueryBuilder<T> {
        const hourFilter = this.hourCondition(filter, column);
        if (hourFilter) query.andWhere(hourFilter.condition, hourFilter.parameters);
        return query;
    }

    private static hourCondition(filter: ReportDateFilter, column: string) {
        if (filter.hourStart === undefined || filter.hourEnd === undefined) return null;
        const hourExpression = `EXTRACT(HOUR FROM (${column} AT TIME ZONE :reportTimeZone))`;
        const condition = filter.hourStart < filter.hourEnd
            ? `${hourExpression} >= :hourStart AND ${hourExpression} < :hourEnd`
            : `(${hourExpression} >= :hourStart OR ${hourExpression} < :hourEnd)`;
        return {
            condition,
            parameters: {
                reportTimeZone: filter.timeZone,
                hourStart: filter.hourStart,
                hourEnd: filter.hourEnd,
            },
        };
    }

    private static salesQuery(filter: ReportDateFilter, start = filter.start, end = filter.end) {
        const query = AppDataSource.getRepository(Sale).createQueryBuilder("sale")
            .where(`(
                sale.status IN (:...statuses)
                OR (sale.status = :voidedStatus AND EXISTS (
                    SELECT 1 FROM credit_notes report_credit_note
                    WHERE report_credit_note.sale_id = sale.id
                ))
            )`, {
                statuses: [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_REFUNDED],
                voidedStatus: SaleStatus.VOIDED,
            })
            .andWhere("sale.created_at >= :start AND sale.created_at < :end", { start, end });

        return this.withHourFilter(query, filter, "sale.created_at");
    }

    static async getSummary(req: AuthenticatedRequest, res: Response) {
        let filter: ReportDateFilter;
        try {
            filter = parseReportDateFilter(req.query as Record<string, unknown>);
        } catch (error) {
            return res.status(400).json({
                message: error instanceof Error ? error.message : "Valid report filters are required",
            });
        }

        try {
            const saleRepo = AppDataSource.getRepository(Sale);
            const productRepo = AppDataSource.getRepository(Product);
            const sales = this.salesQuery(filter);
            const from = filter.start;
            const to = filter.end;
            const costingBaselines: Array<{ created_at: Date | string; valuation_method: string }> =
                await AppDataSource.query(`
                    SELECT "created_at", "valuation_method"
                    FROM "inventory_costing_baselines"
                    WHERE "id" = 1
                `);
            const costingBaselineAt = costingBaselines[0]?.valuation_method === "weighted_average_opening_snapshot"
                ? new Date(costingBaselines[0].created_at)
                : null;
            const trustedCostingBaselineAt = costingBaselineAt && Number.isFinite(costingBaselineAt.getTime())
                ? costingBaselineAt
                : null;
            const productSalesQuery = AppDataSource.getRepository(SaleItem).createQueryBuilder("item")
                .innerJoin("item.sale", "sale")
                .innerJoin("item.product", "product")
                .select("product.id", "product_id")
                .addSelect("product.name", "name")
                .addSelect("product.sku", "sku")
                .addSelect("SUM(item.quantity)", "total_quantity")
                .addSelect("COALESCE(SUM(item.net_revenue_cents::numeric), 0)::text", "net_revenue_cents")
                .addSelect("COALESCE(SUM(item.cogs_total_cents::numeric), 0)::text", "cogs_cents")
                .addSelect(`COUNT(item.id) FILTER (
                    WHERE item.cogs_total_cents IS NULL
                        OR CAST(:trustedCostingBaselineAt AS timestamptz) IS NULL
                        OR sale.created_at < CAST(:trustedCostingBaselineAt AS timestamptz)
                )`, "missing_cost_count")
                .addSelect("COUNT(item.id) FILTER (WHERE item.net_revenue_cents IS NULL)", "missing_revenue_count")
                .where(`(
                    sale.status IN (:...statuses)
                    OR (sale.status = :voidedStatus AND EXISTS (
                        SELECT 1 FROM credit_notes report_credit_note
                        WHERE report_credit_note.sale_id = sale.id
                    ))
                )`, {
                    statuses: [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_REFUNDED],
                    voidedStatus: SaleStatus.VOIDED,
                })
                .andWhere("sale.created_at >= :start AND sale.created_at < :end", { start: from, end: to })
                .setParameter("trustedCostingBaselineAt", trustedCostingBaselineAt);
            this.withHourFilter(productSalesQuery, filter, "sale.created_at");

            const productReturnsQuery = AppDataSource.getRepository(ReturnItem).createQueryBuilder("returnItem")
                .innerJoin("returnItem.return_request", "returnRequest")
                .innerJoin("returnItem.sale_item", "saleItem")
                .innerJoin("saleItem.product", "product")
                .innerJoin("saleItem.sale", "sale")
                .innerJoin(CreditNote, "creditNote", "creditNote.return_request_id = returnRequest.id")
                .select("product.id", "product_id")
                .addSelect("product.name", "name")
                .addSelect("product.sku", "sku")
                .addSelect("SUM(returnItem.quantity)", "quantity")
                .addSelect('COALESCE(SUM("returnItem".net_revenue_cents::numeric), 0)::text', "net_revenue_cents")
                .addSelect('COALESCE(SUM("returnItem".cogs_total_cents::numeric), 0)::text', "cogs_cents")
                .addSelect(`COUNT("returnItem".id) FILTER (
                    WHERE "returnItem".cogs_total_cents IS NULL
                        OR CAST(:trustedCostingBaselineAt AS timestamptz) IS NULL
                        OR sale.created_at < CAST(:trustedCostingBaselineAt AS timestamptz)
                )`, "missing_cost_count")
                .addSelect('COUNT("returnItem".id) FILTER (WHERE "returnItem".net_revenue_cents IS NULL)', "missing_revenue_count")
                .where("returnRequest.status = :approved", { approved: ReturnStatus.APPROVED })
                .andWhere("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: from, end: to })
                .setParameter("trustedCostingBaselineAt", trustedCostingBaselineAt);
            this.withHourFilter(productReturnsQuery, filter, "creditNote.created_at");

            const fullVoidProductReturnsQuery = AppDataSource.getRepository(SaleItem).createQueryBuilder("item")
                .innerJoin("item.sale", "sale")
                .innerJoin("item.product", "product")
                .innerJoin(CreditNote, "creditNote", "creditNote.sale_id = sale.id")
                .select("product.id", "product_id")
                .addSelect("product.name", "name")
                .addSelect("product.sku", "sku")
                .addSelect("SUM(item.quantity)", "quantity")
                .addSelect("COALESCE(SUM(item.net_revenue_cents::numeric), 0)::text", "net_revenue_cents")
                .addSelect("COALESCE(SUM(item.cogs_total_cents::numeric), 0)::text", "cogs_cents")
                .addSelect(`COUNT(item.id) FILTER (
                    WHERE item.cogs_total_cents IS NULL
                        OR CAST(:trustedCostingBaselineAt AS timestamptz) IS NULL
                        OR sale.created_at < CAST(:trustedCostingBaselineAt AS timestamptz)
                )`, "missing_cost_count")
                .addSelect("COUNT(item.id) FILTER (WHERE item.net_revenue_cents IS NULL)", "missing_revenue_count")
                .where("sale.status = :voidedStatus", { voidedStatus: SaleStatus.VOIDED })
                .andWhere("creditNote.return_request_id IS NULL")
                .andWhere("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: from, end: to })
                .setParameter("trustedCostingBaselineAt", trustedCostingBaselineAt);
            this.withHourFilter(fullVoidProductReturnsQuery, filter, "creditNote.created_at");

            const [
                salesTotals,
                payments,
                productRows,
                approvedProductReturnRows,
                fullVoidProductReturnRows,
                products,
                stockTotals,
            ] = await Promise.all([
                sales.clone().select([
                    "COALESCE(SUM(sale.subtotal::numeric), 0)::text AS gross_subtotal",
                    "COALESCE(SUM(sale.loyalty_discount::numeric), 0)::text AS discounts",
                    "COALESCE(SUM(sale.tax_amount::numeric), 0)::text AS tax_amount",
                    "COALESCE(SUM((sale.subtotal + sale.tax_amount)::numeric), 0)::text AS gross_sales",
                    "COALESCE(SUM(sale.total_amount::numeric), 0)::text AS net_sales",
                    "COUNT(sale.id) FILTER (WHERE sale.payment_method IN (:...feeBearingPaymentMethods) OR sale.mpesa_amount > 0) AS fee_bearing_transactions",
                    "COUNT(sale.id) AS transaction_count",
                    "COUNT(DISTINCT DATE_TRUNC('day', (sale.created_at AT TIME ZONE :reportTimeZone))) AS active_days",
                ]).setParameters({
                    reportTimeZone: filter.timeZone,
                    feeBearingPaymentMethods: [PaymentMethod.MPESA, PaymentMethod.HYBRID],
                }).getRawOne(),
                sales.clone()
                    .select("sale.payment_method", "method")
                    .addSelect("COALESCE(SUM(sale.total_amount::numeric), 0)::text", "total")
                    .addSelect("COUNT(sale.id)", "count")
                    .groupBy("sale.payment_method")
                    .getRawMany(),
                productSalesQuery
                    .groupBy("product.id")
                    .addGroupBy("product.name")
                    .addGroupBy("product.sku")
                    .orderBy("product.id", "ASC")
                    .getRawMany(),
                canViewFinancialReports(req.user?.role)
                    ? productReturnsQuery
                        .groupBy("product.id")
                        .addGroupBy("product.name")
                        .addGroupBy("product.sku")
                        .getRawMany()
                    : Promise.resolve([]),
                canViewFinancialReports(req.user?.role)
                    ? fullVoidProductReturnsQuery
                        .groupBy("product.id")
                        .addGroupBy("product.name")
                        .addGroupBy("product.sku")
                        .getRawMany()
                    : Promise.resolve([]),
                productRepo.find({
                    select: { id: true, name: true, sku: true, stock_on_hand: true, reorder_level: true },
                    order: { stock_on_hand: "ASC" },
                }),
                InventoryService.getTotalStockByProduct(AppDataSource.manager),
            ]);

            const returnedProducts = new Map<string, ProductReturnAggregate>();
            for (const returned of [...approvedProductReturnRows, ...fullVoidProductReturnRows]) {
                const current = returnedProducts.get(returned.product_id) || {
                    product_id: returned.product_id,
                    name: returned.name,
                    sku: returned.sku,
                    quantity: 0,
                    net_revenue_cents: "0",
                    cogs_cents: "0",
                    missing_cost_count: 0,
                    missing_revenue_count: 0,
                };
                current.quantity += numeric(returned.quantity);
                current.net_revenue_cents = (
                BigInt(current.net_revenue_cents) + BigInt(returned.net_revenue_cents ?? "0")
                ).toString();
                current.cogs_cents = (BigInt(current.cogs_cents) + BigInt(returned.cogs_cents ?? "0")).toString();
                current.missing_cost_count += numeric(returned.missing_cost_count);
                current.missing_revenue_count += numeric(returned.missing_revenue_count);
                returnedProducts.set(returned.product_id, current);
            }
            const productReturnRows = Array.from(returnedProducts.values());

            let returnTotals = null;
            let cogsReversals = null;
            let expenseTotals = null;
            let taxReversals = null;
            let inventoryLosses = null;
            if (canViewFinancialReports(req.user?.role)) {
                const creditNoteTotalsQuery = AppDataSource.getRepository(CreditNote).createQueryBuilder("creditNote")
                    .select("COALESCE(SUM(creditNote.amount), 0)", "refund_amount")
                    .addSelect("COUNT(creditNote.id)", "refund_transactions")
                    .where("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: from, end: to });
                this.withHourFilter(creditNoteTotalsQuery, filter, "creditNote.created_at");

                const cogsReversalQuery = AppDataSource.getRepository(JournalLine).createQueryBuilder("line")
                    .innerJoin("line.journal_entry", "entry")
                    .innerJoin("line.account", "account")
                    .select("COALESCE(SUM(line.credit), 0)", "cogs_reversed")
                    .where("entry.reference_type = :referenceType", { referenceType: "SALE_VOID" })
                    .andWhere("account.code = :accountCode", { accountCode: "5000" })
                    .andWhere("entry.created_at >= :start AND entry.created_at < :end", { start: from, end: to });
                this.withHourFilter(cogsReversalQuery, filter, "entry.created_at");

                const expenseQuery = AppDataSource.getRepository(JournalLine).createQueryBuilder("line")
                    .innerJoin("line.journal_entry", "entry")
                    .innerJoin("line.account", "account")
                    .select("COALESCE(SUM(line.debit - line.credit), 0)", "expenses")
                    .where("account.type = :expenseType", { expenseType: "expense" })
                    .andWhere("account.code NOT IN (:...excludedCodes)", { excludedCodes: ["5000", "5100", "5200"] })
                    .andWhere("entry.created_at >= :start AND entry.created_at < :end", { start: from, end: to });
                this.withHourFilter(expenseQuery, filter, "entry.created_at");

                const inventoryLossQuery = AppDataSource.getRepository(JournalLine).createQueryBuilder("line")
                    .innerJoin("line.journal_entry", "entry")
                    .innerJoin("line.account", "account")
                    .select("COALESCE(SUM(line.debit - line.credit), 0)", "inventory_losses")
                    .where("account.code = :shrinkageCode", { shrinkageCode: "5100" })
                    .andWhere("entry.created_at >= :start AND entry.created_at < :end", { start: from, end: to });
                this.withHourFilter(inventoryLossQuery, filter, "entry.created_at");

                const taxReversalQuery = AppDataSource.getRepository(JournalLine).createQueryBuilder("line")
                    .innerJoin("line.journal_entry", "entry")
                    .innerJoin("line.account", "account")
                    .select("COALESCE(SUM(line.debit), 0)", "tax_reversed")
                    .where("entry.reference_type = :referenceType", { referenceType: "SALE_VOID" })
                    .andWhere("account.code = :accountCode", { accountCode: "2200" })
                    .andWhere("entry.created_at >= :start AND entry.created_at < :end", { start: from, end: to });
                this.withHourFilter(taxReversalQuery, filter, "entry.created_at");

                [returnTotals, cogsReversals, expenseTotals, taxReversals, inventoryLosses] = await Promise.all([
                    creditNoteTotalsQuery.getRawOne(),
                    cogsReversalQuery.getRawOne(),
                    expenseQuery.getRawOne(),
                    taxReversalQuery.getRawOne(),
                    inventoryLossQuery.getRawOne(),
                ]);
            }

            const lowStock = products
                .map((product) => ({
                    id: product.id,
                    name: product.name,
                    sku: product.sku,
                    stock_on_hand: InventoryService.getTotalStockOnHand(product, stockTotals),
                    reorder_level: product.reorder_level,
                }))
                .filter((product) => product.stock_on_hand <= product.reorder_level);

            const returnedByProduct = new Map<string, typeof productReturnRows[number]>(
                productReturnRows.map((row) => [row.product_id, row]),
            );
            const productsById = new Map<string, typeof productRows[number]>(
                productRows.map((product) => [product.product_id, product]),
            );
            for (const returned of productReturnRows) {
                if (!productsById.has(returned.product_id)) {
                    productsById.set(returned.product_id, {
                        product_id: returned.product_id,
                        name: returned.name,
                        sku: returned.sku,
                        total_quantity: 0,
                        net_revenue_cents: "0",
                        cogs_cents: "0",
                        missing_cost_count: 0,
                        missing_revenue_count: 0,
                    });
                }
            }
            const topProducts = Array.from(productsById.values()).map((product) => {
                const returned = returnedByProduct.get(product.product_id);
                const profitability = calculateNetProductProfitability(
                    {
                        quantity: numeric(product.total_quantity),
                        revenueCents: BigInt(product.net_revenue_cents ?? "0"),
                        cogsCents: BigInt(product.cogs_cents ?? "0"),
                        missingCosts: numeric(product.missing_cost_count),
                        missingRevenue: numeric(product.missing_revenue_count),
                    },
                    {
                        quantity: numeric(returned?.quantity),
                        revenueCents: BigInt(returned?.net_revenue_cents ?? "0"),
                        cogsCents: BigInt(returned?.cogs_cents ?? "0"),
                        missingCosts: numeric(returned?.missing_cost_count),
                        missingRevenue: numeric(returned?.missing_revenue_count),
                    },
                );
                const summary: Record<string, unknown> = {
                    product_id: product.product_id,
                    name: product.name,
                    sku: product.sku,
                    total_quantity: profitability.quantity,
                };
                if (canViewFinancialReports(req.user?.role)) {
                    summary.revenueCents = profitability.revenueCents;
                    summary.costOfGoodsSoldCents = profitability.costOfGoodsSoldCents;
                    summary.grossProfitCents = profitability.grossProfitCents;
                }
                return summary;
            }).sort((a, b) => numeric(b.total_quantity) - numeric(a.total_quantity)).slice(0, 10);

            const report: Record<string, unknown> = {
                salesByPayment: payments.map((row) => ({
                    method: row.method,
                    totalCents: parseKesDecimalToCents(row.total ?? "0").toString(),
                    count: numeric(row.count),
                })),
                topProducts,
                lowStock,
                start: from.toISOString(),
                end: to.toISOString(),
            };

            if (canViewFinancialReports(req.user?.role)) {
                const discountsCents = parseKesDecimalToCents(salesTotals.discounts ?? "0");
                const grossRevenueCents = parseKesDecimalToCents(salesTotals.gross_subtotal ?? "0") - discountsCents;
                const grossCogsQuery = AppDataSource.getRepository(SaleItem).createQueryBuilder("item")
                    .innerJoin("item.sale", "sale")
                    .select('COALESCE(SUM(item.cogs_total_cents::numeric), 0)::text', "cogs_cents")
                    .addSelect(`COUNT(item.id) FILTER (
                        WHERE item.cogs_total_cents IS NULL
                            OR CAST(:trustedCostingBaselineAt AS timestamptz) IS NULL
                            OR sale.created_at < CAST(:trustedCostingBaselineAt AS timestamptz)
                    )`, "missing_cost_count")
                    .where(`(
                        sale.status IN (:...statuses)
                        OR (sale.status = :voidedStatus AND EXISTS (
                            SELECT 1 FROM credit_notes report_credit_note
                            WHERE report_credit_note.sale_id = sale.id
                        ))
                    )`, {
                        statuses: [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_REFUNDED],
                        voidedStatus: SaleStatus.VOIDED,
                    })
                    .andWhere("sale.created_at >= :start AND sale.created_at < :end", { start: from, end: to })
                    .setParameter("trustedCostingBaselineAt", trustedCostingBaselineAt);
                this.withHourFilter(grossCogsQuery, filter, "sale.created_at");
                const refundRevenueQuery = AppDataSource.getRepository(JournalLine).createQueryBuilder("line")
                    .innerJoin("line.journal_entry", "entry")
                    .innerJoin("line.account", "account")
                    .select("COALESCE(SUM(line.debit), 0)", "revenue_refund")
                    .where("entry.reference_type = :referenceType", { referenceType: "SALE_VOID" })
                    .andWhere("account.code = :accountCode", { accountCode: "4000" })
                    .andWhere("entry.created_at >= :start AND entry.created_at < :end", { start: from, end: to });
                this.withHourFilter(refundRevenueQuery, filter, "entry.created_at");
                const [grossCogs, refundRevenue] = await Promise.all([
                    grossCogsQuery.getRawOne(),
                    refundRevenueQuery.getRawOne(),
                ]);

                const cogsCents = BigInt(String(grossCogs.cogs_cents ?? "0"))
                    - parseKesDecimalToCents(cogsReversals?.cogs_reversed ?? "0");
                const missingReturnedCosts = productReturnRows.reduce(
                    (count, row) => count + numeric(row.missing_cost_count),
                    0,
                );
                const costComplete = numeric(grossCogs.missing_cost_count) === 0 && missingReturnedCosts === 0;
                const netRevenueCents = grossRevenueCents
                    - parseKesDecimalToCents(refundRevenue.revenue_refund ?? "0");
                const processingFeeCostsQuery = AppDataSource.getRepository(SaleProcessingFee).createQueryBuilder("fee")
                    .innerJoin("fee.sale", "sale")
                    .select("COALESCE(SUM(fee.fee_cents - fee.recoverable_vat_cents), 0)::text", "expense_cents")
                    .where("sale.created_at >= :start AND sale.created_at < :end", { start: from, end: to });
                this.withHourFilter(processingFeeCostsQuery, filter, "sale.created_at");
                const processingFeeCorrectionCostsQuery = AppDataSource.createQueryBuilder()
                    .select(
                        `COALESCE(SUM(
                            correction.fee_cents - correction.recoverable_vat_cents
                            - COALESCE((
                                SELECT previous.fee_cents - previous.recoverable_vat_cents
                                FROM sale_processing_fee_corrections previous
                                WHERE previous.fee_id = correction.fee_id
                                  AND previous.revision < correction.revision
                                ORDER BY previous.revision DESC
                                LIMIT 1
                            ), fee.fee_cents - fee.recoverable_vat_cents)
                        ), 0)::text`,
                        "expense_delta_cents",
                    )
                    .from(SaleProcessingFeeCorrection, "correction")
                    .innerJoin(SaleProcessingFee, "fee", "fee.id = correction.fee_id")
                    .where("correction.created_at >= :start AND correction.created_at < :end", { start: from, end: to });
                this.withHourFilter(processingFeeCorrectionCostsQuery, filter, "correction.created_at");
                const [missingProcessingFeeCount, processingFeeTotals, processingFeeCorrectionTotals] = await Promise.all([
                    this.salesQuery(filter)
                        .andWhere("(sale.payment_method = :mpesaMethod OR sale.mpesa_amount > 0)", {
                            mpesaMethod: PaymentMethod.MPESA,
                        })
                        .andWhere(`NOT EXISTS (
                            SELECT 1 FROM sale_processing_fees missing_fee
                            WHERE missing_fee.sale_id = sale.id
                        )`)
                        .getCount(),
                    processingFeeCostsQuery.getRawOne(),
                    processingFeeCorrectionCostsQuery.getRawOne(),
                ]);
                const feeExpenseCents = BigInt(String(processingFeeTotals?.expense_cents ?? "0"))
                    + BigInt(String(processingFeeCorrectionTotals?.expense_delta_cents ?? "0"));
                const transactionCostsCents = missingProcessingFeeCount > 0
                    ? null
                    : feeExpenseCents;
                const profitability = calculateProfitability({
                    netRevenueCents,
                    cogsCents,
                    cogsComplete: costComplete,
                    operatingExpensesCents: parseKesDecimalToCents(expenseTotals?.expenses ?? "0"),
                    inventoryLossesCents: parseKesDecimalToCents(inventoryLosses?.inventory_losses ?? "0"),
                    transactionCostsCents,
                });
                const comparisonDuration = to.getTime() - from.getTime();
                const previousStart = new Date(from.getTime() - comparisonDuration);
                const previousTotals = await this.salesQuery(filter, previousStart, from)
                    .select("COALESCE(SUM(sale.total_amount), 0)", "sales")
                    .addSelect("COUNT(sale.id)", "transactions")
                    .getRawOne();
                const previousRefundQuery = AppDataSource.getRepository(CreditNote).createQueryBuilder("creditNote")
                    .select("COALESCE(SUM(creditNote.amount), 0)", "refunds")
                    .where("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: previousStart, end: from });
                this.withHourFilter(previousRefundQuery, filter, "creditNote.created_at");
                const previousRefunds = await previousRefundQuery.getRawOne();
                const currentNetSalesCents = parseKesDecimalToCents(salesTotals.net_sales ?? "0")
                    - parseKesDecimalToCents(returnTotals?.refund_amount ?? "0");
                const previousNetSalesCents = parseKesDecimalToCents(previousTotals.sales ?? "0")
                    - parseKesDecimalToCents(previousRefunds.refunds ?? "0");
                const salesChangeCents = currentNetSalesCents - previousNetSalesCents;
                const salesChangePercentBasisPoints = previousNetSalesCents > 0n
                    ? divideRoundHalfUp(salesChangeCents * 10_000n, previousNetSalesCents)
                    : null;

                const hourExpression = `EXTRACT(HOUR FROM (sale.created_at AT TIME ZONE :reportTimeZone))`;
                const weekdayExpression = `EXTRACT(DOW FROM (sale.created_at AT TIME ZONE :reportTimeZone))`;
                const trendGrain = comparisonDuration <= 31 * 86_400_000
                    ? "day"
                    : comparisonDuration <= 180 * 86_400_000
                        ? "week"
                        : "month";
                const trendPeriodExpression = `TO_CHAR(DATE_TRUNC('${trendGrain}', (sale.created_at AT TIME ZONE :reportTimeZone)), 'YYYY-MM-DD')`;
                const refundTrendExpression = `TO_CHAR(DATE_TRUNC('${trendGrain}', (creditNote.created_at AT TIME ZONE :reportTimeZone)), 'YYYY-MM-DD')`;
                const hourActiveDays = `COUNT(DISTINCT DATE_TRUNC('day', (sale.created_at AT TIME ZONE :reportTimeZone)))`;
                const weekdayActiveDays = `COUNT(DISTINCT DATE_TRUNC('day', (sale.created_at AT TIME ZONE :reportTimeZone)))`;
                const refundHourExpression = `EXTRACT(HOUR FROM (creditNote.created_at AT TIME ZONE :reportTimeZone))`;
                const refundWeekdayExpression = `EXTRACT(DOW FROM (creditNote.created_at AT TIME ZONE :reportTimeZone))`;
                const refundHeatmapKey = `CAST(${refundWeekdayExpression} AS integer)::text || '-' || CAST(${refundHourExpression} AS integer)::text`;
                const refundTrendQuery = AppDataSource.getRepository(CreditNote).createQueryBuilder("creditNote")
                    .select(refundTrendExpression, "key")
                    .addSelect("SUM(creditNote.amount)", "refunds")
                    .addSelect("COUNT(creditNote.id)", "refundTransactions")
                    .where("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: from, end: to })
                    .setParameter("reportTimeZone", filter.timeZone)
                    .groupBy(refundTrendExpression);
                this.withHourFilter(refundTrendQuery, filter, "creditNote.created_at");

                const refundHourQuery = AppDataSource.getRepository(CreditNote).createQueryBuilder("creditNote")
                    .select(`CAST(${refundHourExpression} AS integer)::text`, "key")
                    .addSelect("SUM(creditNote.amount)", "refunds")
                    .addSelect("COUNT(creditNote.id)", "refundTransactions")
                    .where("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: from, end: to })
                    .setParameter("reportTimeZone", filter.timeZone)
                    .groupBy(refundHourExpression);
                this.withHourFilter(refundHourQuery, filter, "creditNote.created_at");

                const refundWeekdayQuery = AppDataSource.getRepository(CreditNote).createQueryBuilder("creditNote")
                    .select(`CAST(${refundWeekdayExpression} AS integer)::text`, "key")
                    .addSelect("SUM(creditNote.amount)", "refunds")
                    .addSelect("COUNT(creditNote.id)", "refundTransactions")
                    .where("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: from, end: to })
                    .setParameter("reportTimeZone", filter.timeZone)
                    .groupBy(refundWeekdayExpression);
                this.withHourFilter(refundWeekdayQuery, filter, "creditNote.created_at");

                const refundHeatmapQuery = AppDataSource.getRepository(CreditNote).createQueryBuilder("creditNote")
                    .select(refundHeatmapKey, "key")
                    .addSelect("SUM(creditNote.amount)", "refunds")
                    .addSelect("COUNT(creditNote.id)", "refundTransactions")
                    .where("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: from, end: to })
                    .setParameter("reportTimeZone", filter.timeZone)
                    .groupBy(refundHeatmapKey);
                this.withHourFilter(refundHeatmapQuery, filter, "creditNote.created_at");

                const cashierRefundQuery = AppDataSource.getRepository(CreditNote).createQueryBuilder("creditNote")
                    .innerJoin("creditNote.sale", "sale")
                    .leftJoin("sale.cashier", "cashier")
                    .select("cashier.id", "cashier_id")
                    .addSelect("cashier.email", "name")
                    .addSelect('COALESCE(SUM("creditNote".amount::numeric), 0)::text', "refunds_cents")
                    .addSelect("COUNT(creditNote.id)", "refund_count")
                    .where("creditNote.created_at >= :start AND creditNote.created_at < :end", { start: from, end: to })
                    .groupBy("cashier.id")
                    .addGroupBy("cashier.email");
                this.withHourFilter(cashierRefundQuery, filter, "creditNote.created_at");

                const cashierCostsQuery = AppDataSource.getRepository(SaleItem).createQueryBuilder("item")
                    .innerJoin("item.sale", "sale")
                    .leftJoin("sale.cashier", "cashier")
                    .select("cashier.id", "cashier_id")
                    .addSelect("COALESCE(SUM(item.cogs_total_cents::numeric), 0)::text", "cogs_cents")
                    .addSelect(`COUNT(item.id) FILTER (
                        WHERE item.cogs_total_cents IS NULL
                            OR CAST(:trustedCostingBaselineAt AS timestamptz) IS NULL
                            OR sale.created_at < CAST(:trustedCostingBaselineAt AS timestamptz)
                    )`, "missing_cost_count")
                    .where(`(
                        sale.status IN (:...statuses)
                        OR (sale.status = :voidedStatus AND EXISTS (
                            SELECT 1 FROM credit_notes report_credit_note
                            WHERE report_credit_note.sale_id = sale.id
                        ))
                    )`, {
                        statuses: [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_REFUNDED],
                        voidedStatus: SaleStatus.VOIDED,
                    })
                    .andWhere("sale.created_at >= :start AND sale.created_at < :end", { start: from, end: to })
                    .setParameter("trustedCostingBaselineAt", trustedCostingBaselineAt)
                    .groupBy("cashier.id");
                this.withHourFilter(cashierCostsQuery, filter, "sale.created_at");

                const cashierRevenueReversalQuery = AppDataSource.getRepository(JournalLine).createQueryBuilder("line")
                    .innerJoin("line.journal_entry", "entry")
                    .innerJoin("line.account", "account")
                    .innerJoin(Sale, "sale", "CAST(sale.id AS text) = entry.reference_id")
                    .leftJoin("sale.cashier", "cashier")
                    .select("cashier.id", "cashier_id")
                    .addSelect("COALESCE(SUM(line.debit::numeric), 0)::text", "revenue_reversed")
                    .where("entry.reference_type = :referenceType", { referenceType: "SALE_VOID" })
                    .andWhere("account.code = :accountCode", { accountCode: "4000" })
                    .andWhere("entry.created_at >= :start AND entry.created_at < :end", { start: from, end: to })
                    .groupBy("cashier.id");
                this.withHourFilter(cashierRevenueReversalQuery, filter, "entry.created_at");

                const cashierCogsReversalQuery = AppDataSource.getRepository(JournalLine).createQueryBuilder("line")
                    .innerJoin("line.journal_entry", "entry")
                    .innerJoin("line.account", "account")
                    .innerJoin(Sale, "sale", "CAST(sale.id AS text) = entry.reference_id")
                    .leftJoin("sale.cashier", "cashier")
                    .select("cashier.id", "cashier_id")
                    .addSelect("COALESCE(SUM(line.credit::numeric), 0)::text", "cogs_reversed")
                    .where("entry.reference_type = :referenceType", { referenceType: "SALE_VOID" })
                    .andWhere("account.code = :accountCode", { accountCode: "5000" })
                    .andWhere("entry.created_at >= :start AND entry.created_at < :end", { start: from, end: to })
                    .groupBy("cashier.id");
                this.withHourFilter(cashierCogsReversalQuery, filter, "entry.created_at");
                const [
                    trendRows,
                    refundTrendRows,
                    hourRows,
                    refundHourRows,
                    weekdayRows,
                    refundWeekdayRows,
                    heatmapRows,
                    refundHeatmapRows,
                    cashierRows,
                    cashierRefundRows,
                    cashierCosts,
                    cashierRevenueReversals,
                    cashierCogsReversals,
                ] = await Promise.all([
                    sales.clone()
                        .select(trendPeriodExpression, "period")
                        .addSelect("COALESCE(SUM(sale.total_amount::numeric), 0)::text", "sales")
                        .addSelect("COUNT(sale.id)", "transactions")
                        .addSelect(hourActiveDays, "activeDays")
                        .setParameter("reportTimeZone", filter.timeZone)
                        .groupBy(trendPeriodExpression)
                        .orderBy(trendPeriodExpression, "ASC")
                        .getRawMany(),
                    refundTrendQuery.getRawMany(),
                    sales.clone()
                        .select(`CAST(${hourExpression} AS integer)`, "hour")
                        .addSelect("COALESCE(SUM(sale.total_amount::numeric), 0)::text", "sales")
                        .addSelect("COUNT(sale.id)", "transactions")
                        .addSelect(hourActiveDays, "activeDays")
                        .setParameter("reportTimeZone", filter.timeZone)
                        .groupBy(hourExpression)
                        .orderBy(hourExpression, "ASC")
                        .getRawMany(),
                    refundHourQuery.getRawMany(),
                    sales.clone()
                        .select(`CAST(${weekdayExpression} AS integer)`, "weekday")
                        .addSelect("COALESCE(SUM(sale.total_amount::numeric), 0)::text", "sales")
                        .addSelect("COUNT(sale.id)", "transactions")
                        .addSelect(weekdayActiveDays, "activeDays")
                        .setParameter("reportTimeZone", filter.timeZone)
                        .groupBy(weekdayExpression)
                        .orderBy(weekdayExpression, "ASC")
                        .getRawMany(),
                    refundWeekdayQuery.getRawMany(),
                    sales.clone()
                        .select(`CAST(${weekdayExpression} AS integer)`, "weekday")
                        .addSelect(`CAST(${hourExpression} AS integer)`, "hour")
                        .addSelect("COALESCE(SUM(sale.total_amount::numeric), 0)::text", "sales")
                        .addSelect("COUNT(sale.id)", "transactions")
                        .addSelect(hourActiveDays, "activeDays")
                        .setParameter("reportTimeZone", filter.timeZone)
                        .groupBy(weekdayExpression)
                        .addGroupBy(hourExpression)
                        .getRawMany(),
                    refundHeatmapQuery.getRawMany(),
                    sales.clone()
                        .leftJoin("sale.cashier", "cashier")
                        .select("cashier.id", "cashier_id")
                        .addSelect("cashier.email", "name")
                        .addSelect("COALESCE(SUM(sale.total_amount::numeric), 0)::text", "total_cents")
                        .addSelect("COALESCE(SUM(sale.subtotal::numeric), 0)::text", "subtotal_cents")
                        .addSelect("COALESCE(SUM(sale.loyalty_discount::numeric), 0)::text", "discounts_cents")
                        .addSelect("COUNT(sale.id)", "count")
                        .groupBy("cashier.id")
                        .addGroupBy("cashier.email")
                        .orderBy("SUM(sale.total_amount)", "DESC")
                        .getRawMany(),
                    cashierRefundQuery.getRawMany(),
                    cashierCostsQuery.getRawMany(),
                    cashierRevenueReversalQuery.getRawMany(),
                    cashierCogsReversalQuery.getRawMany(),
                ]);

                const cashiersWithRefunds = [...cashierRows];
                for (const refund of cashierRefundRows) {
                    if (!cashierRows.some((row) => row.cashier_id === refund.cashier_id)) {
                        cashiersWithRefunds.push({
                            cashier_id: refund.cashier_id,
                            name: refund.name || "Unknown",
                            total_cents: "0",
                            subtotal_cents: "0",
                            discounts_cents: "0",
                            count: 0,
                        });
                    }
                }
                const refundsByCashier = new Map<string, string>(
                    cashierRefundRows.map((row) => [row.cashier_id, String(row.refunds_cents ?? "0")]),
                );
                const costsByCashier = new Map<string, { cogsCents: string; complete: boolean }>(
                    cashierCosts.map((row) => [row.cashier_id, {
                        cogsCents: (
                            BigInt(row.cogs_cents ?? "0")
                            - parseKesDecimalToCents(cashierCogsReversals.find((reversal) =>
                                reversal.cashier_id === row.cashier_id)?.cogs_reversed ?? "0")
                        ).toString(),
                        complete: numeric(row.missing_cost_count) === 0,
                    }]),
                );
                const revenueReversedByCashier = new Map<string, string>(
                    cashierRevenueReversals.map((row) => [row.cashier_id, String(row.revenue_reversed ?? "0")]),
                );

                report.profitAndLoss = {
                    grossSalesCents: parseKesDecimalToCents(salesTotals.gross_sales ?? "0").toString(),
                    discountsCents: discountsCents.toString(),
                    refundsCents: parseKesDecimalToCents(returnTotals?.refund_amount ?? "0").toString(),
                    netRevenueCents: profitability.netRevenueCents,
                    taxCollectedCents: (
                        parseKesDecimalToCents(salesTotals.tax_amount ?? "0")
                        - parseKesDecimalToCents(taxReversals?.tax_reversed ?? "0")
                    ).toString(),
                    costOfGoodsSoldCents: profitability.costOfGoodsSoldCents,
                    grossProfitCents: profitability.grossProfitCents,
                    operatingExpensesCents: profitability.operatingExpensesCents,
                    inventoryLossesCents: profitability.inventoryLossesCents,
                    transactionCostsCents: profitability.transactionCostsCents,
                    netProfitCents: profitability.netProfitCents,
                    lossesCents: profitability.lossesCents,
                    costDataComplete: profitability.costDataComplete,
                    netProfitUnavailableReason: !costComplete
                        ? trustedCostingBaselineAt
                            ? "One or more sale items predate the verified inventory-costing baseline or lack an exact cost snapshot."
                            : "Inventory costing has no verified opening baseline; profit is withheld until the opening valuation is verified."
                        : missingProcessingFeeCount > 0
                            ? "Provider fee records are missing for one or more electronic payments."
                            : null,
                };
                report.comparison = {
                    currentSalesCents: currentNetSalesCents.toString(),
                    previousSalesCents: previousNetSalesCents.toString(),
                    salesChangeCents: salesChangeCents.toString(),
                    salesChangePercentBasisPoints: salesChangePercentBasisPoints?.toString() ?? null,
                    transactions: numeric(previousTotals.transactions),
                    currentTransactions: numeric(salesTotals.transaction_count),
                    previousStart: previousStart.toISOString(),
                    previousEnd: from.toISOString(),
                };
                report.history = {
                    activeDays: numeric(salesTotals.active_days),
                    transactions: numeric(salesTotals.transaction_count),
                };
                const trendBuckets = mergeSalesAndRefundBuckets(
                    trendRows.map((row) => ({
                        key: row.period,
                        sales: row.sales,
                        transactions: row.transactions,
                        activeDays: row.activeDays,
                    })),
                    refundTrendRows,
                );
                report.salesTrend = trendBuckets.map((row) => ({
                    period: row.key,
                    salesCents: row.salesCents,
                    transactions: row.transactions,
                    refundsCents: row.refundsCents,
                    refundTransactions: row.refundTransactions,
                    activeDays: row.activeDays,
                }));
                const hourBuckets = mergeSalesAndRefundBuckets(
                    hourRows.map((row) => ({
                        key: String(numeric(row.hour)).padStart(2, "0"),
                        sales: row.sales,
                        transactions: row.transactions,
                        activeDays: row.activeDays,
                    })),
                    refundHourRows.map((row) => ({ ...row, key: String(row.key).padStart(2, "0") })),
                );
                const salesByHour = Array.from({ length: 24 }, (_, hour) => {
                    const row = hourBuckets.find((value) => value.key === String(hour).padStart(2, "0"));
                    return {
                        hour,
                        salesCents: row?.salesCents || "0",
                        transactions: row?.transactions || 0,
                        refundsCents: row?.refundsCents || "0",
                        refundTransactions: row?.refundTransactions || 0,
                        activeDays: row?.activeDays || 0,
                    };
                });
                report.salesByHour = salesByHour;
                report.hourlyDemand = summarizeHourlyDemand(salesByHour);
                const weekdayBuckets = mergeSalesAndRefundBuckets(
                    weekdayRows.map((row) => ({
                        key: String(numeric(row.weekday)),
                        sales: row.sales,
                        transactions: row.transactions,
                        activeDays: row.activeDays,
                    })),
                    refundWeekdayRows,
                );
                report.salesByWeekday = Array.from({ length: 7 }, (_, weekday) => {
                    const row = weekdayBuckets.find((value) => value.key === String(weekday));
                    return {
                        weekday,
                        salesCents: row?.salesCents || "0",
                        transactions: row?.transactions || 0,
                        refundsCents: row?.refundsCents || "0",
                        refundTransactions: row?.refundTransactions || 0,
                        activeDays: row?.activeDays || 0,
                    };
                });
                const heatmapBuckets = mergeSalesAndRefundBuckets(
                    heatmapRows.map((row) => ({
                        key: `${numeric(row.weekday)}-${numeric(row.hour)}`,
                        sales: row.sales,
                        transactions: row.transactions,
                        activeDays: row.activeDays,
                    })),
                    refundHeatmapRows,
                );
                const heatmap = new Map(heatmapBuckets.map((row) => [row.key, row]));
                report.salesHeatmap = Array.from({ length: 7 }, (_, weekday) => ({
                    weekday,
                    hours: Array.from({ length: 24 }, (_, hour) => ({
                        hour,
                        salesCents: heatmap.get(`${weekday}-${hour}`)?.salesCents || "0",
                        transactions: heatmap.get(`${weekday}-${hour}`)?.transactions || 0,
                        refundsCents: heatmap.get(`${weekday}-${hour}`)?.refundsCents || "0",
                        refundTransactions: heatmap.get(`${weekday}-${hour}`)?.refundTransactions || 0,
                        activeDays: heatmap.get(`${weekday}-${hour}`)?.activeDays || 0,
                    })),
                }));
                report.cashierPerformance = cashiersWithRefunds.map((row) => ({
                    cashier_id: row.cashier_id,
                    name: row.name || "Unknown",
                    totalCents: parseKesDecimalToCents(row.total_cents ?? "0").toString(),
                    discountsCents: parseKesDecimalToCents(row.discounts_cents ?? "0").toString(),
                    refundsCents: parseKesDecimalToCents(refundsByCashier.get(row.cashier_id) ?? "0").toString(),
                    refundTransactions: numeric(cashierRefundRows.find((refund) => refund.cashier_id === row.cashier_id)?.refund_count),
                    count: numeric(row.count),
                    profitContributionCents: (() => {
                        const cost = costsByCashier.get(row.cashier_id);
                        return cost?.complete
                            ? (
                                parseKesDecimalToCents(row.subtotal_cents ?? "0")
                                - parseKesDecimalToCents(row.discounts_cents ?? "0")
                                - parseKesDecimalToCents(revenueReversedByCashier.get(row.cashier_id) ?? "0")
                                - BigInt(cost.cogsCents)
                            ).toString()
                            : null;
                    })(),
                }));
            }

            return res.json(report);
        } catch (error) {
            console.error("Error generating report summary:", error);
            return res.status(500).json({ message: "Error generating report summary" });
        }
    }
}
