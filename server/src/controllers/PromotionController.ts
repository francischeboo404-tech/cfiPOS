import { Request, Response } from "express";
import { EntityManager } from "typeorm";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Product } from "../entity/Product";
import { Promotion } from "../entity/Promotion";
import { PromotionAuditEvent } from "../entity/PromotionAuditEvent";
import { PromotionDiscountType, PromotionItem } from "../entity/PromotionItem";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { User } from "../entity/User";
import {
    centsToKesString,
    parseKesToCents,
    percentageToBasisPoints,
} from "../lib/exactMoney";
import { getPromotionStatus } from "../lib/promotionRules";

interface PromotionItemPayload {
    product_id: string;
    unit_of_measure: string;
    discount_type: PromotionDiscountType;
    discount_value: string;
    min_qty: number;
    max_qty_per_sale: number | null;
    total_quota_qty: number | null;
    loss_override_reason: string | null;
    stored_discount_value: string;
}

interface PromotionPayload {
    name: string;
    starts_at: Date;
    ends_at: Date;
    items: PromotionItemPayload[];
    reason: string | null;
}

const parseOptionalQuantity = (value: unknown, label: string): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const quantity = Number(value);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new Error(`${label} must be a positive whole number or empty`);
    }
    return quantity;
};

const sanitizePayload = (input: unknown): PromotionPayload => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Promotion payload must be an object");
    }
    const payload = input as Record<string, unknown>;
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > 120) throw new Error("Promotion name must contain 1 to 120 characters");
    if (typeof payload.starts_at !== "string" || typeof payload.ends_at !== "string") {
        throw new Error("Promotion start and end times are required");
    }
    const starts_at = new Date(payload.starts_at);
    const ends_at = new Date(payload.ends_at);
    if (!Number.isFinite(starts_at.getTime()) || !Number.isFinite(ends_at.getTime()) ||
        starts_at >= ends_at) {
        throw new Error("Promotion end time must be later than its start time");
    }
    if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 100) {
        throw new Error("A promotion must contain between 1 and 100 products");
    }
    const seen = new Set<string>();
    const items = payload.items.map((value): PromotionItemPayload => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("Each promotion item must be an object");
        }
        const item = value as Record<string, unknown>;
        const product_id = typeof item.product_id === "string" ? item.product_id.trim() : "";
        const unit_of_measure = typeof item.unit_of_measure === "string"
            ? item.unit_of_measure.trim()
            : "";
        if (!product_id || !unit_of_measure || unit_of_measure.length > 80) {
            throw new Error("Each promotion item requires a product and valid unit of measure");
        }
        const key = `${product_id}:${unit_of_measure}`;
        if (seen.has(key)) throw new Error("A product and unit can appear only once in a promotion");
        seen.add(key);

        const discount_type = item.discount_type;
        if (discount_type !== "percent" &&
            discount_type !== "fixed_discount" &&
            discount_type !== "fixed_price") {
            throw new Error("Discount type must be percent, fixed_discount, or fixed_price");
        }
        if (typeof item.discount_value !== "string" && typeof item.discount_value !== "number") {
            throw new Error("Discount value must be a decimal amount");
        }
        const discount_value = String(item.discount_value).trim();
        let stored_discount_value: string;
        if (discount_type === "percent") {
            const basisPoints = percentageToBasisPoints(discount_value);
            if (basisPoints <= 0 || basisPoints > 10_000) {
                throw new Error("Promotion percentage must be greater than 0 and at most 100");
            }
            stored_discount_value = String(basisPoints);
        } else {
            const cents = parseKesToCents(discount_value);
            if (discount_type === "fixed_discount" && cents <= 0n) {
                throw new Error("Fixed discount must be greater than zero");
            }
            stored_discount_value = String(cents);
        }
        const min_qty = Number(item.min_qty);
        if (!Number.isSafeInteger(min_qty) || min_qty <= 0) {
            throw new Error("Minimum quantity must be a positive whole number");
        }
        const max_qty_per_sale = parseOptionalQuantity(item.max_qty_per_sale, "Maximum quantity per sale");
        const total_quota_qty = parseOptionalQuantity(item.total_quota_qty, "Total promotion quota");
        if (max_qty_per_sale !== null && max_qty_per_sale < min_qty) {
            throw new Error("Maximum quantity per sale cannot be lower than the minimum quantity");
        }
        const loss_override_reason = typeof item.loss_override_reason === "string"
            ? item.loss_override_reason.trim() || null
            : null;
        if (loss_override_reason && loss_override_reason.length > 500) {
            throw new Error("Loss override reason must be 500 characters or less");
        }
        return {
            product_id,
            unit_of_measure,
            discount_type,
            discount_value,
            min_qty,
            max_qty_per_sale,
            total_quota_qty,
            loss_override_reason,
            stored_discount_value,
        };
    });
    const reason = typeof payload.reason === "string" ? payload.reason.trim() || null : null;
    if (reason && reason.length > 500) throw new Error("Reason must be 500 characters or less");
    return { name, starts_at, ends_at, items, reason };
};

