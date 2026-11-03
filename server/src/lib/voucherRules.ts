export const calculateEarnedPoints = (amountPaidCents: bigint, pointsPerKes100 = 1n): bigint => {
    if (amountPaidCents < 0n || pointsPerKes100 < 0n) throw new Error("Paid amount and points rate must be non-negative");
    return amountPaidCents / 10_000n * pointsPerKes100;
};

export const calculateRedemptionCents = (requestedPoints: bigint, balance: bigint, saleTotalCents: bigint): bigint => {
    if (requestedPoints < 0n || balance < 0n || saleTotalCents < 0n) {
        throw new Error("Points and sale total must be non-negative");
    }
    if (requestedPoints > balance) throw new Error("Redemption exceeds the available voucher balance");
    if (requestedPoints * 100n > saleTotalCents) throw new Error("Redemption exceeds the sale total");
    return requestedPoints * 100n;
};

export const pointsReversalForReturn = (
    pointsEarned: bigint,
    soldQuantity: number,
    previouslyReturnedQuantity: number,
    currentReturnedQuantity: number,
): bigint => {
    if (pointsEarned < 0n || !Number.isSafeInteger(soldQuantity) || soldQuantity <= 0 ||
        !Number.isSafeInteger(previouslyReturnedQuantity) || previouslyReturnedQuantity < 0 ||
        !Number.isSafeInteger(currentReturnedQuantity) || currentReturnedQuantity < 0 ||
        previouslyReturnedQuantity + currentReturnedQuantity > soldQuantity) {
        throw new Error("Returned quantities must be valid and cannot exceed the original sale");
    }
    const cumulativeBefore = pointsEarned * BigInt(previouslyReturnedQuantity) / BigInt(soldQuantity);
    const cumulativeAfter = pointsEarned * BigInt(previouslyReturnedQuantity + currentReturnedQuantity) / BigInt(soldQuantity);
    return cumulativeAfter - cumulativeBefore;
};

export const addCalendarYear = (date: string): string => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error("Date must be YYYY-MM-DD");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const source = new Date(Date.UTC(year, month - 1, day));
    if (source.getUTCFullYear() !== year || source.getUTCMonth() !== month - 1 || source.getUTCDate() !== day) {
        throw new Error("Date must be a valid calendar date");
    }
    const targetYear = year + 1;
    const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
    return `${targetYear}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
};

export const renewedExpiryDate = (currentExpiry: string, renewalDate: string): string =>
    currentExpiry >= renewalDate ? addCalendarYear(currentExpiry) : addCalendarYear(renewalDate);

export const parseSupportedRenewalFeeCents = (value: string | undefined): bigint => {
    if (value === undefined || !/^\d{1,10}$/.test(value)) {
        throw new Error("Voucher renewal fee setting is invalid");
    }
    return BigInt(value);
};

export const canCancelVoucherRenewalCheckout = (
    cashPaidCents: bigint,
    mpesaStatuses: readonly string[],
): boolean => cashPaidCents === 0n && mpesaStatuses.every((status) => status === "failed");

export const isVoucherExpired = (expiryDate: string, today: string): boolean => expiryDate < today;
