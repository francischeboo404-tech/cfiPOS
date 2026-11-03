import { centsToKesString, divideRoundHalfUp, parseKesToCents } from "../lib/exactMoney";

export interface DailySalesPoint {
    date: string;
    total: string | number;
    count: number;
}

export interface InventoryPredictionProduct {
    id: string;
    name: string;
    sku: string;
    stock_on_hand: number;
    reorder_level: number;
}

type InventoryAlertUrgency = "critical" | "high" | "medium";

export interface InventoryPredictionResult {
    salesForecast: {
        next7Days: string;
        next30Days: string;
        trendDirection: "increasing" | "stable" | "decreasing";
        confidence: "high" | "medium" | "low";
        baselineDailySales: string;
        historyDays: number;
        historicalTransactions: number;
        activeSalesDays: number;
    };
    inventoryAlerts: {
        productName: string;
        sku: string;
        currentStock: number;
        reorderLevel: number;
        suggestedReorderQty: number;
        urgency: InventoryAlertUrgency;
        reasoning: string;
    }[];
    demandPatterns: { pattern: string; insight: string }[];
    recommendations: string[];
}

const formatCurrencyCents = (amountCents: bigint) => {
    const whole = amountCents / 100n;
    const fraction = String(amountCents % 100n).padStart(2, "0");
    return `KSh ${new Intl.NumberFormat("en-KE").format(whole)}.${fraction}`;
};

export function createInventoryPredictions(
    inventory: InventoryPredictionProduct[],
    dailySales: DailySalesPoint[],
): InventoryPredictionResult {
    const days = [...dailySales].sort((left, right) => left.date.localeCompare(right.date));
    const recentDays = days.slice(-30);
    const previousDays = days.slice(-60, -30);
    const recentRevenueCents = recentDays.reduce(
        (sum, day) => sum + parseKesToCents(String(day.total)),
        0n,
    );
    const previousRevenueCents = previousDays.reduce(
        (sum, day) => sum + parseKesToCents(String(day.total)),
        0n,
    );
    const historicalTransactions = days.reduce((sum, day) => sum + day.count, 0);
    const activeSalesDays = days.filter((day) => day.count > 0).length;
    const baselineDailySalesCents = recentDays.length > 0
        ? divideRoundHalfUp(recentRevenueCents, BigInt(recentDays.length))
        : 0n;
    const trendDirection = previousRevenueCents === 0n
        ? (recentRevenueCents > 0n ? "increasing" : "stable")
        : recentRevenueCents * 10n > previousRevenueCents * 11n
            ? "increasing"
            : recentRevenueCents * 10n < previousRevenueCents * 9n
                ? "decreasing"
                : "stable";
    const confidence = historicalTransactions >= 90 && activeSalesDays >= 45
        ? "high"
        : historicalTransactions >= 20 && activeSalesDays >= 14
            ? "medium"
            : "low";

    const inventoryAlerts = inventory
        .map((product) => {
            const currentStock = Math.max(0, Number(product.stock_on_hand) || 0);
            const reorderLevel = Math.max(0, Number(product.reorder_level) || 0);
            if (currentStock > reorderLevel) return null;

            const targetStock = Math.ceil(reorderLevel);
            const suggestedReorderQty = Math.max(0, targetStock - Math.floor(currentStock));
            const urgency: InventoryAlertUrgency = currentStock === 0
                ? "critical"
                : reorderLevel > 0 && currentStock < reorderLevel / 2
                    ? "high"
                    : "medium";
            const reasoning = reorderLevel === 0
                ? `Current stock is ${currentStock} and no reorder level is configured. Set a reorder level to calculate an order quantity.`
                : `Current stock is ${currentStock}, at or below the configured reorder level of ${reorderLevel}. Ordering ${suggestedReorderQty} units would restore stock to that level.`;

            return {
                productName: product.name,
                sku: product.sku,
                currentStock,
                reorderLevel,
                suggestedReorderQty,
                urgency,
                reasoning,
            };
        })
        .filter((alert): alert is NonNullable<typeof alert> => alert !== null)
        .sort((left, right) => {
            const urgencyRank: Record<InventoryAlertUrgency, number> = {
                critical: 0,
                high: 1,
                medium: 2,
            };
            return urgencyRank[left.urgency] - urgencyRank[right.urgency] ||
                left.currentStock - right.currentStock ||
                left.productName.localeCompare(right.productName);
        });

    const trendInsight = previousDays.length === 0 || recentDays.length === 0
        ? "There is not enough dated sales history to compare 30-day periods."
        : previousRevenueCents === 0n && recentRevenueCents === 0n
            ? "No completed sales were recorded in either 30-day comparison period."
            : previousRevenueCents === 0n
                ? `Recent 30-day sales were ${formatCurrencyCents(recentRevenueCents)}; the preceding 30-day period had no completed sales.`
                : `Completed sales were ${formatCurrencyCents(recentRevenueCents)} in the recent 30 days versus ${formatCurrencyCents(previousRevenueCents)} in the preceding 30 days (${trendDirection}).`;

    const recommendations = inventoryAlerts.length > 0
        ? inventoryAlerts.slice(0, 5).map((alert) =>
            alert.suggestedReorderQty > 0
                ? `Order ${alert.suggestedReorderQty} units of ${alert.productName} (${alert.sku}) to reach its configured reorder level.`
                : `Set a reorder level for ${alert.productName} (${alert.sku}) to calculate a recommended order quantity.`,
        )
        : ["All products are above their configured reorder levels."];

    if (historicalTransactions === 0) {
        recommendations.unshift("No completed sales were recorded in the 90-day history; treat the sales forecast as unavailable until sales history exists.");
    }

    return {
        salesForecast: {
            next7Days: centsToKesString(recentDays.length > 0
                ? divideRoundHalfUp(recentRevenueCents * 7n, BigInt(recentDays.length))
                : 0n),
            next30Days: centsToKesString(recentDays.length > 0
                ? divideRoundHalfUp(recentRevenueCents * 30n, BigInt(recentDays.length))
                : 0n),
            trendDirection,
            confidence,
            baselineDailySales: centsToKesString(baselineDailySalesCents),
            historyDays: days.length,
            historicalTransactions,
            activeSalesDays,
        },
        inventoryAlerts,
        demandPatterns: [
            { pattern: "Recent sales trend", insight: trendInsight },
            {
                pattern: "Forecast data coverage",
                insight: `The estimate uses ${days.length} complete daily buckets, including days with no sales. ${historicalTransactions} completed transactions occurred across ${activeSalesDays} active sales days. Confidence reflects data volume and consistency, not a guarantee of future results.`,
            },
        ],
        recommendations,
    };
}
