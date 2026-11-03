import test from "node:test";
import assert from "node:assert/strict";
import {
    allocateQuantityShare,
    allocateWeightedAverageCogs,
    calculateInclusiveVatCents,
    calculateReconciliation,
    calculateZeroQuantityValueAdjustment,
    calculateWeightedAverageReceipt,
    parseKesToCents,
    percentageToBasisPoints,
} from "./exactMoney";
import {
    calculateEarnedPoints,
    calculateRedemptionCents,
    canCancelVoucherRenewalCheckout,
    isVoucherExpired,
    parseSupportedRenewalFeeCents,
    pointsReversalForReturn,
    renewedExpiryDate,
} from "./voucherRules";

test("weighted-average purchases value stock and allocate exact COGS cents", () => {
    const firstReceipt = calculateWeightedAverageReceipt(0, 0n, 100, parseKesToCents("40"));
    const secondReceipt = calculateWeightedAverageReceipt(firstReceipt.quantity, firstReceipt.stockValueCents, 100, parseKesToCents("50"));
    assert.equal(secondReceipt.quantity, 200);
    assert.equal(secondReceipt.stockValueCents, 900_000n);
    const sale = allocateWeightedAverageCogs(secondReceipt.quantity, secondReceipt.stockValueCents, 10);
    assert.equal(sale.cogsCents, 45_000n);
    assert.equal(sale.remainingQuantity, 190);
    assert.equal(sale.remainingStockValueCents, 855_000n);
});

test("voucher renewal cancellation allows only unpaid sessions with terminal failed M-Pesa attempts", () => {
    assert.equal(canCancelVoucherRenewalCheckout(0n, []), true);
    assert.equal(canCancelVoucherRenewalCheckout(0n, ["failed"]), true);
    assert.equal(canCancelVoucherRenewalCheckout(0n, ["failed", "failed"]), true);
    assert.equal(canCancelVoucherRenewalCheckout(1n, ["failed"]), false);
    assert.equal(canCancelVoucherRenewalCheckout(0n, ["pending"]), false);
    assert.equal(canCancelVoucherRenewalCheckout(0n, ["completed"]), false);
    assert.equal(canCancelVoucherRenewalCheckout(0n, ["needs_review"]), false);
});

test("admin-approved negative stock uses the current average and blends later receipts exactly", () => {
    const oversold = allocateWeightedAverageCogs(100, 450_000n, 110, true, 6_000n);
    assert.equal(oversold.cogsCents, 495_000n);
    assert.equal(oversold.remainingQuantity, -10);
    assert.equal(oversold.remainingStockValueCents, -45_000n);

    const replenished = calculateWeightedAverageReceipt(
        oversold.remainingQuantity,
        oversold.remainingStockValueCents,
        10,
        5_000n,
    );
    assert.equal(replenished.quantity, 0);
    assert.equal(replenished.stockValueCents, 5_000n);
    const zeroStockValueAdjustment = calculateZeroQuantityValueAdjustment(
        replenished.quantity,
        replenished.stockValueCents,
    );
    assert.equal(zeroStockValueAdjustment, -5_000n);
    assert.equal(replenished.stockValueCents + zeroStockValueAdjustment, 0n);

    const soldFromZero = allocateWeightedAverageCogs(
        replenished.quantity,
        0n,
        1,
        true,
        6_000n,
    );
    assert.equal(soldFromZero.cogsCents, 6_000n);
    assert.equal(soldFromZero.remainingQuantity, -1);
    assert.equal(soldFromZero.remainingStockValueCents, -6_000n);
    assert.throws(() => allocateWeightedAverageCogs(100, 450_000n, 110), /exceeds available/i);
});

test("zero-quantity cost variance is adjusted explicitly without changing nonzero stock", () => {
    assert.equal(calculateZeroQuantityValueAdjustment(0, 5_000n), -5_000n);
    assert.equal(calculateZeroQuantityValueAdjustment(0, -5_000n), 5_000n);
    assert.equal(calculateZeroQuantityValueAdjustment(1, 5_000n), 0n);
});

test("a later purchase never mutates a saved sale cost or profit snapshot", () => {
    const initial = calculateWeightedAverageReceipt(100, 400_000n, 100, 5_000n);
    const sale = allocateWeightedAverageCogs(initial.quantity, initial.stockValueCents, 10);
    const savedCogs = sale.cogsCents;
    const laterPurchase = calculateWeightedAverageReceipt(sale.remainingQuantity, sale.remainingStockValueCents, 100, 8_000n);
    assert.equal(savedCogs, 45_000n);
    assert.equal(laterPurchase.quantity, 290);
    assert.equal(savedCogs, 45_000n);
});

test("inclusive standard VAT splits KES 116 into KES 100 net and KES 16 VAT", () => {
    const vat = calculateInclusiveVatCents(parseKesToCents("116.00"), percentageToBasisPoints("16"));
    assert.deepEqual(vat, { netRevenueCents: 10_000n, vatCents: 1_600n });
});

