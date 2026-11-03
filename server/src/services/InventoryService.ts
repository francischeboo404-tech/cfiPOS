import { EntityManager } from "typeorm";
import { Product } from "../entity/Product";
import { StockMovement } from "../entity/StockMovement";
import { WarehouseStock } from "../entity/WarehouseStock";
import { Purchase } from "../entity/Purchase";
import { PurchaseItem } from "../entity/PurchaseItem";
import { InventoryAdjustment, AdjustmentType } from "../entity/InventoryAdjustment";
import { AccountingService } from "./AccountingService";
import {
    allocateWeightedAverageCogs,
    calculateZeroQuantityValueAdjustment,
    calculateWeightedAverageReceipt,
    centsToKesString,
    divideRoundHalfUp,
    parseKesToCents,
} from "../lib/exactMoney";

export interface InventoryMovementInput {
    productId: string;
    movementType: string;
    quantityChange: number;
    quantityBefore: number;
    locationId: string | null;
    unitCost: number | null;
    referenceType: string;
    referenceId: string | null;
    notes?: string | null;
    allowNegativeBalance?: boolean;
    negativeStockOverride?: boolean;
    valueChangeCents?: bigint | null;
    createdBy: string;
}

export class InventoryService {
    static async initializeCostingBaseline(manager: EntityManager): Promise<boolean> {
        return manager.transaction(async (transaction) => {
            await transaction.query(`LOCK TABLE "warehouse_stocks" IN SHARE ROW EXCLUSIVE MODE`);
            await transaction.query(`LOCK TABLE "stock_movements" IN SHARE ROW EXCLUSIVE MODE`);

            const existing = await transaction.query(
                `SELECT "id" FROM "inventory_costing_baselines" WHERE "id" = 1`,
            );
            if (existing.length > 0) return true;

            const actors = await transaction.query(`
                SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1
            `);
            if (actors.length === 0) return false;

            const invalidStock = await transaction.query(`
                SELECT COUNT(*)::int AS "count"
                FROM "warehouse_stocks"
                WHERE "stock_on_hand" < 0
                   OR "stock_value_cents" IS NULL
                   OR "stock_value_cents" < 0
            `);
            if (Number(invalidStock[0].count) > 0) {
                throw new Error("Cannot establish a costing baseline while stock quantity or value is incomplete");
            }

            const ledgerCoverage = await transaction.query(`
                WITH movement_balances AS (
                    SELECT movement."product_id", movement."location_id",
                        SUM(movement."quantity")::bigint AS quantity,
                        SUM(movement."value_change_cents")::numeric AS value_cents,
                        COUNT(*) FILTER (WHERE movement."value_change_cents" IS NULL)::int AS missing_values
                    FROM "stock_movements" movement
                    WHERE movement."location_id" IS NOT NULL
                    GROUP BY movement."product_id", movement."location_id"
                ),
                stock_mismatches AS (
                    SELECT 1
                    FROM "warehouse_stocks" stock
                    LEFT JOIN movement_balances movement
                        ON movement."product_id" = stock."product_id"
                        AND movement."location_id" = stock."warehouse_id"
                    WHERE stock."stock_on_hand" <> COALESCE(movement.quantity, 0)
                        OR stock."stock_value_cents"::numeric <> COALESCE(movement.value_cents, 0)
                        OR COALESCE(movement.missing_values, 0) > 0
                    UNION ALL
                    SELECT 1
                    FROM movement_balances movement
                    LEFT JOIN "warehouse_stocks" stock
                        ON stock."product_id" = movement."product_id"
                        AND stock."warehouse_id" = movement."location_id"
                    WHERE stock."id" IS NULL
                        AND (
                            movement.quantity <> 0
                            OR movement.value_cents <> 0
                            OR movement.missing_values > 0
                        )
                ),
                aggregate_mismatches AS (
                    SELECT 1
                    FROM "products" product
                    LEFT JOIN (
                        SELECT "product_id", SUM("stock_on_hand")::bigint AS quantity
                        FROM "warehouse_stocks"
                        GROUP BY "product_id"
                    ) stock ON stock."product_id" = product."id"
                    WHERE product."stock_on_hand" <> COALESCE(stock.quantity, 0)
                )
                SELECT (
                    EXISTS (SELECT 1 FROM stock_mismatches)
                    OR EXISTS (SELECT 1 FROM aggregate_mismatches)
                ) AS incomplete
            `);
            const baselineVerified = !ledgerCoverage[0]?.incomplete;

            const baselineRows = await transaction.query(`
                INSERT INTO "inventory_costing_baselines" (
                    "id", "created_at", "created_by", "valuation_method"
                )
                VALUES (1, transaction_timestamp(), $1, $2)
                RETURNING "created_at"
            `, [
                actors[0].id,
                baselineVerified ? "weighted_average_opening_snapshot" : "legacy_product_unit_cost_snapshot",
            ]);
            const baselineAt = baselineRows[0].created_at;

            await transaction.query(`
                INSERT INTO "stock_movements" (
                    "product_id", "movement_type", "quantity", "quantity_before", "quantity_after",
                    "unit_cost", "value_change_cents", "reference_type", "location_id", "notes",
                    "created_by", "created_at"
                )
                SELECT stock."product_id", 'costing_opening_balance', stock."stock_on_hand", 0,
                    stock."stock_on_hand", product."unit_cost", stock."stock_value_cents",
                    'costing_opening_balance', stock."warehouse_id",
                    $3,
                    $1, $2
                FROM "warehouse_stocks" stock
                JOIN "products" product ON product."id" = stock."product_id"
                WHERE stock."stock_on_hand" > 0
            `, [
                actors[0].id,
                baselineAt,
                baselineVerified
                    ? "Verified opening stock valuation snapshot created after exact stock ledger reconciliation"
                    : "Unverified legacy opening stock valuation snapshot; current stock ledger does not fully reconcile",
            ]);

            return true;
        });
    }

