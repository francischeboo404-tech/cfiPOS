import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculatePromotionPrice, getAvailablePromotionQuantity, getPromotionStatus } from "./promotionRules";

describe("promotion pricing rules", () => {
    it("uses inclusive start and exclusive end boundaries", () => {
        const start = new Date("2026-05-01T09:00:00.000Z");
        const end = new Date("2026-05-01T10:00:00.000Z");
        assert.equal(getPromotionStatus(start, end, false, start), "active");
        assert.equal(getPromotionStatus(start, end, false, end), "expired");
        assert.equal(getPromotionStatus(start, end, true, start), "cancelled");
    });

    it("splits qualifying and excess units using cents and quantity caps", () => {
        const result = calculatePromotionPrice({
            unitPriceCents: 1_000n,
            quantity: 7,
            minQuantity: 2,
            maxQuantityPerSale: 3,
            remainingQuota: 2,
            discountType: "fixed_discount",
            discountValue: "2.50",
        });
        assert.deepEqual(result.map((segment) => ({
            quantity: segment.quantity,
            price: segment.unitPriceCents,
            discount: segment.discountPerUnitCents,
            promoted: segment.promotionApplied,
        })), [
            { quantity: 2, price: 750n, discount: 250n, promoted: true },
            { quantity: 5, price: 1_000n, discount: 0n, promoted: false },
        ]);
    });

    it("rounds percentage discounts half up and caps discounts at the full price", () => {
        const halfUp = calculatePromotionPrice({
            unitPriceCents: 5n,
            quantity: 1,
            minQuantity: 1,
            maxQuantityPerSale: null,
            remainingQuota: null,
            discountType: "percent",
            discountValue: "10.00",
        });
        assert.equal(halfUp[0].discountPerUnitCents, 1n);

        const freeItem = calculatePromotionPrice({
            unitPriceCents: 100n,
            quantity: 1,
            minQuantity: 1,
            maxQuantityPerSale: null,
            remainingQuota: null,
            discountType: "fixed_discount",
            discountValue: "5.00",
        });
        assert.equal(freeItem[0].unitPriceCents, 0n);
    });

    it("prices fixed-price offers in exact cents and ignores offers at retail price", () => {
        const fixedPrice = calculatePromotionPrice({
            unitPriceCents: 1_999n,
            quantity: 2,
            minQuantity: 1,
            maxQuantityPerSale: null,
            remainingQuota: null,
            discountType: "fixed_price",
            discountValue: "14.50",
        });
        assert.deepEqual(fixedPrice, [{
            quantity: 2,
            unitPriceCents: 1_450n,
            originalUnitPriceCents: 1_999n,
            discountPerUnitCents: 549n,
            promotionApplied: true,
        }]);

        const noDiscount = calculatePromotionPrice({
            unitPriceCents: 1_999n,
            quantity: 1,
            minQuantity: 1,
            maxQuantityPerSale: null,
            remainingQuota: null,
            discountType: "fixed_price",
            discountValue: "19.99",
        });
        assert.equal(noDiscount[0].promotionApplied, false);
    });

    it("counts existing reservations against quota without exceeding it", () => {
        assert.equal(getAvailablePromotionQuantity(5, 2, 4, 6, 2, 3), 1);
        assert.equal(getAvailablePromotionQuantity(5, 2, 4, 6, 2, 4), 0);
        assert.equal(getAvailablePromotionQuantity(1, 2, null, null, 0, 0), 0);
    });
});
