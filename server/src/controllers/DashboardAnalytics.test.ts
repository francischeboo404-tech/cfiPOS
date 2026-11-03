import assert from "node:assert/strict";
import test from "node:test";
import { dashboardMoneyCents, sumKesAmountsToCents } from "./DashboardAnalytics";

test("dashboard sums decimal database values exactly beyond JavaScript safe integer range", () => {
    assert.equal(sumKesAmountsToCents(["90071992547409.91", "0.09"]), 9_007_199_254_741_000n);
});

test("dashboard top-product amount prefers exact sale-line cents snapshots", () => {
    assert.equal(dashboardMoneyCents("9007199254740993", "1.00"), 9_007_199_254_740_993n);
    assert.equal(dashboardMoneyCents(null, "116.00"), 11_600n);
});

test("dashboard rejects invalid or non-exact monetary database values", () => {
    assert.throws(() => sumKesAmountsToCents([116]), /Database money values must be returned as exact decimal strings/);
    assert.throws(() => dashboardMoneyCents("1.5", "1.00"), /Invalid integer-cent dashboard snapshot/);
});
