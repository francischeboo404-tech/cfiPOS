import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Invoice, InvoiceStatus } from "../entity/Invoice";
import { InvoicePayment } from "../entity/InvoicePayment";
import { AccountingService } from "../services/AccountingService";
import { getErrorMessage } from "../utils/errors";
import { centsToKesString, parseKesToCents } from "../lib/exactMoney";

const ALLOWED_PAYMENT_METHODS = new Set(["cash", "mpesa", "bank_transfer", "card", "credit", "store_credit"]);

export const sanitizeInvoicePaymentPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Payment payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    if (typeof payload.amount !== "string" && typeof payload.amount !== "number") {
        throw new Error("amount must be a positive KES amount with at most two decimal places");
    }
    let amountCents: bigint;
    try {
        amountCents = parseKesToCents(String(payload.amount));
    } catch {
        throw new Error("amount must be a positive KES amount with at most two decimal places");
    }
    if (amountCents <= 0n) throw new Error("amount must be greater than zero");

    const payment_method = typeof payload.payment_method === "string" ? payload.payment_method.trim().toLowerCase() : "cash";
    if (!ALLOWED_PAYMENT_METHODS.has(payment_method)) {
        throw new Error("payment_method is invalid");
    }

    const reference_number = typeof payload.reference_number === "string" ? payload.reference_number.trim().slice(0, 80) : undefined;
    const mpesa_receipt = typeof payload.mpesa_receipt === "string" ? payload.mpesa_receipt.trim().slice(0, 80) : undefined;
    const notes = typeof payload.notes === "string" ? payload.notes.trim().slice(0, 500) : undefined;

    const sanitized: Record<string, unknown> = {
        amount: centsToKesString(amountCents),
        payment_method,
    };

    if (reference_number) sanitized.reference_number = reference_number;
    if (mpesa_receipt) sanitized.mpesa_receipt = mpesa_receipt;
    if (notes) sanitized.notes = notes;

    return sanitized;
};

export class InvoiceController {
    static async list(req: Request, res: Response) {
        try {
            const status = req.query.status as InvoiceStatus | undefined;
            const invoices = await AppDataSource.getRepository(Invoice).find({
                where: status ? { status } : undefined,
                relations: ["customer"],
                order: { created_at: "DESC" },
            });
            res.json(invoices);
        } catch (error) {
            console.error("Error fetching invoices:", error);
            res.status(500).json({ message: "Error fetching invoices" });
        }
    }

    static async listPayments(req: Request, res: Response) {
        try {
            const payments = await AppDataSource.getRepository(InvoicePayment).find({
                where: { invoice_id: req.params.invoiceId as string },
                order: { created_at: "DESC" },
            });
            res.json(payments);
        } catch (error) {
            console.error("Error fetching invoice payments:", error);
            res.status(500).json({ message: "Error fetching invoice payments" });
        }
    }

    static async recordPayment(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const invoiceId = req.params.invoiceId as string;
            const payload = sanitizeInvoicePaymentPayload(req.body);
            const { amount, payment_method, reference_number, mpesa_receipt, notes } = payload;
            const receivedBy = req.user?.id as string;

            if (!receivedBy) {
                await queryRunner.rollbackTransaction();
                return res.status(401).json({ message: "Authenticated user is required" });
            }

            const invoice = await queryRunner.manager.findOne(Invoice, {
                where: { id: invoiceId },
                lock: { mode: "pessimistic_write" },
            });
            if (!invoice) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Invoice not found" });
            }

            const amountCents = parseKesToCents(String(amount));
            const balanceDueCents = parseKesToCents(String(invoice.balance_due ?? invoice.total_amount ?? 0));
            if (amountCents > balanceDueCents) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Payment amount exceeds invoice balance" });
            }

            const payment = new InvoicePayment();
            payment.invoice_id = invoice.id;
            payment.amount = Number(amount);
            payment.payment_method = String(payment_method);
            payment.reference_number = typeof reference_number === "string" ? reference_number : null;
            payment.mpesa_receipt = typeof mpesa_receipt === "string" ? mpesa_receipt : null;
            payment.notes = typeof notes === "string" ? notes : null;
            payment.received_by = receivedBy;
            await queryRunner.manager.save(payment);

            const paidAmountCents = parseKesToCents(String(invoice.paid_amount || 0)) + amountCents;
            const totalAmountCents = parseKesToCents(String(invoice.total_amount || 0));
            const newBalanceCents = totalAmountCents > paidAmountCents
                ? totalAmountCents - paidAmountCents
                : 0n;
            invoice.paid_amount = Number(centsToKesString(paidAmountCents));
            invoice.balance_due = Number(centsToKesString(newBalanceCents));
            invoice.status = newBalanceCents === 0n ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID;
            invoice.paid_at = newBalanceCents === 0n ? new Date() : null;
            await queryRunner.manager.save(invoice);

            await AccountingService.recordInvoicePayment(
                queryRunner.manager,
                invoice.id,
                amountCents,
            );

            await queryRunner.commitTransaction();
            res.status(201).json({ message: "Payment recorded", payment, invoice });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error("Error recording invoice payment:", error);
            res.status(500).json({ message: getErrorMessage(error, "Error recording invoice payment") });
        } finally {
            await queryRunner.release();
        }
    }
}
