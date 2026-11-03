import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Product } from "../entity/Product";
import { User } from "../entity/User";
import { Warehouse } from "../entity/Warehouse";
import { WarehouseStock } from "../entity/WarehouseStock";
import { ProductBatch } from "../entity/ProductBatch";
import { InventoryAdjustment, AdjustmentType } from "../entity/InventoryAdjustment";
import { InventoryTransfer, TransferStatus } from "../entity/InventoryTransfer";
import { StockTake, StockTakeStatus } from "../entity/StockTake";
import { StockTakeItem } from "../entity/StockTakeItem";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { AccountingService } from "../services/AccountingService";
import { InventoryService } from "../services/InventoryService";
import { SocketService } from "../services/SocketService";
import { getErrorMessage } from "../utils/errors";
import { getReservedQuantity } from "../services/CheckoutReservationService";
import { centsToKesString, divideRoundHalfUp } from "../lib/exactMoney";

const ALLOWED_ADJUSTMENT_TYPES = new Set(Object.values(AdjustmentType));

export const sanitizeInventoryAdjustmentPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Adjustment payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const product_id = typeof payload.product_id === "string" ? payload.product_id.trim() : "";
    const warehouse_id = typeof payload.warehouse_id === "string" ? payload.warehouse_id.trim() : "";
    const type = typeof payload.type === "string" ? payload.type.trim().toLowerCase() : "";
    const quantity_adjusted = Number(payload.quantity_adjusted);
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";

    if (!product_id || !warehouse_id) {
        throw new Error("product_id and warehouse_id are required");
    }

    if (!ALLOWED_ADJUSTMENT_TYPES.has(type as AdjustmentType)) {
        throw new Error("type must be one of: shrinkage, damage, miscount, expiration");
    }

    if (!Number.isSafeInteger(quantity_adjusted) || quantity_adjusted === 0) {
        throw new Error("quantity_adjusted must be a non-zero whole number");
    }
    if (type !== AdjustmentType.MISCOUNT && quantity_adjusted > 0) {
        throw new Error("Shrinkage, damage, and expiration adjustments must reduce stock");
    }

    if (!reason || reason.length > 500) {
        throw new Error("reason is required and must be under 500 characters");
    }

    return {
        product_id,
        warehouse_id,
        type: type as AdjustmentType,
        quantity_adjusted,
        reason,
    };
};

export const sanitizeInventoryTransferPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Transfer payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const product_id = typeof payload.product_id === "string" ? payload.product_id.trim() : "";
    const from_warehouse_id = typeof payload.from_warehouse_id === "string" ? payload.from_warehouse_id.trim() : "";
    const to_warehouse_id = typeof payload.to_warehouse_id === "string" ? payload.to_warehouse_id.trim() : "";
    const quantity = Number(payload.quantity);

    if (!product_id || !from_warehouse_id || !to_warehouse_id) {
        throw new Error("product_id, from_warehouse_id, and to_warehouse_id are required");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("quantity must be a positive whole number");
    }

    return {
        product_id,
        from_warehouse_id,
        to_warehouse_id,
        quantity,
    };
};

export const sanitizeTransferStatusPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Transfer status payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";

    if (!Object.values(TransferStatus).includes(status as TransferStatus)) {
        throw new Error("status must be one of the valid transfer states");
    }

    return { status: status as TransferStatus };
};

export const sanitizeStockTakePayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Stock take payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const warehouse_id = typeof payload.warehouse_id === "string" ? payload.warehouse_id.trim() : "";

    if (!warehouse_id) {
        throw new Error("warehouse_id is required");
    }

    if (payload.notes !== undefined && typeof payload.notes !== "string") {
        throw new Error("notes must be a string when provided");
    }

    const notes = typeof payload.notes === "string" ? payload.notes.trim() : undefined;
    if (notes && notes.length > 1000) {
        throw new Error("notes must be under 1000 characters");
    }

    return { warehouse_id, ...(notes !== undefined ? { notes } : {}) };
};

export interface SanitizedStockTakeUpdateItem {
    id: string;
    counted_quantity: number | null;
}

export interface SanitizedStockTakeUpdatePayload {
    items: SanitizedStockTakeUpdateItem[];
    status?: StockTakeStatus;
}

