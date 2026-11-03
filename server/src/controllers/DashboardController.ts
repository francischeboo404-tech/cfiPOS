import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Sale, SaleStatus } from "../entity/Sale";
import { SaleItem } from "../entity/SaleItem";
import { Product } from "../entity/Product";
import { Customer } from "../entity/Customer";
import { MoreThanOrEqual } from "typeorm";
import { InventoryService } from "../services/InventoryService";
import { dashboardMoneyCents, sumKesAmountsToCents } from "./DashboardAnalytics";

export class DashboardController {
    static async getDashboardStats(req: AuthenticatedRequest, res: Response) {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const saleRepo = AppDataSource.getRepository(Sale);
            const saleItemRepo = AppDataSource.getRepository(SaleItem);
            const productRepo = AppDataSource.getRepository(Product);
            const customerRepo = AppDataSource.getRepository(Customer);

            if (req.user?.role === "cashier") {
                const cashierSalesData = await saleRepo.find({
                    where: {
                        cashier: { id: req.user.id },
                        status: SaleStatus.COMPLETED,
                        created_at: MoreThanOrEqual(today)
                    },
                    order: { created_at: "DESC" }
                });

                const todaySalesCents = sumKesAmountsToCents(cashierSalesData.map((sale) => sale.total_amount));
                const todayTransactions = cashierSalesData.length;

                const recentTransactions = cashierSalesData.slice(0, 5).map(sale => ({
                    id: sale.id,
                    time: sale.created_at.toLocaleTimeString('en-KE'),
                    amountCents: dashboardMoneyCents(null, sale.total_amount).toString(),
                    method: sale.payment_method
                }));

                const paymentSummary = new Map<string, bigint>();
                for (const sale of cashierSalesData) {
                    const method = sale.payment_method;
                    paymentSummary.set(
                        method,
                        (paymentSummary.get(method) || 0n) + dashboardMoneyCents(null, sale.total_amount),
                    );
                }

                const salesByMethod = Array.from(paymentSummary, ([method, amount]) => ({
                    method,
                    amountCents: amount.toString(),
                }));

                return res.json({
                    todaySalesCents: todaySalesCents.toString(),
                    todayTransactions,
                    recentTransactions,
                    salesByMethod,
                    weeklyTrend: [],
                    topProducts: [],
                    totalProducts: 0,
                    lowStockCount: 0,
                    totalCustomers: 0
                });
            }

            // Get today's sales
            const todaySalesData = await saleRepo.find({
                where: {
                    status: SaleStatus.COMPLETED,
                    created_at: MoreThanOrEqual(today)
                },
                order: { created_at: "DESC" }
            });

            const todaySalesCents = sumKesAmountsToCents(todaySalesData.map((sale) => sale.total_amount));
            const todayTransactions = todaySalesData.length;

            const recentTransactions = todaySalesData.slice(0, 5).map(sale => ({
                id: sale.id,
                time: sale.created_at.toLocaleTimeString('en-KE'),
                amountCents: dashboardMoneyCents(null, sale.total_amount).toString(),
                method: sale.payment_method
            }));

            const paymentSummary = new Map<string, bigint>();
            for (const sale of todaySalesData) {
                const method = sale.payment_method;
                paymentSummary.set(
                    method,
                    (paymentSummary.get(method) || 0n) + dashboardMoneyCents(null, sale.total_amount),
                );
            }

            const salesByMethod = Array.from(paymentSummary, ([method, amount]) => ({
                method,
                amountCents: amount.toString(),
            }));

            // Get weekly trend
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            weekAgo.setHours(0, 0, 0, 0);

            const weekSalesData = await saleRepo.find({
                where: {
                    status: SaleStatus.COMPLETED,
                    created_at: MoreThanOrEqual(weekAgo)
                }
            });

            const weeklyTrend = Array.from({ length: 7 }, (_, i) => {
                const date = new Date();
                date.setDate(date.getDate() - (6 - i));
                date.setHours(0, 0, 0, 0);
                const dayName = date.toLocaleDateString('en-KE', { weekday: 'short' });
                const daySales = weekSalesData.filter(sale => {
                    const saleDate = new Date(sale.created_at);
                    saleDate.setHours(0, 0, 0, 0);
                    return saleDate.getTime() === date.getTime();
                });

                return {
                    day: dayName,
                    salesCents: daySales.reduce(
                        (sum, sale) => sum + dashboardMoneyCents(null, sale.total_amount),
                        0n,
                    ).toString(),
                    transactions: daySales.length
                };
            });

            // Get top products
            const todaySaleItems = await saleItemRepo.find({
                where: {
                    created_at: MoreThanOrEqual(today),
                    sale: { status: SaleStatus.COMPLETED },
                },
                relations: ["product"]
            });

            const productSummary = new Map<string, {
                name: string;
                quantity: number;
                revenueCents: bigint;
            }>();
            for (const item of todaySaleItems) {
                const productId = item.product.id;
                const summary = productSummary.get(productId) || {
                    name: item.product.name,
                    quantity: 0,
                    revenueCents: 0n,
                };
                summary.quantity += item.quantity;
                summary.revenueCents += dashboardMoneyCents(item.line_total_cents, item.line_total);
                productSummary.set(productId, summary);
            }

            const topProducts = Array.from(productSummary.values())
                .sort((a, b) => a.revenueCents === b.revenueCents ? 0 : a.revenueCents > b.revenueCents ? -1 : 1)
                .slice(0, 5);
            const serializedTopProducts = topProducts.map(({ revenueCents, ...product }) => ({
                ...product,
                revenueCents: revenueCents.toString(),
            }));

            // Get products info
            const [products, stockTotals] = await Promise.all([
                productRepo.find(),
                InventoryService.getTotalStockByProduct(AppDataSource.manager),
            ]);
            const totalProducts = products.length;
            const lowStockCount = products.filter(
                (product) => InventoryService.getTotalStockOnHand(product, stockTotals) <= product.reorder_level,
            ).length;

            // Get customers
            const totalCustomers = await customerRepo.count();

            res.json({
                todaySalesCents: todaySalesCents.toString(),
                todayTransactions,
                recentTransactions,
                salesByMethod,
                weeklyTrend,
                topProducts: serializedTopProducts,
                totalProducts,
                lowStockCount,
                totalCustomers
            });

        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching dashboard stats" });
        }
    }
}
