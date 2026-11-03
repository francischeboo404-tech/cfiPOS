import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Product } from "../entity/Product";
import { Sale, SaleStatus } from "../entity/Sale";
import { InventoryService } from "../services/InventoryService";
import { createInventoryPredictions } from "../services/InventoryPredictionService";
import { centsToKesString, parseKesToCents } from "../lib/exactMoney";

const getUtcDayStart = (date: Date) => new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
));

export class InventoryPredictionController {
    static async getPredictions(_req: Request, res: Response) {
        try {
            const end = getUtcDayStart(new Date());
            const start = new Date(end);
            start.setUTCDate(start.getUTCDate() - 90);

            const [sales, products, stockTotals] = await Promise.all([
                AppDataSource.getRepository(Sale)
                    .createQueryBuilder("sale")
                    .leftJoinAndSelect("sale.items", "item")
                    .leftJoinAndSelect("item.product", "product")
                    .where("sale.status = :status", { status: SaleStatus.COMPLETED })
                    .andWhere("sale.created_at >= :start", { start })
                    .andWhere("sale.created_at < :end", { end })
                    .orderBy("sale.created_at", "ASC")
                    .getMany(),
                AppDataSource.getRepository(Product).find(),
                InventoryService.getTotalStockByProduct(AppDataSource.manager),
            ]);

            const dailySales = new Map<string, { totalCents: bigint; count: number }>();
            for (let offset = 0; offset < 90; offset += 1) {
                const date = new Date(start);
                date.setUTCDate(date.getUTCDate() + offset);
                dailySales.set(date.toISOString().slice(0, 10), { totalCents: 0n, count: 0 });
            }

            for (const sale of sales) {
                const date = new Date(sale.created_at).toISOString().slice(0, 10);
                const day = dailySales.get(date);
                if (!day) continue;
                day.totalCents += parseKesToCents(String(sale.total_amount));
                day.count += 1;
            }

            const inventory = products.map((product) => ({
                id: product.id,
                name: product.name,
                sku: product.sku,
                stock_on_hand: InventoryService.getTotalStockOnHand(product, stockTotals),
                reorder_level: Number(product.reorder_level) || 0,
            }));
            const predictions = createInventoryPredictions(
                inventory,
                Array.from(dailySales, ([date, totals]) => ({
                    date,
                    total: centsToKesString(totals.totalCents),
                    count: totals.count,
                })),
            );

            return res.json({
                success: true,
                source: "statistical",
                predictions,
                metadata: {
                    dataStart: start.toISOString().slice(0, 10),
                    dataEnd: new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10),
                    completedTransactions: sales.length,
                    productsAnalyzed: products.length,
                    criticalItems: predictions.inventoryAlerts.length,
                    forecastMethod: "Recent 30-day average daily completed sales, extrapolated over each forecast horizon.",
                },
            });
        } catch (error) {
            console.error("Inventory predictions error:", error);
            return res.status(500).json({ error: "Failed to generate inventory predictions" });
        }
    }
}
