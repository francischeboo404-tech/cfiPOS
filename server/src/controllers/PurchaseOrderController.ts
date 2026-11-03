import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { PurchaseOrder } from "../entity/PurchaseOrder";
import { PoItem } from "../entity/PoItem";
import { DeliveryNote } from "../entity/DeliveryNote";
import { DeliveryNoteItem } from "../entity/DeliveryNoteItem";
import { ProductBatch } from "../entity/ProductBatch";
import { Product } from "../entity/Product";
import { Warehouse } from "../entity/Warehouse";
import { InventoryService } from "../services/InventoryService";
import { AccountingService } from "../services/AccountingService";
import { EmailService } from "../services/EmailService";
import { Purchase } from "../entity/Purchase";
import { PurchaseItem } from "../entity/PurchaseItem";
import { centsToKesString, parseKesToCents } from "../lib/exactMoney";

class PurchaseOrderReceiveValidationError extends Error {}
class PurchaseOrderCreateValidationError extends Error {}

export const sanitizePurchaseOrderCreatePayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new PurchaseOrderCreateValidationError("Purchase order payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const vendor_id = typeof payload.vendor_id === "string" ? payload.vendor_id.trim() : "";
    const warehouse_id = typeof payload.warehouse_id === "string" ? payload.warehouse_id.trim() : "";
    if (!vendor_id) throw new PurchaseOrderCreateValidationError("vendor_id is required");
    if (!warehouse_id) throw new PurchaseOrderCreateValidationError("warehouse_id is required");

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        throw new PurchaseOrderCreateValidationError("At least one purchase-order item is required");
    }

    const items = payload.items.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new PurchaseOrderCreateValidationError("Each purchase-order item must be an object");
        }

        const itemPayload = item as Record<string, unknown>;
        const product_id = typeof itemPayload.product_id === "string" ? itemPayload.product_id.trim() : "";
        const quantity = Number(itemPayload.quantity);
        const unit_cost = itemPayload.unit_cost;

        if (!product_id) throw new PurchaseOrderCreateValidationError("Each purchase-order item requires a product_id");
        if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new PurchaseOrderCreateValidationError("Each purchase-order item quantity must be a positive whole number");
        let unitCostCents: bigint;
        try {
            unitCostCents = parseKesToCents(String(unit_cost));
        } catch {
            throw new PurchaseOrderCreateValidationError("Each purchase-order item unit_cost must be a non-negative amount with at most two decimal places");
        }

        return {
            product_id,
            quantity,
            unit_cost: Number(centsToKesString(unitCostCents)),
        };
    });

    return { vendor_id, warehouse_id, items };
};

export const sanitizePurchaseOrderStatusPayload = (input: unknown): { status: string } => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Purchase order status payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
    const allowedStatuses = ["draft", "sent", "partially_received", "received", "cancelled"];

    if (!allowedStatuses.includes(status)) {
        throw new Error("status is invalid");
    }

    return { status };
};

export const sanitizePurchaseOrderReceivePayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new PurchaseOrderReceiveValidationError("Purchase order receive payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const reference = typeof payload.reference === "string" ? payload.reference.trim().slice(0, 120) : "";
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
        throw new PurchaseOrderReceiveValidationError("Receiving items are required");
    }

    const items = payload.items.map((requestItem: unknown) => {
        if (!requestItem || typeof requestItem !== "object" || Array.isArray(requestItem)) {
            throw new PurchaseOrderReceiveValidationError("Each receiving item must be an object");
        }

        const item = requestItem as Record<string, unknown>;
        const po_item_id = typeof item.po_item_id === "string" ? item.po_item_id.trim() : "";
        const product_id = typeof item.product_id === "string" ? item.product_id.trim() : "";
        const receiving_quantity = Number(item.receiving_quantity);
        const rejected_quantity = Number(item.rejected_quantity ?? 0);

        if (!po_item_id) throw new PurchaseOrderReceiveValidationError("Each receiving item requires a po_item_id");
        if (!product_id) throw new PurchaseOrderReceiveValidationError("Each receiving item requires a product_id");
        if (!Number.isSafeInteger(receiving_quantity) || receiving_quantity < 0) {
            throw new PurchaseOrderReceiveValidationError("Each receiving item receiving_quantity must be a non-negative whole number");
        }
        if (!Number.isSafeInteger(rejected_quantity) || rejected_quantity < 0) {
            throw new PurchaseOrderReceiveValidationError("Each receiving item rejected_quantity must be a non-negative whole number");
        }

        const optionalText = (key: string, maxLength: number) => {
            const value = item[key];
            return typeof value === "string" && value.trim()
                ? value.trim().slice(0, maxLength)
                : undefined;
        };
        const optionalDate = (key: string) => {
            const value = item[key];
            if (value === undefined || value === null || value === "") return undefined;
            if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                throw new PurchaseOrderReceiveValidationError(`${key} must be a valid date`);
            }
            const parsed = new Date(`${value}T00:00:00.000Z`);
            if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
                throw new PurchaseOrderReceiveValidationError(`${key} must be a valid date`);
            }
            return value;
        };

        return {
            po_item_id,
            product_id,
            receiving_quantity,
            rejected_quantity,
            rejection_reason: optionalText("rejection_reason", 500),
            batch_number: optionalText("batch_number", 100),
            manufacturing_date: optionalDate("manufacturing_date"),
            expiry_date: optionalDate("expiry_date"),
            supplier_batch_reference: optionalText("supplier_batch_reference", 100),
            environmental_conditions: optionalText("environmental_conditions", 500),
        };
    });

    return {
        items,
        reference,
        notes: typeof payload.notes === "string" ? payload.notes.trim().slice(0, 500) : undefined,
    };
};

export class PurchaseOrderController {
    static async getAll(req: Request, res: Response) {
        try {
            const poRepo = AppDataSource.getRepository(PurchaseOrder);
            const pos = await poRepo.find({
                relations: ["vendor", "warehouse", "items", "items.product"],
                order: { created_at: "DESC" }
            });
            res.json(pos);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching purchase orders" });
        }
    }

