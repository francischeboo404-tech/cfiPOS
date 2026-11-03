export interface SupplierFifoEvent {
    id: string;
    type: "receipt" | "sale" | "return" | "void" | "consume" | "transfer_out" | "transfer_in";
    productId: string;
    warehouseId: string;
    quantity: number;
    at: string;
    supplierId?: string | null;
    unitCostCents?: bigint | null;
    saleId?: string | null;
    referenceId?: string | null;
    netRevenueCents?: bigint | null;
}

interface FifoLot {
    id: string;
    supplierId: string | null;
    remaining: number;
    unitCostCents: bigint | null;
}

interface SaleAllocation {
    lotId: string;
    supplierId: string | null;
    quantity: number;
    returnedQuantity: number;
    revenueCents: bigint | null;
    costCents: bigint | null;
    unitCostCents: bigint | null;
}

export interface SupplierAttributionEntry {
    at: string;
    saleId: string;
    referenceId: string | null;
    productId: string;
    warehouseId: string;
    supplierId: string | null;
    quantity: number;
    netRevenueCents: bigint | null;
    fifoCostCents: bigint | null;
}

const roundRatio = (amount: bigint, numerator: bigint, denominator: bigint): bigint =>
    denominator === 0n ? 0n : (amount * numerator + denominator / 2n) / denominator;

const eventPriority = (type: SupplierFifoEvent["type"]): number => {
    if (type === "receipt") return 0;
    if (type === "sale") return 1;
    if (type === "return" || type === "void") return 2;
    if (type === "transfer_out") return 3;
    if (type === "transfer_in") return 4;
    return 5;
};

