export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export const parseKesToCents = (input: string | number): bigint => {
    const value = String(input).trim();
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
    if (!match) throw new Error("Money must be a non-negative amount with at most two decimal places");
    return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0");
};

export const parseKesDecimalToCents = (input: unknown): bigint => {
    if (typeof input !== "string") {
        throw new Error("Database money values must be returned as exact decimal strings");
    }
    const value = input.trim();
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
    if (!match) throw new Error(`Invalid exact KES decimal value: ${value}`);
    const cents = BigInt(match[2]) * 100n + BigInt((match[3] || "").padEnd(2, "0") || "0");
    return match[1] === "-" ? -cents : cents;
};

export const centsToKesString = (cents: bigint): string => {
    const sign = cents < 0n ? "-" : "";
    const absolute = cents < 0n ? -cents : cents;
    return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

export const divideRoundHalfUp = (numerator: bigint, denominator: bigint): bigint => {
    if (denominator <= 0n) throw new Error("Denominator must be positive");
    if (numerator < 0n) return -divideRoundHalfUp(-numerator, denominator);
    return (numerator + denominator / 2n) / denominator;
};

export const calculateInclusiveVatCents = (grossCents: bigint, taxRateBasisPoints: number) => {
    if (!Number.isInteger(taxRateBasisPoints) || taxRateBasisPoints < 0) {
        throw new Error("Tax rate must be a non-negative whole number of basis points");
    }
    const rate = BigInt(taxRateBasisPoints);
    const netCents = divideRoundHalfUp(grossCents * 10_000n, 10_000n + rate);
    return { netRevenueCents: netCents, vatCents: grossCents - netCents };
};

export const allocateDiscountCents = (lineGrossCents: bigint[], discountCents: bigint): bigint[] => {
    const grossTotal = lineGrossCents.reduce((sum, value) => sum + value, 0n);
    if (lineGrossCents.some((value) => value < 0n) || discountCents < 0n || discountCents > grossTotal) {
        throw new Error("Discount must not exceed the gross sale total");
    }
    if (grossTotal === 0n) return lineGrossCents.map(() => 0n);

    let allocated = 0n;
    return lineGrossCents.map((lineCents, index) => {
        const lineDiscount = index === lineGrossCents.length - 1
            ? discountCents - allocated
            : discountCents * lineCents / grossTotal;
        allocated += lineDiscount;
        return lineDiscount;
    });
};

export const allocateQuantityShare = (
    amount: bigint,
    totalQuantity: number,
    quantityBefore: number,
    quantityNow: number,
): bigint => {
    if (!Number.isSafeInteger(totalQuantity) || totalQuantity <= 0 ||
        !Number.isSafeInteger(quantityBefore) || quantityBefore < 0 ||
        !Number.isSafeInteger(quantityNow) || quantityNow < 0 ||
        quantityBefore + quantityNow > totalQuantity) {
        throw new Error("Return quantities exceed the original sale line");
    }
    const denominator = BigInt(totalQuantity);
    return amount * BigInt(quantityBefore + quantityNow) / denominator -
        amount * BigInt(quantityBefore) / denominator;
};

export const percentageToBasisPoints = (percentage: string | number): number => {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(percentage).trim());
    if (!match) throw new Error("Tax percentage must have at most two decimal places");
    const basisPoints = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0");
    if (basisPoints > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Tax percentage is too large");
    return Number(basisPoints);
};

export const calculateWeightedAverageReceipt = (
    oldQuantity: number,
    oldStockValueCents: bigint,
    receivedQuantity: number,
    unitCostCents: bigint,
) => {
    if (!Number.isSafeInteger(oldQuantity) ||
        !Number.isSafeInteger(receivedQuantity) || receivedQuantity <= 0 ||
        unitCostCents < 0n) {
        throw new Error("Stock balances must be integers and purchase cost must be non-negative");
    }
    const stockValueCents = oldStockValueCents + BigInt(receivedQuantity) * unitCostCents;
    return {
        quantity: oldQuantity + receivedQuantity,
        stockValueCents,
    };
};

export const calculateZeroQuantityValueAdjustment = (
    quantity: number,
    stockValueCents: bigint,
): bigint => {
    if (!Number.isSafeInteger(quantity)) throw new Error("Stock quantity must be a whole number");
    return quantity === 0 ? -stockValueCents : 0n;
};

export const allocateWeightedAverageCogs = (
    quantityOnHand: number,
    stockValueCents: bigint,
    quantitySold: number,
    allowNegativeStock = false,
    zeroStockUnitCostCents?: bigint,
) => {
    if (!Number.isSafeInteger(quantityOnHand) ||
        !Number.isSafeInteger(quantitySold) || quantitySold <= 0 ||
        (quantitySold > quantityOnHand || quantityOnHand <= 0) && !allowNegativeStock) {
        throw new Error("Sale quantity exceeds available valued stock");
    }
    if (quantityOnHand <= 0 || quantitySold > quantityOnHand) {
        let unitCostCents: bigint;
        if (quantityOnHand > 0) {
            if (stockValueCents < 0n) throw new Error("Positive stock cannot have a negative inventory value");
            const excessQuantity = quantitySold - quantityOnHand;
            unitCostCents = divideRoundHalfUp(stockValueCents, BigInt(quantityOnHand));
            const cogsCents = stockValueCents + BigInt(excessQuantity) * unitCostCents;
            return {
                cogsCents,
                remainingQuantity: quantityOnHand - quantitySold,
                remainingStockValueCents: -BigInt(excessQuantity) * unitCostCents,
            };
        }
        if (quantityOnHand < 0 && stockValueCents < 0n) {
            unitCostCents = divideRoundHalfUp(-stockValueCents, BigInt(-quantityOnHand));
        } else if (zeroStockUnitCostCents !== undefined && zeroStockUnitCostCents >= 0n) {
            unitCostCents = zeroStockUnitCostCents;
        } else {
            throw new Error("A valid cost basis is required to sell below zero stock");
        }
        const cogsCents = BigInt(quantitySold) * unitCostCents;
        return {
            cogsCents,
            remainingQuantity: quantityOnHand - quantitySold,
            remainingStockValueCents: stockValueCents - cogsCents,
        };
    }
    if (stockValueCents < 0n) throw new Error("Positive stock cannot have a negative inventory value");
    const cogsCents = divideRoundHalfUp(stockValueCents * BigInt(quantitySold), BigInt(quantityOnHand));
    return {
        cogsCents,
        remainingQuantity: quantityOnHand - quantitySold,
        remainingStockValueCents: stockValueCents - cogsCents,
    };
};

export const calculateReconciliation = (input: {
    openingStockValueCents: bigint;
    purchasesCents: bigint;
    cogsCents: bigint;
    writeOffsCents: bigint;
    adjustmentsCents: bigint;
    closingStockValueCents: bigint;
}) => {
    const expectedClosingStockValueCents = input.openingStockValueCents +
        input.purchasesCents - input.cogsCents - input.writeOffsCents + input.adjustmentsCents;
    return {
        expectedClosingStockValueCents,
        differenceCents: input.closingStockValueCents - expectedClosingStockValueCents,
        balanced: input.closingStockValueCents === expectedClosingStockValueCents,
    };
};