    static async getById(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const poRepo = AppDataSource.getRepository(PurchaseOrder);
            const po = await poRepo.findOne({
                where: { id },
                relations: ["vendor", "warehouse", "items", "items.product"]
            });
            if (!po) {
                return res.status(404).json({ message: "Purchase order not found" });
            }
            res.json(po);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching purchase order" });
        }
    }

    static async create(req: AuthenticatedRequest, res: Response) {
        try {
            const actorId = req.user?.id;
            if (!actorId) {
                return res.status(400).json({ message: "Creator is required" });
            }

            const { vendor_id, warehouse_id, items } = sanitizePurchaseOrderCreatePayload(req.body ?? {});
            const calculatedTotalCents = items.reduce(
                (sum, item) => sum + BigInt(item.quantity) * parseKesToCents(String(item.unit_cost)),
                0n,
            );
            const calculatedTotal = Number(centsToKesString(calculatedTotalCents));
            const poNumber = `PO-${Date.now()}`;

            const createdPurchaseOrder = await AppDataSource.transaction(async (manager) => {
                const warehouse = await manager.findOne(Warehouse, {
                    where: { id: warehouse_id, is_active: true },
                });
                if (!warehouse) throw new PurchaseOrderCreateValidationError("An active receiving warehouse is required");

                const purchaseOrder = manager.create(PurchaseOrder, {
                    po_number: poNumber,
                    vendor_id,
                    warehouse_id: warehouse.id,
                    total_amount: calculatedTotal,
                    created_by: actorId,
                    status: "draft",
                });
                const savedPurchaseOrder = await manager.save(purchaseOrder);
                await manager.save(PoItem, items.map((item) => manager.create(PoItem, {
                    po_id: savedPurchaseOrder.id,
                    product_id: item.product_id,
                    quantity: item.quantity,
                    unit_cost: item.unit_cost,
                })));

                return manager.findOne(PurchaseOrder, {
                    where: { id: savedPurchaseOrder.id },
                    relations: ["vendor", "warehouse", "items", "items.product"],
                });
            });

            res.status(201).json(createdPurchaseOrder);
        } catch (error) {
            if (error instanceof PurchaseOrderCreateValidationError) {
                return res.status(400).json({ message: error.message });
            }
            console.error(error);
            res.status(500).json({ message: "Error creating purchase order" });
        }
    }

    static async updateStatus(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const { status } = sanitizePurchaseOrderStatusPayload(req.body ?? {});
            const poRepo = AppDataSource.getRepository(PurchaseOrder);
            const po = await poRepo.findOne({ where: { id } });
            if (!po) {
                return res.status(404).json({ message: "Purchase order not found" });
            }

            const allowedTransitions: Record<string, string[]> = {
                draft: ["sent", "cancelled"],
                sent: ["cancelled"],
            };
            if (!allowedTransitions[po.status]?.includes(status)) {
                return res.status(400).json({ message: `Cannot transition purchase order from ${po.status} to ${status}` });
            }

            po.status = status;
            await poRepo.save(po);
            res.json(po);
        } catch (error) {
            console.error(error);
            res.status(400).json({ message: error instanceof Error ? error.message : "Error updating purchase order status" });
        }
    }

    static async sendEmail(req: Request, res: Response) {
        try {
            const po = await AppDataSource.getRepository(PurchaseOrder).findOne({
                where: { id: req.params.id as string },
                relations: ["vendor", "items", "items.product"],
            });
            if (!po) {
                return res.status(404).json({ message: "Purchase order not found" });
            }
            if (!po.vendor?.email) {
                return res.status(400).json({ message: "Vendor email not found" });
            }

            const sent = await EmailService.sendPurchaseOrderEmail(
                po.vendor.email,
                po.vendor.name,
                po.po_number,
                Number(po.total_amount),
                (po.items || []).map((item) => ({
                    productName: item.product?.name || "Unknown",
                    quantity: Number(item.quantity),
                    unitCost: Number(item.unit_cost),
                }))
            );
            if (!sent) {
                return res.status(503).json({ message: "Purchase order email service is not configured" });
            }
            res.json({ message: "Purchase order sent to vendor" });
        } catch (error) {
            console.error("Error sending purchase order email:", error);
            res.status(500).json({ message: "Failed to send purchase order email" });
        }
    }
    static async getDeliveryNotes(req: Request, res: Response) {
        try {
            const notes = await AppDataSource.getRepository(DeliveryNote).find({
                relations: ["vendor", "purchase_order"],
                order: { created_at: "DESC" },
            });
            res.json(notes);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching delivery notes" });
        }
    }

    static async getDeliveryNoteById(req: Request, res: Response) {
        try {
            const note = await AppDataSource.getRepository(DeliveryNote).findOne({
                where: { id: req.params.id as string },
                relations: ["vendor", "purchase_order", "items", "items.product"],
            });
            if (!note) {
                return res.status(404).json({ message: "Delivery note not found" });
            }
            res.json(note);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching delivery note" });
        }
    }

    static async receive(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            const id = req.params.id as string;
            const { items: requestItems, notes, reference } = sanitizePurchaseOrderReceivePayload(req.body ?? {});
            const receiverId = req.user?.id;

            const poRepo = queryRunner.manager.getRepository(PurchaseOrder);
            const poItemRepo = queryRunner.manager.getRepository(PoItem);
            const dnRepo = queryRunner.manager.getRepository(DeliveryNote);
            const dnItemRepo = queryRunner.manager.getRepository(DeliveryNoteItem);
            const batchRepo = queryRunner.manager.getRepository(ProductBatch);
            const productRepo = queryRunner.manager.getRepository(Product);

            const po = await poRepo.findOne({ where: { id }, lock: { mode: "pessimistic_write" } });
            if (!po) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Purchase order not found" });
            }
            po.items = await poItemRepo.find({ where: { po_id: po.id } });

            if (po.status !== "sent" && po.status !== "partially_received") {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Purchase order must be sent before receiving goods" });
            }

            let receivingWarehouse = po.warehouse_id
                ? await queryRunner.manager.findOne(Warehouse, {
                    where: { id: po.warehouse_id, is_active: true },
                })
                : null;
            if (!receivingWarehouse) {
                receivingWarehouse = await queryRunner.manager.findOne(Warehouse, {
                    where: { is_main: true, is_active: true },
                });
            }
            if (!receivingWarehouse) {
                throw new PurchaseOrderReceiveValidationError("An active receiving warehouse is required");
            }
            if (!po.warehouse_id) {
                po.warehouse_id = receivingWarehouse.id;
            }

            if (!receiverId || !Array.isArray(requestItems) || requestItems.length === 0) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Receiver and receiving items are required" });
            }

            const requestedQuantitiesByPoItem = new Map<string, number>();
            const items = requestItems.map((requestItem) => {
                const poItem = po.items.find((item) => item.id === requestItem.po_item_id);
                const receivingQuantity = Number(requestItem.receiving_quantity);
                const rejectedQuantity = Number(requestItem.rejected_quantity || 0);
                const remainingQuantity = poItem ? poItem.quantity - poItem.received_quantity : 0;
                const requestedQuantity = receivingQuantity + rejectedQuantity;
                const cumulativeRequestedQuantity = (requestedQuantitiesByPoItem.get(requestItem.po_item_id) || 0) + requestedQuantity;

                if (!poItem || poItem.product_id !== requestItem.product_id ||
                    !Number.isSafeInteger(receivingQuantity) || receivingQuantity < 0 ||
                    !Number.isSafeInteger(rejectedQuantity) || rejectedQuantity < 0 ||
                    cumulativeRequestedQuantity > remainingQuantity) {
                    throw new PurchaseOrderReceiveValidationError("Receiving quantities exceed the purchase order");
                }
                requestedQuantitiesByPoItem.set(poItem.id, cumulativeRequestedQuantity);

                return {
                    ...requestItem,
                    po_item_id: poItem.id,
                    product_id: poItem.product_id,
                    ordered_quantity: poItem.quantity,
                    receiving_quantity: receivingQuantity,
                    rejected_quantity: rejectedQuantity,
                    unit_cost: Number(poItem.unit_cost),
                    unit_cost_cents: parseKesToCents(String(poItem.unit_cost)),
                };
            });

            const totalItems = items.reduce((sum, item) => sum + item.receiving_quantity, 0);
            const totalHandledItems = items.reduce((sum, item) => sum + item.receiving_quantity + item.rejected_quantity, 0);
            const totalValueCents = items.reduce(
                (sum, item) => sum + BigInt(item.receiving_quantity) * item.unit_cost_cents,
                0n,
            );
            const totalValue = Number(centsToKesString(totalValueCents));

            if (totalHandledItems === 0) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "No items to receive" });
            }

            const grnNumber = `GRN-${Date.now()}`;

            const newDn = dnRepo.create({
                po_id: po.id,
                vendor_id: po.vendor_id,
                grn_number: grnNumber,
                received_by: receiverId,
                total_items: totalItems,
                total_value: totalValue,
                notes,
                status: 'completed'
            });
            const savedDn = await dnRepo.save(newDn);
            const purchase = await queryRunner.manager.save(Purchase, queryRunner.manager.create(Purchase, {
                vendor_id: po.vendor_id,
                warehouse_id: receivingWarehouse.id,
                delivery_note_id: savedDn.id,
                reference: reference || po.po_number,
                purchase_kind: "receipt",
                purchased_at: new Date(),
                created_by: receiverId,
            }));

            let fullyReceived = true;
            let atLeastOneReceived = false;

            for (const requestItem of items) {
                if (requestItem.receiving_quantity > 0 || requestItem.rejected_quantity > 0) {
                    const dnItem = dnItemRepo.create({
                        delivery_note_id: savedDn.id,
                        po_item_id: requestItem.po_item_id,
                        product_id: requestItem.product_id,
                        ordered_quantity: requestItem.ordered_quantity,
                        received_quantity: requestItem.receiving_quantity,
                        rejected_quantity: requestItem.rejected_quantity,
                        rejection_reason: requestItem.rejection_reason,
                        unit_cost: requestItem.unit_cost,
                        line_total: Number(centsToKesString(
                            BigInt(requestItem.receiving_quantity) * requestItem.unit_cost_cents,
                        )),
                        batch_number: requestItem.batch_number,
                        expiry_date: requestItem.expiry_date
                    });
                    await dnItemRepo.save(dnItem);
                }

                if (requestItem.receiving_quantity > 0) {
                    atLeastOneReceived = true;

                    // Update PO Item received quantity
                    const receiptUpdate = await poItemRepo.increment(
                        { id: requestItem.po_item_id },
                        "received_quantity",
                        requestItem.receiving_quantity,
                    );
                    if (receiptUpdate.affected !== 1) {
                        throw new Error("Purchase-order item was not found while recording the receipt");
                    }

                    const product = await productRepo.findOne({ where: { id: requestItem.product_id } });
                    if (!product) throw new Error("Product not found while receiving purchase order");
                    const unitCostCents = parseKesToCents(String(requestItem.unit_cost));
                    product.stock_on_hand = await InventoryService.receiveStock(
                        queryRunner.manager,
                        product.id,
                        receivingWarehouse.id,
                        requestItem.receiving_quantity,
                        purchase.id,
                        receiverId,
                        unitCostCents,
                    );
                    await queryRunner.manager.save(PurchaseItem, queryRunner.manager.create(PurchaseItem, {
                        purchase_id: purchase.id,
                        product_id: product.id,
                        quantity: requestItem.receiving_quantity,
                        unit_cost_cents: String(unitCostCents),
                        total_cost_cents: String(unitCostCents * BigInt(requestItem.receiving_quantity)),
                    }));

                    // Create ProductBatch for advanced tracking (FIFO)
                    const batch = batchRepo.create({
                        product_id: requestItem.product_id,
                        po_id: po.id,
                        batch_number: requestItem.batch_number || `BATCH-${Date.now()}`,
                        manufacturing_date: requestItem.manufacturing_date ? new Date(requestItem.manufacturing_date) : undefined,
                        expiry_date: requestItem.expiry_date ? new Date(requestItem.expiry_date) : undefined,
                        supplier_batch_reference: requestItem.supplier_batch_reference || undefined,
                        quality_check_status: 'passed',
                        environmental_conditions: requestItem.environmental_conditions || undefined,
                        initial_quantity: requestItem.receiving_quantity,
                        current_quantity: requestItem.receiving_quantity,
                        unit_cost: requestItem.unit_cost
                    });
                    await batchRepo.save(batch);
                }
            }

            // Calculate overall PO status based on exact PO items vs updated ones
            const currentPoItems = await poItemRepo.find({ where: { po_id: po.id } });
            
            for (const item of currentPoItems) {
                if (item.received_quantity < item.quantity) {
                    fullyReceived = false;
                }
                if (item.received_quantity > 0) {
                    atLeastOneReceived = true;
                }
            }

            if (totalValueCents > 0n) {
                await AccountingService.recordInventoryReceipt(queryRunner.manager, po.id, totalValueCents);
            }

            if (fullyReceived) {
                po.status = 'received';
            } else if (atLeastOneReceived) {
                po.status = 'partially_received';
            }
            await poRepo.update(po.id, {
                status: po.status,
                warehouse_id: receivingWarehouse.id,
            });

            await queryRunner.commitTransaction();
            
            res.json({ message: "Goods received successfully", grn: grnNumber, po });
        } catch (error) {
            if (queryRunner.isTransactionActive) {
                await queryRunner.rollbackTransaction();
            }
            if (error instanceof PurchaseOrderReceiveValidationError) {
                return res.status(400).json({ message: error.message });
            }
            console.error(error);
            res.status(500).json({ message: "Error receiving goods" });
        } finally {
            await queryRunner.release();
        }
    }
}
