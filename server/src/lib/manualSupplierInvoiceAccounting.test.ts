import assert from "node:assert/strict";
import test from "node:test";
import { AccountType } from "../entity/Account";
import {
    isEligibleManualInvoiceDebitAccount,
    normalizeInvoiceAccountingDate,
    validateManualInvoiceAmounts,
} from "./manualSupplierInvoiceAccounting";

test("manual invoice debit accounts exclude cash, control accounts, and inactive accounts", () => {
    const base = { id: "account-id", is_active: true, type: AccountType.ASSET };
    assert.equal(isEligibleManualInvoiceDebitAccount({ ...base, code: "1000" }, "subtotal"), false);
    assert.equal(isEligibleManualInvoiceDebitAccount({ ...base, code: "1200" }, "tax"), false);
    assert.equal(isEligibleManualInvoiceDebitAccount({ ...base, code: "1300" }, "subtotal"), true);
    assert.equal(isEligibleManualInvoiceDebitAccount({ ...base, code: "1300", is_active: false }, "subtotal"), false);
    assert.equal(
        isEligibleManualInvoiceDebitAccount({ ...base, code: "2000", type: AccountType.LIABILITY }, "subtotal"),
        false,
    );
});

test("recoverable input VAT is eligible only for tax allocation", () => {
    const inputVat = { id: "vat", code: "1400", type: AccountType.ASSET, is_active: true };
    assert.equal(isEligibleManualInvoiceDebitAccount(inputVat, "subtotal"), false);
    assert.equal(isEligibleManualInvoiceDebitAccount(inputVat, "tax"), true);
});

test("manual invoice recognition requires exact, non-negative amounts", () => {
    assert.doesNotThrow(() => validateManualInvoiceAmounts(10000n, 1600n, 11600n));
    assert.throws(() => validateManualInvoiceAmounts(10000n, 1600n, 11601n), /exactly/);
    assert.throws(() => validateManualInvoiceAmounts(-1n, 1601n, 1600n), /non-negative/);
});

test("invoice accounting dates accept database date strings without timezone conversion", () => {
    assert.equal(normalizeInvoiceAccountingDate("2026-10-06"), "2026-10-06");
    assert.equal(
        normalizeInvoiceAccountingDate(new Date("2026-10-06T00:00:00.000Z")),
        "2026-10-06",
    );
    assert.throws(() => normalizeInvoiceAccountingDate("2026-02-30"), /invalid/);
});
