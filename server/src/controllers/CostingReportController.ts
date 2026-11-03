import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { AppDataSource } from "../data-source";
import { AuthenticatedRequest } from "../middleware/auth";
import { AdjustmentType, InventoryAdjustment } from "../entity/InventoryAdjustment";
import {
    hasCompleteCostingSnapshots,
    hasFullOpeningCoverage,
    isVerifiedCostingBaseline,
    reconcilePeriodEndValue,
} from "../lib/costingReportRules";
import { SupplierFifoEvent, allocateSupplierFifoAttribution } from "../lib/supplierFifoAttribution";
import { buildSupplierProfitability, SupplierProductInfo } from "../lib/supplierProfitability";
import { centsToKesString } from "../lib/exactMoney";
import { InventoryService } from "../services/InventoryService";
import { AccountingService } from "../services/AccountingService";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class PeriodCloseError extends Error {}
class BaselineVerificationError extends Error {}

interface BaselineVerificationLine {
    warehouse_stock_id: string;
    counted_quantity: number;
    valuation_cents: string;
}

const validDate = (value: unknown): value is string =>
    typeof value === "string" && ISO_DATE.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const validTimeZone = (value: unknown): value is string => {
    if (typeof value !== "string" || value.length > 100) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
    } catch {
        return false;
    }
};

export class CostingReportController {
    static async getBaselineVerification(_req: Request, res: Response) {
        try {
            const baseline = await AppDataSource.query(`
                SELECT "created_at", "valuation_method"
                FROM "inventory_costing_baselines" WHERE "id" = 1
            `);
            if (!baseline.length) {
                return res.status(409).json({ message: "The costing baseline has not been initialized." });
            }
            const closes = await AppDataSource.query(`SELECT "id" FROM "inventory_period_closes" LIMIT 1`);
            if (closes.length) {
                return res.status(409).json({
                    message: "A period has already been closed. Opening valuation cannot be changed without altering closed history.",
                });
            }
            if (isVerifiedCostingBaseline(baseline[0].valuation_method)) {
                return res.status(409).json({ message: "The opening valuation has already been verified." });
            }
            const rows = await AppDataSource.query(`
                SELECT stock."id" AS warehouse_stock_id, stock."warehouse_id",
                    warehouse."name" AS warehouse_name, stock."product_id",
                    product."sku", product."name" AS product_name,
                    stock."stock_on_hand"::int AS quantity,
                    stock."stock_value_cents"::text AS current_value_cents
                FROM "warehouse_stocks" stock
                JOIN "warehouses" warehouse ON warehouse."id" = stock."warehouse_id"
                JOIN "products" product ON product."id" = stock."product_id"
                ORDER BY warehouse."name", product."name", product."sku"
            `);
            return res.json({
                previous_baseline_at: baseline[0].created_at,
                previous_valuation_method: baseline[0].valuation_method,
                rows,
            });
        } catch (error) {
            console.error("Costing baseline verification preview failed:", error);
            return res.status(500).json({ message: "Unable to prepare opening valuation verification." });
        }
    }