const itemState = (item: PromotionItem) => ({
    id: item.id,
    product_id: item.product.id,
    product_name: item.product.name,
    unit_of_measure: item.unit_of_measure,
    discount_type: item.discount_type,
    discount_value: item.discount_type === "percent"
        ? `${BigInt(item.discount_value) / 100n}.${String(BigInt(item.discount_value) % 100n).padStart(2, "0")}`
        : centsToKesString(BigInt(item.discount_value)),
    min_qty: item.min_qty,
    max_qty_per_sale: item.max_qty_per_sale,
    total_quota_qty: item.total_quota_qty,
    used_qty: item.used_qty,
    loss_override_reason: item.loss_override_reason,
    is_active: item.is_active,
});

const promotionState = (promotion: Promotion, items: PromotionItem[]) => ({
    id: promotion.id,
    name: promotion.name,
    starts_at: promotion.starts_at.toISOString(),
    ends_at: promotion.ends_at.toISOString(),
    status: getPromotionStatus(
        new Date(promotion.starts_at),
        new Date(promotion.ends_at),
        promotion.status_override === "cancelled",
    ),
    status_override: promotion.status_override,
    items: items.map(itemState),
});

const loadPromotionProducts = async (manager: EntityManager, payload: PromotionPayload) => {
    const products: Product[] = [];
    for (const item of payload.items) {
        const product = await manager.findOne(Product, {
            where: { id: item.product_id },
        });
        if (!product) throw new Error("One or more promotion products do not exist");
        if (product.unit_of_measure !== item.unit_of_measure) {
            throw new Error(`${product.name} can only be sold in ${product.unit_of_measure}`);
        }
        const priceCents = parseKesToCents(String(product.retail_price));
        let promoPriceCents: bigint;
        if (item.discount_type === "percent") {
            const basisPoints = BigInt(item.stored_discount_value);
            const discount = (priceCents * basisPoints + 5_000n) / 10_000n;
            promoPriceCents = priceCents - (discount > priceCents ? priceCents : discount);
        } else if (item.discount_type === "fixed_discount") {
            const discount = BigInt(item.stored_discount_value);
            promoPriceCents = priceCents - (discount > priceCents ? priceCents : discount);
        } else {
            promoPriceCents = BigInt(item.stored_discount_value);
            if (promoPriceCents >= priceCents) {
                throw new Error(`${product.name} promotion price must be below its current retail price`);
            }
        }
        const unitCostCents = parseKesToCents(String(product.unit_cost));
        if (promoPriceCents < unitCostCents && !item.loss_override_reason) {
            throw new Error(`${product.name} would sell below weighted-average cost; a manager loss reason is required`);
        }
        products.push(product);
    }
    return products;
};