    static async getTotalStockByProduct(manager: EntityManager): Promise<Map<string, number>> {
        const rows: { product_id: string; stock_on_hand: string | number }[] = await manager.query(
            `SELECT "product_id", SUM("stock_on_hand")::int AS "stock_on_hand"
             FROM "warehouse_stocks"
             GROUP BY "product_id"`,
        );
        return new Map(rows.map((row) => [row.product_id, Number(row.stock_on_hand)]));
    }

    static getTotalStockOnHand(
        product: Pick<Product, "id" | "stock_on_hand">,
        totalsByProduct: ReadonlyMap<string, number>,
    ): number {
        const warehouseTotal = totalsByProduct.get(product.id);
        return warehouseTotal === undefined ? Number(product.stock_on_hand) || 0 : warehouseTotal;
    }

    static async initializeStock(
        manager: EntityManager,
        productId: string,
        warehouseId: string,
        quantity: number,
        createdBy: string,
    ): Promise<void> {
        if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new Error("Opening stock must be a positive whole number");
        }

        const product = await manager.findOneByOrFail(Product, { id: productId });
        if (product.unit_cost === null || product.unit_cost === undefined) {
            throw new Error("Opening stock requires a recorded unit cost");
        }
        if (Number(product.stock_on_hand) !== quantity) {
            throw new Error("Opening quantity must match the product aggregate balance");
        }

        const existingStock = await manager.findOneBy(WarehouseStock, {
            warehouse_id: warehouseId,
            product_id: productId,
        });
        if (existingStock) {
            throw new Error("Opening stock has already been initialized for this product and warehouse");
        }