export const sanitizeStockTakeUpdatePayload = (input: unknown): SanitizedStockTakeUpdatePayload => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Stock take update payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    if (!Array.isArray(payload.items)) {
        throw new Error("items must be an array");
    }

    const items: SanitizedStockTakeUpdateItem[] = payload.items.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Each stock-take item must be an object");
        }

        const itemPayload = item as Record<string, unknown>;
        const id = typeof itemPayload.id === "string" ? itemPayload.id.trim() : "";
        if (!id) throw new Error("Each stock-take item requires an id");

        if (itemPayload.counted_quantity !== undefined && itemPayload.counted_quantity !== null) {
            const counted_quantity = Number(itemPayload.counted_quantity);
            if (!Number.isInteger(counted_quantity) || counted_quantity < 0) {
                throw new Error("Each counted_quantity must be a non-negative whole number or null");
            }
            return { id, counted_quantity };
        }

        return { id, counted_quantity: null };
    });

    const sanitized: SanitizedStockTakeUpdatePayload = { items };

    if (payload.status !== undefined) {
        const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
        if (!Object.values(StockTakeStatus).includes(status as StockTakeStatus)) {
            throw new Error("status must be one of the valid stock-take states");
        }
        sanitized.status = status as StockTakeStatus;
    }

    return sanitized;
};

export class InventoryController {
    