export const allocateSupplierFifoAttribution = (
    events: SupplierFifoEvent[],
): SupplierAttributionEntry[] => {
    const lots = new Map<string, FifoLot[]>();
    const sales = new Map<string, SaleAllocation[]>();
    const transferLots = new Map<string, Array<{ lot: FifoLot; quantity: number }>>();
    const unmatchedNegativeStock = new Map<string, number>();
    const result: SupplierAttributionEntry[] = [];

    const stockKey = (event: SupplierFifoEvent) => `${event.warehouseId}:${event.productId}`;
    const saleKey = (event: SupplierFifoEvent) => `${event.saleId}:${event.productId}`;

    const consume = (event: SupplierFifoEvent): Array<{ lot: FifoLot; quantity: number }> => {
        const key = stockKey(event);
        const productLots = lots.get(key) || [];
        let remaining = event.quantity;
        const consumed: Array<{ lot: FifoLot; quantity: number }> = [];
        for (const lot of productLots) {
            if (remaining <= 0) break;
            if (lot.remaining <= 0) continue;
            const quantity = Math.min(remaining, lot.remaining);
            lot.remaining -= quantity;
            remaining -= quantity;
            consumed.push({ lot, quantity });
        }
        if (remaining > 0) {
            unmatchedNegativeStock.set(key, (unmatchedNegativeStock.get(key) || 0) + remaining);
            consumed.push({
                lot: { id: `unmatched:${event.id}`, supplierId: null, remaining: 0, unitCostCents: null },
                quantity: remaining,
            });
        }
        return consumed;
    };

    const restore = (warehouseId: string, productId: string, lot: FifoLot, quantity: number) => {
        const key = `${warehouseId}:${productId}`;
        const negative = unmatchedNegativeStock.get(key) || 0;
        const offset = Math.min(negative, quantity);
        unmatchedNegativeStock.set(key, negative - offset);
        const rest = quantity - offset;
        if (rest > 0) {
            const productLots = lots.get(key) || [];
            const existingLot = productLots.find((candidate) => candidate.id === lot.id);
            if (existingLot) {
                existingLot.remaining += rest;
            } else {
                productLots.push({ ...lot, remaining: rest });
            }
            lots.set(key, productLots);
        }
    };

    const reverseSale = (event: SupplierFifoEvent, quantity: number) => {
        if (!event.saleId) throw new Error(`${event.type} event requires its original sale id`);
        const allocationList = sales.get(saleKey(event)) || [];
        let remaining = quantity;
        for (const allocation of allocationList) {
            if (remaining <= 0) break;
            const allocatable = allocation.quantity - allocation.returnedQuantity;
            if (allocatable <= 0) continue;
            const reversedQuantity = Math.min(remaining, allocatable);
            const oldReturned = allocation.returnedQuantity;
            const newReturned = oldReturned + reversedQuantity;
            const revenue = allocation.revenueCents === null
                ? null
                : roundRatio(allocation.revenueCents, BigInt(newReturned), BigInt(allocation.quantity)) -
                    roundRatio(allocation.revenueCents, BigInt(oldReturned), BigInt(allocation.quantity));
            const cost = allocation.costCents === null
                ? null
                : roundRatio(allocation.costCents, BigInt(newReturned), BigInt(allocation.quantity)) -
                    roundRatio(allocation.costCents, BigInt(oldReturned), BigInt(allocation.quantity));
            allocation.returnedQuantity = newReturned;
            remaining -= reversedQuantity;
            restore(
                event.warehouseId,
                event.productId,
                {
                    id: allocation.lotId,
                    supplierId: allocation.supplierId,
                    remaining: 0,
                    unitCostCents: allocation.unitCostCents,
                },
                reversedQuantity,
            );
            result.push({
                at: event.at,
                saleId: event.saleId,
                referenceId: event.referenceId || null,
                productId: event.productId,
                warehouseId: event.warehouseId,
                supplierId: allocation.supplierId,
                quantity: -reversedQuantity,
                netRevenueCents: revenue === null ? null : -revenue,
                fifoCostCents: cost === null ? null : -cost,
            });
        }
        if (remaining > 0) {
            restore(event.warehouseId, event.productId, {
                id: `unattributed-return:${event.id}`,
                supplierId: null,
                remaining: 0,
                unitCostCents: null,
            }, remaining);
            result.push({
                at: event.at,
                saleId: event.saleId,
                referenceId: event.referenceId || null,
                productId: event.productId,
                warehouseId: event.warehouseId,
                supplierId: null,
                quantity: -remaining,
                netRevenueCents: null,
                fifoCostCents: null,
            });
        }
    };

    for (const event of [...events].sort((a, b) =>
        a.at.localeCompare(b.at) ||
        eventPriority(a.type) - eventPriority(b.type) ||
        a.id.localeCompare(b.id))) {
        if (!Number.isSafeInteger(event.quantity) || event.quantity <= 0) {
            throw new Error("Supplier FIFO events require positive whole-number quantities");
        }
        const key = stockKey(event);
        const productLots = lots.get(key) || [];
        if (event.type === "receipt") {
            const deficit = unmatchedNegativeStock.get(key) || 0;
            const offset = Math.min(deficit, event.quantity);
            unmatchedNegativeStock.set(key, deficit - offset);
            const remainder = event.quantity - offset;
            if (remainder > 0) {
                productLots.push({
                    id: event.id,
                    supplierId: event.supplierId || null,
                    remaining: remainder,
                    unitCostCents: event.unitCostCents ?? null,
                });
                lots.set(key, productLots);
            }
            continue;
        }
        if (event.type === "transfer_in") {
            const transferred = transferLots.get(`${event.referenceId || ""}:${event.productId}`);
            if (!transferred) throw new Error("Transfer receipt has no source FIFO allocation");
            let remaining = event.quantity;
            for (const source of transferred) {
                if (remaining <= 0) break;
                const quantity = Math.min(source.quantity, remaining);
                restore(event.warehouseId, event.productId, source.lot, quantity);
                source.quantity -= quantity;
                remaining -= quantity;
            }
            if (remaining > 0) throw new Error("Transfer receipt exceeds its source FIFO allocation");
            continue;
        }
        if (event.type === "return" || event.type === "void") {
            reverseSale(event, event.quantity);
            continue;
        }

        const consumed = consume(event);
        if (event.type === "transfer_out") {
            const key = `${event.referenceId || ""}:${event.productId}`;
            const existing = transferLots.get(key) || [];
            existing.push(...consumed.map(({ lot, quantity }) => ({ lot, quantity })));
            transferLots.set(key, existing);
            continue;
        }
        if (event.type !== "sale") continue;
        if (!event.saleId) throw new Error("Supplier FIFO sale events require sale id");
        const allocations: SaleAllocation[] = [];
        let assignedRevenue = 0n;
        for (let index = 0; index < consumed.length; index += 1) {
            const { lot, quantity } = consumed[index];
            const isLast = index === consumed.length - 1;
            const revenue = event.netRevenueCents == null
                ? null
                : isLast
                    ? event.netRevenueCents - assignedRevenue
                    : roundRatio(event.netRevenueCents, BigInt(quantity), BigInt(event.quantity));
            if (revenue !== null) assignedRevenue += revenue;
            const cost = lot.unitCostCents === null ? null : lot.unitCostCents * BigInt(quantity);
            allocations.push({
                lotId: lot.id,
                supplierId: lot.supplierId,
                quantity,
                returnedQuantity: 0,
                revenueCents: revenue,
                costCents: cost,
                unitCostCents: lot.unitCostCents,
            });
            result.push({
                at: event.at,
                saleId: event.saleId,
                referenceId: null,
                productId: event.productId,
                warehouseId: event.warehouseId,
                supplierId: lot.supplierId,
                quantity,
                netRevenueCents: revenue,
                fifoCostCents: cost,
            });
        }
        const existing = sales.get(saleKey(event)) || [];
        existing.push(...allocations);
        sales.set(saleKey(event), existing);
    }
    return result;
};
