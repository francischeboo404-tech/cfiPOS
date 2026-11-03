import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Sale, SaleStatus } from "../entity/Sale";
import { ReturnRequest, ReturnStatus, RefundMethod, MpesaRefundStatus } from "../entity/ReturnRequest";
import { ReturnItem, ReturnItemCondition } from "../entity/ReturnItem";
import { SaleItem } from "../entity/SaleItem";
import { SaleItemBatch } from "../entity/SaleItemBatch";
import { PromotionItem } from "../entity/PromotionItem";
import { PromotionAuditEvent } from "../entity/PromotionAuditEvent";
import { User, AppRole } from "../entity/User";
import { CreditNote } from "../entity/CreditNote";
import { ProductBatch } from "../entity/ProductBatch";
import { WarehouseStock } from "../entity/WarehouseStock";
import { Shift, ShiftStatus } from "../entity/Shift";
import { AccountingService } from "../services/AccountingService";
import { InventoryService } from "../services/InventoryService";
import { EtimsStatus } from "../entity/Sale";
import { EtimsService } from "../services/etims/EtimsService";
import { SocketService } from "../services/SocketService";
import { StoreCredit, StoreCreditStatus } from "../entity/StoreCredit";
import { Customer } from "../entity/Customer";
import { Invoice } from "../entity/Invoice";
import crypto from "crypto";
import { In } from "typeorm";
import { VoucherService } from "../services/VoucherService";
import {
    allocateQuantityShare,
    centsToKesString,
    divideRoundHalfUp,
    parseKesDecimalToCents,
    parseKesToCents,
    percentageToBasisPoints,
} from "../lib/exactMoney";

const saleRepository = AppDataSource.getRepository(Sale);
const returnRepository = AppDataSource.getRepository(ReturnRequest);
const returnItemRepository = AppDataSource.getRepository(ReturnItem);
const userRepository = AppDataSource.getRepository(User);
const saleItemRepository = AppDataSource.getRepository(SaleItem);

const RETURN_ITEM_ALLOWED_CONDITIONS = new Set(Object.values(ReturnItemCondition));
const RETURN_ALLOWED_REFUND_METHODS = new Set(Object.values(RefundMethod));

export interface SanitizedReturnRequestItem {
    sale_item_id: string;
    quantity: number;
}

export interface SanitizedReturnRequestPayload {
    sale_id: string;
    reason: string;
    items: SanitizedReturnRequestItem[];
}

export interface SanitizedReturnItemCondition {
    return_item_id: string;
    condition: ReturnItemCondition;
}

export interface SanitizedApproveReturnPayload {
    items_conditions?: SanitizedReturnItemCondition[];
    refund_method?: RefundMethod;
}

export const sanitizeReturnRequestPayload = (input: unknown): SanitizedReturnRequestPayload => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Return request payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const sale_id = typeof payload.sale_id === "string" ? payload.sale_id.trim() : "";
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    const items = Array.isArray(payload.items) ? payload.items : [];

    if (!sale_id) throw new Error("sale_id is required");
    if (!reason || reason.length > 500) throw new Error("reason is required and must be under 500 characters");
    if (items.length === 0) throw new Error("At least one return item is required");

    const sanitizedItems: SanitizedReturnRequestItem[] = items.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Each return item must be an object");
        }

        const itemPayload = item as Record<string, unknown>;
        const sale_item_id = typeof itemPayload.sale_item_id === "string" ? itemPayload.sale_item_id.trim() : "";
        const quantity = Number(itemPayload.quantity);

        if (!sale_item_id) throw new Error("Each return item requires a sale_item_id");
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Each return item quantity must be a positive whole number");

        return { sale_item_id, quantity };
    });

    if (new Set(sanitizedItems.map((item) => item.sale_item_id)).size !== sanitizedItems.length) {
        throw new Error("A sale item may only appear once in a return request");
    }

    return { sale_id, reason, items: sanitizedItems };
};

export const sanitizeRejectReturnPayload = (input: unknown): { rejection_reason: string } => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Reject payload must be an object");
    }

    const payload = input as Record<string, unknown>;

    if (payload.rejection_reason !== undefined && typeof payload.rejection_reason !== "string") {
        throw new Error("rejection_reason must be a string");
    }

    const rejection_reason = typeof payload.rejection_reason === "string" ? payload.rejection_reason.trim() : "";

    if (rejection_reason.length > 500) {
        throw new Error("rejection_reason must be 500 characters or less");
    }

    return { rejection_reason: rejection_reason || "Rejected by management" };
};

export const sanitizeMpesaRefundReceipt = (input: unknown): string => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("M-Pesa payout confirmation must be an object");
    }
    const receiptValue = (input as Record<string, unknown>).receipt_number;
    const receiptNumber = typeof receiptValue === "string" ? receiptValue.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{5,64}$/.test(receiptNumber)) {
        throw new Error("receipt_number must be a valid Safaricom receipt");
    }
    return receiptNumber;
};

