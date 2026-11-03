import assert from "node:assert/strict";
import test from "node:test";
import {
    calculateExpectedSupplierInvoiceTaxCents,
    validateSupplierInvoiceTax,
} from "./supplierInvoiceTax";

test("supplier invoice tax is calculated per received line using tax class rates", () => {
    const expected = calculateExpectedSupplierInvoiceTaxCents([
        { line_total: "10.00", product: { tax_class: { rate: "16.00" }, tax_rate: "0.00" } },
        { line_total: "5.00", product: { tax_class: null, tax_rate: "0.00" } },
    ]);
    assert.equal(expected, 160n);
    assert.doesNotThrow(() => validateSupplierInvoiceTax(expected, 160n));
    assert.throws(() => validateSupplierInvoiceTax(161n, expected), /tax classes/);
});

test("supplier invoice tax rounds each received line to the nearest cent", () => {
    const expected = calculateExpectedSupplierInvoiceTaxCents([
        { line_total: "0.04", product: { tax_rate: "16.00" } },
        { line_total: "0.04", product: { tax_rate: "16.00" } },
    ]);
    assert.equal(expected, 2n);
});
