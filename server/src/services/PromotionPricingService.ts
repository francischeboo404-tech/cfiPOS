import { EntityManager } from "typeorm";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { Product } from "../entity/Product";
import { PromotionItem } from "../entity/PromotionItem";
import { centsToKesString, parseKesToCents } from "../lib/exactMoney";
import {
    calculatePromotionPrice,
    getAvailablePromotionQuantity,
    PromotionPriceSegment,
} from "../lib/promotionRules";

export interface PricedPromotionSegment extends PromotionPriceSegment {
    promotionId: string | null;
    promotionItemId: string | null;
    promotionName: string | null;
    lossOverrideReason: string | null;
}

const percentFromBasisPoints = (basisPoints: bigint): string => {
    const whole = basisPoints / 100n;
    const fraction = String(basisPoints % 100n).padStart(2, "0");
    return `${whole}.${fraction}`;
};

const getReservedPromotionQuantity = (
    sessions: PaymentCheckoutSession[],
    promotionItemId: string,
    excludeSessionId?: string,
): number => sessions
    .filter((session) => session.status === "reserved" && session.id !== excludeSessionId)
    .reduce((total, session) => total + session.items.reduce(
        (sum, item) => sum + (item.price_segments || [])
            .filter((segment) => segment.promotion_item_id === promotionItemId)
            .reduce((quantity, segment) => quantity + segment.quantity, 0),
        0,
    ), 0);

export class PromotionPricingService {
    static async priceProduct(
        manager: EntityManager,
        product: Product,
        quantity: number,
        activeSessions: PaymentCheckoutSession[],
        options: { excludeSessionId?: string; lock?: boolean } = {},
    ): Promise<PricedPromotionSegment[]> {
        const unitPriceCents = parseKesToCents(String(product.retail_price));
        const promotionQuery = manager.createQueryBuilder(PromotionItem, "item")
            .innerJoinAndSelect("item.promotion", "promotion")
            .where("item.product_id = :productId", { productId: product.id })
            .andWhere("item.unit_of_measure = :unit", { unit: product.unit_of_measure })
            .andWhere("item.is_active = true")
            .andWhere("promotion.status_override IS NULL")
            .andWhere("promotion.starts_at <= :now AND promotion.ends_at > :now", { now: new Date() })
            .orderBy("promotion.starts_at", "DESC")
            .take(1);
        if (options.lock) promotionQuery.setLock("pessimistic_write", undefined, ["item", "promotion"]);
        const promotionItem = await promotionQuery.getOne();
        if (!promotionItem) {
            return [{
                quantity,
                unitPriceCents,
                originalUnitPriceCents: unitPriceCents,
                discountPerUnitCents: 0n,
                promotionApplied: false,
                promotionId: null,
                promotionItemId: null,
                promotionName: null,
                lossOverrideReason: null,
            }];
        }

        const sessionsForQuota = options.lock
            ? await manager.find(PaymentCheckoutSession, { where: { status: "reserved" } })
            : activeSessions;
        const reservedQuantity = getReservedPromotionQuantity(
            sessionsForQuota,
            promotionItem.id,
            options.excludeSessionId,
        );
        const availableQuantity = getAvailablePromotionQuantity(
            quantity,
            promotionItem.min_qty,
            promotionItem.max_qty_per_sale,
            promotionItem.total_quota_qty,
            promotionItem.used_qty,
            reservedQuantity,
        );
        const discountValue = promotionItem.discount_type === "percent"
            ? percentFromBasisPoints(BigInt(promotionItem.discount_value))
            : centsToKesString(BigInt(promotionItem.discount_value));
        const calculated = calculatePromotionPrice({
            unitPriceCents,
            quantity,
            minQuantity: promotionItem.min_qty,
            maxQuantityPerSale: promotionItem.max_qty_per_sale,
            remainingQuota: availableQuantity,
            discountType: promotionItem.discount_type,
            discountValue,
        });
        return calculated.map((segment) => ({
            ...segment,
            promotionId: segment.promotionApplied ? promotionItem.promotion.id : null,
            promotionItemId: segment.promotionApplied ? promotionItem.id : null,
            promotionName: segment.promotionApplied ? promotionItem.promotion.name : null,
            lossOverrideReason: segment.promotionApplied
                ? promotionItem.loss_override_reason
                : null,
        }));
    }

    static getSegmentGrossCents(segments: Array<{ quantity: number; unitPriceCents: bigint }>): bigint {
        return segments.reduce(
            (total, segment) => total + segment.unitPriceCents * BigInt(segment.quantity),
            0n,
        );
    }
}
