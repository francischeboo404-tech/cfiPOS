import assert from "node:assert/strict";
import test from "node:test";
import {
    hasCompleteCostingSnapshots,
    hasFullOpeningCoverage,
    isVerifiedCostingBaseline,
    reconcilePeriodEndValue,
} from "./costingReportRules";

test("costing report completeness requires revenue, VAT, and COGS snapshots", () => {
    assert.equal(hasCompleteCostingSnapshots({ revenue: 0, vat: 0, cogs: 0 }), true);
    assert.equal(hasCompleteCostingSnapshots({ revenue: 1, vat: 0, cogs: 0 }), false);
    assert.equal(hasCompleteCostingSnapshots({ revenue: 0, vat: 1, cogs: 0 }), false);
    assert.equal(hasCompleteCostingSnapshots({ revenue: 0, vat: 0, cogs: 1 }), false);
});

test("reconciliation requires a baseline at or before the period's exact opening instant", () => {
    const baseline = new Date("2026-10-17T10:00:00.000Z");
    assert.equal(hasFullOpeningCoverage("2026-10-17", baseline), false);
    assert.equal(hasFullOpeningCoverage("2026-10-18", baseline), true);
    assert.equal(hasFullOpeningCoverage("not-a-date", baseline), false);
});

test("only a physically established weighted-average snapshot is eligible for reconciliation", () => {
    assert.equal(isVerifiedCostingBaseline("weighted_average_opening_snapshot"), true);
    assert.equal(isVerifiedCostingBaseline("legacy_product_unit_cost_snapshot"), false);
    assert.equal(isVerifiedCostingBaseline(null), false);
});

test("period-close reconciliation follows the signed inventory identity exactly", () => {
    const balanced = reconcilePeriodEndValue({
        openingValueCents: 500_000n,
        purchaseValueCents: 250_000n,
        cogsCents: 120_000n,
        writeOffsCents: 10_000n,
        adjustmentsCents: -5_000n,
        closingValueCents: 615_000n,
    });
    assert.deepEqual(balanced, {
        expectedClosingValueCents: 615_000n,
        differenceCents: 0n,
        balanced: true,
    });
    assert.equal(reconcilePeriodEndValue({
        openingValueCents: 500_000n,
        purchaseValueCents: 250_000n,
        cogsCents: 120_000n,
        writeOffsCents: 10_000n,
        adjustmentsCents: -5_000n,
        closingValueCents: 614_999n,
    }).balanced, false);
});