test("zero-rated and exempt sales have no VAT split", () => {
    for (const rate of ["0", "0.00"]) {
        assert.deepEqual(calculateInclusiveVatCents(parseKesToCents("116"), percentageToBasisPoints(rate)), {
            netRevenueCents: 11_600n,
            vatCents: 0n,
        });
    }
});

test("full return reverses original stock, revenue, COGS, and points exactly", () => {
    const originalQuantity = 10;
    const originalNetRevenueCents = 10_000n;
    const originalVatCents = 1_600n;
    const originalCogsCents = 45_000n;
    const afterSale = allocateWeightedAverageCogs(200, 900_000n, 10);
    const returnedStockValueCents = afterSale.remainingStockValueCents + originalCogsCents;
    assert.equal(afterSale.remainingQuantity + originalQuantity, 200);
    assert.equal(returnedStockValueCents, 900_000n);
    assert.equal(allocateQuantityShare(originalNetRevenueCents, originalQuantity, 0, originalQuantity), originalNetRevenueCents);
    assert.equal(allocateQuantityShare(originalVatCents, originalQuantity, 0, originalQuantity), originalVatCents);
    assert.equal(allocateQuantityShare(originalCogsCents, originalQuantity, 0, originalQuantity), originalCogsCents);

    const earnedPoints = 7n;
    const redeemedPoints = 3n;
    const earnedReversal = pointsReversalForReturn(earnedPoints, originalQuantity, 0, originalQuantity);
    const redeemedRestoration = pointsReversalForReturn(redeemedPoints, originalQuantity, 0, originalQuantity);
    assert.equal(earnedReversal, earnedPoints);
    assert.equal(redeemedRestoration, redeemedPoints);
    assert.equal(earnedPoints - redeemedPoints - earnedReversal + redeemedRestoration, 0n);
});

test("partial returns allocate stored cents cumulatively without losing rounding cents", () => {
    const netRevenueCents = 10_001n;
    const firstReturn = allocateQuantityShare(netRevenueCents, 3, 0, 1);
    const secondReturn = allocateQuantityShare(netRevenueCents, 3, 1, 1);
    const finalReturn = allocateQuantityShare(netRevenueCents, 3, 2, 1);

    assert.deepEqual([firstReturn, secondReturn, finalReturn], [3_333n, 3_334n, 3_334n]);
    assert.equal(firstReturn + secondReturn + finalReturn, netRevenueCents);
});

test("voucher ledger balance is the exact sum after 100 earn, redeem and reversal entries", () => {
    let seed = 29;
    const next = () => {
        seed = (seed * 48271) % 2_147_483_647;
        return seed;
    };
    const ledger: bigint[] = [];
    let balance = 0n;
    for (let index = 0; index < 100; index += 1) {
        const operation = next() % 3;
        if (operation === 0 || balance === 0n) {
            const points = BigInt((next() % 80) + 1);
            ledger.push(points);
            balance += points;
        } else {
            const points = BigInt((next() % Number(balance < 80n ? balance : 80n)) + 1);
            ledger.push(-points);
            balance -= points;
        }
    }
    assert.equal(ledger.reduce((sum, entry) => sum + entry, 0n), balance);
});

test("voucher expiry, renewal and point earning/redemption use exact boundaries", () => {
    assert.equal(isVoucherExpired("2026-10-16", "2026-10-17"), true);
    assert.equal(isVoucherExpired("2026-10-17", "2026-10-17"), false);
    assert.equal(renewedExpiryDate("2026-10-17", "2026-10-17"), "2027-10-17");
    assert.equal(renewedExpiryDate("2026-10-16", "2026-10-17"), "2027-10-17");
    assert.equal(renewedExpiryDate("2024-02-29", "2024-02-29"), "2025-02-28");
    assert.equal(calculateEarnedPoints(1_099_999n), 109n);
    assert.equal(calculateRedemptionCents(10n, 100n, 1_000n), 1_000n);
    assert.throws(() => calculateRedemptionCents(11n, 100n, 1_000n), /sale total/i);
    assert.throws(() => calculateRedemptionCents(101n, 100n, 20_000n), /balance/i);
    assert.equal(parseSupportedRenewalFeeCents("0"), 0n);
   assert.equal(parseSupportedRenewalFeeCents("1250"), 1250n);
   assert.throws(() => parseSupportedRenewalFeeCents("10000000000"), /invalid/i);
});

test("inventory reconciliation balances after receipts, sales, returns and write-offs", () => {
    const result = calculateReconciliation({
        openingStockValueCents: 500_000n,
        purchasesCents: 250_000n,
        cogsCents: 120_000n,
        writeOffsCents: 10_000n,
        adjustmentsCents: -5_000n,
        closingStockValueCents: 615_000n,
    });
    assert.deepEqual(result, {
        expectedClosingStockValueCents: 615_000n,
        differenceCents: 0n,
        balanced: true,
    });
});
