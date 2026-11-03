import test from "node:test";
import assert from "node:assert/strict";
import {
    calculateNetProductProfitability,
    calculateProfitability,
    canViewFinancialReports,
    hourMatchesFilter,
    mergeSalesAndRefundBuckets,
    parseReportDateFilter,
    summarizeHourlyDemand,
} from "./ReportAnalytics";
import { parseKesDecimalToCents } from "../lib/exactMoney";

test("report filters validate dates, hour bounds, and time zones", () => {
    const dayFilter = parseReportDateFilter({
        start: "2026-01-01",
        end: "2026-01-02",
    });
    assert.equal(dayFilter.hourStart, undefined);
    assert.equal(dayFilter.hourEnd, undefined);

    const filter = parseReportDateFilter({
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-02T00:00:00.000Z",
        hourStart: "08",
        hourEnd: "18",
        timeZone: "Africa/Nairobi",
    });

    assert.equal(filter.hourStart, 8);
    assert.equal(filter.hourEnd, 18);
    assert.throws(() => parseReportDateFilter({ start: "bad", end: "2026-01-02" }));
    assert.throws(() => parseReportDateFilter({
        start: "2026-01-01",
        end: "2026-01-02",
        hourStart: "08",
    }));
    assert.throws(() => parseReportDateFilter({
        start: "2026-01-01",
        end: "2026-01-02",
        hourStart: "08",
        hourEnd: "08",
    }));
    assert.throws(() => parseReportDateFilter({
        start: "2026-01-01",
        end: "2026-01-02",
        timeZone: "../../etc",
    }));
});

test("hour filtering supports normal and overnight ranges", () => {
    assert.equal(hourMatchesFilter(9, 8, 18), true);
    assert.equal(hourMatchesFilter(18, 8, 18), false);
    assert.equal(hourMatchesFilter(23, 22, 6), true);
    assert.equal(hourMatchesFilter(4, 22, 6), true);
    assert.equal(hourMatchesFilter(12, 22, 6), false);
});

test("profitability never substitutes unavailable costs with zero", () => {
    assert.deepEqual(calculateProfitability({
        netRevenueCents: 100_000n,
        cogsCents: 40_000n,
        cogsComplete: false,
        operatingExpensesCents: 10_000n,
        inventoryLossesCents: 0n,
        transactionCostsCents: 0n,
    }), {
        netRevenueCents: "100000",
        costOfGoodsSoldCents: null,
        grossProfitCents: null,
        operatingExpensesCents: "10000",
        inventoryLossesCents: "0",
        transactionCostsCents: "0",
        netProfitCents: null,
        lossesCents: null,
        costDataComplete: false,
    });

    const complete = calculateProfitability({
        netRevenueCents: 100_000n,
        cogsCents: 40_000n,
        cogsComplete: true,
        operatingExpensesCents: 10_000n,
        inventoryLossesCents: 2_500n,
        transactionCostsCents: null,
    });
    assert.equal(complete.grossProfitCents, "60000");
    assert.equal(complete.netProfitCents, null);
    assert.equal(complete.inventoryLossesCents, "2500");

    const loss = calculateProfitability({
        netRevenueCents: 30_000n,
        cogsCents: 40_000n,
        cogsComplete: true,
        operatingExpensesCents: 1_000n,
        inventoryLossesCents: 0n,
        transactionCostsCents: 0n,
    });
    assert.equal(loss.netProfitCents, "-11000");
    assert.equal(loss.lossesCents, "11000");
});

test("financial report amount conversion accepts exact KES decimals only", () => {
    assert.equal(parseKesDecimalToCents("116.00"), 11_600n);
    assert.equal(parseKesDecimalToCents("-0.01"), -1n);
    assert.equal(parseKesDecimalToCents("90071992547409.91"), 9_007_199_254_740_991n);
    assert.throws(() => parseKesDecimalToCents(0.1));
    assert.throws(() => parseKesDecimalToCents("1.001"));
    assert.throws(() => parseKesDecimalToCents("1e2"));
});

test("hourly demand recommendations require repeated samples and normalize per active day", () => {
    const hours = [
        { hour: 9, salesCents: "100000", transactions: 10, activeDays: 1 },
        { hour: 10, salesCents: "240000", transactions: 12, activeDays: 3 },
        { hour: 11, salesCents: "90000", transactions: 6, activeDays: 3 },
    ];
    const result = summarizeHourlyDemand(hours);
    assert.equal(result.peak?.hour, 10);
    assert.equal(result.slow?.hour, 11);
    assert.equal(summarizeHourlyDemand(hours.slice(0, 1)).peak, undefined);
});

test("financial and cashier report details are manager/admin only", () => {
    assert.equal(canViewFinancialReports("cashier"), false);
    assert.equal(canViewFinancialReports("supervisor"), false);
    assert.equal(canViewFinancialReports("manager"), true);
    assert.equal(canViewFinancialReports("admin"), true);
});

test("net product ranking inputs include discounts and approved returns", () => {
    assert.deepEqual(calculateNetProductProfitability(
        { quantity: 10, revenueCents: 90_000n, cogsCents: 50_000n, missingCosts: 0, missingRevenue: 0 },
        { quantity: 3, revenueCents: 27_000n, cogsCents: 15_000n, missingCosts: 0, missingRevenue: 0 },
    ), {
        quantity: 7,
        revenueCents: "63000",
        costOfGoodsSoldCents: "35000",
        grossProfitCents: "28000",
    });
    assert.equal(calculateNetProductProfitability(
        { quantity: 1, revenueCents: 10_000n, cogsCents: 0n, missingCosts: 1, missingRevenue: 1 },
        { quantity: 0, revenueCents: 0n, cogsCents: 0n, missingCosts: 0, missingRevenue: 0 },
    ).grossProfitCents, null);
});

test("sales buckets subtract exact-cent refunds by refund timestamp and retain refund-only buckets", () => {
    assert.deepEqual(mergeSalesAndRefundBuckets(
        [{ key: "2026-01-01", sales: "1000", transactions: "2", activeDays: "1" }],
        [
            { key: "2026-01-01", refunds: "1.25", refundTransactions: "1" },
            { key: "2026-01-02", refunds: "0.50", refundTransactions: "1" },
        ],
    ), [
        { key: "2026-01-01", salesCents: "99875", transactions: 2, activeDays: 1, refundsCents: "125", refundTransactions: 1 },
        { key: "2026-01-02", salesCents: "-50", transactions: 0, activeDays: 0, refundsCents: "50", refundTransactions: 1 },
    ]);
});
