import {
    divideRoundHalfUp,
    percentageToBasisPoints,
    parseKesToCents,
} from "./exactMoney";
import { PromotionDiscountType } from "../entity/PromotionItem";

export interface PromotionPriceInput {
    unitPriceCents: bigint;
    quantity: number;
    minQuantity: number;
    maxQuantityPerSale: number | null;
    remainingQuota: number | null;
    discountType: PromotionDiscountType;
    discountValue: string;
}

export interface PromotionPriceSegment {
    quantity: number;
    unitPriceCents: bigint;
    originalUnitPriceCents: bigint;
    discountPerUnitCents: bigint;
    promotionApplied: boolean;
}

export const calculatePromotionPrice = (input: PromotionPriceInput): PromotionPriceSegment[] => {
    if (input.unitPriceCents < 0n ||
        !Number.isSafeInteger(input.quantity) || input.quantity <= 0 ||
        !Number.isSafeInteger(input.minQuantity) || input.minQuantity <= 0 ||
        (input.maxQuantityPerSale !== null &&
            (!Number.isSafeInteger(input.maxQuantityPerSale) ||
                input.maxQuantityPerSale < input.minQuantity)) ||
        (input.remainingQuota !== null &&
            (!Number.isSafeInteger(input.remainingQuota) || input.remainingQuota < 0))) {
        throw new Error("Promotion quantities or product price are invalid");
    }
    if (input.quantity < input.minQuantity) {
        return [{
            quantity: input.quantity,
            unitPriceCents: input.unitPriceCents,
            originalUnitPriceCents: input.unitPriceCents,
            discountPerUnitCents: 0n,
            promotionApplied: false,
        }];
    }

    const eligibleQuantity = Math.min(
        input.quantity,
        input.maxQuantityPerSale ?? input.quantity,
        input.remainingQuota ?? input.quantity,
    );
    if (eligibleQuantity <= 0) {
        return [{
            quantity: input.quantity,
            unitPriceCents: input.unitPriceCents,
            originalUnitPriceCents: input.unitPriceCents,
            discountPerUnitCents: 0n,
            promotionApplied: false,
        }];
    }

    let discountPerUnitCents: bigint;
    switch (input.discountType) {
        case "percent": {
            const basisPoints = BigInt(percentageToBasisPoints(input.discountValue));
            if (basisPoints <= 0n || basisPoints > 10_000n) {
                throw new Error("Promotion percentage must be greater than 0 and at most 100");
            }
            discountPerUnitCents = divideRoundHalfUp(
                input.unitPriceCents * basisPoints,
                10_000n,
            );
            break;
        }
        case "fixed_discount":
            discountPerUnitCents = parseKesToCents(input.discountValue);
            if (discountPerUnitCents <= 0n) {
                throw new Error("Promotion discount must be greater than zero");
            }
            break;
        case "fixed_price": {
            const promotionalPriceCents = parseKesToCents(input.discountValue);
            if (promotionalPriceCents >= input.unitPriceCents) {
                return [{
                    quantity: input.quantity,
                    unitPriceCents: input.unitPriceCents,
                    originalUnitPriceCents: input.unitPriceCents,
                    discountPerUnitCents: 0n,
                    promotionApplied: false,
                }];
            }
            discountPerUnitCents = input.unitPriceCents - promotionalPriceCents;
            break;
        }
        default:
            throw new Error("Promotion discount type is invalid");
    }

    discountPerUnitCents = discountPerUnitCents > input.unitPriceCents
        ? input.unitPriceCents
        : discountPerUnitCents;
    const segments: PromotionPriceSegment[] = [];
    segments.push({
        quantity: eligibleQuantity,
        unitPriceCents: input.unitPriceCents - discountPerUnitCents,
        originalUnitPriceCents: input.unitPriceCents,
        discountPerUnitCents,
        promotionApplied: true,
    });
    if (eligibleQuantity < input.quantity) {
        segments.push({
            quantity: input.quantity - eligibleQuantity,
            unitPriceCents: input.unitPriceCents,
            originalUnitPriceCents: input.unitPriceCents,
            discountPerUnitCents: 0n,
            promotionApplied: false,
        });
    }
    return segments;
};

export const getPromotionStatus = (
    startsAt: Date,
    endsAt: Date,
    cancelled: boolean,
    now = new Date(),
): "scheduled" | "active" | "expired" | "cancelled" => {
    if (cancelled) return "cancelled";
    if (startsAt > now) return "scheduled";
    if (endsAt <= now) return "expired";
    return "active";
};

export const getAvailablePromotionQuantity = (
    requestedQuantity: number,
    minQuantity: number,
    maxQuantityPerSale: number | null,
    totalQuota: number | null,
    usedQuantity: number,
    reservedQuantity: number,
): number => {
    if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0 ||
        !Number.isSafeInteger(minQuantity) || minQuantity <= 0 ||
        !Number.isSafeInteger(usedQuantity) || usedQuantity < 0 ||
        !Number.isSafeInteger(reservedQuantity) || reservedQuantity < 0 ||
        (maxQuantityPerSale !== null &&
            (!Number.isSafeInteger(maxQuantityPerSale) || maxQuantityPerSale < minQuantity)) ||
        (totalQuota !== null &&
            (!Number.isSafeInteger(totalQuota) || totalQuota < 0 || usedQuantity > totalQuota))) {
        throw new Error("Promotion quantities are invalid");
    }
    if (requestedQuantity < minQuantity) return 0;
    const remainingQuota = totalQuota === null
        ? requestedQuantity
        : Math.max(0, totalQuota - usedQuantity - reservedQuantity);
    return Math.max(0, Math.min(
        requestedQuantity,
        maxQuantityPerSale ?? requestedQuantity,
        remainingQuota,
    ));
};
