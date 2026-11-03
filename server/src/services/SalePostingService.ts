import { EntityManager } from "typeorm";
import { Customer } from "../entity/Customer";
import { Invoice, InvoiceStatus } from "../entity/Invoice";
import { MpesaTransaction } from "../entity/MpesaTransaction";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { ProductBatch } from "../entity/ProductBatch";
import { Sale } from "../entity/Sale";
import { SaleItem } from "../entity/SaleItem";
import { SaleItemBatch } from "../entity/SaleItemBatch";
import { Shift } from "../entity/Shift";
import { User } from "../entity/User";
import { AccountingService } from "./AccountingService";
import { InventoryMovementInput, InventoryService } from "./InventoryService";
import { centsToKesString, parseKesDecimalToCents, parseKesToCents } from "../lib/exactMoney";

export interface SaleBatchDeduction {
    saleItem: SaleItem;
    batch: ProductBatch;
    deducted: number;
}

export interface SalePostingInput {
    sale: Sale;
    cashier: User;
    customer: Customer | null;
    saleItems: SaleItem[];
    batchDeductions: SaleBatchDeduction[];
    inventoryMovements: Array<Omit<
        InventoryMovementInput,
        "movementType" | "referenceType" | "referenceId" | "createdBy"
    >>;
    confirmedMpesaTransactions?: MpesaTransaction[];
    checkoutSession?: PaymentCheckoutSession | null;
    invoice: {
        subtotal: number;
        taxAmount: number;
        discountAmount: number;
        totalAmount: number;
        paidAmount: number;
        balanceDue: number;
        status: InvoiceStatus;
        dueDate?: Date | null;
    };
    accounting: {
        totalAmount: number;
        subtotal: number;
        taxAmount: number;
        totalCogs: number;
        cashAmount: number;
        mpesaAmount: number;
        storeCreditAmount: number;
        receivableAmount?: number;
        isCash: boolean;
    };
    shift?: Shift | null;
    updateCustomerPurchaseStats?: boolean;
}

export class SalePostingService {
    static async postPreparedSale(manager: EntityManager, input: SalePostingInput): Promise<Invoice> {
        const { sale, cashier, customer } = input;
        const invoice = manager.create(Invoice, {
            invoice_number: `INV-${sale.id.toUpperCase().replace(/-/g, "")}`,
            sale,
            customer,
            subtotal: input.invoice.subtotal,
            tax_amount: input.invoice.taxAmount,
            discount_amount: input.invoice.discountAmount,
            total_amount: input.invoice.totalAmount,
            paid_amount: input.invoice.paidAmount,
            balance_due: input.invoice.balanceDue,
            status: input.invoice.status,
            issued_at: new Date(),
            paid_at: input.invoice.balanceDue === 0 ? new Date() : null,
            due_date: input.invoice.dueDate ?? null,
            created_by: cashier.id,
        });
        await manager.save(invoice);

        for (const transaction of input.confirmedMpesaTransactions || []) {
            transaction.sale_id = sale.id;
            transaction.sale = sale;
            await manager.save(transaction);
        }

        if (input.checkoutSession) {
            input.checkoutSession.status = "completed";
            await manager.save(input.checkoutSession);
        }

        for (const movement of input.inventoryMovements) {
            await InventoryService.recordMovement(manager, {
                ...movement,
                movementType: "sale",
                referenceType: "sale",
                referenceId: sale.id,
                createdBy: cashier.id,
            });
        }

        for (const saleItem of input.saleItems) {
            saleItem.sale = sale;
            await manager.save(saleItem);
        }

        for (const deduction of input.batchDeductions) {
            await manager.save(SaleItemBatch, manager.create(SaleItemBatch, {
                sale_item: deduction.saleItem,
                product_batch: deduction.batch,
                quantity_deducted: deduction.deducted,
            }));
        }

        if (customer && input.updateCustomerPurchaseStats !== false) {
            customer.purchase_count += 1;
            customer.total_purchases = Number(customer.total_purchases) + input.invoice.totalAmount;
            if (customer.purchase_count > 5) customer.is_frequent = true;
            await manager.save(customer);
        }

        await AccountingService.recordSale(
            manager,
            sale.id,
            input.accounting.totalAmount,
            input.accounting.subtotal,
            input.accounting.taxAmount,
            input.accounting.totalCogs,
            input.accounting.isCash,
            input.accounting.cashAmount,
            input.accounting.mpesaAmount,
            input.accounting.storeCreditAmount,
            input.accounting.receivableAmount,
        );

        if (input.shift) {
            const cashReceivedCents = parseKesToCents(String(sale.cash_amount));
            const changeCents = parseKesToCents(String(sale.change_amount));
            const cashDrawerCents = cashReceivedCents > changeCents
                ? cashReceivedCents - changeCents
                : 0n;
            input.shift.expected_cash = centsToKesString(
                parseKesDecimalToCents(String(input.shift.expected_cash)) + cashDrawerCents,
            );
            input.shift.mpesa_total = centsToKesString(
                parseKesDecimalToCents(String(input.shift.mpesa_total)) +
                    parseKesToCents(String(sale.mpesa_amount)),
            );
            await manager.save(input.shift);
        }

        return invoice;
    }
}