export const sanitizeApproveReturnPayload = (input: unknown): SanitizedApproveReturnPayload => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Approval payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const sanitized: SanitizedApproveReturnPayload = {};

    if (payload.items_conditions !== undefined) {
        if (!Array.isArray(payload.items_conditions)) {
            throw new Error("items_conditions must be an array");
        }

        sanitized.items_conditions = payload.items_conditions.map((item: unknown) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                throw new Error("Each item condition must be an object");
            }

            const itemPayload = item as Record<string, unknown>;
            const return_item_id = typeof itemPayload.return_item_id === "string" ? itemPayload.return_item_id.trim() : "";
            const conditionValue = typeof itemPayload.condition === "string" ? itemPayload.condition.trim().toLowerCase() : "";
            if (!return_item_id) throw new Error("return_item_id is required");
            if (!RETURN_ITEM_ALLOWED_CONDITIONS.has(conditionValue as ReturnItemCondition)) {
                throw new Error("condition must be one of the valid return item conditions");
            }

            return { return_item_id, condition: conditionValue as ReturnItemCondition };
        });
    }

    if (payload.refund_method !== undefined) {
        const refundMethodValue = typeof payload.refund_method === "string" ? payload.refund_method.trim().toLowerCase() : "";
        if (!RETURN_ALLOWED_REFUND_METHODS.has(refundMethodValue as RefundMethod)) {
            throw new Error("refund_method is invalid");
        }
        sanitized.refund_method = refundMethodValue as RefundMethod;
    }

    if (!sanitized.items_conditions && !sanitized.refund_method) {
        throw new Error("Approval payload must contain a valid return action");
    }

    return sanitized;
};

export class ReturnController {
    // Utility to calculate exactly 3 working days strictly (excluding Saturday & Sunday)
    static isWithinReturnWindow(invoiceDate: Date): boolean {
        const MAX_WORKING_DAYS = 3;
        let workingDaysElapsed = 0;
        
        const current = new Date(invoiceDate);
        const now = new Date();
        
        while (current.getTime() + 86400000 <= now.getTime()) {
            current.setTime(current.getTime() + 86400000);
            const dayOfWeek = current.getDay();
            if (dayOfWeek !== 0 && dayOfWeek !== 6) { // 0=Sun, 6=Sat
                workingDaysElapsed++;
            }
        }
        return workingDaysElapsed <= MAX_WORKING_DAYS;
    }

    static async searchReturnableSales(req: Request, res: Response) {
        try {
            const invoiceNumber = typeof req.query.invoice_number === "string"
                ? req.query.invoice_number.trim()
                : "";
            if (!invoiceNumber) {
                return res.status(400).json({ message: "Invoice number is required" });
            }

            const invoices = await AppDataSource.getRepository(Invoice)
                .createQueryBuilder("invoice")
                .leftJoinAndSelect("invoice.customer", "customer")
                .leftJoinAndSelect("invoice.sale", "sale")
                .leftJoinAndSelect("sale.items", "saleItem")
                .leftJoinAndSelect("saleItem.product", "product")
                .where("UPPER(invoice.invoice_number) = UPPER(:invoiceNumber)", { invoiceNumber })
                .andWhere("invoice.status NOT IN (:...excludedInvoiceStatuses)", {
                    excludedInvoiceStatuses: ["cancelled", "void"],
                })
                .getMany();

            const results: (Sale & { invoice_number: string; customer: Customer | null })[] = [];
            for (const invoice of invoices) {
                const sale = invoice.sale;
                if (!sale ||
                    (sale.status !== SaleStatus.COMPLETED && sale.status !== SaleStatus.PARTIALLY_REFUNDED) ||
                    sale.payment_status !== "paid" ||
                    !ReturnController.isWithinReturnWindow(sale.created_at)) {
                    continue;
                }

                const saleItemIds = (sale.items || []).map((item) => item.id);
                if (saleItemIds.length === 0) continue;

                const previousReturns = await returnItemRepository.find({
                    where: saleItemIds.map((saleItemId) => ({ sale_item: { id: saleItemId } })),
                    relations: ["return_request", "sale_item"],
                });
                const returnedQuantity = new Map<string, number>();
                const approvedReturnedQuantity = new Map<string, number>();
                for (const previousReturn of previousReturns) {
                    if (previousReturn.return_request.status !== ReturnStatus.PENDING &&
                        previousReturn.return_request.status !== ReturnStatus.APPROVED) {
                        continue;
                    }
                    const saleItemId = previousReturn.sale_item.id;
                    returnedQuantity.set(
                        saleItemId,
                        (returnedQuantity.get(saleItemId) || 0) + previousReturn.quantity,
                    );
                    if (previousReturn.return_request.status === ReturnStatus.APPROVED) {
                        approvedReturnedQuantity.set(
                            saleItemId,
                            (approvedReturnedQuantity.get(saleItemId) || 0) + previousReturn.quantity,
                        );
                    }
                }

                if (!(sale.items || []).some((item) =>
                    (returnedQuantity.get(item.id) || 0) < item.quantity)) {
                    continue;
                }

                const returnableItems = sale.items.map((item) => Object.assign(item, {
                    returnable_quantity: item.quantity - (returnedQuantity.get(item.id) || 0),
                    approved_returned_quantity: approvedReturnedQuantity.get(item.id) || 0,
                }));
                results.push(Object.assign(sale, {
                    invoice_number: invoice.invoice_number,
                    customer: invoice.customer,
                    items: returnableItems,
                }));
            }

            res.json(results);
        } catch (error) {
            console.error("Error searching returnable invoices:", error);
            res.status(500).json({ message: "Error searching returnable invoices" });
        }
    }