    static async verifyBaseline(req: AuthenticatedRequest, res: Response) {
        if (!req.user?.id) {
            return res.status(401).json({ message: "Authenticated administrator is required." });
        }
        const verifiedBy = req.user.id;
        const evidenceReference = typeof req.body?.evidence_reference === "string"
            ? req.body.evidence_reference.trim()
            : "";
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        const submittedRows = req.body?.rows;
        if (!evidenceReference || evidenceReference.length > 120) {
            return res.status(400).json({ message: "A stocktake evidence reference (1–120 characters) is required." });
        }
        if (!reason || reason.length > 2_000) {
            return res.status(400).json({ message: "A verification reason (1–2,000 characters) is required." });
        }
        if (req.body?.physical_counts_confirmed !== true) {
            return res.status(400).json({ message: "Confirm that every submitted physical quantity matches the book quantity." });
        }
        if (!Array.isArray(submittedRows) || submittedRows.length > 100_000) {
            return res.status(400).json({ message: "A complete stock valuation row list is required." });
        }

        try {
            const result = await AppDataSource.transaction(async (manager) => {
                await manager.query(`LOCK TABLE "warehouse_stocks" IN SHARE ROW EXCLUSIVE MODE`);
                await manager.query(`LOCK TABLE "stock_movements" IN SHARE ROW EXCLUSIVE MODE`);
                const closes = await manager.query(`SELECT "id" FROM "inventory_period_closes" LIMIT 1`);
                if (closes.length) {
                    throw new BaselineVerificationError(
                        "A period has already been closed. Opening valuation cannot be changed without altering closed history.",
                    );
                }
                const baselines = await manager.query(`
                    SELECT "created_at", "valuation_method"
                    FROM "inventory_costing_baselines" WHERE "id" = 1 FOR UPDATE
                `);
                if (!baselines.length) throw new BaselineVerificationError("The costing baseline has not been initialized.");
                if (isVerifiedCostingBaseline(baselines[0].valuation_method)) {
                    throw new BaselineVerificationError("The opening valuation has already been verified.");
                }

                const stockRows = await manager.query(`
                    SELECT stock."id" AS warehouse_stock_id, stock."warehouse_id",
                        warehouse."name" AS warehouse_name, stock."product_id",
                        product."sku", product."name" AS product_name,
                        stock."stock_on_hand"::int AS quantity,
                        stock."stock_value_cents"::text AS current_value_cents
                    FROM "warehouse_stocks" stock
                    JOIN "warehouses" warehouse ON warehouse."id" = stock."warehouse_id"
                    JOIN "products" product ON product."id" = stock."product_id"
                    ORDER BY stock."id"
                    FOR UPDATE OF stock
                `);
                if (submittedRows.length !== stockRows.length) {
                    throw new BaselineVerificationError("The submitted stocktake must include every warehouse/product stock row exactly once.");
                }
                const submittedById = new Map<string, bigint>();
                const submittedCounts = new Map<string, number>();
                for (const row of submittedRows as BaselineVerificationLine[]) {
                    if (!row || typeof row.warehouse_stock_id !== "string" ||
                        !Number.isSafeInteger(row.counted_quantity) ||
                        row.counted_quantity < 0 || row.counted_quantity > 2_147_483_647 ||
                        typeof row.valuation_cents !== "string" ||
                        !/^(0|[1-9]\d*)$/.test(row.valuation_cents) ||
                        submittedById.has(row.warehouse_stock_id)) {
                        throw new BaselineVerificationError("Stocktake rows must have unique stock IDs and non-negative integer cent values.");
                    }
                    submittedById.set(row.warehouse_stock_id, BigInt(row.valuation_cents));
                    submittedCounts.set(row.warehouse_stock_id, row.counted_quantity);
                }

                const aggregateMismatches = await manager.query(`
                    SELECT product."sku", product."name"
                    FROM "products" product
                    LEFT JOIN (
                        SELECT "product_id", SUM("stock_on_hand")::bigint AS quantity
                        FROM "warehouse_stocks" GROUP BY "product_id"
                    ) stock ON stock."product_id" = product."id"
                    WHERE product."stock_on_hand" <> COALESCE(stock.quantity, 0)
                    LIMIT 10
                `);
                if (aggregateMismatches.length) {
                    throw new BaselineVerificationError(
                        "Product totals do not match warehouse stock. Resolve the stock discrepancy through the stock adjustment workflow first.",
                    );
                }

                let totalValueCents = 0n;
                const snapshots: Array<Record<string, string | number | null>> = [];
                const valueAdjustments: Array<{ row: Record<string, string | number | null>; delta: bigint }> = [];
                const maximumAdjustmentCents = 9_999_999_999n;
                for (const stock of stockRows) {
                    const newValueCents = submittedById.get(stock.warehouse_stock_id);
                    if (newValueCents === undefined) {
                        throw new BaselineVerificationError("The submitted stocktake is missing a warehouse/product row.");
                    }
                    if (!Number.isInteger(Number(stock.quantity)) || Number(stock.quantity) < 0) {
                        throw new BaselineVerificationError("Negative or invalid book quantities must be resolved before valuation verification.");
                    }
                    const submittedCount = submittedCounts.get(stock.warehouse_stock_id);
                    if (submittedCount !== Number(stock.quantity)) {
                        throw new BaselineVerificationError(
                            `Physical count differs from book quantity for ${stock.sku} at ${stock.warehouse_name}. Resolve the difference with a stock adjustment and reload.`,
                        );
                    }
                    if (stock.current_value_cents == null || !/^(0|[1-9]\d*)$/.test(String(stock.current_value_cents))) {
                        throw new BaselineVerificationError("Current book values are incomplete. Resolve missing inventory values before verification.");
                    }
                    if (Number(stock.quantity) === 0 && newValueCents !== 0n) {
                        throw new BaselineVerificationError("A zero-quantity stock row cannot have a non-zero inventory value.");
                    }
                    totalValueCents += newValueCents;
                    if (totalValueCents > 9_223_372_036_854_775_807n) {
                        throw new BaselineVerificationError("The combined inventory value exceeds the supported exact storage range.");
                    }
                    const oldValueCents = BigInt(stock.current_value_cents);
                    const delta = newValueCents - oldValueCents;
                    if (delta > maximumAdjustmentCents || delta < -maximumAdjustmentCents) {
                        throw new BaselineVerificationError("A valuation adjustment exceeds the supported per-product accounting adjustment amount.");
                    }
                    const snapshot = {
                        warehouse_stock_id: stock.warehouse_stock_id as string,
                        warehouse_id: stock.warehouse_id as string,
                        warehouse_name: stock.warehouse_name as string,
                        product_id: stock.product_id as string,
                        sku: stock.sku as string,
                        product_name: stock.product_name as string,
                        quantity: Number(stock.quantity),
                        previous_value_cents: String(oldValueCents),
                        verified_value_cents: String(newValueCents),
                        delta_cents: String(delta),
                    };
                    snapshots.push(snapshot);
                    if (delta !== 0n) valueAdjustments.push({ row: snapshot, delta });
                }
                if (submittedById.size !== stockRows.length) {
                    throw new BaselineVerificationError("The submitted stocktake contains unknown warehouse/product rows.");
                }

                const verificationId = randomUUID();

                for (const { row, delta } of valueAdjustments) {
                    const absoluteDelta = delta < 0n ? -delta : delta;
                    const adjustment = await manager.save(InventoryAdjustment, manager.create(InventoryAdjustment, {
                        product_id: row.product_id as string,
                        warehouse_id: row.warehouse_id as string,
                        authorized_by: verifiedBy,
                        type: AdjustmentType.MISCOUNT,
                        quantity_adjusted: 0,
                        unit_cost: 0,
                        total_value_adjusted: Number(centsToKesString(absoluteDelta)),
                        reason: `Opening valuation verification ${verificationId}; evidence ${evidenceReference}. ${reason}`,
                    }));
                    const signedDelta = delta;
                    await manager.query(`
                        UPDATE "warehouse_stocks"
                        SET "stock_value_cents" = $1
                        WHERE "id" = $2
                    `, [String(BigInt(String(row.verified_value_cents))), row.warehouse_stock_id]);
                    await InventoryService.recordMovement(manager, {
                        productId: row.product_id as string,
                        movementType: "inventory_value_adjustment",
                        quantityChange: 0,
                        quantityBefore: Number(row.quantity),
                        locationId: row.warehouse_id as string,
                        unitCost: null,
                        valueChangeCents: signedDelta,
                        referenceType: "adjustment",
                        referenceId: adjustment.id,
                        notes: `Opening valuation verification ${verificationId}. Evidence ${evidenceReference}. ${reason}`,
                        createdBy: verifiedBy,
                    });
                    await AccountingService.recordInventoryAdjustment(
                        manager,
                        adjustment.id,
                        Number(centsToKesString(absoluteDelta)),
                        delta < 0n,
                    );
                }

                const baselineAtRows = await manager.query(`SELECT clock_timestamp() AS baseline_at`);
                const baselineAt = baselineAtRows[0].baseline_at;
                await manager.query(`
                    INSERT INTO "inventory_costing_baseline_verifications" (
                        "id", "previous_baseline_at", "previous_valuation_method", "baseline_at",
                        "evidence_reference", "reason", "line_count", "total_value_cents",
                        "stock_snapshot", "verified_by"
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
                `, [
                    verificationId,
                    baselines[0].created_at,
                    baselines[0].valuation_method,
                    baselineAt,
                    evidenceReference,
                    reason,
                    snapshots.length,
                    String(totalValueCents),
                    JSON.stringify(snapshots),
                    verifiedBy,
                ]);
                await manager.query(`
                    INSERT INTO "stock_movements" (
                        "product_id", "movement_type", "quantity", "quantity_before", "quantity_after",
                        "unit_cost", "value_change_cents", "reference_type", "reference_id",
                        "location_id", "notes", "created_by", "created_at"
                    )
                    SELECT stock."product_id", 'costing_opening_balance', stock."stock_on_hand", 0,
                        stock."stock_on_hand", NULL, stock."stock_value_cents",
                        'costing_baseline_verification', $1, stock."warehouse_id",
                        $2, $3, $4
                    FROM "warehouse_stocks" stock
                    WHERE stock."stock_on_hand" > 0
                `, [
                    verificationId,
                    `Admin-verified opening stock valuation. Evidence ${evidenceReference}. ${reason}`,
                    verifiedBy,
                    baselineAt,
                ]);
                await manager.query(`
                    UPDATE "inventory_costing_baselines"
                    SET "created_at" = $1, "created_by" = $2,
                        "valuation_method" = 'weighted_average_opening_snapshot'
                    WHERE "id" = 1
                `, [baselineAt, verifiedBy]);
                return { verification_id: verificationId, baseline_at: baselineAt, line_count: snapshots.length, total_value_cents: String(totalValueCents) };
            });
            return res.status(201).json(result);
        } catch (error) {
            if (error instanceof BaselineVerificationError) {
                return res.status(409).json({ message: error.message });
            }
            console.error("Costing baseline verification failed:", error);
            return res.status(500).json({ message: "Unable to verify the opening inventory valuation." });
        }
    }

