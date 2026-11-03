import assert from "node:assert/strict";
import test from "node:test";
import { allocateSupplierFifoAttribution, SupplierFifoEvent } from "./supplierFifoAttribution";

const event = (overrides: Partial<SupplierFifoEvent>): SupplierFifoEvent => ({
    id: "event",
    type: "receipt",
    productId: "product",
    warehouseId: "warehouse",
    quantity: 1,
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
});

test("FIFO report attribution follows supplier lots and leaves WAC outside the calculation", () => {
    const entries = allocateSupplierFifoAttribution([
        event({ id: "r1", type: "receipt", quantity: 100, supplierId: "supplier-a", unitCostCents: 4_000n }),
        event({ id: "r2", type: "receipt", quantity: 100, at: "2026-01-02T00:00:00.000Z", supplierId: "supplier-b", unitCostCents: 5_000n }),
        event({ id: "s1", type: "sale", quantity: 10, at: "2026-01-03T00:00:00.000Z", saleId: "sale-1", netRevenueCents: 10_000n }),
    ]);
    assert.deepEqual(entries.map(({ supplierId, quantity, netRevenueCents, fifoCostCents }) => ({
        supplierId,
        quantity,
        netRevenueCents,
        fifoCostCents,
    })), [{
        supplierId: "supplier-a",
        quantity: 10,
        netRevenueCents: 10_000n,
        fifoCostCents: 40_000n,
    }]);
});

test("partial and full returns reverse exact original FIFO supplier allocation and restore lots", () => {
    const entries = allocateSupplierFifoAttribution([
        event({ id: "r1", type: "receipt", quantity: 2, supplierId: "supplier-a", unitCostCents: 4_000n }),
        event({ id: "r2", type: "receipt", quantity: 2, at: "2026-01-02T00:00:00.000Z", supplierId: "supplier-b", unitCostCents: 5_000n }),
        event({ id: "s1", type: "sale", quantity: 4, at: "2026-01-03T00:00:00.000Z", saleId: "sale-1", netRevenueCents: 10_001n }),
        event({ id: "ret1", type: "return", quantity: 1, at: "2026-01-04T00:00:00.000Z", saleId: "sale-1" }),
        event({ id: "ret2", type: "return", quantity: 3, at: "2026-01-05T00:00:00.000Z", saleId: "sale-1" }),
    ]);
    const originalRevenue = entries.filter((row) => row.quantity > 0).reduce((sum, row) => sum + (row.netRevenueCents ?? 0n), 0n);
    const reversedRevenue = entries.filter((row) => row.quantity < 0).reduce((sum, row) => sum + (row.netRevenueCents ?? 0n), 0n);
    const originalCost = entries.filter((row) => row.quantity > 0).reduce((sum, row) => sum + (row.fifoCostCents || 0n), 0n);
    const reversedCost = entries.filter((row) => row.quantity < 0).reduce((sum, row) => sum + (row.fifoCostCents || 0n), 0n);
    assert.equal(originalRevenue + reversedRevenue, 0n);
    assert.equal(originalCost + reversedCost, 0n);
    assert.equal(entries.filter((row) => row.quantity < 0).reduce((sum, row) => sum - row.quantity, 0), 4);
});

test("unmatched negative stock remains unattributed after receipt rather than assigning a supplier retroactively", () => {
    const entries = allocateSupplierFifoAttribution([
        event({ id: "sale", type: "sale", quantity: 3, saleId: "sale-1", netRevenueCents: 1_000n }),
        event({ id: "receipt", type: "receipt", quantity: 3, at: "2026-01-02T00:00:00.000Z", supplierId: "supplier-a", unitCostCents: 100n }),
    ]);
    assert.equal(entries[0].supplierId, null);
    assert.equal(entries[0].fifoCostCents, null);
});

test("transfers preserve supplier lot identity across warehouses", () => {
    const entries = allocateSupplierFifoAttribution([
        event({ id: "r1", type: "receipt", quantity: 5, supplierId: "supplier-a", unitCostCents: 100n }),
        event({ id: "transfer-out", type: "transfer_out", quantity: 3, referenceId: "transfer-1", at: "2026-01-02T00:00:00.000Z" }),
        event({ id: "transfer-in", type: "transfer_in", quantity: 3, referenceId: "transfer-1", warehouseId: "warehouse-2", at: "2026-01-03T00:00:00.000Z" }),
        event({ id: "sale-2", type: "sale", quantity: 3, saleId: "sale-2", warehouseId: "warehouse-2", at: "2026-01-04T00:00:00.000Z", netRevenueCents: 900n }),
    ]);
    assert.equal(entries.at(-1)?.supplierId, "supplier-a");
    assert.equal(entries.at(-1)?.fifoCostCents, 300n);
});
