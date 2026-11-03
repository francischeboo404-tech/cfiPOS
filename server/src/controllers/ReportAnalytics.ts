import { parseKesDecimalToCents } from "../lib/exactMoney";

export interface ReportDateFilter {
    start: Date;
    end: Date;
    hourStart?: number;
    hourEnd?: number;
    timeZone: string;
}

const MAX_REPORT_RANGE_MS = 5 * 366 * 24 * 60 * 60 * 1000;

const parseHour = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^(?:[01]\d|2[0-3])$/.test(value)) {
        throw new Error("Report hours must be between 00 and 23");
    }
    return Number(value);
};

export const parseReportDateFilter = (query: Record<string, unknown>): ReportDateFilter => {
    if (typeof query.start !== "string" || typeof query.end !== "string") {
        throw new Error("Valid report date range is required");
    }
    const start = new Date(query.start);
    const end = new Date(query.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
        throw new Error("Valid report date range is required");
    }
    if (end.getTime() - start.getTime() > MAX_REPORT_RANGE_MS) {
        throw new Error("Report date range cannot exceed five years");
    }

    const hourStart = parseHour(query.hourStart);
    const hourEnd = parseHour(query.hourEnd);
    if ((hourStart === undefined) !== (hourEnd === undefined) ||
        (hourStart !== undefined && hourStart === hourEnd)) {
        throw new Error("Both start and end hours are required and must differ");
    }

    const timeZone = typeof query.timeZone === "string" && query.timeZone.length <= 64
        ? query.timeZone
        : "UTC";
    try {
        new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
    } catch {
        throw new Error("Invalid report time zone");
    }

    return { start, end, hourStart, hourEnd, timeZone };
};

export const calculateProfitability = (input: {
    netRevenueCents: bigint;
    cogsCents: bigint;
    cogsComplete: boolean;
    operatingExpensesCents: bigint;
    inventoryLossesCents: bigint;
    transactionCostsCents: bigint | null;
}) => {
    const grossProfitCents = input.cogsComplete ? input.netRevenueCents - input.cogsCents : null;
    const netProfitCents = grossProfitCents !== null && input.transactionCostsCents !== null
        ? grossProfitCents - input.operatingExpensesCents - input.inventoryLossesCents - input.transactionCostsCents
        : null;

    return {
        netRevenueCents: input.netRevenueCents.toString(),
        costOfGoodsSoldCents: input.cogsComplete ? input.cogsCents.toString() : null,
        grossProfitCents: grossProfitCents?.toString() ?? null,
        operatingExpensesCents: input.operatingExpensesCents.toString(),
        inventoryLossesCents: input.inventoryLossesCents.toString(),
        transactionCostsCents: input.transactionCostsCents?.toString() ?? null,
        netProfitCents: netProfitCents?.toString() ?? null,
        lossesCents: netProfitCents === null ? null : (netProfitCents < 0n ? -netProfitCents : 0n).toString(),
        costDataComplete: input.cogsComplete,
    };
};

export interface ProductProfitabilityInput {
    quantity: number;
    revenueCents: bigint;
    cogsCents: bigint;
    missingCosts: number;
    missingRevenue: number;
}

export const calculateNetProductProfitability = (
    sold: ProductProfitabilityInput,
    returned: ProductProfitabilityInput,
) => {
    const revenueCents = sold.revenueCents - returned.revenueCents;
    const cogsCents = sold.cogsCents - returned.cogsCents;
    const costComplete = sold.missingCosts + returned.missingCosts === 0;
    const revenueComplete = sold.missingRevenue + returned.missingRevenue === 0;
    return {
        quantity: sold.quantity - returned.quantity,
        revenueCents: revenueComplete ? revenueCents.toString() : null,
        costOfGoodsSoldCents: costComplete ? cogsCents.toString() : null,
        grossProfitCents: costComplete && revenueComplete ? (revenueCents - cogsCents).toString() : null,
    };
};

export interface SalesActivityBucket {
    key: string;
    salesCents: string;
    transactions: number;
    activeDays: number;
    refundsCents: string;
    refundTransactions: number;
}

export const mergeSalesAndRefundBuckets = (
    salesRows: Array<{ key: string; sales: unknown; transactions: unknown; activeDays: unknown }>,
    refundRows: Array<{ key: string; refunds: unknown; refundTransactions: unknown }>,
): SalesActivityBucket[] => {
    const refundsByKey = new Map(refundRows.map((row) => [
        row.key,
        { refundsCents: parseKesDecimalToCents(row.refunds ?? "0"), refundTransactions: Number(row.refundTransactions) || 0 },
    ]));
    const buckets = new Map<string, SalesActivityBucket>();
    for (const row of salesRows) {
        const refund = refundsByKey.get(row.key);
        const refundsCents = refund?.refundsCents ?? 0n;
        buckets.set(row.key, {
            key: row.key,
            salesCents: (parseKesDecimalToCents(row.sales ?? "0") - refundsCents).toString(),
            transactions: Number(row.transactions) || 0,
            activeDays: Number(row.activeDays) || 0,
            refundsCents: refundsCents.toString(),
            refundTransactions: refund?.refundTransactions || 0,
        });
        refundsByKey.delete(row.key);
    }
    for (const [key, refund] of refundsByKey) {
        buckets.set(key, {
            key,
            salesCents: (-refund.refundsCents).toString(),
            transactions: 0,
            activeDays: 0,
            refundsCents: refund.refundsCents.toString(),
            refundTransactions: refund.refundTransactions,
        });
    }
    return Array.from(buckets.values()).sort((a, b) => a.key.localeCompare(b.key));
};

export const summarizeHourlyDemand = <T extends {
    hour: number;
    salesCents: string;
    transactions: number;
    activeDays: number;
}>(hours: T[], minimumSamples = 3) => {
    const sufficientlyObserved = hours.filter((hour) => hour.activeDays >= minimumSamples);
    const peak = sufficientlyObserved.reduce<T | undefined>((best, current) =>
        !best || BigInt(current.salesCents) * BigInt(best.activeDays) >
            BigInt(best.salesCents) * BigInt(current.activeDays) ? current : best,
    undefined);
    const slow = sufficientlyObserved
        .filter((hour) => hour.transactions > 0)
        .reduce<T | undefined>((best, current) =>
            !best || BigInt(current.salesCents) * BigInt(best.activeDays) <
                BigInt(best.salesCents) * BigInt(current.activeDays) ? current : best,
        undefined);
    return { peak, slow, minimumSamples };
};

export const hourMatchesFilter = (hour: number, start?: number, end?: number): boolean => {
    if (start === undefined || end === undefined) return true;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
};

export const canViewFinancialReports = (role?: string): boolean => role === "manager" || role === "admin";