    static async listPeriodCloses(_req: Request, res: Response) {
        try {
            const closes = await AppDataSource.query(`
                SELECT period_close."id", period_close."period_end_date"::text AS "period_end_date", period_close."opening_value_cents"::text,
                    period_close."purchase_value_cents"::text, period_close."cogs_cents"::text,
                    period_close."write_offs_cents"::text, period_close."adjustments_cents"::text,
                    period_close."closing_value_cents"::text, period_close."closed_at",
                    COALESCE(profile."full_name", user_record."email") AS closed_by_name
                FROM "inventory_period_closes" period_close
                JOIN "users" user_record ON user_record."id" = period_close."closed_by"
                LEFT JOIN "profiles" profile ON profile."id" = user_record."id"
                ORDER BY period_close."period_end_date" DESC
                LIMIT 100
            `);
            return res.json(closes);
        } catch (error) {
            console.error("Inventory period close history query failed:", error);
            return res.status(500).json({ message: "Unable to load inventory period closes" });
        }
    }

    static async closePeriod(req: AuthenticatedRequest, res: Response) {
        const endDate = req.body?.end_date;
        if (!validDate(endDate)) {
            return res.status(400).json({ message: "end_date must be a valid YYYY-MM-DD date" });
        }
        const today = new Date().toISOString().slice(0, 10);
        if (endDate >= today) {
            return res.status(400).json({ message: "Only completed UTC dates can be closed" });
        }
        if (!req.user?.id) {
            return res.status(401).json({ message: "Authenticated user is required" });
        }

        try {
            const close = await AppDataSource.transaction(async (manager) => {
                await manager.query(`LOCK TABLE "warehouse_stocks" IN SHARE ROW EXCLUSIVE MODE`);
                await manager.query(`LOCK TABLE "stock_movements" IN SHARE ROW EXCLUSIVE MODE`);
                const alreadyClosed = await manager.query(
                    `SELECT "id" FROM "inventory_period_closes" WHERE "period_end_date" = $1::date`,
                    [endDate],
                );
                if (alreadyClosed.length) throw new PeriodCloseError("This inventory period has already been closed");
                const latestClose = await manager.query(`
                    SELECT "period_end_date"::text AS "period_end_date" FROM "inventory_period_closes"
                    ORDER BY "period_end_date" DESC LIMIT 1
                `);
                if (latestClose.length && String(latestClose[0].period_end_date).slice(0, 10) >= endDate) {
                    throw new PeriodCloseError("Inventory periods must be closed in chronological order");
                }

                const baselines = await manager.query(`
                    SELECT "created_at", "valuation_method"
                    FROM "inventory_costing_baselines" WHERE "id" = 1
                `);
                const baselineAt = baselines[0]?.created_at ? new Date(baselines[0].created_at) : null;
                if (!baselineAt) throw new PeriodCloseError("Costing baseline is unavailable");
                if (!isVerifiedCostingBaseline(baselines[0]?.valuation_method)) {
                    throw new PeriodCloseError(
                        "The costing baseline uses unverified legacy product costs; verify opening inventory values before closing periods",
                    );
                }

                const previous = await manager.query(`
                    SELECT "period_end_date"::text AS "period_end_date", "closing_value_cents"::text
                    FROM "inventory_period_closes"
                    WHERE "period_end_date" < $1::date
                    ORDER BY "period_end_date" DESC LIMIT 1
                `, [endDate]);
                const endExclusive = new Date(`${endDate}T00:00:00.000Z`);
                endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
                const endExclusiveIso = endExclusive.toISOString();

                let openingValueCents: bigint;
                let periodStartIso: string;
                if (previous.length) {
                    openingValueCents = BigInt(previous[0].closing_value_cents);
                    const periodStart = new Date(`${String(previous[0].period_end_date).slice(0, 10)}T00:00:00.000Z`);
                    periodStart.setUTCDate(periodStart.getUTCDate() + 1);
                    periodStartIso = periodStart.toISOString();
                } else {
                    const baselineDate = baselineAt.toISOString().slice(0, 10);
                    const firstCloseableDate = new Date(`${baselineDate}T00:00:00.000Z`);
                    firstCloseableDate.setUTCDate(firstCloseableDate.getUTCDate() + 1);
                    if (endDate < firstCloseableDate.toISOString().slice(0, 10)) {
                        throw new PeriodCloseError("The selected date predates complete costing coverage");
                    }
                    periodStartIso = firstCloseableDate.toISOString();
                    const openingRows = await manager.query(`
                        SELECT COALESCE(SUM(movement."value_change_cents") FILTER (
                            WHERE movement."movement_type" = 'costing_opening_balance'
                        ), 0)::text AS baseline_value_cents,
                        COALESCE(SUM(movement."value_change_cents") FILTER (
                            WHERE movement."movement_type" <> 'costing_opening_balance'
                                AND movement."created_at" < $2::timestamptz
                        ), 0)::text AS pre_period_change_cents
                        FROM "stock_movements" movement
                        WHERE movement."created_at" >= $1::timestamptz
                            AND movement."created_at" < $2::timestamptz
                    `, [baselineAt, periodStartIso]);
                    openingValueCents = BigInt(openingRows[0].baseline_value_cents) +
                        BigInt(openingRows[0].pre_period_change_cents);
                }
                if (!hasFullOpeningCoverage(periodStartIso.slice(0, 10), baselineAt)) {
                    throw new PeriodCloseError("The selected date predates complete costing coverage");
                }
                if (new Date(periodStartIso) >= endExclusive) {
                    throw new PeriodCloseError("The selected period has no complete dates after the prior close");
                }

                const movementRows = await manager.query(`
                    SELECT COUNT(*) FILTER (
                            WHERE movement."value_change_cents" IS NULL
                        )::int AS missing_values,
                        COALESCE(SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" >= $2::timestamptz
                                AND movement."created_at" < $3::timestamptz
                                AND movement."movement_type" <> 'costing_opening_balance'
                        ), 0)::text AS period_change_cents,
                        COALESCE(SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" >= $2::timestamptz
                                AND movement."created_at" < $3::timestamptz
                                AND movement."movement_type" IN ('purchase_receipt', 'initial_stock')
                        ), 0)::text AS purchases_cents,
                        COALESCE(-SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" >= $2::timestamptz
                                AND movement."created_at" < $3::timestamptz
                                AND movement."movement_type" IN ('sale', 'sale_return', 'sale_void')
                        ), 0)::text AS cogs_cents,
                        COALESCE(-SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" >= $2::timestamptz
                                AND movement."created_at" < $3::timestamptz
                                AND movement."movement_type" IN ('damaged', 'expired', 'shrinkage')
                        ), 0)::text AS write_offs_cents
                    FROM "stock_movements" movement
                    WHERE movement."created_at" >= $1::timestamptz
                `, [baselineAt, periodStartIso, endExclusiveIso]);
                const movement = movementRows[0];
                if (Number(movement.missing_values) > 0) {
                    throw new PeriodCloseError("Some stock movements lack exact values; the period cannot be closed");
                }
                const currentValues = await manager.query(`
                    SELECT COUNT(*) FILTER (
                            WHERE stock."stock_value_cents" IS NULL
                        )::int AS missing_values,
                        COALESCE(SUM(stock."stock_value_cents"), 0)::text AS value_cents
                    FROM "warehouse_stocks" stock
                `);
                if (Number(currentValues[0].missing_values) > 0) {
                    throw new PeriodCloseError("Some current stock values are unavailable; the period cannot be closed");
                }
                const futureMovements = await manager.query(`
                    SELECT COUNT(*) FILTER (
                            WHERE movement."value_change_cents" IS NULL
                        )::int AS missing_values,
                        COALESCE(SUM(movement."value_change_cents"), 0)::text AS value_cents
                    FROM "stock_movements" movement
                    WHERE movement."created_at" >= $1::timestamptz
                `, [endExclusiveIso]);
                if (Number(futureMovements[0].missing_values) > 0) {
                    throw new PeriodCloseError("Stock movements after the selected period lack exact values; the period cannot be closed");
                }
                const closingValueCents = BigInt(currentValues[0].value_cents) -
                    BigInt(futureMovements[0].value_cents);
                const purchaseValueCents = BigInt(movement.purchases_cents);
                const cogsCents = BigInt(movement.cogs_cents);
                const writeOffsCents = BigInt(movement.write_offs_cents);
                const periodChangeCents = BigInt(movement.period_change_cents);
                const adjustmentsCents = periodChangeCents - purchaseValueCents +
                    cogsCents + writeOffsCents;
                const reconciliation = reconcilePeriodEndValue({
                    openingValueCents,
                    purchaseValueCents,
                    cogsCents,
                    writeOffsCents,
                    adjustmentsCents,
                    closingValueCents,
                });
                if (!reconciliation.balanced) {
                    throw new PeriodCloseError(`Inventory reconciliation is out of balance by ${reconciliation.differenceCents} cents; period close blocked`);
                }
                const saved = await manager.query(`
                    INSERT INTO "inventory_period_closes" (
                        "period_end_date", "opening_value_cents", "purchase_value_cents",
                        "cogs_cents", "write_offs_cents", "adjustments_cents",
                        "closing_value_cents", "closed_by"
                    ) VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING "id", "period_end_date", "closed_at"
                `, [
                    endDate, String(openingValueCents), String(purchaseValueCents),
                    String(cogsCents), String(writeOffsCents), String(adjustmentsCents),
                    String(closingValueCents), req.user!.id,
                ]);
                return {
                    ...saved[0],
                    period_end_date: endDate,
                    opening_value_cents: String(openingValueCents),
                    purchase_value_cents: String(purchaseValueCents),
                    cogs_cents: String(cogsCents),
                    write_offs_cents: String(writeOffsCents),
                    adjustments_cents: String(adjustmentsCents),
                    closing_value_cents: String(closingValueCents),
                    valuation_method: baselines[0].valuation_method,
                };
            });
            return res.status(201).json(close);
        } catch (error) {
            console.error("Inventory period close failed:", error);
            if (error instanceof PeriodCloseError) {
                return res.status(/already been closed/.test(error.message) ? 409 : 400).json({ message: error.message });
            }
            return res.status(500).json({ message: "Unable to close inventory period because of a server error" });
        }
    }