const saveItems = async (
    manager: EntityManager,
    promotion: Promotion,
    payload: PromotionPayload,
    products: Product[],
) => {
    const repository = manager.getRepository(PromotionItem);
    const currentItems = await repository.find({
        where: { promotion: { id: promotion.id } },
        relations: ["product"],
        lock: { mode: "pessimistic_write" },
    });
    const activeSessions = await manager.find(PaymentCheckoutSession, {
        where: { status: "reserved" },
    });
    const incomingKeys = new Set(payload.items.map((item) => `${item.product_id}:${item.unit_of_measure}`));
    for (const current of currentItems) {
        if (current.is_active && !incomingKeys.has(`${current.product.id}:${current.unit_of_measure}`)) {
            current.is_active = false;
            await repository.save(current);
        }
    }
    for (let index = 0; index < payload.items.length; index += 1) {
        const item = payload.items[index];
        const product = products[index];
        const current = currentItems.find(
            (candidate) => candidate.product.id === item.product_id &&
                candidate.unit_of_measure === item.unit_of_measure,
        );
        if (current) {
            if (item.total_quota_qty !== null && item.total_quota_qty < current.used_qty) {
                throw new Error(`${product.name} total quota cannot be lower than already redeemed quantity`);
            }
            const reservedQuantity = activeSessions.reduce(
                (total, session) => total + session.items.reduce(
                    (sessionTotal, checkoutItem) => sessionTotal +
                        (checkoutItem.price_segments || [])
                            .filter((segment) => segment.promotion_item_id === current.id)
                            .reduce((quantity, segment) => quantity + segment.quantity, 0),
                    0,
                ),
                0,
            );
            if (item.total_quota_qty !== null &&
                current.used_qty + reservedQuantity > item.total_quota_qty) {
                throw new Error(`${product.name} total quota cannot be lower than already redeemed and reserved quantity`);
            }
            current.discount_type = item.discount_type;
            current.discount_value = item.stored_discount_value;
            current.min_qty = item.min_qty;
            current.max_qty_per_sale = item.max_qty_per_sale;
            current.total_quota_qty = item.total_quota_qty;
            current.loss_override_reason = item.loss_override_reason;
            current.is_active = true;
            await repository.save(current);
        } else {
            const newItem = repository.create({
                promotion,
                product,
                unit_of_measure: item.unit_of_measure,
                discount_type: item.discount_type,
                discount_value: item.stored_discount_value,
                min_qty: item.min_qty,
                max_qty_per_sale: item.max_qty_per_sale,
                total_quota_qty: item.total_quota_qty,
                used_qty: 0,
                loss_override_reason: item.loss_override_reason,
                is_active: true,
            });
            await repository.save(newItem);
        }
    }
    return repository.find({
        where: { promotion: { id: promotion.id } },
        relations: ["product"],
        order: { created_at: "ASC" },
    });
};

export class PromotionController {
    static async active(_req: Request, res: Response) {
        try {
            const now = new Date();
            const items = await AppDataSource.getRepository(PromotionItem).createQueryBuilder("item")
                .innerJoinAndSelect("item.promotion", "promotion")
                .innerJoinAndSelect("item.product", "product")
                .where("item.is_active = true")
                .andWhere("promotion.status_override IS NULL")
                .andWhere("promotion.starts_at <= :now AND promotion.ends_at > :now", { now })
                .andWhere("(item.total_quota_qty IS NULL OR item.used_qty < item.total_quota_qty)")
                .orderBy("promotion.starts_at", "ASC")
                .getMany();
            return res.json(items.map((item) => ({
                promotion_id: item.promotion.id,
                promotion_name: item.promotion.name,
                starts_at: item.promotion.starts_at,
                ends_at: item.promotion.ends_at,
                product_id: item.product.id,
                product_name: item.product.name,
                unit_of_measure: item.unit_of_measure,
                discount_type: item.discount_type,
                discount_value: item.discount_type === "percent"
                    ? `${BigInt(item.discount_value) / 100n}.${String(BigInt(item.discount_value) % 100n).padStart(2, "0")}`
                    : centsToKesString(BigInt(item.discount_value)),
                min_qty: item.min_qty,
                max_qty_per_sale: item.max_qty_per_sale,
                remaining_quota_qty: item.total_quota_qty === null
                    ? null
                    : item.total_quota_qty - item.used_qty,
            })));
        } catch (error) {
            console.error("Could not list active promotions:", error);
            return res.status(500).json({ message: "Could not list active promotions" });
        }
    }

    static async list(_req: Request, res: Response) {
        try {
            const promotions = await AppDataSource.getRepository(Promotion).find({
                relations: ["items", "items.product", "created_by", "updated_by"],
                order: { starts_at: "DESC" },
                take: 200,
            });
            const itemsByPromotion = new Map<string, PromotionItem[]>();
            for (const item of await AppDataSource.getRepository(PromotionItem).find({
                relations: ["product", "promotion"],
                order: { created_at: "ASC" },
            })) {
                const current = itemsByPromotion.get(item.promotion.id) || [];
                current.push(item);
                itemsByPromotion.set(item.promotion.id, current);
            }
            return res.json(promotions.map((promotion) => ({
                ...promotionState(promotion, itemsByPromotion.get(promotion.id) || []),
                created_by: promotion.created_by?.id,
                updated_by: promotion.updated_by?.id,
            })));
        } catch (error) {
            console.error("Could not list promotions:", error);
            return res.status(500).json({ message: "Could not list promotions" });
        }
    }