    static async createAdjustment(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const { product_id, warehouse_id, type, quantity_adjusted, reason } = sanitizeInventoryAdjustmentPayload(req.body);
            
            const authorizer = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            const product = await queryRunner.manager.findOne(Product, {
                where: { id: product_id },
                lock: { mode: "pessimistic_write" },
            });
            const warehouse = await queryRunner.manager.findOneBy(Warehouse, { id: warehouse_id });

            if (!authorizer || !product || !warehouse) {
                throw new Error("Invalid references for adjustment");
            }

            if (quantity_adjusted === 0) throw new Error("Adjustment quantity cannot be 0");

            const isShrinkage = quantity_adjusted < 0;
            const absoluteQty = Math.abs(quantity_adjusted);
            const activeSessions = isShrinkage
                ? await queryRunner.manager.find(PaymentCheckoutSession, { where: { status: "reserved" } })
                : [];
            const reservedGlobal = getReservedQuantity(activeSessions, product.id);
            if (isShrinkage && Number(product.stock_on_hand) - reservedGlobal < absoluteQty) {
                throw new Error("Adjustment would reduce global stock below active checkout reservations");
            }

            // Update Global Stock
            product.stock_on_hand += quantity_adjusted;
            await queryRunner.manager.save(product);

            // Update Warehouse Stock
            let branchStock = await queryRunner.manager.findOne(WarehouseStock, {
                where: { warehouse_id: warehouse.id, product_id: product.id },
                lock: { mode: "pessimistic_write" },
            });

            if (!branchStock) {
                branchStock = new WarehouseStock();
                branchStock.warehouse_id = warehouse.id;
                branchStock.product_id = product.id;
                branchStock.stock_on_hand = 0;
            }

            if (isShrinkage && branchStock.stock_on_hand < absoluteQty) {
                throw new Error("Branch does not have enough stock to shrink");
            }
            const reservedBranch = getReservedQuantity(activeSessions, product.id, undefined, warehouse.id);
            if (isShrinkage && Number(branchStock.stock_on_hand) - reservedBranch < absoluteQty) {
                throw new Error("Adjustment would reduce branch stock below active checkout reservations");
            }
            const valuedAdjustment = await InventoryService.adjustValuedStock(
                queryRunner.manager,
                warehouse.id,
                product.id,
                quantity_adjusted,
            );

            // Fetch active batches and adjust
            const batches = await queryRunner.manager.find(ProductBatch, {
                where: { product_id: product.id },
                order: { expiry_date: "ASC", created_at: "ASC" }
            });

            let qtyToAdjust = absoluteQty;
            if (isShrinkage) {
                // FEFO deduction
                for (const batch of batches) {
                    if (qtyToAdjust <= 0) break;
                    if (batch.current_quantity > 0) {
                        const deductAmount = Math.min(batch.current_quantity, qtyToAdjust);
                        batch.current_quantity -= deductAmount;
                        qtyToAdjust -= deductAmount;
                        await queryRunner.manager.save(batch);
                    }
                }
            } else {
                // Positive adjustment, add to the latest batch or create one?
                // For simplicity, add to the most recent batch or first batch
                if (batches.length > 0) {
                    const latestBatch = batches[batches.length - 1];
                    latestBatch.current_quantity += qtyToAdjust;
                    await queryRunner.manager.save(latestBatch);
                }
            }

            // Accounting
            const totalValueCents = valuedAdjustment.valueChangeCents < 0n
                ? -valuedAdjustment.valueChangeCents
                : valuedAdjustment.valueChangeCents;
            const unitCostCents = divideRoundHalfUp(totalValueCents, BigInt(absoluteQty));
            const unitCost = Number(centsToKesString(unitCostCents));
            const totalValue = Number(centsToKesString(totalValueCents));

            const adjustment = new InventoryAdjustment();
            adjustment.product = product;
            adjustment.warehouse = warehouse;
            adjustment.authorizer = authorizer;
            adjustment.type = type;
            adjustment.quantity_adjusted = quantity_adjusted;
            adjustment.unit_cost = unitCost;
            adjustment.total_value_adjusted = totalValue;
            adjustment.reason = reason;
            await queryRunner.manager.save(adjustment);

                        const adjustmentMovementType = quantity_adjusted > 0
                                ? "adjustment_in"
                                : type === AdjustmentType.DAMAGE
                                    ? "damaged"
                                    : type === AdjustmentType.EXPIRATION
                                        ? "expired"
                                        : type === AdjustmentType.SHRINKAGE
                                            ? "shrinkage"
                                            : "adjustment_out";
                        await InventoryService.recordMovement(queryRunner.manager, {
                                productId: product.id,
                                movementType: adjustmentMovementType,
                                quantityChange: quantity_adjusted,
                                quantityBefore: valuedAdjustment.quantityBefore,
                                locationId: warehouse.id,
                                unitCost: Number(unitCost),
                                valueChangeCents: valuedAdjustment.valueChangeCents,
                                referenceType: "adjustment",
                                referenceId: adjustment.id,
                                notes: reason,
                                allowNegativeBalance: valuedAdjustment.quantityBefore < 0 ||
                                    valuedAdjustment.quantityAfter < 0,
                                createdBy: authorizer.id,
                        });
            await InventoryService.recordZeroQuantityCostAdjustment(
                queryRunner.manager,
                warehouse.id,
                product.id,
                authorizer.id,
                "adjustment",
                adjustment.id,
            );

            await AccountingService.recordInventoryAdjustment(
                queryRunner.manager,
                adjustment.id,
                totalValue,
                isShrinkage
            );

            await queryRunner.commitTransaction();

            SocketService.emitInventoryUpdated(product.id, valuedAdjustment.quantityAfter, warehouse.id);

            res.status(201).json(adjustment);

        } catch (err) {
            await queryRunner.rollbackTransaction();
            console.error(err);
            res.status(400).json({ message: getErrorMessage(err, "Error creating adjustment") });
        } finally {
            await queryRunner.release();
        }
    }

    static async createTransfer(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            const { product_id, from_warehouse_id, to_warehouse_id, quantity } = sanitizeInventoryTransferPayload(req.body);
            
            const requester = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            const product = await queryRunner.manager.findOneBy(Product, { id: product_id });
            const from_warehouse = await queryRunner.manager.findOneBy(Warehouse, { id: from_warehouse_id });
            const to_warehouse = await queryRunner.manager.findOneBy(Warehouse, { id: to_warehouse_id });

            if (!requester || !product || !from_warehouse || !to_warehouse) {
                throw new Error("Invalid references for transfer");
            }

            if (from_warehouse.id === to_warehouse.id) {
                throw new Error("Source and destination warehouses must be different");
            }
            if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Quantity must be a positive whole number");

            // Check From Warehouse Stock
            const fromStock = await queryRunner.manager.findOneBy(WarehouseStock, {
                warehouse_id: from_warehouse.id,
                product_id: product.id
            });

            if (!fromStock || fromStock.stock_on_hand < quantity) {
                throw new Error("Source warehouse does not have enough stock");
            }

            const transfer = new InventoryTransfer();
            transfer.product = product;
            transfer.from_warehouse = from_warehouse;
            transfer.to_warehouse = to_warehouse;
            transfer.quantity = quantity;
            transfer.requester = requester;
            transfer.status = TransferStatus.PENDING;
            
            await queryRunner.manager.save(transfer);
            await queryRunner.commitTransaction();

            res.status(201).json(transfer);
        } catch (err) {
            await queryRunner.rollbackTransaction();
            res.status(400).json({ message: getErrorMessage(err, "Error creating transfer") });
        } finally {
            await queryRunner.release();
        }
    }

    static async updateTransferStatus(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            const id = req.params.id;
            const { status } = sanitizeTransferStatusPayload(req.body);
            
            const fulfiller = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            const transfer = await queryRunner.manager.findOne(InventoryTransfer, { 
                where: { id },
                relations: ["product", "from_warehouse", "to_warehouse"]
            });

            if (!fulfiller || !transfer) throw new Error("Invalid transfer reference");
            if (transfer.status !== TransferStatus.PENDING && transfer.status !== TransferStatus.IN_TRANSIT) {
                throw new Error(`Cannot update transfer in ${transfer.status} status`);
            }

            const inventoryUpdates: Array<{ warehouseId: string; stockOnHand: number }> = [];
            transfer.status = status;
            transfer.fulfiller = fulfiller;

            if (status === TransferStatus.COMPLETED) {
                const lockedProduct = await queryRunner.manager.findOne(Product, {
                    where: { id: transfer.product.id },
                    lock: { mode: "pessimistic_write" },
                });
                if (!lockedProduct) throw new Error("Transfer product no longer exists");
                const activeSessions = await queryRunner.manager.find(PaymentCheckoutSession, {
                    where: { status: "reserved" },
                });
                // Deduct from Source Warehouse Stock
                const fromStock = await queryRunner.manager.findOne(WarehouseStock, {
                    where: { warehouse_id: transfer.from_warehouse.id, product_id: transfer.product.id },
                    lock: { mode: "pessimistic_write" },
                });
                const reservedAtSource = getReservedQuantity(
                    activeSessions,
                    transfer.product.id,
                    undefined,
                    transfer.from_warehouse.id,
                );
                if (!fromStock || Number(fromStock.stock_on_hand) - reservedAtSource < transfer.quantity) {
                    throw new Error("Source warehouse no longer has enough stock to complete transfer");
                }
                const sourceAllocation = await InventoryService.consumeValuedStock(
                    queryRunner.manager,
                    transfer.from_warehouse.id,
                    transfer.product.id,
                    transfer.quantity,
                );
                inventoryUpdates.push({
                    warehouseId: transfer.from_warehouse.id,
                    stockOnHand: sourceAllocation.quantityAfter,
                });

                // Add to Destination Warehouse Stock
                const toQuantityBefore = Number((await queryRunner.manager.findOneBy(WarehouseStock, {
                    warehouse_id: transfer.to_warehouse.id,
                    product_id: transfer.product.id,
                }))?.stock_on_hand || 0);
                const toQuantityAfter = await InventoryService.receiveTransferValuedStock(
                    queryRunner.manager,
                    transfer.to_warehouse.id,
                    transfer.product.id,
                    transfer.quantity,
                    sourceAllocation.cogsCents,
                );
                inventoryUpdates.push({
                    warehouseId: transfer.to_warehouse.id,
                    stockOnHand: toQuantityAfter,
                });

                await InventoryService.recordMovement(queryRunner.manager, {
                    productId: transfer.product.id,
                    movementType: "transfer_out",
                    quantityChange: -transfer.quantity,
                    quantityBefore: sourceAllocation.quantityBefore,
                    locationId: transfer.from_warehouse.id,
                    unitCost: Number(centsToKesString(divideRoundHalfUp(sourceAllocation.cogsCents, BigInt(transfer.quantity)))),
                    valueChangeCents: -sourceAllocation.cogsCents,
                    referenceType: "transfer",
                    referenceId: transfer.id,
                    createdBy: fulfiller.id,
                });
                await InventoryService.recordZeroQuantityCostAdjustment(
                    queryRunner.manager,
                    transfer.to_warehouse.id,
                    transfer.product.id,
                    fulfiller.id,
                    "transfer",
                    transfer.id,
                );
                await InventoryService.recordMovement(queryRunner.manager, {
                    productId: transfer.product.id,
                    movementType: "transfer_in",
                    quantityChange: transfer.quantity,
                    quantityBefore: toQuantityBefore,
                    locationId: transfer.to_warehouse.id,
                    unitCost: Number(centsToKesString(divideRoundHalfUp(sourceAllocation.cogsCents, BigInt(transfer.quantity)))),
                    valueChangeCents: sourceAllocation.cogsCents,
                    referenceType: "transfer",
                    referenceId: transfer.id,
                    allowNegativeBalance: toQuantityBefore < 0 || toQuantityAfter < 0,
                    createdBy: fulfiller.id,
                });

            }

            await queryRunner.manager.save(transfer);
            await queryRunner.commitTransaction();

            for (const update of inventoryUpdates) {
                SocketService.emitInventoryUpdated(
                    transfer.product.id,
                    update.stockOnHand,
                    update.warehouseId,
                );
            }
            res.status(200).json(transfer);
        } catch (err) {
            await queryRunner.rollbackTransaction();
            res.status(400).json({ message: getErrorMessage(err, "Error updating transfer") });
        } finally {
            await queryRunner.release();
        }
    }

    static async getAdjustments(req: Request, res: Response) {
        try {
            const adjustments = await AppDataSource.manager.find(InventoryAdjustment, {
                relations: ["product", "warehouse", "authorizer", "authorizer.profile"],
                order: { created_at: "DESC" }
            });
            res.status(200).json(adjustments);
        } catch (err) {
            res.status(500).json({ message: getErrorMessage(err, "Error fetching adjustments") });
        }
    }

    static async getTransfers(req: Request, res: Response) {
        try {
            const transfers = await AppDataSource.manager.find(InventoryTransfer, {
                relations: ["product", "from_warehouse", "to_warehouse", "requester", "fulfiller"],
                order: { created_at: "DESC" }
            });
            res.status(200).json(transfers);
        } catch (err) {
            res.status(500).json({ message: getErrorMessage(err, "Error fetching transfers") });
        }
    }

    static async getAllStockTakes(req: Request, res: Response) {
        try {
            const stockTakes = await AppDataSource.manager.find(StockTake, {
                relations: ["warehouse", "creator", "completer", "items", "items.product"],
                order: { created_at: "DESC" }
            });
            res.status(200).json(stockTakes);
        } catch (err) {
            res.status(500).json({ message: getErrorMessage(err, "Error fetching stock takes") });
        }
    }

    static async initiateStockTake(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const { warehouse_id, notes } = sanitizeStockTakePayload(req.body);
            const creator = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            const warehouse = await queryRunner.manager.findOneBy(Warehouse, { id: warehouse_id });

            if (!creator || !warehouse) {
                throw new Error("Invalid references");
            }

            // Check if there's already an active stock take for this warehouse
            const existing = await queryRunner.manager.findOne(StockTake, {
                where: [
                    { warehouse_id, status: StockTakeStatus.PENDING },
                    { warehouse_id, status: StockTakeStatus.IN_PROGRESS }
                ]
            });
            if (existing) {
                throw new Error("An active stock take already exists for this warehouse");
            }

            const stockTake = new StockTake();
            stockTake.warehouse = warehouse;
            stockTake.creator = creator;
            stockTake.notes = notes ?? "";
            stockTake.status = StockTakeStatus.PENDING;
            await queryRunner.manager.save(stockTake);

            // Populate items based on current warehouse stock
            const stocks = await queryRunner.manager.find(WarehouseStock, {
                where: { warehouse_id },
                relations: ["product"]
            });

            const items: StockTakeItem[] = [];
            for (const stock of stocks) {
                const item = new StockTakeItem();
                item.stock_take = stockTake;
                item.product = stock.product;
                item.expected_quantity = stock.stock_on_hand;
                items.push(item);
            }

            // Save items
            if (items.length > 0) {
                await queryRunner.manager.save(items);
            }

            await queryRunner.commitTransaction();

            // Fetch fully populated
            const created = await queryRunner.manager.findOne(StockTake, {
                where: { id: stockTake.id },
                relations: ["warehouse", "creator", "items", "items.product"]
            });
            res.status(201).json(created);
        } catch (err) {
            await queryRunner.rollbackTransaction();
            res.status(400).json({ message: getErrorMessage(err, "Error initiating stock take") });
        } finally {
            await queryRunner.release();
        }
    }

    static async updateStockTakeCounts(req: Request, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const id = req.params.id;
            const { items, status } = sanitizeStockTakeUpdatePayload(req.body);

            const lockedStockTake = await queryRunner.manager.findOne(StockTake, {
                where: { id: id as string },
                lock: { mode: "pessimistic_write" },
            });
            if (!lockedStockTake) throw new Error("Stock Take not found");
            const stockTake = await queryRunner.manager.findOne(StockTake, {
                where: { id: id as string },
                relations: ["items"]
            });

            if (!stockTake) throw new Error("Stock Take not found");
            if (stockTake.status === StockTakeStatus.COMPLETED || stockTake.status === StockTakeStatus.CANCELLED) {
                throw new Error("Cannot update a closed stock take");
            }
            if (!Array.isArray(items)) {
                throw new Error("Stock-take items are required");
            }

            const submittedItemIds = new Set<string>();
            for (const updateItem of items) {
                if (submittedItemIds.has(updateItem.id)) {
                    throw new Error("A stock-take item can only be submitted once");
                }
                submittedItemIds.add(updateItem.id);
                const stItem = stockTake.items.find(i => i.id === updateItem.id);
                if (!stItem) {
                    throw new Error("Stock-take item does not belong to this stock take");
                }
                if (updateItem.counted_quantity !== null &&
                    (!Number.isInteger(updateItem.counted_quantity) || updateItem.counted_quantity < 0)) {
                    throw new Error("Counted quantity must be a non-negative whole number or null");
                }
                stItem.counted_quantity = updateItem.counted_quantity;
                stItem.discrepancy = updateItem.counted_quantity !== null
                    ? updateItem.counted_quantity - stItem.expected_quantity
                    : null;
                await queryRunner.manager.save(stItem);
            }

            if (status !== undefined) {
                if (![StockTakeStatus.PENDING, StockTakeStatus.IN_PROGRESS].includes(status)) {
                    throw new Error("Stock-take completion must use the dedicated complete action");
                }
                if (stockTake.status === StockTakeStatus.IN_PROGRESS && status === StockTakeStatus.PENDING) {
                    throw new Error("An in-progress stock take cannot be returned to pending");
                }
                stockTake.status = status;
                await queryRunner.manager.save(stockTake);
            }

            await queryRunner.commitTransaction();
            res.status(200).json({ message: "Counts updated successfully" });
        } catch (err) {
            await queryRunner.rollbackTransaction();
            res.status(400).json({ message: getErrorMessage(err, "Error updating counts") });
        } finally {
            await queryRunner.release();
        }
    }

    static async completeStockTake(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const id = req.params.id;
            const lockedStockTake = await queryRunner.manager.findOne(StockTake, {
                where: { id: id as string },
                lock: { mode: "pessimistic_write" },
            });
            if (!lockedStockTake) throw new Error("Stock Take not found");
            const completer = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            const stockTake = await queryRunner.manager.findOne(StockTake, {
                where: { id: id as string },
                relations: ["warehouse", "items", "items.product"]
            });

            if (!completer || !stockTake) throw new Error("Stock Take not found");
            if (stockTake.status === StockTakeStatus.COMPLETED || stockTake.status === StockTakeStatus.CANCELLED) {
                throw new Error("Stock take is already closed");
            }
            if (stockTake.items.some((item) => item.counted_quantity === null)) {
                throw new Error("Every stock-take item must be counted before completion");
            }
            const inventoryUpdates: Array<{ productId: string; stockOnHand: number; warehouseId: string }> = [];

            // Apply discrepancies
            for (const item of stockTake.items) {
                if (item.counted_quantity !== null && item.discrepancy != null && item.discrepancy !== 0) {
                    const quantity_adjusted = item.discrepancy as number;
                    const isShrinkage = quantity_adjusted < 0;
                    const absoluteQty = Math.abs(quantity_adjusted);

                    const lockedProduct = await queryRunner.manager.findOne(Product, {
                        where: { id: item.product.id },
                        lock: { mode: "pessimistic_write" },
                    });
                    if (!lockedProduct) throw new Error("Stock-take product no longer exists");
                    const activeSessions = await queryRunner.manager.find(PaymentCheckoutSession, {
                        where: { status: "reserved" },
                    });
                    const reservedGlobal = getReservedQuantity(activeSessions, item.product.id);
                    const reservedBranch = getReservedQuantity(
                        activeSessions,
                        item.product.id,
                        undefined,
                        stockTake.warehouse.id,
                    );
                    if (Number(lockedProduct.stock_on_hand) + quantity_adjusted < reservedGlobal) {
                        throw new Error("Stock take would reduce global stock below active checkout reservations");
                    }

                    // Update Global Stock
                    lockedProduct.stock_on_hand += quantity_adjusted;
                    item.product = lockedProduct;
                    await queryRunner.manager.save(lockedProduct);

                    // Update Warehouse Stock
                    let branchStock = await queryRunner.manager.findOne(WarehouseStock, {
                        where: { warehouse_id: stockTake.warehouse.id, product_id: item.product.id },
                        lock: { mode: "pessimistic_write" },
                    });
                    if (!branchStock) {
                        branchStock = queryRunner.manager.create(WarehouseStock, {
                            warehouse_id: stockTake.warehouse.id,
                            product_id: item.product.id,
                            stock_on_hand: 0,
                        });
                    }
                    if (Number(branchStock.stock_on_hand) + quantity_adjusted < reservedBranch) {
                        throw new Error("Stock take would reduce branch stock below active checkout reservations");
                    }
                    const valuedAdjustment = await InventoryService.adjustValuedStock(
                        queryRunner.manager,
                        stockTake.warehouse.id,
                        item.product.id,
                        quantity_adjusted,
                    );
                    branchStock.stock_on_hand = valuedAdjustment.quantityAfter;

                    // Create Inventory Adjustment record
                    const totalValueCents = valuedAdjustment.valueChangeCents < 0n
                        ? -valuedAdjustment.valueChangeCents
                        : valuedAdjustment.valueChangeCents;
                    const unitCostCents = divideRoundHalfUp(totalValueCents, BigInt(absoluteQty));
                    const unitCost = Number(centsToKesString(unitCostCents));
                    const totalValue = Number(centsToKesString(totalValueCents));

                    const adjustment = new InventoryAdjustment();
                    adjustment.product = item.product;
                    adjustment.warehouse = stockTake.warehouse;
                    adjustment.authorizer = completer;
                    adjustment.type = isShrinkage ? AdjustmentType.MISCOUNT : AdjustmentType.MISCOUNT; 
                    adjustment.quantity_adjusted = quantity_adjusted;
                    adjustment.unit_cost = unitCost;
                    adjustment.total_value_adjusted = totalValue;
                    adjustment.reason = `Stock Take ${stockTake.id} Discrepancy`;
                    await queryRunner.manager.save(adjustment);

                    await InventoryService.recordMovement(queryRunner.manager, {
                        productId: item.product.id,
                        movementType: quantity_adjusted > 0 ? "adjustment_in" : "adjustment_out",
                        quantityChange: quantity_adjusted,
                        quantityBefore: valuedAdjustment.quantityBefore,
                        locationId: stockTake.warehouse.id,
                        unitCost: Number(unitCost),
                        valueChangeCents: valuedAdjustment.valueChangeCents,
                        referenceType: "adjustment",
                        referenceId: adjustment.id,
                        notes: adjustment.reason,
                        allowNegativeBalance: valuedAdjustment.quantityBefore < 0 ||
                            valuedAdjustment.quantityAfter < 0,
                        createdBy: completer.id,
                    });
                    await InventoryService.recordZeroQuantityCostAdjustment(
                        queryRunner.manager,
                        stockTake.warehouse.id,
                        item.product.id,
                        completer.id,
                        "stock_take",
                        stockTake.id,
                    );

                    // Accounting
                    await AccountingService.recordInventoryAdjustment(
                        queryRunner.manager,
                        adjustment.id,
                        totalValue,
                        isShrinkage
                    );

                    inventoryUpdates.push({
                        productId: item.product.id,
                        stockOnHand: Number(branchStock.stock_on_hand),
                        warehouseId: stockTake.warehouse.id,
                    });
                }
            }

            stockTake.status = StockTakeStatus.COMPLETED;
            stockTake.completer = completer;
            stockTake.completed_at = new Date();
            await queryRunner.manager.save(stockTake);

            await queryRunner.commitTransaction();
            for (const update of inventoryUpdates) {
                SocketService.emitInventoryUpdated(update.productId, update.stockOnHand, update.warehouseId);
            }
            res.status(200).json(stockTake);
        } catch (err) {
            await queryRunner.rollbackTransaction();
            res.status(400).json({ message: getErrorMessage(err, "Error completing stock take") });
        } finally {
            await queryRunner.release();
        }
    }
}