        await manager.save(WarehouseStock, manager.create(WarehouseStock, {
            warehouse_id: warehouseId,
            product_id: productId,
            stock_on_hand: quantity,
            stock_value_cents: String(BigInt(quantity) * parseKesToCents(String(product.unit_cost))),
        }));
        const unitCostCents = parseKesToCents(String(product.unit_cost));
        const purchase = await manager.save(Purchase, manager.create(Purchase, {
            vendor_id: null,
            warehouse_id: warehouseId,
            delivery_note_id: null,
            reference: "Opening stock",
            purchase_kind: "opening_stock",
            purchased_at: new Date(),
            created_by: createdBy,
        }));
        await manager.save(PurchaseItem, manager.create(PurchaseItem, {
            purchase_id: purchase.id,
            product_id: productId,
            quantity,
            unit_cost_cents: String(unitCostCents),
            total_cost_cents: String(BigInt(quantity) * unitCostCents),
        }));
        await this.recordMovement(manager, {
            productId,
            movementType: "initial_stock",
            quantityChange: quantity,
            quantityBefore: 0,
            locationId: warehouseId,
            unitCost: Number(centsToKesString(unitCostCents)),
            referenceType: "initial",
            referenceId: productId,
            notes: "Opening stock at product creation",
            valueChangeCents: BigInt(quantity) * unitCostCents,
            createdBy,
        });
    }

    static async recordMovement(manager: EntityManager, input: InventoryMovementInput): Promise<StockMovement> {
        const quantityAfter = input.quantityBefore + input.quantityChange;
        const hasValueOnlyAdjustment = input.quantityChange === 0 &&
            input.valueChangeCents !== undefined &&
            input.valueChangeCents !== null &&
            input.valueChangeCents !== 0n;
        if (!Number.isInteger(input.quantityChange) ||
            (input.quantityChange === 0 && !hasValueOnlyAdjustment) ||
            !Number.isInteger(input.quantityBefore) ||
            (input.quantityBefore < 0 && !input.allowNegativeBalance) ||
            (quantityAfter < 0 && !input.allowNegativeBalance)) {
            throw new Error("Inventory movement must describe a valid non-negative stock change");
        }

        const movement = manager.create(StockMovement, {
            product_id: input.productId,
            movement_type: input.movementType,
            quantity: input.quantityChange,
            quantity_before: input.quantityBefore,
            quantity_after: quantityAfter,
            unit_cost: input.unitCost,
            value_change_cents: input.valueChangeCents === undefined || input.valueChangeCents === null
                ? null
                : String(input.valueChangeCents),
            reference_type: input.referenceType,
            reference_id: input.referenceId,
            location_id: input.locationId,
            notes: [
                input.notes?.trim() || null,
                input.negativeStockOverride ? "Negative-stock override enabled by admin setting" : null,
            ].filter((note): note is string => note !== null).join("\n") || null,
            created_by: input.createdBy,
        });
        return manager.save(movement);
    }

    static async recordZeroQuantityCostAdjustment(
        manager: EntityManager,
        warehouseId: string,
        productId: string,
        createdBy: string,
        sourceType: string,
        sourceId: string,
    ): Promise<bigint> {
        const stock = await manager.findOne(WarehouseStock, {
            where: { warehouse_id: warehouseId, product_id: productId },
            lock: { mode: "pessimistic_write" },
        });
        if (!stock) return 0n;
        if (stock.stock_value_cents === null) {
            throw new Error("Cannot recognize zero-stock cost variance because stock value is unavailable");
        }

        const valueChangeCents = calculateZeroQuantityValueAdjustment(
            Number(stock.stock_on_hand),
            BigInt(stock.stock_value_cents),
        );
        if (valueChangeCents === 0n) return 0n;

        const absoluteValueCents = valueChangeCents < 0n ? -valueChangeCents : valueChangeCents;
        const totalValue = Number(centsToKesString(absoluteValueCents));
        const reason = `Weighted-average cost variance recognized when negative stock was replenished to zero. Source: ${sourceType} ${sourceId}.`;
        stock.stock_value_cents = "0";
        await manager.save(stock);

        const adjustment = await manager.save(InventoryAdjustment, manager.create(InventoryAdjustment, {
            product_id: productId,
            warehouse_id: warehouseId,
            authorized_by: createdBy,
            type: AdjustmentType.MISCOUNT,
            quantity_adjusted: 0,
            unit_cost: 0,
            total_value_adjusted: totalValue,
            reason,
        }));
        await this.recordMovement(manager, {
            productId,
            movementType: "inventory_value_adjustment",
            quantityChange: 0,
            quantityBefore: 0,
            locationId: warehouseId,
            unitCost: null,
            valueChangeCents,
            referenceType: "adjustment",
            referenceId: adjustment.id,
            notes: reason,
            createdBy,
        });
        await AccountingService.recordInventoryAdjustment(
            manager,
            adjustment.id,
            totalValue,
            valueChangeCents < 0n,
        );
        return valueChangeCents;
    }

    static async receiveStock(
        manager: EntityManager,
        productId: string,
        warehouseId: string,
        quantity: number,
        referenceId: string,
        createdBy: string,
        unitCostCents: bigint,
    ): Promise<number> {
        if (!Number.isInteger(quantity) || quantity <= 0 || unitCostCents < 0n) {
            throw new Error("Received quantity must be a positive whole number");
        }

        const existing = await manager.findOne(WarehouseStock, {
            where: { warehouse_id: warehouseId, product_id: productId },
            lock: { mode: "pessimistic_write" },
        });
        const oldQuantity = Number(existing?.stock_on_hand || 0);
        if (existing?.stock_value_cents == null && oldQuantity !== 0) {
            throw new Error("Cannot receive stock because existing warehouse cost value is unavailable");
        }
        const updated = calculateWeightedAverageReceipt(
            oldQuantity,
            BigInt(existing?.stock_value_cents || "0"),
            quantity,
            unitCostCents,
        );
        const warehouseStock = existing || manager.create(WarehouseStock, {
            warehouse_id: warehouseId,
            product_id: productId,
            stock_on_hand: 0,
            stock_value_cents: "0",
        });
        warehouseStock.stock_on_hand = updated.quantity;
        warehouseStock.stock_value_cents = String(updated.stockValueCents);
        await manager.save(warehouseStock);
        await manager.increment(Product, { id: productId }, "stock_on_hand", quantity);

        const product = await manager.findOneByOrFail(Product, { id: productId });
        await this.recordMovement(manager, {
            productId,
            movementType: "purchase_receipt",
            quantityChange: quantity,
            quantityBefore: updated.quantity - quantity,
            locationId: warehouseId,
            unitCost: Number(centsToKesString(unitCostCents)),
            valueChangeCents: BigInt(quantity) * unitCostCents,
            referenceType: "purchase",
            referenceId,
            allowNegativeBalance: oldQuantity < 0 || updated.quantity < 0,
            createdBy,
        });
        await this.recordZeroQuantityCostAdjustment(
            manager,
            warehouseId,
            productId,
            createdBy,
            "purchase",
            referenceId,
        );
        return Number(product.stock_on_hand);
    }

    static async consumeValuedStock(
        manager: EntityManager,
        warehouseId: string,
        productId: string,
        quantity: number,
        allowNegativeStock = false,
    ): Promise<{
        cogsCents: bigint;
        unitCostCents: bigint;
        costBasisCents: bigint;
        quantityBefore: number;
        quantityAfter: number;
    }> {
        const stock = await manager.findOne(WarehouseStock, {
            where: { warehouse_id: warehouseId, product_id: productId },
            lock: { mode: "pessimistic_write" },
        });
        if (!stock && !allowNegativeStock) {
            throw new Error("Warehouse stock has no recorded cost value");
        }
        const product = allowNegativeStock
            ? await manager.findOneByOrFail(Product, { id: productId })
            : null;
        const warehouseStock = stock || manager.create(WarehouseStock, {
            warehouse_id: warehouseId,
            product_id: productId,
            stock_on_hand: 0,
            stock_value_cents: "0",
        });
        if (warehouseStock.stock_value_cents === null &&
            (Number(warehouseStock.stock_on_hand) !== 0 || !allowNegativeStock)) {
            throw new Error("Warehouse stock has no recorded cost value");
        }
        const quantityBefore = Number(warehouseStock.stock_on_hand);
        const costBasisCents = BigInt(warehouseStock.stock_value_cents || "0");
        const fallbackUnitCostCents = product?.unit_cost === null || product?.unit_cost === undefined
            ? undefined
            : parseKesToCents(String(product.unit_cost));
        const allocation = allocateWeightedAverageCogs(
            quantityBefore,
            costBasisCents,
            quantity,
            allowNegativeStock,
            fallbackUnitCostCents,
        );
        warehouseStock.stock_on_hand = allocation.remainingQuantity;
        warehouseStock.stock_value_cents = String(allocation.remainingStockValueCents);
        await manager.save(warehouseStock);
        await manager.decrement(Product, { id: productId }, "stock_on_hand", quantity);
        const unitCostCents = divideRoundHalfUp(allocation.cogsCents, BigInt(quantity));
        return {
            cogsCents: allocation.cogsCents,
            unitCostCents,
            costBasisCents,
            quantityBefore,
            quantityAfter: allocation.remainingQuantity,
        };
    }

    static async restoreValuedStock(
        manager: EntityManager,
        warehouseId: string,
        productId: string,
        quantity: number,
        cogsCents: bigint,
    ): Promise<number> {
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || cogsCents < 0n) {
            throw new Error("Returned quantity and original cost must be valid");
        }
        const stock = await manager.findOne(WarehouseStock, {
            where: { warehouse_id: warehouseId, product_id: productId },
            lock: { mode: "pessimistic_write" },
        });
        if (stock?.stock_value_cents == null && Number(stock?.stock_on_hand || 0) !== 0) {
            throw new Error("Cannot restore returned stock because existing warehouse cost value is unavailable");
        }
        const warehouseStock = stock || manager.create(WarehouseStock, {
            warehouse_id: warehouseId,
            product_id: productId,
            stock_on_hand: 0,
            stock_value_cents: "0",
        });
        warehouseStock.stock_on_hand += quantity;
        warehouseStock.stock_value_cents = String(BigInt(warehouseStock.stock_value_cents || "0") + cogsCents);
        await manager.save(warehouseStock);
        await manager.increment(Product, { id: productId }, "stock_on_hand", quantity);
        return warehouseStock.stock_on_hand;
    }

    static async receiveTransferValuedStock(
        manager: EntityManager,
        warehouseId: string,
        productId: string,
        quantity: number,
        valueCents: bigint,
    ): Promise<number> {
        if (!Number.isSafeInteger(quantity) || quantity <= 0 || valueCents < 0n) {
            throw new Error("Transfer quantity and value must be valid");
        }
        const stock = await manager.findOne(WarehouseStock, {
            where: { warehouse_id: warehouseId, product_id: productId },
            lock: { mode: "pessimistic_write" },
        });
        if (stock?.stock_value_cents == null && Number(stock?.stock_on_hand || 0) !== 0) {
            throw new Error("Cannot receive transferred stock because destination cost value is unavailable");
        }
        const destination = stock || manager.create(WarehouseStock, {
            warehouse_id: warehouseId,
            product_id: productId,
            stock_on_hand: 0,
            stock_value_cents: "0",
        });
        destination.stock_on_hand += quantity;
        destination.stock_value_cents = String(BigInt(destination.stock_value_cents || "0") + valueCents);
        await manager.save(destination);
        return destination.stock_on_hand;
    }

    static async adjustValuedStock(
        manager: EntityManager,
        warehouseId: string,
        productId: string,
        quantityChange: number,
    ): Promise<{ quantityBefore: number; quantityAfter: number; valueChangeCents: bigint }> {
        if (!Number.isSafeInteger(quantityChange) || quantityChange === 0) {
            throw new Error("Inventory adjustment quantity must be a non-zero whole number");
        }
        const stock = await manager.findOne(WarehouseStock, {
            where: { warehouse_id: warehouseId, product_id: productId },
            lock: { mode: "pessimistic_write" },
        });
        const quantityBefore = Number(stock?.stock_on_hand || 0);
        if (stock?.stock_value_cents == null && quantityBefore !== 0) {
            throw new Error("Cannot adjust stock because its recorded cost value is unavailable");
        }
        let quantityAfter: number;
        let valueChangeCents: bigint;
        let valueAfterCents: bigint;
        if (quantityChange < 0) {
            const allocation = allocateWeightedAverageCogs(
                quantityBefore,
                BigInt(stock?.stock_value_cents || "0"),
                -quantityChange,
            );
            quantityAfter = allocation.remainingQuantity;
            valueAfterCents = allocation.remainingStockValueCents;
            valueChangeCents = -allocation.cogsCents;
        } else {
            quantityAfter = quantityBefore + quantityChange;
            if (quantityBefore > 0) {
                valueChangeCents = divideRoundHalfUp(
                    BigInt(stock!.stock_value_cents!) * BigInt(quantityChange),
                    BigInt(quantityBefore),
                );
            } else if (quantityBefore < 0 && BigInt(stock?.stock_value_cents || "0") < 0n) {
                const currentAverageCents = divideRoundHalfUp(
                    -BigInt(stock!.stock_value_cents!),
                    BigInt(-quantityBefore),
                );
                valueChangeCents = currentAverageCents * BigInt(quantityChange);
            } else {
                const product = await manager.findOneByOrFail(Product, { id: productId });
                if (product.unit_cost === null || product.unit_cost === undefined) {
                    throw new Error("Positive stock adjustment requires recorded unit-cost data");
                }
                valueChangeCents = BigInt(quantityChange) * parseKesToCents(String(product.unit_cost));
            }
            valueAfterCents = BigInt(stock?.stock_value_cents || "0") + valueChangeCents;
        }
        const updated = stock || manager.create(WarehouseStock, {
            warehouse_id: warehouseId,
            product_id: productId,
            stock_on_hand: 0,
            stock_value_cents: "0",
        });
        updated.stock_on_hand = quantityAfter;
        updated.stock_value_cents = String(valueAfterCents);
        await manager.save(updated);
        return { quantityBefore, quantityAfter, valueChangeCents };
    }
}