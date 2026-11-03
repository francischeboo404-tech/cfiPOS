const DISCOUNT_AUTHORIZED_ROLES = new Set(["manager", "admin"]);

export const assertSaleDiscountAuthorized = (
    role: string | undefined,
    discountAmount: number,
): void => {
    if (discountAmount > 0 && !DISCOUNT_AUTHORIZED_ROLES.has(role || "")) {
        throw new Error("Manual sale discounts require manager or admin authorization");
    }
};
