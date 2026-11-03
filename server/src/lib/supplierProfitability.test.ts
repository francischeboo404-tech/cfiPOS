import assert from "node:assert/strict";
import test from "node:test";
import { buildSupplierProfitability } from "./supplierProfitability";
import { SupplierAttributionEntry } from "./supplierFifoAttribution";

const entry = (overrides: Partial<SupplierAttributionEntry>): SupplierAttributionEntry => ({
    at: "2026-10-18T10:00:00.000Z",
    saleId: "sale-1",
    referenceId: null,
    productId: "product-1",
    warehouseId: "warehouse-1",
    supplierId: "supplier-1",
    quantity: 1,
    netRevenueCents: 10_000n,
    fifoCostCents: 4_000n,
    ...overrides,
});

test("supplier profitability aggregates FIFO sale and return snapshots exactly", () => {
    const result = buildSupplierProfitability({
        entries: [
            entry({ quantity: 2, netRevenueCents: 20_000n, fifoCostCents: 8_000n }),
            entry({ at: "2026-10-19T10:00:00.000Z", quantity: -1, netRevenueCents: -10_000n, fifoCostCents: -4_000n }),
        ],
        products: new Map([["product-1", {
            id: "product-1",
            name: "Milk",
            sku: "MILK",
            categoryId: "category-1",
            category: "Dairy",
        }]]),
        suppliers: new Map([["supplier-1", "Supplier One"]]),
        startDate: "2026-10-18",
        endDate: "2026-10-19",
        timeZone: "Africa/Nairobi",
    });
    assert.equal(result.by_supplier.length, 1);
    assert.equal(result.by_supplier[0].quantity_sold, "1");
    assert.equal(result.by_supplier[0].net_revenue_cents, "10000");
    assert.equal(result.by_supplier[0].fifo_cost_cents, "4000");
    assert.equal(result.by_supplier[0].gross_profit_cents, "6000");
    assert.equal(result.by_day.length, 2);
    assert.equal(result.overall[0].margin_basis_points, "6000");
});

test("unknown supplier preserves known amounts while missing snapshots remain unavailable", () => {
    const result = buildSupplierProfitability({
        entries: [
            entry({ supplierId: null }),
            entry({ saleId: "sale-2", supplierId: "supplier-1", netRevenueCents: null }),
        ],
        products: new Map(),
        suppliers: new Map([["supplier-1", "Supplier One"]]),
        startDate: "2026-10-18",
        endDate: "2026-10-18",
        timeZone: "UTC",
    });
    const unattributed = result.by_supplier.find((row) => row.supplier === "Unattributed / unknown supplier");
    assert.ok(unattributed);
    assert.equal(unattributed.data_complete, true);
    assert.equal(unattributed.supplier_attribution_complete, false);
    assert.equal(unattributed.net_revenue_cents, "10000");
    assert.equal(unattributed.fifo_cost_cents, "4000");
    assert.equal(unattributed.gross_profit_cents, "6000");

    const missingSnapshots = result.by_supplier.find((row) => row.supplier === "Supplier One");
    assert.ok(missingSnapshots);
    assert.equal(missingSnapshots.data_complete, false);
    assert.equal(missingSnapshots.supplier_attribution_complete, true);
    assert.equal(missingSnapshots.net_revenue_cents, null);
    assert.equal(missingSnapshots.fifo_cost_cents, "4000");
    assert.equal(result.overall[0].data_complete, false);
    assert.equal(result.overall[0].supplier_attribution_complete, false);
});

test("warehouse filters are applied to supplier sale results after replay", () => {
    const result = buildSupplierProfitability({
        entries: [
            entry({
                warehouseId: "source",
                at: "2026-10-18T09:00:00.000Z",
                quantity: 3,
                netRevenueCents: 30_000n,
                fifoCostCents: 12_000n,
            }),
            entry({
                warehouseId: "destination",
                at: "2026-10-18T10:00:00.000Z",
                quantity: 2,
                netRevenueCents: 20_000n,
                fifoCostCents: 8_000n,
            }),
        ],
        products: new Map(),
        suppliers: new Map([["supplier-1", "Supplier One"]]),
        startDate: "2026-10-18",
        endDate: "2026-10-18",
        timeZone: "UTC",
        warehouseId: "destination",
    });
    assert.equal(result.by_supplier[0].quantity_sold, "2");
    assert.equal(result.by_supplier[0].gross_profit_cents, "12000");
});