    static async requestReturn(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const { sale_id, reason, items } = sanitizeReturnRequestPayload(req.body);
            if (!sale_id || !reason || !items || !items.length) {
                return res.status(400).json({ message: "Sale ID, reason, and items are required" });
            }

            const sale = await queryRunner.manager.findOne(Sale, {
                where: { id: sale_id },
                lock: { mode: "pessimistic_write" },
            });
            if (!sale) throw new Error("Sale not found");

            if (sale.status === SaleStatus.VOIDED) {
                throw new Error("Sale is already voided/fully returned");
            }
            if (sale.status !== SaleStatus.COMPLETED && sale.status !== SaleStatus.PARTIALLY_REFUNDED) {
                throw new Error("Only completed sales can be returned");
            }
            if (sale.payment_status !== "paid") {
                throw new Error("An unpaid sale cannot be returned");
            }

            if (!ReturnController.isWithinReturnWindow(sale.created_at)) {
                await queryRunner.rollbackTransaction();
                return res.status(403).json({ message: "Return window expired. Strictly limited to 3 working days." });
            }

            const cashier = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            if (!cashier) throw new Error("Cashier not found");

            const returnReq = new ReturnRequest();
            returnReq.sale = sale;
            returnReq.requested_by = cashier;
            returnReq.reason = reason;
            await queryRunner.manager.save(returnReq);

            for (const payloadItem of items) {
                const saleItem = await queryRunner.manager.findOne(SaleItem, {
                    where: { id: payloadItem.sale_item_id },
                    relations: ["sale", "product"],
                });
                if (!saleItem || saleItem.sale.id !== sale.id) {
                    throw new Error(`Invalid sale item ${payloadItem.sale_item_id}`);
                }
                if (!Number.isInteger(payloadItem.quantity) || payloadItem.quantity <= 0) {
                    throw new Error(`Invalid quantity for item ${saleItem.product.name}`);
                }

                const existingReturns = await queryRunner.manager.find(ReturnItem, {
                    where: { sale_item: { id: saleItem.id } },
                    relations: ["return_request"],
                });
                const alreadyClaimed = existingReturns
                    .filter((item) => item.return_request.status === ReturnStatus.PENDING || item.return_request.status === ReturnStatus.APPROVED)
                    .reduce((sum, item) => sum + item.quantity, 0);
                if (alreadyClaimed + payloadItem.quantity > saleItem.quantity) {
                    throw new Error(`Return quantity exceeds remaining quantity for item ${saleItem.product.name}`);
                }

                const retItem = new ReturnItem();
                retItem.return_request = returnReq;
                retItem.sale_item = saleItem;
                retItem.quantity = payloadItem.quantity;
                await queryRunner.manager.save(retItem);
            }

            await queryRunner.commitTransaction();
            res.status(201).json({ message: "Return requested successfully. Awaiting managerial approval.", request: returnReq });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error("Error requesting return:", error);
            res.status(400).json({ message: error instanceof Error ? error.message : "Server error creating return request" });
        } finally {
            await queryRunner.release();
        }
    }

    static async approveReturn(req: AuthenticatedRequest, res: Response) {
        const requestId = req.params.id;
        const { items_conditions, refund_method } = sanitizeApproveReturnPayload(req.body);

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const lockedReturnRequest = await queryRunner.manager.findOne(ReturnRequest, {
                where: { id: requestId },
                lock: { mode: "pessimistic_write" },
            });

            if (!lockedReturnRequest) throw new Error("Return request not found");
            if (lockedReturnRequest.status !== ReturnStatus.PENDING) throw new Error("Return request is already processed");

            const returnRequestSale = await queryRunner.manager.findOne(ReturnRequest, {
                where: { id: requestId },
                relations: ["sale"],
            });
            if (!returnRequestSale?.sale) throw new Error("Sale not found");
            const saleLock = await queryRunner.manager.findOne(Sale, {
                where: { id: returnRequestSale.sale.id },
                lock: { mode: "pessimistic_write" },
            });
            if (!saleLock) throw new Error("Sale not found");

            const returnReq = await queryRunner.manager.findOne(ReturnRequest, {
                where: { id: requestId },
                relations: ["sale", "sale.customer", "sale.warehouse", "sale.cashier", "items", "items.sale_item", "items.sale_item.product", "requested_by"],
            });
            if (!returnReq) throw new Error("Return request not found");
            if (refund_method !== undefined && !Object.values(RefundMethod).includes(refund_method)) {
                throw new Error("Invalid refund method");
            }

            const admin = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            if (!admin) throw new Error("Approval user not found");

            const sale = returnReq.sale;
            if (sale.status === SaleStatus.VOIDED) throw new Error("Sale is already voided");
            if (refund_method !== undefined) {
                returnReq.refund_method = refund_method;
            }

            let cashRefundShift: Shift | null = null;
            if (returnReq.refund_method === RefundMethod.CASH) {
                cashRefundShift = await queryRunner.manager.findOne(Shift, {
                    where: { cashier_id: returnReq.requested_by.id, status: ShiftStatus.OPEN },
                    lock: { mode: "pessimistic_write" },
                });
                if (!cashRefundShift) {
                    throw new Error("Open a shift for the requesting cashier before approving a cash refund");
                }
            }

            const inventoryUpdates: { productId: string; newStockLevel: number; warehouseId: string | null }[] = [];
            let calculatedTotalCogs = 0;
            let calculatedTotalCogsCents = 0n;
            let subtotalRefundCents = 0n;
            let taxRefundCents = 0n;
            const previousApprovedReturnItems = await queryRunner.manager.createQueryBuilder(ReturnItem, "returnItem")
                .innerJoin("returnItem.return_request", "returnRequest")
                .innerJoinAndSelect("returnItem.sale_item", "saleItem")
                .where("returnRequest.sale_id = :saleId", { saleId: sale.id })
                .andWhere("returnRequest.status = :status", { status: ReturnStatus.APPROVED })
                .andWhere("returnRequest.id != :requestId", { requestId })
                .getMany();
            const previousReturnedQuantityBySaleItem = new Map<string, number>();
            let previousRefundCents = 0n;
            for (const previousItem of previousApprovedReturnItems) {
                const saleItemId = previousItem.sale_item.id;
                const returnedBefore = previousReturnedQuantityBySaleItem.get(saleItemId) || 0;
                const lineGrossCents = BigInt(previousItem.sale_item.line_total_cents ??
                    parseKesToCents(String(previousItem.sale_item.line_total)).toString());
                const lineDiscountCents = BigInt(previousItem.sale_item.discount_cents || "0");
                const lineNetCents = previousItem.sale_item.net_revenue_cents !== null
                    ? BigInt(previousItem.sale_item.net_revenue_cents)
                    : lineGrossCents - lineDiscountCents;
                const lineVatCents = previousItem.sale_item.vat_cents !== null
                    ? BigInt(previousItem.sale_item.vat_cents)
                    : divideRoundHalfUp(
                        lineGrossCents * BigInt(percentageToBasisPoints(String(previousItem.sale_item.tax_rate))),
                        10_000n,
                    );
                previousRefundCents += allocateQuantityShare(
                    lineNetCents + lineVatCents,
                    previousItem.sale_item.quantity,
                    returnedBefore,
                    previousItem.quantity,
                );
                previousReturnedQuantityBySaleItem.set(
                    saleItemId,
                    returnedBefore + previousItem.quantity,
                );
            }

            for (const retItem of returnReq.items) {
                const saleItem = retItem.sale_item;
                const product = saleItem.product;

                const conditionPayload = items_conditions?.find((condition) => condition.return_item_id === retItem.id);
                const condition = conditionPayload?.condition || ReturnItemCondition.SELLABLE;
                if (!Object.values(ReturnItemCondition).includes(condition)) {
                    throw new Error("Invalid returned item condition");
                }
                retItem.condition = condition;

                const returnedQuantityBefore = previousReturnedQuantityBySaleItem.get(saleItem.id) || 0;
                const lineGrossCents = BigInt(
                    saleItem.line_total_cents ?? parseKesToCents(String(saleItem.line_total)).toString(),
                );
                const lineDiscountCents = BigInt(saleItem.discount_cents || "0");
                const lineNetCents = saleItem.net_revenue_cents !== null
                    ? BigInt(saleItem.net_revenue_cents)
                    : lineGrossCents - lineDiscountCents;
                const lineVatCents = saleItem.vat_cents !== null
                    ? BigInt(saleItem.vat_cents)
                    : divideRoundHalfUp(
                        lineGrossCents * BigInt(percentageToBasisPoints(String(saleItem.tax_rate))),
                        10_000n,
                    );
                const returnedNetCents = allocateQuantityShare(
                    lineNetCents,
                    saleItem.quantity,
                    returnedQuantityBefore,
                    retItem.quantity,
                );
                const returnedVatCents = allocateQuantityShare(
                    lineVatCents,
                    saleItem.quantity,
                    returnedQuantityBefore,
                    retItem.quantity,
                );
                const totalCogsCents = saleItem.cogs_total_cents !== null
                    ? BigInt(saleItem.cogs_total_cents)
                    : saleItem.cogs_total !== null
                        ? parseKesToCents(String(saleItem.cogs_total))
                        : saleItem.unit_cost !== null
                            ? parseKesToCents(String(saleItem.unit_cost)) * BigInt(saleItem.quantity)
                            : (() => { throw new Error("Original sale cost is unavailable; return cannot be valued accurately"); })();
                const itemCogsCents = allocateQuantityShare(
                    totalCogsCents,
                    saleItem.quantity,
                    returnedQuantityBefore,
                    retItem.quantity,
                );
                const itemCogs = Number(centsToKesString(itemCogsCents));
                previousReturnedQuantityBySaleItem.set(
                    saleItem.id,
                    returnedQuantityBefore + retItem.quantity,
                );

                if (saleItem.promotion_item_id && saleItem.promotion_quantity) {
                    const returnedPromotionQuantity = Number(allocateQuantityShare(
                        BigInt(saleItem.promotion_quantity),
                        saleItem.quantity,
                        returnedQuantityBefore,
                        retItem.quantity,
                    ));
                    if (returnedPromotionQuantity > 0) {
                        const promotionItem = await queryRunner.manager.findOne(PromotionItem, {
                            where: { id: saleItem.promotion_item_id },
                            relations: ["promotion"],
                            lock: { mode: "pessimistic_write" },
                        });
                        if (!promotionItem || promotionItem.used_qty < returnedPromotionQuantity) {
                            throw new Error("Promotion quota cannot be restored accurately for this return");
                        }
                        const usedQtyBeforeReturn = promotionItem.used_qty;
                        promotionItem.used_qty -= returnedPromotionQuantity;
                        await queryRunner.manager.save(promotionItem);
                        await queryRunner.manager.save(queryRunner.manager.create(PromotionAuditEvent, {
                            promotion: promotionItem.promotion,
                            actor: admin,
                            action: "sale_reversed",
                            before_state: {
                                promotion_item_id: promotionItem.id,
                                used_qty: usedQtyBeforeReturn,
                            },
                            after_state: {
                                promotion_item_id: promotionItem.id,
                                return_request_id: returnReq.id,
                                sale_id: sale.id,
                                quantity_restored: returnedPromotionQuantity,
                                used_qty: promotionItem.used_qty,
                            },
                            reason: returnReq.reason,
                        }));
                    }
                }

                subtotalRefundCents += returnedNetCents;
                taxRefundCents += returnedVatCents;
                calculatedTotalCogsCents += itemCogsCents;
                calculatedTotalCogs = Number(centsToKesString(calculatedTotalCogsCents));
                retItem.net_revenue_cents = String(returnedNetCents);
                retItem.vat_cents = String(returnedVatCents);
                retItem.cogs_total_cents = String(itemCogsCents);

                if (retItem.condition === ReturnItemCondition.SELLABLE) {
                    let movementLocationId: string | null = null;
                    let branchStockAfter: number | null = null;
                    if (sale.warehouse) {
                        branchStockAfter = await InventoryService.restoreValuedStock(
                            queryRunner.manager,
                            sale.warehouse.id,
                            product.id,
                            retItem.quantity,
                            itemCogsCents,
                        );
                        product.stock_on_hand += retItem.quantity;
                        movementLocationId = sale.warehouse.id;
                    } else {
                        product.stock_on_hand += retItem.quantity;
                    }
                    await queryRunner.manager.save(product);

                    const returnMovementQuantityBefore = branchStockAfter === null
                        ? Number(product.stock_on_hand) - retItem.quantity
                        : branchStockAfter - retItem.quantity;
                    await InventoryService.recordMovement(queryRunner.manager, {
                        productId: product.id,
                        movementType: "sale_return",
                        quantityChange: retItem.quantity,
                        quantityBefore: returnMovementQuantityBefore,
                        locationId: movementLocationId,
                        unitCost: Number(centsToKesString(
                            divideRoundHalfUp(itemCogsCents, BigInt(retItem.quantity)),
                        )),
                        valueChangeCents: itemCogsCents,
                        referenceType: "return",
                        referenceId: returnReq.id,
                        allowNegativeBalance: returnMovementQuantityBefore < 0 ||
                            returnMovementQuantityBefore + retItem.quantity < 0,
                        createdBy: admin.id,
                    });
                    if (sale.warehouse) {
                        await InventoryService.recordZeroQuantityCostAdjustment(
                            queryRunner.manager,
                            sale.warehouse.id,
                            product.id,
                            admin.id,
                            "return",
                            returnReq.id,
                        );
                    }

                    let qtyToReturn = retItem.quantity;
                    const saleItemBatches = await queryRunner.manager.find(SaleItemBatch, {
                        where: { sale_item: { id: saleItem.id } },
                        relations: ["product_batch"]
                    });
                    
                    for (const sib of saleItemBatches) {
                        if (qtyToReturn <= 0) break;
                        const returnableToThisBatch = Math.min(sib.quantity_deducted, qtyToReturn);
                        if (returnableToThisBatch > 0) {
                            sib.product_batch.current_quantity += returnableToThisBatch;
                            sib.quantity_deducted -= returnableToThisBatch;
                            qtyToReturn -= returnableToThisBatch;
                            
                            await queryRunner.manager.save(sib.product_batch);
                            await queryRunner.manager.save(sib);
                        }
                    }
                    
                    if (qtyToReturn > 0) {
                        const batch = await queryRunner.manager.findOne(ProductBatch, {
                            where: { product_id: product.id },
                            order: { created_at: "DESC" }
                        });
                        if (batch) {
                            batch.current_quantity += qtyToReturn;
                            await queryRunner.manager.save(batch);
                        }
                    }

                    inventoryUpdates.push({
                        productId: product.id,
                        newStockLevel: branchStockAfter ?? Number(product.stock_on_hand),
                        warehouseId: sale.warehouse ? sale.warehouse.id : null
                    });
                } else if (retItem.condition === ReturnItemCondition.DAMAGED) {
                    let movementQuantityBefore = Number(product.stock_on_hand);
                    let movementLocationId: string | null = null;
                    if (sale.warehouse) {
                        const branchStock = await queryRunner.manager.findOne(WarehouseStock, {
                            where: { warehouse_id: sale.warehouse.id, product_id: product.id },
                            lock: { mode: "pessimistic_write" },
                        });
                        movementQuantityBefore = Number(branchStock?.stock_on_hand || 0);
                        movementLocationId = sale.warehouse.id;
                    }
                    const movementUnitCost = Number(centsToKesString(
                        divideRoundHalfUp(itemCogsCents, BigInt(retItem.quantity)),
                    ));
                    await InventoryService.recordMovement(queryRunner.manager, {
                        productId: product.id,
                        movementType: "sale_return",
                        quantityChange: retItem.quantity,
                        quantityBefore: movementQuantityBefore,
                        locationId: movementLocationId,
                        unitCost: movementUnitCost,
                        valueChangeCents: itemCogsCents,
                        referenceType: "return",
                        referenceId: returnReq.id,
                        allowNegativeBalance: movementQuantityBefore < 0 ||
                            movementQuantityBefore + retItem.quantity < 0,
                        notes: "Damaged returned goods received and written off",
                        createdBy: admin.id,
                    });
                    await InventoryService.recordMovement(queryRunner.manager, {
                        productId: product.id,
                        movementType: "damaged",
                        quantityChange: -retItem.quantity,
                        quantityBefore: movementQuantityBefore + retItem.quantity,
                        locationId: movementLocationId,
                        unitCost: movementUnitCost,
                        valueChangeCents: -itemCogsCents,
                        referenceType: "return",
                        referenceId: returnReq.id,
                        notes: "Damaged returned goods written off",
                        allowNegativeBalance: movementQuantityBefore < 0,
                        createdBy: admin.id,
                    });
                    await AccountingService.recordInventoryAdjustment(
                        queryRunner.manager, 
                        returnReq.id, // using request ID as correlation
                        itemCogs, 
                        true // isShrinkage = true
                    );
                }

                await queryRunner.manager.save(retItem);
            }

            const totalSubtotalRefund = Number(centsToKesString(subtotalRefundCents));
            const totalTaxRefund = Number(centsToKesString(taxRefundCents));
            const totalRefundCents = subtotalRefundCents + taxRefundCents;
            const totalRefundAmount = Number(centsToKesString(totalRefundCents));

            if (sale.voucher_id) {
                const saleTotalCents = parseKesToCents(String(sale.total_amount));
                const earnedPoints = BigInt(sale.voucher_points_earned || "0");
                const redeemedPoints = BigInt(sale.voucher_points_redeemed || "0");
                const reverseProportionally = (points: bigint) => saleTotalCents > 0n
                    ? points * (previousRefundCents + totalRefundCents) / saleTotalCents -
                        points * previousRefundCents / saleTotalCents
                    : 0n;
                const earnedToReverse = reverseProportionally(earnedPoints);
                const redeemedToRestore = reverseProportionally(redeemedPoints);
                if (earnedToReverse > 0n) {
                    await VoucherService.append(queryRunner.manager, {
                        voucherId: sale.voucher_id,
                        type: "reversal",
                        points: -earnedToReverse,
                        actorId: admin.id,
                        saleId: sale.id,
                        reference: `return ${returnReq.id}: earned points`,
                        reason: returnReq.reason,
                    });
                }
                if (redeemedToRestore > 0n) {
                    await VoucherService.append(queryRunner.manager, {
                        voucherId: sale.voucher_id,
                        type: "reversal",
                        points: redeemedToRestore,
                        actorId: admin.id,
                        saleId: sale.id,
                        reference: `return ${returnReq.id}: redeemed points`,
                        reason: returnReq.reason,
                    });
                }
            }

            sale.status = SaleStatus.PARTIALLY_REFUNDED;
            await queryRunner.manager.save(sale);

            const creditNote = new CreditNote();
            creditNote.sale = sale;
            creditNote.return_request = returnReq;
            creditNote.amount = totalRefundAmount;
            creditNote.reason = returnReq.reason;
            creditNote.cashier = admin;
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
                cash: returnReq.refund_method === RefundMethod.CASH ? totalRefundAmount : 0,
                mpesaRefundPayable: returnReq.refund_method === RefundMethod.MPESA ? totalRefundAmount : 0,
                storeCredit: returnReq.refund_method === RefundMethod.STORE_CREDIT ||
                    returnReq.refund_method === RefundMethod.EXCHANGE
                    ? totalRefundAmount
                    : 0,
            };
            if (returnReq.refund_method === RefundMethod.MPESA) {
                returnReq.mpesa_refund_status = MpesaRefundStatus.PENDING;
                returnReq.mpesa_refund_amount = Number(centsToKesString(totalRefundCents));
                returnReq.pesapal_refund_logged = false;
                returnReq.pesapal_refund_notes = "Awaiting confirmation of the Safaricom M-Pesa payout";
            }
            await AccountingService.recordSaleReversal(
                queryRunner.manager,
                sale.id,
                totalRefundAmount,
                totalSubtotalRefund,
                totalTaxRefund,
                calculatedTotalCogs,
                settlement
            );

            if (cashRefundShift) {
                cashRefundShift.expected_cash = centsToKesString(
                    parseKesDecimalToCents(String(cashRefundShift.expected_cash)) - totalRefundCents,
                );
                await queryRunner.manager.save(cashRefundShift);
            }

            returnReq.status = ReturnStatus.APPROVED;
            returnReq.approved_by = admin;

            let generatedStoreCredit = null;

            if (returnReq.refund_method === RefundMethod.STORE_CREDIT ||
                returnReq.refund_method === RefundMethod.EXCHANGE) {
                if (sale.customer) {
                    sale.customer.store_credit_balance = Number(sale.customer.store_credit_balance) + totalRefundAmount;
                    await queryRunner.manager.save(sale.customer);
                } else {
                    const sc = new StoreCredit();
                    sc.barcode = "SC-" + crypto.randomBytes(4).toString("hex").toUpperCase();
                    sc.original_amount = totalRefundAmount;
                    sc.current_balance = totalRefundAmount;
                    sc.issued_from_return_id = returnReq.id;
                    sc.status = StoreCreditStatus.ACTIVE;
                    // expire in 1 year
                    sc.expires_at = new Date(new Date().setFullYear(new Date().getFullYear() + 1));
                    await queryRunner.manager.save(sc);
                    generatedStoreCredit = sc;
                }
            } else if (returnReq.refund_method === RefundMethod.MPESA) {
                returnReq.pesapal_refund_notes = "Awaiting confirmation of the Safaricom M-Pesa payout";
            }
            
            await queryRunner.manager.save(returnReq);

            await queryRunner.commitTransaction();

            let finalCreditNote = creditNote;
            if (creditNote.etims_status === EtimsStatus.PENDING) {
                try {
                    const signed = await EtimsService.processCreditNoteSigning(creditNote.id);
                    if (signed) {
                        finalCreditNote = signed;
                    }
                } catch (err) {
                    console.error("Asynchronous eTIMS credit note signing failed:", err);
                }
            }

            for (const update of inventoryUpdates) {
                SocketService.emitInventoryUpdated(update.productId, update.newStockLevel, update.warehouseId || undefined);
            }

            res.status(200).json({ 
                message: "Return approved securely.", 
                creditNote: finalCreditNote, 
                mpesaRefundPending: returnReq.refund_method === RefundMethod.MPESA,
                storeCreditBarcode: generatedStoreCredit ? generatedStoreCredit.barcode : null
            });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            res.status(400).json({ message: error instanceof Error ? error.message : "Error approving return" });
        } finally {
            await queryRunner.release();
        }
    }

    static async confirmMpesaRefundPayout(req: AuthenticatedRequest, res: Response) {
        let receiptNumber: string;
        try {
            receiptNumber = sanitizeMpesaRefundReceipt(req.body);
        } catch (error) {
            return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid M-Pesa receipt" });
        }

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const requestId = typeof req.params.id === "string" ? req.params.id : "";
            if (!requestId) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Return request ID is invalid" });
            }
            const returnReq = await queryRunner.manager.findOne(ReturnRequest, {
                where: { id: requestId },
                lock: { mode: "pessimistic_write" },
            });
            if (!returnReq) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Return request not found" });
            }
            if (returnReq.status !== ReturnStatus.APPROVED || returnReq.refund_method !== RefundMethod.MPESA) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Only an approved M-Pesa refund can be settled" });
            }
            if (returnReq.mpesa_refund_status === MpesaRefundStatus.COMPLETED) {
                await queryRunner.rollbackTransaction();
                if (returnReq.mpesa_refund_receipt === receiptNumber) {
                    return res.status(200).json({ message: "M-Pesa refund payout was already recorded", returnReq });
                }
                return res.status(409).json({ message: "This M-Pesa refund already has a different receipt" });
            }
            if (returnReq.mpesa_refund_status !== MpesaRefundStatus.PENDING) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "M-Pesa refund is not awaiting payout confirmation" });
            }

            const amountCents = parseKesDecimalToCents(String(returnReq.mpesa_refund_amount));
            if (amountCents <= 0n) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "M-Pesa refund amount is missing; reconcile this return before settlement" });
            }
            const amount = Number(centsToKesString(amountCents));

            const confirmingUser = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            if (!confirmingUser) {
                await queryRunner.rollbackTransaction();
                return res.status(401).json({ message: "Confirming user was not found" });
            }
            const activeShift = await queryRunner.manager.findOne(Shift, {
                where: { cashier_id: confirmingUser.id, status: ShiftStatus.OPEN },
                lock: { mode: "pessimistic_write" },
            });
            if (!activeShift) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Open a shift before recording the M-Pesa payout" });
            }

            await AccountingService.recordMpesaRefundPayout(queryRunner.manager, returnReq.id, amount);
            returnReq.mpesa_refund_status = MpesaRefundStatus.COMPLETED;
            returnReq.mpesa_refund_receipt = receiptNumber;
            returnReq.mpesa_refund_completed_at = new Date();
            returnReq.mpesa_refund_completed_by = confirmingUser;
            returnReq.pesapal_refund_logged = true;
            returnReq.pesapal_refund_notes = `Safaricom payout confirmed with receipt ${receiptNumber}`;
            await queryRunner.manager.save(returnReq);

            activeShift.mpesa_total = centsToKesString(
                parseKesDecimalToCents(String(activeShift.mpesa_total)) - amountCents,
            );
            await queryRunner.manager.save(activeShift);
            await queryRunner.commitTransaction();

            return res.status(200).json({ message: "M-Pesa refund payout recorded", returnReq });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            const databaseCode = error && typeof error === "object" && "code" in error
                ? (error as { code?: unknown }).code
                : undefined;
            if (databaseCode === "23505") {
                return res.status(409).json({ message: "This Safaricom receipt has already been used" });
            }
            console.error("Error recording M-Pesa refund payout:", error);
            return res.status(500).json({ message: "Error recording M-Pesa refund payout" });
        } finally {
            await queryRunner.release();
        }
    }

    static async rejectReturn(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        try {
            const requestId = req.params.id;
            const { rejection_reason } = sanitizeRejectReturnPayload(req.body ?? {});

            await queryRunner.connect();
            await queryRunner.startTransaction();
            const returnReq = await queryRunner.manager.findOne(ReturnRequest, {
                where: { id: requestId },
                lock: { mode: "pessimistic_write" },
            });
            if (!returnReq) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Return request not found" });
            }

            if (returnReq.status !== ReturnStatus.PENDING) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Request already processed" });
            }

            const admin = await queryRunner.manager.findOneBy(User, { id: req.user!.id });
            if (!admin) {
                await queryRunner.rollbackTransaction();
                return res.status(401).json({ message: "Rejecting user was not found" });
            }

            returnReq.status = ReturnStatus.REJECTED;
            returnReq.approved_by = admin;
            returnReq.rejection_reason = rejection_reason || "Rejected by management";

            await queryRunner.manager.save(returnReq);
            await queryRunner.commitTransaction();

            return res.status(200).json({ message: "Return request rejected", returnReq });
        } catch (error) {
            if (queryRunner.isTransactionActive) {
                await queryRunner.rollbackTransaction();
            }
            console.error("Error rejecting return:", error);
            return res.status(500).json({ message: "Error rejecting return" });
        } finally {
            await queryRunner.release();
        }
    }

    static async getAllRequests(req: AuthenticatedRequest, res: Response) {
        try {
            const isCashier = req.user?.role === AppRole.CASHIER;
            const requests = await returnRepository.find({
                where: isCashier && req.user?.id ? { requested_by: { id: req.user!.id } } : {},
                relations: ["sale", "requested_by", "approved_by", "items", "items.sale_item", "items.sale_item.product"],
                order: { created_at: "DESC" }
            });
            const requestIds = requests.map((request) => request.id);
            const saleIds = requests
                .map((request) => request.sale?.id)
                .filter((saleId): saleId is string => Boolean(saleId));
            const [invoices, storeCredits] = requestIds.length
                ? await Promise.all([
                    AppDataSource.getRepository(Invoice).find({
                        where: { sale_id: In(saleIds) },
                        select: ["sale_id", "invoice_number"],
                    }),
                    AppDataSource.getRepository(StoreCredit).find({
                        where: { issued_from_return_id: In(requestIds) },
                        select: ["issued_from_return_id", "barcode", "current_balance", "status", "expires_at"],
                    }),
                ])
                : [[], []];
            const invoiceNumberBySaleId = new Map(
                invoices.map((invoice) => [invoice.sale_id, invoice.invoice_number]),
            );
            const voucherByReturnId = new Map(
                storeCredits.map((credit) => [credit.issued_from_return_id, {
                    barcode: credit.barcode,
                    current_balance: credit.current_balance,
                    status: credit.status,
                    expires_at: credit.expires_at,
                }]),
            );

            res.json(requests.map((request) => ({
                ...request,
                sale_id: request.sale?.id ?? null,
                invoice_number: request.sale?.id
                    ? invoiceNumberBySaleId.get(request.sale.id) ?? null
                    : null,
                store_credit_voucher: voucherByReturnId.get(request.id) ?? null,
            })));
        } catch (error) {
            console.error("Error fetching returns:", error);
            res.status(500).json({ message: "Error fetching returns" });
        }
    }
}
