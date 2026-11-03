import { SupplierAttributionEntry } from "./supplierFifoAttribution";

export interface SupplierProductInfo {
    id: string;
    name: string;
    sku: string;
    categoryId: string | null;
    category: string | null;
}

export interface SupplierProfitabilityRow {
    supplier_id: string | null;
    supplier: string;
    product_id: string | null;
    product: string | null;
    sku: string | null;
    category_id: string | null;
    category: string | null;
    day: string | null;
    month: string | null;
    quantity_sold: string;
    net_revenue_cents: string | null;
    fifo_cost_cents: string | null;
    gross_profit_cents: string | null;
    margin_basis_points: string | null;
    data_complete: boolean;
    supplier_attribution_complete: boolean;
}

const groupDate = (date: Date, timeZone: string): string => {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const monthValue = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return `${year}-${monthValue}-${day}`;
};

export const buildSupplierProfitability = (input: {
    entries: SupplierAttributionEntry[];
    products: Map<string, SupplierProductInfo>;
    suppliers: Map<string, string>;
    startDate: string;
    endDate: string;
    timeZone: string;
    supplierId?: string;
    warehouseId?: string;
}) => {
    const groups = new Map<string, {
        supplierId: string | null;
        productId: string | null;
        day: string | null;
        month: string | null;
        quantity: number;
        revenue: bigint;
        cost: bigint;
        missingRevenue: boolean;
        missingCost: boolean;
        missingSupplier: boolean;
    }>();
    for (const entry of input.entries) {
        const day = groupDate(new Date(entry.at), input.timeZone);
        if (day < input.startDate || day > input.endDate) continue;
        if (input.supplierId && entry.supplierId !== input.supplierId) continue;
        if (input.warehouseId && entry.warehouseId !== input.warehouseId) continue;
        const dimensions: Array<{
            key: string;
            supplierId: string | null;
            productId: string | null;
            day: string | null;
            month: string | null;
        }> = [
            {
                key: `supplier:${entry.supplierId ?? "unattributed"}`,
                supplierId: entry.supplierId,
                productId: null,
                day: null,
                month: null,
            },
            {
                key: `product:${entry.supplierId ?? "unattributed"}:${entry.productId}`,
                supplierId: entry.supplierId,
                productId: entry.productId,
                day: null,
                month: null,
            },
            {
                key: `day:${day}`,
                supplierId: null,
                productId: null,
                day,
                month: null,
            },
            {
                key: `month:${day.slice(0, 7)}`,
                supplierId: null,
                productId: null,
                day: null,
                month: day.slice(0, 7),
            },
            { key: "overall", supplierId: null, productId: null, day: null, month: null },
        ];
        for (const dimension of dimensions) {
            const group = groups.get(dimension.key) || {
                supplierId: dimension.supplierId,
                productId: dimension.productId,
                day: dimension.day,
                month: dimension.month,
                quantity: 0,
                revenue: 0n,
                cost: 0n,
                missingRevenue: false,
                missingCost: false,
                missingSupplier: false,
            };
            group.quantity += entry.quantity;
            if (entry.netRevenueCents === null) group.missingRevenue = true;
            else group.revenue += entry.netRevenueCents;
            if (entry.fifoCostCents === null) group.missingCost = true;
            else group.cost += entry.fifoCostCents;
            if (entry.supplierId === null) group.missingSupplier = true;
            groups.set(dimension.key, group);
        }
    }

    const rows = (keyPrefix: string): SupplierProfitabilityRow[] =>
        Array.from(groups.entries())
            .filter(([key]) => keyPrefix === "overall" ? key === "overall" : key.startsWith(`${keyPrefix}:`))
            .map(([key, group]) => {
                const product = group.productId ? input.products.get(group.productId) : undefined;
                const supplier = group.supplierId
                    ? input.suppliers.get(group.supplierId) || "Unknown supplier"
                    : key.includes("unattributed") || group.productId
                        ? "Unattributed / unknown supplier"
                        : "All suppliers";
                const financialDataComplete = !group.missingRevenue && !group.missingCost;
                const grossProfit = group.revenue - group.cost;
                return {
                    supplier_id: group.supplierId,
                    supplier,
                    product_id: group.productId,
                    product: product?.name ?? null,
                    sku: product?.sku ?? null,
                    category_id: product?.categoryId ?? null,
                    category: product?.category ?? null,
                    day: group.day,
                    month: group.month,
                    quantity_sold: String(group.quantity),
                    net_revenue_cents: group.missingRevenue ? null : String(group.revenue),
                    fifo_cost_cents: group.missingCost ? null : String(group.cost),
                    gross_profit_cents: financialDataComplete ? String(grossProfit) : null,
                    margin_basis_points: financialDataComplete && group.revenue !== 0n
                        ? String(grossProfit * 10_000n / group.revenue)
                        : null,
                    data_complete: financialDataComplete,
                    supplier_attribution_complete: !group.missingSupplier,
                };
            })
            .sort((a, b) =>
                a.supplier.localeCompare(b.supplier) ||
                (a.product || "").localeCompare(b.product || "") ||
                (a.day || "").localeCompare(b.day || "") ||
                (a.month || "").localeCompare(b.month || ""));

    return {
        by_supplier: rows("supplier"),
        by_supplier_product: rows("product"),
        by_day: rows("day"),
        by_month: rows("month"),
        overall: rows("overall"),
    };
};