    static async get(req: Request, res: Response) {
        try {
            const startDate = req.query.start_date;
            const endDate = req.query.end_date;
            if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
                return res.status(400).json({ message: "Valid start_date and end_date in YYYY-MM-DD format are required" });
            }
            const timeZone = req.query.time_zone === undefined ? "UTC" : req.query.time_zone;
            if (!validTimeZone(timeZone)) {
                return res.status(400).json({ message: "time_zone must be a valid IANA timezone" });
            }
            const warehouseId = typeof req.query.warehouse_id === "string" ? req.query.warehouse_id : undefined;
            const productId = typeof req.query.product_id === "string" ? req.query.product_id : undefined;
            const categoryId = typeof req.query.category_id === "string" ? req.query.category_id : undefined;
            const supplierId = typeof req.query.supplier_id === "string" ? req.query.supplier_id : undefined;
            for (const [name, value] of Object.entries({ warehouse_id: warehouseId, product_id: productId, category_id: categoryId, supplier_id: supplierId })) {
                if (value && !UUID.test(value)) return res.status(400).json({ message: `${name} must be a valid UUID` });
            }

            const params: unknown[] = [startDate, endDate, timeZone];
            const filters: string[] = [];
            const addFilter = (sql: string, value: string | undefined) => {
                if (!value) return;
                params.push(value);
                filters.push(sql.replace("?", `$${params.length}`));
            };
            addFilter(`purchase."warehouse_id" = ?`, warehouseId);
            addFilter(`purchaseItem."product_id" = ?`, productId);
            addFilter(`product."category_id" = ?`, categoryId);
            addFilter(`purchase."vendor_id" = ?`, supplierId);
            const purchaseWhere = filters.length ? `AND ${filters.join(" AND ")}` : "";
            const purchases: Array<Record<string, unknown>> = await AppDataSource.query(`
                SELECT product."id" AS product_id, product."sku" AS sku, product."name" AS product,
                    category."id" AS category_id, category."name" AS category,
                    vendor."id" AS supplier_id, vendor."name" AS supplier,
                    SUM(purchaseItem."quantity")::bigint AS quantity,
                    SUM(purchaseItem."total_cost_cents")::text AS cost_cents
                FROM "purchase_items" purchaseItem
                JOIN "purchases" purchase ON purchase."id" = purchaseItem."purchase_id"
                JOIN "products" product ON product."id" = purchaseItem."product_id"
                LEFT JOIN "categories" category ON category."id" = product."category_id"
                LEFT JOIN "vendors" vendor ON vendor."id" = purchase."vendor_id"
                WHERE purchase."purchased_at" >= ($1::date::timestamp AT TIME ZONE $3)
                    AND purchase."purchased_at" < (($2::date + 1)::timestamp AT TIME ZONE $3)
                    ${purchaseWhere}
                GROUP BY product."id", product."sku", product."name", category."id", category."name",
                    vendor."id", vendor."name"
                ORDER BY product."name", vendor."name"
            `, params);

            const stockParams: unknown[] = [];
            const stockFilters: string[] = [];
            const addStockFilter = (column: string, value: string | undefined) => {
                if (!value) return;
                stockParams.push(value);
                stockFilters.push(`${column} = $${stockParams.length}`);
            };
            addStockFilter(`stock."warehouse_id"`, warehouseId);
            addStockFilter(`stock."product_id"`, productId);
            addStockFilter(`product."category_id"`, categoryId);
            if (supplierId) {
                stockParams.push(supplierId);
                stockFilters.push(`EXISTS (
                    SELECT 1
                    FROM "purchase_items" supplier_item
                    JOIN "purchases" supplier_purchase ON supplier_purchase."id" = supplier_item."purchase_id"
                    WHERE supplier_item."product_id" = product."id"
                        AND supplier_purchase."vendor_id" = $${stockParams.length}
                )`);
            }
            const stockValuation: Array<Record<string, unknown>> = await AppDataSource.query(`
                SELECT stock."warehouse_id", warehouse."name" AS warehouse,
                    product."id" AS product_id, product."sku", product."name" AS product,
                    category."id" AS category_id, category."name" AS category, stock."stock_on_hand" AS quantity,
                    stock."stock_value_cents"::text AS value_cents
                FROM "warehouse_stocks" stock
                JOIN "warehouses" warehouse ON warehouse."id" = stock."warehouse_id"
                JOIN "products" product ON product."id" = stock."product_id"
                LEFT JOIN "categories" category ON category."id" = product."category_id"
                ${stockFilters.length ? `WHERE ${stockFilters.join(" AND ")}` : ""}
                ORDER BY warehouse."name", product."name"
            `, stockParams);
            const missingStockValue = await AppDataSource.query(`
                SELECT COUNT(*) FILTER (WHERE stock."stock_value_cents" IS NULL)::int AS count
                FROM "warehouse_stocks" stock
                JOIN "products" product ON product."id" = stock."product_id"
                ${stockFilters.length ? `WHERE ${stockFilters.join(" AND ")}` : ""}
            `, stockParams);

            const baseline = await AppDataSource.query(`
                SELECT "created_at", "valuation_method"
                FROM "inventory_costing_baselines"
                WHERE "id" = 1
            `);
            const baselineAt = baseline[0]?.created_at ? new Date(baseline[0].created_at) : null;
            const baselineVerified = isVerifiedCostingBaseline(baseline[0]?.valuation_method);
            const reconciliation: Record<string, unknown> = {
                balanced: false,
                available: false,
                start_date: startDate,
                end_date: endDate,
                difference_cents: null,
                baseline_verified: baselineVerified,
                message: !baselineAt
                    ? "Costing baseline is unavailable; reconciliation cannot be calculated accurately."
                    : !baselineVerified
                        ? "Opening inventory values come from legacy product costs and are unverified; reconciliation is withheld until a verified opening stock valuation is established."
                        : "Costing baseline is unavailable; reconciliation cannot be calculated accurately.",
            };
            const coverageRows = baselineAt
                ? await AppDataSource.query(`
                    SELECT ($1::date::timestamp AT TIME ZONE $2) >= $3::timestamptz AS covered
                `, [startDate, timeZone, baselineAt])
                : [];
            if (baselineAt && baselineVerified && coverageRows[0]?.covered) {
                const reconParams: unknown[] = [baselineAt, startDate, endDate, timeZone];
                const warehouseFilter = warehouseId
                    ? (reconParams.push(warehouseId), `AND movement."location_id" = $${reconParams.length}`)
                    : "";
                const movements = await AppDataSource.query(`
                    SELECT
                        COUNT(*) FILTER (WHERE movement."value_change_cents" IS NULL)::int AS missing_values,
                        COALESCE(SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" < ($2::date::timestamp AT TIME ZONE $4)
                        ), 0)::text AS opening_cents,
                        COALESCE(SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" >= ($2::date::timestamp AT TIME ZONE $4)
                                AND movement."created_at" < (($3::date + 1)::timestamp AT TIME ZONE $4)
                        ), 0)::text AS period_change_cents,
                        COALESCE(SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" >= ($2::date::timestamp AT TIME ZONE $4)
                                AND movement."created_at" < (($3::date + 1)::timestamp AT TIME ZONE $4)
                                AND movement."movement_type" IN ('purchase_receipt', 'initial_stock')
                        ), 0)::text AS purchases_cents,
                        COALESCE(-SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" >= ($2::date::timestamp AT TIME ZONE $4)
                                AND movement."created_at" < (($3::date + 1)::timestamp AT TIME ZONE $4)
                                AND movement."movement_type" IN ('sale', 'sale_return', 'sale_void')
                        ), 0)::text AS cogs_cents,
                        COALESCE(-SUM(movement."value_change_cents") FILTER (
                            WHERE movement."created_at" >= ($2::date::timestamp AT TIME ZONE $4)
                                AND movement."created_at" < (($3::date + 1)::timestamp AT TIME ZONE $4)
                                AND movement."movement_type" IN ('damaged', 'expired', 'shrinkage')
                        ), 0)::text AS write_offs_cents
                    FROM "stock_movements" movement
                    WHERE movement."created_at" >= $1
                        AND movement."created_at" < (($3::date + 1)::timestamp AT TIME ZONE $4)
                        ${warehouseFilter}
                `, reconParams);
                const row = movements[0];
                if (Number(row.missing_values) === 0) {
                    const opening = BigInt(row.opening_cents);
                    const periodChange = BigInt(row.period_change_cents);
                    const expectedClosing = opening + periodChange;
                    let actualClosing: bigint | null = null;
                    let currentStockValuesComplete = true;
                    if (endDate === new Date().toISOString().slice(0, 10)) {
                        const current = await AppDataSource.query(`
                            SELECT COALESCE(SUM(stock."stock_value_cents"), 0)::text AS value_cents,
                                COUNT(*) FILTER (WHERE stock."stock_value_cents" IS NULL)::int AS missing_values
                            FROM "warehouse_stocks" stock
                            ${warehouseId ? `WHERE stock."warehouse_id" = $1` : ""}
                        `, warehouseId ? [warehouseId] : []);
                        currentStockValuesComplete = Number(current[0].missing_values) === 0;
                        if (currentStockValuesComplete) {
                            actualClosing = BigInt(current[0].value_cents);
                        }
                    } else if (timeZone === "UTC") {
                        const closedPeriods = await AppDataSource.query(`
                            SELECT "closing_value_cents"::text
                            FROM "inventory_period_closes"
                            WHERE "period_end_date" = $1::date
                        `, [endDate]);
                        if (closedPeriods.length) {
                            actualClosing = BigInt(closedPeriods[0].closing_value_cents);
                        }
                    }
                    const difference = actualClosing === null ? null : actualClosing - expectedClosing;
                    reconciliation.balanced = difference !== null && difference === 0n;
                    reconciliation.available = actualClosing !== null;
                    reconciliation.opening_value_cents = String(opening);
                    reconciliation.purchase_value_cents = row.purchases_cents;
                    reconciliation.cogs_cents = row.cogs_cents;
                    reconciliation.write_offs_cents = row.write_offs_cents;
                    reconciliation.other_movement_value_cents =
                        String(periodChange - BigInt(row.purchases_cents) + BigInt(row.cogs_cents) + BigInt(row.write_offs_cents));
                    reconciliation.expected_closing_value_cents = String(expectedClosing);
                    reconciliation.actual_closing_value_cents = actualClosing === null ? null : String(actualClosing);
                    reconciliation.difference_cents = difference === null ? null : String(difference);
                    reconciliation.message = actualClosing === null
                        ? endDate === new Date().toISOString().slice(0, 10) && !currentStockValuesComplete
                            ? "Some current warehouse stock values are unavailable; reconciliation cannot be confirmed. Period close must remain blocked."
                            : timeZone === "UTC"
                                ? "Expected closing stock value is calculated from movements, but no saved period-end inventory close exists for an independent reconciliation."
                                : "The requested timezone does not match the UTC inventory-close snapshots; independent reconciliation is unavailable."
                        : difference === 0n
                            ? "Inventory value reconciliation balances."
                            : "Inventory value reconciliation does not balance. Period close must be blocked.";
                    reconciliation.opening_valuation_method = baseline[0].valuation_method;
                    if (baseline[0].valuation_method === "legacy_product_unit_cost_snapshot") {
                        reconciliation.message += " The opening balance uses legacy product unit_cost values; historical weighted-average costs before this baseline are unavailable.";
                    }
                    if (productId || categoryId || supplierId) {
                        reconciliation.scope_note = "Reconciliation covers the selected warehouse scope, not the product, category, or supplier filters.";
                    }
                } else {
                    reconciliation.message = "Some stock movements lack exact value snapshots; reconciliation is unavailable for this period.";
                }
            }

            const purchasesTotalCents = purchases.reduce(
                (sum, row) => sum + BigInt(String(row.cost_cents || "0")),
                0n,
            );
            const stockValueCents = Number(missingStockValue[0]?.count || 0) > 0
                ? null
                : stockValuation.reduce((sum, row) =>
                    sum + BigInt(String(row.value_cents || "0")), 0n);
            const profitParams: unknown[] = [startDate, endDate, timeZone];
            const profitFilters: string[] = [];
            const addProfitFilter = (sql: string, value: string | undefined) => {
                if (!value) return;
                profitParams.push(value);
                profitFilters.push(sql.replace("?", `$${profitParams.length}`));
            };
            addProfitFilter(`sale."warehouse_id" = ?`, warehouseId);
            addProfitFilter(`product."id" = ?`, productId);
            addProfitFilter(`product."category_id" = ?`, categoryId);
            if (supplierId) {
                profitParams.push(supplierId);
                profitFilters.push(`EXISTS (
                    SELECT 1
                    FROM "purchase_items" supplier_item
                    JOIN "purchases" supplier_purchase ON supplier_purchase."id" = supplier_item."purchase_id"
                    WHERE supplier_item."product_id" = product."id"
                        AND supplier_purchase."vendor_id" = $${profitParams.length}
                )`);
            }
            const qualifiedProductFilter = profitFilters.length
                ? `AND ${profitFilters.join(" AND ")}`
                : "";
            const profitRows: Array<Record<string, unknown>> = await AppDataSource.query(`
                WITH filtered_sale_items AS (
                    SELECT sale_item."id" AS sale_item_id, sale_item."product_id",
                        sale."id" AS sale_id, sale."created_at" AS sale_created_at,
                        sale."warehouse_id", sale."status" AS sale_status,
                        sale_item."quantity", sale_item."net_revenue_cents",
                        sale_item."vat_cents",
                        sale_item."cogs_total_cents", product."name" AS product_name,
                        product."sku", product."category_id",
                        category."name" AS category_name
                    FROM "sale_items" sale_item
                    JOIN "sales" sale ON sale."id" = sale_item."sale_id"
                    JOIN "products" product ON product."id" = sale_item."product_id"
                    LEFT JOIN "categories" category ON category."id" = product."category_id"
                    WHERE (
                        sale."status" IN ('completed', 'partially_refunded')
                        OR (sale."status" = 'voided' AND EXISTS (
                            SELECT 1 FROM "credit_notes" void_note
                            WHERE void_note."sale_id" = sale."id"
                        ))
                    )
                    ${qualifiedProductFilter}
                ),
                profit_events AS (
                    SELECT filtered."product_id", filtered."product_name", filtered."sku",
                        filtered."category_id", filtered."category_name",
                        filtered."sale_created_at" AS event_at, filtered."quantity" AS quantity,
                        filtered."net_revenue_cents" AS net_revenue_cents,
                        filtered."vat_cents" AS vat_cents,
                        filtered."cogs_total_cents" AS cogs_cents
                    FROM filtered_sale_items filtered
                    WHERE filtered."sale_created_at" >= ($1::date::timestamp AT TIME ZONE $3)
                        AND filtered."sale_created_at" < (($2::date + 1)::timestamp AT TIME ZONE $3)
                    UNION ALL
                    SELECT filtered."product_id", filtered."product_name", filtered."sku",
                        filtered."category_id", filtered."category_name",
                        credit_note."created_at" AS event_at, -return_item."quantity" AS quantity,
                        -return_item."net_revenue_cents" AS net_revenue_cents,
                        -return_item."vat_cents" AS vat_cents,
                        -return_item."cogs_total_cents" AS cogs_cents
                    FROM "return_items" return_item
                    JOIN "return_requests" return_request
                        ON return_request."id" = return_item."return_request_id"
                    JOIN "credit_notes" credit_note
                        ON credit_note."return_request_id" = return_request."id"
                    JOIN filtered_sale_items filtered
                        ON filtered."sale_item_id" = return_item."sale_item_id"
                    WHERE return_request."status" = 'approved'
                        AND credit_note."created_at" >= ($1::date::timestamp AT TIME ZONE $3)
                        AND credit_note."created_at" < (($2::date + 1)::timestamp AT TIME ZONE $3)
                    UNION ALL
                    SELECT filtered."product_id", filtered."product_name", filtered."sku",
                        filtered."category_id", filtered."category_name",
                        credit_note."created_at" AS event_at, -filtered."quantity" AS quantity,
                        -filtered."net_revenue_cents" AS net_revenue_cents,
                        -filtered."vat_cents" AS vat_cents,
                        -filtered."cogs_total_cents" AS cogs_cents
                    FROM filtered_sale_items filtered
                    JOIN "credit_notes" credit_note ON credit_note."sale_id" = filtered."sale_id"
                    WHERE filtered."sale_status" = 'voided'
                        AND credit_note."return_request_id" IS NULL
                        AND credit_note."created_at" >= ($1::date::timestamp AT TIME ZONE $3)
                        AND credit_note."created_at" < (($2::date + 1)::timestamp AT TIME ZONE $3)
                ),
                bucketed_events AS (
                    SELECT *, TO_CHAR(event_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day_bucket,
                        TO_CHAR(event_at AT TIME ZONE $3, 'YYYY-MM') AS month_bucket
                    FROM profit_events
                )
                SELECT CASE
                        WHEN GROUPING("product_id") = 0 THEN 'product'
                        WHEN GROUPING("category_id") = 0 THEN 'category'
                        WHEN GROUPING("day_bucket") = 0 THEN 'day'
                        WHEN GROUPING("month_bucket") = 0 THEN 'month'
                        ELSE 'overall'
                    END AS grouping,
                    "product_id", "product_name", "sku", "category_id", "category_name",
                    "day_bucket", "month_bucket",
                    COALESCE(SUM("quantity"), 0)::text AS quantity_sold,
                    COALESCE(SUM("net_revenue_cents"), 0)::text AS net_revenue_cents,
                    COALESCE(SUM("cogs_cents"), 0)::text AS cogs_cents,
                    COUNT(*) FILTER (WHERE "net_revenue_cents" IS NULL)::int AS missing_revenue_count,
                    COUNT(*) FILTER (WHERE "vat_cents" IS NULL)::int AS missing_vat_count,
                    COUNT(*) FILTER (WHERE "cogs_cents" IS NULL)::int AS missing_cogs_count
                FROM bucketed_events
                GROUP BY GROUPING SETS (
                    ("product_id", "product_name", "sku", "category_id", "category_name"),
                    ("category_id", "category_name"),
                    ("day_bucket"),
                    ("month_bucket"),
                    ()
                )
                ORDER BY grouping, "product_name", "category_name", "day_bucket", "month_bucket"
            `, profitParams);
            const profitability: Record<string, Array<Record<string, unknown>>> = {
                product: [],
                category: [],
                day: [],
                month: [],
                overall: [],
            };
            for (const row of profitRows) {
                const group = String(row.grouping);
                const missingRevenueCount = Number(row.missing_revenue_count);
                const missingVatCount = Number(row.missing_vat_count);
                const missingCogsCount = Number(row.missing_cogs_count);
                const complete = hasCompleteCostingSnapshots({
                    revenue: missingRevenueCount,
                    vat: missingVatCount,
                    cogs: missingCogsCount,
                });
                const netRevenueCents = BigInt(String(row.net_revenue_cents || "0"));
                const cogsCents = BigInt(String(row.cogs_cents || "0"));
                const grossProfitCents = netRevenueCents - cogsCents;
                profitability[group]?.push({
                    product_id: row.product_id,
                    product: row.product_name,
                    sku: row.sku,
                    category_id: row.category_id,
                    category: row.category_name,
                    day: row.day_bucket,
                    month: row.month_bucket,
                    quantity_sold: String(row.quantity_sold),
                    net_revenue_cents: complete ? String(netRevenueCents) : null,
                    cogs_cents: complete ? String(cogsCents) : null,
                    gross_profit_cents: complete ? String(grossProfitCents) : null,
                    margin_basis_points: complete && netRevenueCents !== 0n
                        ? String(grossProfitCents * 10_000n / netRevenueCents)
                        : null,
                    data_complete: complete,
                    missing_revenue_count: missingRevenueCount,
                    missing_vat_count: missingVatCount,
                    missing_cogs_count: missingCogsCount,
                });
            }
            const supplierReport: Record<string, unknown> = {
                available: false,
                method: "FIFO purchase-lot attribution for analysis only",
                note: baselineAt && !baselineVerified
                    ? "Supplier profitability is withheld until a physical opening valuation is verified. Opening stock values come from unverified legacy product costs, so FIFO cost and supplier attribution cannot be relied on. Official sale COGS and inventory valuation continue to use weighted-average cost."
                    : "Supplier revenue and FIFO purchase cost are analytical allocations. Official sale COGS and inventory valuation continue to use weighted-average cost. Stock already on hand at the costing baseline and sales made while stock is negative remain unattributed.",
                by_supplier: [],
                by_supplier_product: [],
                by_day: [],
                by_month: [],
                overall: [],
            };
            if (baselineAt) {
                const replayCoverage = await AppDataSource.query(`
                    SELECT ($1::date::timestamp AT TIME ZONE $3) >= $2::timestamptz AS covered
                `, [startDate, baselineAt, timeZone]);
                if (baselineVerified && replayCoverage[0]?.covered) {
                    const movementRows: Array<Record<string, unknown>> = await AppDataSource.query(`
                        SELECT movement."id", movement."product_id", movement."movement_type",
                            movement."quantity", movement."created_at",
                            movement."reference_type", movement."reference_id",
                            COALESCE(movement."location_id"::text, 'unassigned') AS warehouse_id,
                            COALESCE(purchase."vendor_id", NULL)::text AS supplier_id,
                            COALESCE(ROUND(movement."unit_cost" * 100)::bigint,
                                purchase_item."unit_cost_cents")::text AS unit_cost_cents,
                            movement."value_change_cents"::text AS value_change_cents,
                            product."name" AS product_name, product."sku",
                            product."category_id", category."name" AS category_name
                        FROM "stock_movements" movement
                        JOIN "products" product ON product."id" = movement."product_id"
                        LEFT JOIN "categories" category ON category."id" = product."category_id"
                        LEFT JOIN "purchases" purchase
                            ON movement."reference_type" = 'purchase'
                            AND purchase."id" = movement."reference_id"
                        LEFT JOIN LATERAL (
                            SELECT item."unit_cost_cents"
                            FROM "purchase_items" item
                            WHERE item."purchase_id" = purchase."id"
                                AND item."product_id" = movement."product_id"
                            ORDER BY item."id"
                            LIMIT 1
                        ) purchase_item ON true
                        WHERE movement."created_at" >= $1::timestamptz
                            AND movement."created_at" < (($2::date + 1)::timestamp AT TIME ZONE $3)
                            AND movement."quantity" <> 0
                            AND ($4::uuid IS NULL OR movement."product_id" = $4)
                            AND ($5::uuid IS NULL OR product."category_id" = $5)
                        ORDER BY movement."created_at", movement."id"
                    `, [baselineAt, endDate, timeZone, productId || null, categoryId || null]);
                    const saleRows: Array<Record<string, unknown>> = await AppDataSource.query(`
                        SELECT sale_item."sale_id", sale_item."product_id",
                            SUM(sale_item."quantity")::bigint AS quantity,
                            SUM(sale_item."net_revenue_cents")::text AS net_revenue_cents,
                            COUNT(*) FILTER (WHERE sale_item."net_revenue_cents" IS NULL)::int AS missing_revenue
                        FROM "sale_items" sale_item
                        JOIN "sales" sale ON sale."id" = sale_item."sale_id"
                        JOIN "products" product ON product."id" = sale_item."product_id"
                        WHERE sale."created_at" < (($1::date + 1)::timestamp AT TIME ZONE $2)
                            AND sale."status" IN ('completed', 'partially_refunded', 'voided')
                            AND ($3::uuid IS NULL OR sale_item."product_id" = $3)
                            AND ($4::uuid IS NULL OR product."category_id" = $4)
                        GROUP BY sale_item."sale_id", sale_item."product_id"
                    `, [endDate, timeZone, productId || null, categoryId || null]);
                    const returnRows: Array<Record<string, unknown>> = await AppDataSource.query(`
                        SELECT return_request."id" AS return_id, sale_item."sale_id",
                            sale_item."product_id", SUM(return_item."quantity")::bigint AS quantity
                        FROM "return_items" return_item
                        JOIN "return_requests" return_request
                            ON return_request."id" = return_item."return_request_id"
                        JOIN "sale_items" sale_item ON sale_item."id" = return_item."sale_item_id"
                        JOIN "sales" sale ON sale."id" = sale_item."sale_id"
                        JOIN "products" product ON product."id" = sale_item."product_id"
                        JOIN "credit_notes" note ON note."return_request_id" = return_request."id"
                        WHERE return_request."status" = 'approved'
                            AND note."created_at" < (($1::date + 1)::timestamp AT TIME ZONE $2)
                            AND ($3::uuid IS NULL OR sale_item."product_id" = $3)
                            AND ($4::uuid IS NULL OR product."category_id" = $4)
                        GROUP BY return_request."id", sale_item."sale_id", sale_item."product_id"
                    `, [endDate, timeZone, productId || null, categoryId || null]);
                    const salesByKey = new Map(saleRows.map((row) => [
                        `${row.sale_id}:${row.product_id}`,
                        {
                            quantity: Number(row.quantity),
                            revenue: Number(row.missing_revenue) === 0 && row.net_revenue_cents !== null
                                ? BigInt(String(row.net_revenue_cents))
                                : null,
                        },
                    ]));
                    const returnsByKey = new Map(returnRows.map((row) => [
                        `${row.return_id}:${row.product_id}`,
                        { saleId: String(row.sale_id), quantity: Number(row.quantity) },
                    ]));
                    const productInfo = new Map<string, SupplierProductInfo>();
                    const supplierNames = new Map<string, string>();
                    const fifoEvents: SupplierFifoEvent[] = [];
                    const saleMovementGroups = new Map<string, {
                        movement: Record<string, unknown>;
                        quantity: number;
                    }>();
                    const reversalMovementGroups = new Map<string, {
                        movement: Record<string, unknown>;
                        quantity: number;
                    }>();
                    const addMappedEvent = (movement: Record<string, unknown>, event: SupplierFifoEvent) => {
                        fifoEvents.push(event);
                        const productIdFromRow = String(movement.product_id);
                        productInfo.set(productIdFromRow, {
                            id: productIdFromRow,
                            name: String(movement.product_name),
                            sku: String(movement.sku),
                            categoryId: movement.category_id ? String(movement.category_id) : null,
                            category: movement.category_name ? String(movement.category_name) : null,
                        });
                        if (movement.supplier_id) supplierNames.set(String(movement.supplier_id), "Supplier");
                    };
                    for (const movement of movementRows) {
                        const quantity = Math.abs(Number(movement.quantity));
                        const movementType = String(movement.movement_type);
                        const productKey = String(movement.product_id);
                        const warehouseKey = String(movement.warehouse_id);
                        const at = new Date(String(movement.created_at)).toISOString();
                        const referenceId = movement.reference_id ? String(movement.reference_id) : null;
                        const id = String(movement.id);
                        const base = {
                            id,
                            productId: productKey,
                            warehouseId: warehouseKey,
                            quantity,
                            at,
                            referenceId,
                        };
                        if (movementType === "sale") {
                            const key = `${referenceId}:${productKey}`;
                            const existing = saleMovementGroups.get(key);
                            saleMovementGroups.set(key, {
                                movement: existing?.movement || movement,
                                quantity: (existing?.quantity || 0) + quantity,
                            });
                            continue;
                        }
                        if (movementType === "sale_return" || movementType === "sale_void") {
                            const key = `${movementType}:${referenceId}:${productKey}`;
                            const existing = reversalMovementGroups.get(key);
                            reversalMovementGroups.set(key, {
                                movement: existing?.movement || movement,
                                quantity: (existing?.quantity || 0) + quantity,
                            });
                            continue;
                        }
                        let type: SupplierFifoEvent["type"] | null = null;
                        if (movementType === "purchase_receipt" || movementType === "initial_stock" ||
                            movementType === "adjustment_in" || movementType === "costing_opening_balance") {
                            type = "receipt";
                        } else if (movementType === "transfer_out") {
                            type = "transfer_out";
                        } else if (movementType === "transfer_in") {
                            type = "transfer_in";
                        } else if (Number(movement.quantity) < 0) {
                            type = "consume";
                        } else if (Number(movement.quantity) > 0) {
                            type = "receipt";
                        }
                        if (!type) continue;
                        const rawCost = movement.unit_cost_cents ?? movement.value_change_cents;
                        const cost = rawCost === null || rawCost === undefined
                            ? null
                            : movement.unit_cost_cents !== null && movement.unit_cost_cents !== undefined
                                ? BigInt(String(rawCost))
                                : quantity > 0
                                    ? BigInt(String(rawCost)) / BigInt(quantity)
                                    : null;
                        addMappedEvent(movement, {
                            ...base,
                            type,
                            supplierId: type === "receipt" && movementType === "purchase_receipt" && movement.supplier_id
                                ? String(movement.supplier_id)
                                : null,
                            unitCostCents: cost,
                        });
                    }
                    for (const [key, group] of saleMovementGroups) {
                        const [saleId, currentProductId] = key.split(":");
                        const snapshot = salesByKey.get(`${saleId}:${currentProductId}`);
                        if (!snapshot) continue;
                        addMappedEvent(group.movement, {
                            id: String(group.movement.id),
                            type: "sale",
                            productId: currentProductId,
                            warehouseId: String(group.movement.warehouse_id),
                            quantity: group.quantity,
                            at: new Date(String(group.movement.created_at)).toISOString(),
                            saleId,
                            netRevenueCents: snapshot.revenue,
                        });
                    }
                    for (const [key, group] of reversalMovementGroups) {
                        const [movementType, referenceId, currentProductId] = key.split(":");
                        const isVoid = movementType === "sale_void";
                        const originalSaleId = isVoid
                            ? referenceId
                            : returnsByKey.get(`${referenceId}:${currentProductId}`)?.saleId;
                        if (!originalSaleId) continue;
                        addMappedEvent(group.movement, {
                            id: String(group.movement.id),
                            type: isVoid ? "void" : "return",
                            productId: currentProductId,
                            warehouseId: String(group.movement.warehouse_id),
                            quantity: group.quantity,
                            at: new Date(String(group.movement.created_at)).toISOString(),
                            saleId: originalSaleId,
                            referenceId,
                        });
                    }
                    const supplierIds = Array.from(supplierNames.keys());
                    if (supplierIds.length) {
                        const supplierRows: Array<{ id: string; name: string }> = await AppDataSource.query(
                            `SELECT "id", "name" FROM "vendors" WHERE "id" = ANY($1::uuid[])`,
                            [supplierIds],
                        );
                        for (const supplier of supplierRows) supplierNames.set(supplier.id, supplier.name);
                    }
                    const entries = allocateSupplierFifoAttribution(fifoEvents);
                    const built = buildSupplierProfitability({
                        entries,
                        products: productInfo,
                        suppliers: supplierNames,
                        startDate: String(startDate),
                        endDate: String(endDate),
                        timeZone,
                        supplierId,
                        warehouseId,
                    });
                    Object.assign(supplierReport, { available: true, ...built });
                }
            }
            return res.json({
                purchases,
                purchases_total_cents: String(purchasesTotalCents),
                stock_valuation: stockValuation,
                stock_value_total_cents: stockValueCents === null ? null : String(stockValueCents),
                stock_value_data_available: stockValueCents !== null,
                stock_value_verified: baselineVerified,
                profitability,
                supplier_profitability: supplierReport,
                reconciliation,
            });
        } catch (error) {
            console.error("Costing report query failed:", error);
            return res.status(500).json({ message: "Unable to calculate costing report" });
        }
    }
}