    static async create(req: AuthenticatedRequest, res: Response) {
        const runner = AppDataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            if (!req.user?.id) throw new Error("Authenticated promotion manager is required");
            const payload = sanitizePayload(req.body);
            const products = await loadPromotionProducts(runner.manager, payload);
            const actor = await runner.manager.findOneBy(User, { id: req.user.id });
            if (!actor) throw new Error("Promotion manager account was not found");
            const promotion = runner.manager.create(Promotion, {
                name: payload.name,
                starts_at: payload.starts_at,
                ends_at: payload.ends_at,
                status_override: null,
                created_by: actor,
                updated_by: actor,
            });
            await runner.manager.save(promotion);
            const items = await saveItems(runner.manager, promotion, payload, products);
            const state = promotionState(promotion, items);
            await runner.manager.save(runner.manager.create(PromotionAuditEvent, {
                promotion,
                actor,
                action: "created",
                before_state: null,
                after_state: state,
                reason: payload.reason,
            }));
            await runner.commitTransaction();
            return res.status(201).json(state);
        } catch (error) {
            await runner.rollbackTransaction();
            const message = error instanceof Error ? error.message : "Could not create promotion";
            if (message.includes("already overlaps")) return res.status(409).json({ message });
            return res.status(400).json({ message });
        } finally {
            await runner.release();
        }
    }

    static async update(req: AuthenticatedRequest, res: Response) {
        const runner = AppDataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            if (!req.user?.id) throw new Error("Authenticated promotion manager is required");
            const payload = sanitizePayload(req.body);
            const promotion = await runner.manager.findOne(Promotion, {
                where: { id: String(req.params.id) },
                lock: { mode: "pessimistic_write" },
            });
            if (!promotion) {
                await runner.rollbackTransaction();
                return res.status(404).json({ message: "Promotion not found" });
            }
            if (promotion.status_override === "cancelled") {
                await runner.rollbackTransaction();
                return res.status(409).json({ message: "Cancelled promotions cannot be edited" });
            }
            const currentItems = await runner.manager.find(PromotionItem, {
                where: { promotion: { id: promotion.id } },
                relations: ["product"],
                lock: { mode: "pessimistic_write" },
            });
            const before = promotionState(promotion, currentItems);
            const products = await loadPromotionProducts(runner.manager, payload);
            const actor = await runner.manager.findOneBy(User, { id: req.user.id });
            if (!actor) throw new Error("Promotion manager account was not found");
            promotion.name = payload.name;
            promotion.starts_at = payload.starts_at;
            promotion.ends_at = payload.ends_at;
            promotion.updated_by = actor;
            await runner.manager.save(promotion);
            const items = await saveItems(runner.manager, promotion, payload, products);
            const after = promotionState(promotion, items);
            await runner.manager.save(runner.manager.create(PromotionAuditEvent, {
                promotion,
                actor,
                action: "updated",
                before_state: before,
                after_state: after,
                reason: payload.reason,
            }));
            await runner.commitTransaction();
            return res.json(after);
        } catch (error) {
            await runner.rollbackTransaction();
            const message = error instanceof Error ? error.message : "Could not update promotion";
            if (message.includes("already overlaps")) return res.status(409).json({ message });
            return res.status(400).json({ message });
        } finally {
            await runner.release();
        }
    }

    static async cancel(req: AuthenticatedRequest, res: Response) {
        const runner = AppDataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            if (!req.user?.id) throw new Error("Authenticated promotion manager is required");
            const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
            if (!reason || reason.length > 500) {
                throw new Error("A cancellation reason of 1 to 500 characters is required");
            }
            const promotion = await runner.manager.findOne(Promotion, {
                where: { id: String(req.params.id) },
                relations: ["created_by", "updated_by"],
                lock: { mode: "pessimistic_write" },
            });
            if (!promotion) {
                await runner.rollbackTransaction();
                return res.status(404).json({ message: "Promotion not found" });
            }
            if (promotion.status_override === "cancelled") {
                await runner.rollbackTransaction();
                return res.status(409).json({ message: "Promotion is already cancelled" });
            }
            const items = await runner.manager.find(PromotionItem, {
                where: { promotion: { id: promotion.id } },
                relations: ["product"],
            });
            const before = promotionState(promotion, items);
            const actor = await runner.manager.findOneBy(User, { id: req.user.id });
            if (!actor) throw new Error("Promotion manager account was not found");
            promotion.status_override = "cancelled";
            promotion.updated_by = actor;
            await runner.manager.save(promotion);
            const after = promotionState(promotion, items);
            await runner.manager.save(runner.manager.create(PromotionAuditEvent, {
                promotion,
                actor,
                action: "cancelled",
                before_state: before,
                after_state: after,
                reason,
            }));
            await runner.commitTransaction();
            return res.json(after);
        } catch (error) {
            await runner.rollbackTransaction();
            return res.status(400).json({
                message: error instanceof Error ? error.message : "Could not cancel promotion",
            });
        } finally {
            await runner.release();
        }
    }

    static async audit(req: Request, res: Response) {
        try {
            const events = await AppDataSource.getRepository(PromotionAuditEvent).find({
                where: { promotion: { id: String(req.params.id) } },
                relations: ["actor"],
                order: { created_at: "DESC" },
            });
            return res.json(events.map((event) => ({
                id: event.id,
                action: event.action,
                before_state: event.before_state,
                after_state: event.after_state,
                reason: event.reason,
                actor_id: event.actor.id,
                created_at: event.created_at,
            })));
        } catch (error) {
            console.error("Could not fetch promotion audit:", error);
            return res.status(500).json({ message: "Could not fetch promotion audit" });
        }
    }

    static async performance(req: Request, res: Response) {
        try {
            const start = typeof req.query.start === "string" ? new Date(req.query.start) : null;
            const end = typeof req.query.end === "string" ? new Date(req.query.end) : null;
            if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime())) ||
                (start && end && start >= end)) {
                return res.status(400).json({ message: "Report date range is invalid" });
            }
            const params: unknown[] = [];
            const conditions = ["si.promotion_item_id IS NOT NULL", "si.promotion_quantity > 0"];
            if (start) {
                params.push(start);
                conditions.push(`s.created_at >= $${params.length}`);
            }
            if (end) {
                params.push(end);
                conditions.push(`s.created_at < $${params.length}`);
            }
            if (typeof req.query.promotion_id === "string" && req.query.promotion_id.trim()) {
                params.push(req.query.promotion_id.trim());
                conditions.push(`p.id = $${params.length}`);
            }
            const rows = await AppDataSource.query(`
                SELECT
                    p.id AS promotion_id,
                    p.name AS promotion_name,
                    pr.id AS product_id,
                    pr.name AS product_name,
                    SUM(si.promotion_quantity)::text AS units_sold,
                    SUM(si.promotion_discount_per_unit_cents * si.promotion_quantity)::text AS promotion_discount_cents,
                    SUM(si.net_revenue_cents)::text AS net_revenue_cents,
                    SUM(si.vat_cents)::text AS vat_cents,
                    SUM(si.cogs_total_cents)::text AS cogs_cents,
                    COUNT(DISTINCT s.id)::text AS sale_count
                FROM sale_items si
                JOIN sales s ON s.id = si.sale_id
                JOIN promotions p ON p.id = si.promotion_id
                JOIN products pr ON pr.id = si.product_id
                WHERE ${conditions.join(" AND ")}
                GROUP BY p.id, p.name, pr.id, pr.name
                ORDER BY p.name, pr.name
            `, params) as Array<Record<string, string>>;
            return res.json(rows.map((row) => ({
                promotion_id: row.promotion_id,
                promotion_name: row.promotion_name,
                product_id: row.product_id,
                product_name: row.product_name,
                units_sold: Number(row.units_sold),
                promotion_discount: centsToKesString(BigInt(row.promotion_discount_cents || "0")),
                net_revenue: centsToKesString(BigInt(row.net_revenue_cents || "0")),
                vat: centsToKesString(BigInt(row.vat_cents || "0")),
                cogs: centsToKesString(BigInt(row.cogs_cents || "0")),
                sale_count: Number(row.sale_count),
            })));
        } catch (error) {
            console.error("Could not generate promotion performance report:", error);
            return res.status(500).json({ message: "Could not generate promotion performance report" });
        }
    }
}
