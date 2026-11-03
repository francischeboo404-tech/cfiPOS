export const hasFullOpeningCoverage = (startDate: string, baselineAt: Date): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(baselineAt.getTime())) {
        return false;
    }
    const start = new Date(`${startDate}T00:00:00.000Z`);
    return start.toISOString().slice(0, 10) === startDate && start >= baselineAt;
};

export const hasCompleteCostingSnapshots = (missing: {
    revenue: number;
    vat: number;
    cogs: number;
}): boolean => missing.revenue === 0 && missing.vat === 0 && missing.cogs === 0;

export const isVerifiedCostingBaseline = (valuationMethod: unknown): boolean =>
    valuationMethod === "weighted_average_opening_snapshot";

export const reconcilePeriodEndValue = (input: {
    openingValueCents: bigint;
    purchaseValueCents: bigint;
    cogsCents: bigint;
    writeOffsCents: bigint;
    adjustmentsCents: bigint;
    closingValueCents: bigint;
}) => {
    const expectedClosingValueCents = input.openingValueCents +
        input.purchaseValueCents - input.cogsCents - input.writeOffsCents +
        input.adjustmentsCents;
    return {
        expectedClosingValueCents,
        differenceCents: input.closingValueCents - expectedClosingValueCents,
        balanced: input.closingValueCents === expectedClosingValueCents,
    };
};
