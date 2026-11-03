import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { In, QueryFailedError } from "typeorm";
import { AppDataSource } from "../data-source";
import { Account, AccountType } from "../entity/Account";
import { JournalEntry } from "../entity/JournalEntry";
import { PurchaseOrder } from "../entity/PurchaseOrder";
import { DeliveryNote } from "../entity/DeliveryNote";
import { DeliveryNoteItem } from "../entity/DeliveryNoteItem";
import { SupplierInvoice, InvoiceStatus } from "../entity/SupplierInvoice";
import { PurchaseRequisition, RequisitionStatus } from "../entity/PurchaseRequisition";
import { Vendor } from "../entity/Vendor";
import { User } from "../entity/User";
import { SupplierPayment, SupplierPaymentMethod } from "../entity/SupplierPayment";
import { AccountingService } from "../services/AccountingService";
import { centsToKesString, parseKesToCents } from "../lib/exactMoney";
import {
    isEligibleManualInvoiceDebitAccount,
    ManualSupplierInvoiceAccountingError,
    normalizeInvoiceAccountingDate,
    validateManualInvoiceAmounts,
} from "../lib/manualSupplierInvoiceAccounting";
import {
    calculateExpectedSupplierInvoiceTaxCents,
    validateSupplierInvoiceTax,
} from "../lib/supplierInvoiceTax";

const invoiceRepo = AppDataSource.getRepository(SupplierInvoice);
const paymentRepo = AppDataSource.getRepository(SupplierPayment);
const reqRepo = AppDataSource.getRepository(PurchaseRequisition);

class DuplicateSupplierInvoiceError extends Error {}
class DuplicateDeliveryNoteInvoiceError extends Error {}

const SUPPLIER_INVOICE_ALLOWED_FIELDS = new Set([
    "invoice_number",
    "vendor_id",
    "po_id",
    "delivery_note_id",
    "subtotal",
    "tax_amount",
    "total_amount",
    "due_date",
    "invoice_date",
    "notes",
    "payment_terms",
    "supplier_name",
    "supplier_contact_person",
    "supplier_phone",
    "supplier_email",
    "supplier_address",
]);

const SUPPLIER_PAYMENT_ALLOWED_FIELDS = new Set([
    "amount",
    "payment_method",
    "reference_number",
    "payment_date",
    "notes",
    "idempotency_key",
]);

type SupplierInvoicePayload = Partial<Record<
    "invoice_number" | "vendor_id" | "po_id" | "delivery_note_id" | "due_date" | "invoice_date" | "notes" | "payment_terms" |
    "supplier_name" | "supplier_contact_person" | "supplier_phone" | "supplier_email" | "supplier_address",
    string
> & Partial<Record<"subtotal" | "tax_amount" | "total_amount", string>>>;

type SupplierPaymentPayload = { amount: string; idempotency_key: string } & Partial<Record<
    "reference_number" | "payment_date" | "notes",
    string
>> & { payment_method?: SupplierPaymentMethod };

export const sanitizeSupplierInvoicePayload = (input: unknown): SupplierInvoicePayload => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {};
    }

    const sanitized: SupplierInvoicePayload = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!SUPPLIER_INVOICE_ALLOWED_FIELDS.has(key) || value === undefined || value === null) {
            continue;
        }

        if ((typeof value === "number" || typeof value === "string") &&
            (key === "subtotal" || key === "tax_amount" || key === "total_amount")) {
            try {
                sanitized[key] = centsToKesString(parseKesToCents(String(value)));
            } catch {
                throw new Error(`${key} must be a non-negative KES amount with at most two decimal places`);
            }
            continue;
        }

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed === "" && (key === "invoice_number" || key === "vendor_id" || key === "po_id" ||
                key === "supplier_name")) continue;
            if (key === "invoice_number" || key === "vendor_id" || key === "po_id" || key === "delivery_note_id" ||
                key === "due_date" || key === "invoice_date" || key === "notes" || key === "payment_terms" ||
                key === "supplier_name" || key === "supplier_contact_person" || key === "supplier_phone" ||
                key === "supplier_email" || key === "supplier_address") {
                if ((key === "invoice_date" || key === "due_date") && trimmed) {
                    const date = new Date(`${trimmed}T00:00:00.000Z`);
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
                        !Number.isFinite(date.getTime()) ||
                        date.toISOString().slice(0, 10) !== trimmed) {
                        throw new Error(`${key} must be a valid date in YYYY-MM-DD format`);
                    }
                }
                if (key === "supplier_email" && trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
                    throw new Error("supplier_email must be a valid email address");
                }
                const maxLength = key === "supplier_name" || key === "supplier_contact_person" ? 200 :
                    key === "supplier_phone" ? 50 :
                        key === "supplier_email" ? 254 :
                            key === "supplier_address" ? 500 :
                                key === "notes" ? 1000 : Number.POSITIVE_INFINITY;
                if (trimmed.length > maxLength) throw new Error(`${key} is too long`);
                sanitized[key] = trimmed;
            }
            continue;
        }
    }

    return sanitized;
};

export const sanitizeSupplierPaymentPayload = (input: unknown): SupplierPaymentPayload => {
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
    const idempotencyKey = typeof payload.idempotency_key === "string"
        ? payload.idempotency_key.trim()
        : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
        throw new Error("idempotency_key must be a valid UUID");
    }

    const sanitized: Partial<Omit<SupplierPaymentPayload, "amount">> = {};
    for (const [key, value] of Object.entries(payload)) {
        if (!SUPPLIER_PAYMENT_ALLOWED_FIELDS.has(key) || value === undefined || value === null) {
            continue;
        }

        if (key === "payment_method") {
            if (typeof value !== "string" ||
                !Object.values(SupplierPaymentMethod).includes(value.trim().toLowerCase() as SupplierPaymentMethod)) {
                throw new Error("payment_method must be bank_transfer, cash, mpesa, or cheque");
            }
            sanitized.payment_method = value.trim().toLowerCase() as SupplierPaymentMethod;
            continue;
        }

        if (key === "idempotency_key") continue;

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (key === "reference_number") {
                if (trimmed.length > 100) throw new Error("reference_number must be 100 characters or less");
                if (trimmed) sanitized.reference_number = trimmed;
            } else if (key === "payment_date") {
                const date = new Date(`${trimmed}T00:00:00.000Z`);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
                    !Number.isFinite(date.getTime()) ||
                    date.toISOString().slice(0, 10) !== trimmed) {
                    throw new Error("payment_date must be a valid date in YYYY-MM-DD format");
                }
                sanitized.payment_date = trimmed;
            } else if (key === "notes") {
                if (trimmed.length > 500) throw new Error("notes must be 500 characters or less");
                if (trimmed) sanitized.notes = trimmed;
            }
            continue;
        }
        if (key === "reference_number" || key === "payment_date" || key === "notes") {
            throw new Error(`${key} must be a string`);
        }
    }

    return { ...sanitized, amount: centsToKesString(amountCents), idempotency_key: idempotencyKey };
};

export const isSameSupplierPaymentRequest = (
    existingPayment: {
        supplier_invoice_id: string;
        amount: string | number;
        payment_method: SupplierPaymentMethod;
        reference_number: string | null;
        payment_date: Date | string;
        notes: string | null;
    },
    invoiceId: string,
    payload: SupplierPaymentPayload,
): boolean => {
    const existingPaymentDate = existingPayment.payment_date instanceof Date
        ? existingPayment.payment_date.toISOString().slice(0, 10)
        : String(existingPayment.payment_date).slice(0, 10);

    return existingPayment.supplier_invoice_id === invoiceId &&
        parseKesToCents(String(existingPayment.amount)) === parseKesToCents(payload.amount) &&
        existingPayment.payment_method === (payload.payment_method ?? SupplierPaymentMethod.BANK_TRANSFER) &&
        existingPayment.reference_number === (payload.reference_number ?? null) &&
        (payload.payment_date === undefined || existingPaymentDate === payload.payment_date) &&
        existingPayment.notes === (payload.notes ?? null);
};

export const sanitizeRequisitionStatusPayload = (input: unknown): { status: RequisitionStatus } => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Requisition status payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";

    if (!Object.values(RequisitionStatus).includes(status as RequisitionStatus)) {
        throw new Error("status is invalid");
    }

    return { status: status as RequisitionStatus };
};

export class ProcurementController {

    static async listSupplierInvoices(req: Request, res: Response) {
        try {
            const invoices = await invoiceRepo.find({
                relations: ["vendor", "purchase_order", "delivery_note"],
                order: { created_at: "DESC" },
            });
            const manualInvoiceIds = invoices
                .filter((invoice) => !invoice.po_id && !invoice.delivery_note_id)
                .map((invoice) => invoice.id);
            const recognizedEntries = manualInvoiceIds.length > 0
                ? await AppDataSource.getRepository(JournalEntry).find({
                    where: {
                        reference_type: "SUPPLIER_INVOICE",
                        reference_id: In(manualInvoiceIds),
                    },
                    select: ["reference_id"],
                })
                : [];
            const recognizedInvoiceIds = new Set(recognizedEntries.map((entry) => entry.reference_id));

            return res.json(invoices.map((invoice) => ({
                ...invoice,
                accounting_recognized:
                    Boolean(invoice.po_id || invoice.delivery_note_id) ||
                    recognizedInvoiceIds.has(invoice.id),
            })));
        } catch (error) {
            console.error("Error fetching supplier invoices:", error);
            return res.status(500).json({ message: "Error fetching supplier invoices" });
        }
    }

    static async listManualSupplierInvoiceAccounts(req: Request, res: Response) {
        try {
            const accounts = await AppDataSource.getRepository(Account).find({
                where: {
                    is_active: true,
                    type: In([AccountType.ASSET, AccountType.EXPENSE]),
                },
                order: { code: "ASC" },
            });
            return res.json(accounts.filter((account) =>
                isEligibleManualInvoiceDebitAccount(account, "subtotal") ||
                isEligibleManualInvoiceDebitAccount(account, "tax"),
            ).map(({ id, code, name, type }) => ({ id, code, name, type })));
        } catch (error) {
            console.error("Error fetching eligible supplier invoice accounts:", error);
            return res.status(500).json({ message: "Error fetching eligible supplier invoice accounts" });
        }
    }

    static async listSupplierPayments(req: Request, res: Response) {
        try {
            const payments = await paymentRepo.find({
                where: { supplier_invoice_id: req.params.invoiceId as string },
                relations: ["payer", "payer.profile"],
                order: { payment_date: "DESC", created_at: "DESC" },
            });

            return res.json(payments.map((payment) => ({
                id: payment.id,
                supplier_invoice_id: payment.supplier_invoice_id,
                vendor_id: payment.vendor_id,
                amount: payment.amount,
                payment_method: payment.payment_method,
                reference_number: payment.reference_number,
                payment_date: payment.payment_date,
                notes: payment.notes,
                paid_by: payment.paid_by,
                created_at: payment.created_at,
                payer: {
                    id: payment.payer?.id ?? payment.paid_by,
                    full_name: payment.payer?.profile?.full_name ?? null,
                },
            })));
        } catch (error) {
            console.error("Error fetching supplier payments:", error);
            return res.status(500).json({ message: "Error fetching supplier payments" });
        }
    }

    // -----------------------------------------------------
    // 3-WAY MATCHING (Invoice <- PO -> GRN)
    // -----------------------------------------------------
    static async createSupplierInvoice(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const payload = sanitizeSupplierInvoicePayload(req.body);
            const {
                vendor_id, po_id, delivery_note_id, subtotal, tax_amount, total_amount,
                due_date, invoice_date, notes, payment_terms, supplier_name,
                supplier_contact_person, supplier_phone, supplier_email, supplier_address,
            } = payload;
            const invoiceNumber = typeof payload.invoice_number === "string" ? payload.invoice_number.trim().toUpperCase() : "";
            if (!invoiceNumber) throw new Error("invoice_number is required");
            if (invoiceNumber.length > 100) throw new Error("invoice_number must be 100 characters or less");
            const actorId = req.user?.id ?? null;

            const hasPurchaseOrder = Boolean(po_id);
            const hasGoodsReceipt = Boolean(delivery_note_id);
            if (hasPurchaseOrder !== hasGoodsReceipt) {
                throw new Error("Purchase order and goods receipt must be provided together, or both omitted for manual invoice entry.");
            }
            if (vendor_id && supplier_name) {
                throw new Error("Choose an existing supplier or enter a new supplier, not both.");
            }
            if (!vendor_id && (!supplier_name || hasPurchaseOrder)) {
                throw new Error("Select an existing supplier or provide a supplier name for a manual invoice.");
            }

            let vendor: Vendor | null = null;
            if (vendor_id) {
                vendor = await queryRunner.manager.findOneBy(Vendor, { id: vendor_id });
            } else if (supplier_name) {
                const existingVendor = await queryRunner.manager
                    .createQueryBuilder(Vendor, "vendor")
                    .where("LOWER(BTRIM(vendor.name)) = LOWER(BTRIM(:name))", { name: supplier_name })
                    .getOne();
                if (existingVendor) {
                    throw new Error("Supplier is already registered; select the existing supplier instead.");
                }
                vendor = new Vendor();
                vendor.name = supplier_name;
                vendor.contact_person = supplier_contact_person ?? null;
                vendor.phone = supplier_phone ?? null;
                vendor.email = supplier_email ?? null;
                vendor.address = supplier_address ?? null;
                vendor.payment_terms = payment_terms ?? null;
                vendor.needs_review = true;
                await queryRunner.manager.save(vendor);
            }
            if (!vendor) throw new Error("Supplier not found.");

            const duplicateInvoice = await queryRunner.manager.findOne(SupplierInvoice, {
                where: { vendor_id: vendor.id, invoice_number: invoiceNumber },
            });
            if (duplicateInvoice) {
                throw new DuplicateSupplierInvoiceError("This invoice number already exists for this vendor");
            }

            const po = po_id ? await queryRunner.manager.findOneBy(PurchaseOrder, { id: po_id }) : null;
            const grn = delivery_note_id
                ? await queryRunner.manager.findOne(DeliveryNote, {
                    where: { id: delivery_note_id },
                    lock: { mode: "pessimistic_write" },
                })
                : null;

            if (hasPurchaseOrder && (!po || !grn)) {
                throw new Error("Invalid references provided.");
            }
            if (po && grn && (po.vendor_id !== vendor.id || grn.vendor_id !== vendor.id || grn.po_id !== po.id)) {
                throw new Error("Invoice vendor, purchase order, and goods receipt must match.");
            }
            if (grn && grn.status !== "completed") {
                throw new Error("Goods receipt must be completed before invoicing.");
            }

            const invoiceSubtotalCents = parseKesToCents(subtotal ?? "0");
            const invoiceTaxCents = parseKesToCents(tax_amount ?? "0");
            const invoiceTotalCents = total_amount === undefined
                ? invoiceSubtotalCents + invoiceTaxCents
                : parseKesToCents(total_amount);
            const invoiceTotalDifference = invoiceTotalCents - invoiceSubtotalCents - invoiceTaxCents;
            if (invoiceTotalCents <= 0n) {
                throw new Error("Invoice total must be greater than zero.");
            }
            if (invoiceTotalDifference > 1n || invoiceTotalDifference < -1n) {
                throw new Error("Invoice total must equal subtotal plus tax.");
            }
            if ((!po || !grn) && invoiceTotalDifference !== 0n) {
                throw new Error("Manual invoice total must equal subtotal plus tax exactly.");
            }

            const invoice = new SupplierInvoice();
            invoice.invoice_number = invoiceNumber;
            invoice.vendor = vendor;
            invoice.vendor_id = vendor.id;
            invoice.po_id = po?.id ?? null;
            invoice.purchase_order = po;
            invoice.delivery_note = grn;
            invoice.delivery_note_id = grn?.id ?? null;
            invoice.total_amount = Number(centsToKesString(invoiceTotalCents));
            invoice.tax_amount = Number(centsToKesString(invoiceTaxCents));
            invoice.due_date = new Date(due_date || invoice_date || Date.now());
            invoice.payment_terms = payment_terms ?? null;
            invoice.notes = notes ?? null;
            invoice.created_by = actorId ?? null;
            invoice.invoice_date = invoice_date ? new Date(invoice_date) : new Date();
            invoice.subtotal = Number(centsToKesString(invoiceSubtotalCents));
            invoice.paid_amount = 0;
            invoice.balance_due = invoice.total_amount;

            if (!po || !grn) {
                invoice.status = InvoiceStatus.PENDING;
                invoice.manual_reviewed_at = null;
                invoice.manual_reviewed_by = null;
            } else {
                const receiptItems = await queryRunner.manager.find(DeliveryNoteItem, {
                    where: { delivery_note_id: grn.id },
                    relations: ["product", "product.tax_class"],
                });
                const grnAmountCents = parseKesToCents(String(grn.total_value || 0));
                const poAmountCents = parseKesToCents(String(po.total_amount || 0));

                if (grnAmountCents > poAmountCents + 1n) {
                    throw new Error("Goods receipt value exceeds the purchase order value.");
                }

                const subtotalDifferenceCents = invoiceSubtotalCents - grnAmountCents;
                if (subtotalDifferenceCents <= 1n && subtotalDifferenceCents >= -1n) {
                    const expectedTaxCents = calculateExpectedSupplierInvoiceTaxCents(receiptItems);
                    validateSupplierInvoiceTax(invoiceTaxCents, expectedTaxCents);
                    const existingInvoicesForGrn = await queryRunner.manager.find(SupplierInvoice, {
                        where: { delivery_note_id: grn.id },
                        select: ["id", "status"],
                    });
                    if (existingInvoicesForGrn.some((existingInvoice) => existingInvoice.status !== InvoiceStatus.DISCREPANCY)) {
                        throw new DuplicateDeliveryNoteInvoiceError("This goods receipt already has a payable supplier invoice");
                    }
                    invoice.status = InvoiceStatus.MATCHED;
                } else {
                    invoice.status = InvoiceStatus.DISCREPANCY;
                }
            }

            await queryRunner.manager.save(invoice);
            await queryRunner.commitTransaction();
            return res.status(201).json({ message: "Invoice processed", invoice });

        } catch (error) {
            await queryRunner.rollbackTransaction();
            if (error instanceof DuplicateSupplierInvoiceError) {
                return res.status(409).json({ message: error.message });
            }
            if (error instanceof DuplicateDeliveryNoteInvoiceError) {
                return res.status(409).json({ message: error.message });
            }
            if (error instanceof QueryFailedError &&
                error.driverError.code === "23505" &&
                error.driverError.constraint === "IDX_supplier_invoice_vendor_number") {
                return res.status(409).json({ message: "This invoice number already exists for this vendor" });
            }
            return res.status(400).json({ message: error instanceof Error ? error.message : "Failed to process invoice" });
        } finally {
            await queryRunner.release();
        }
    }

    static async reviewManualSupplierInvoice(req: AuthenticatedRequest, res: Response) {
        const { subtotal_account_id, tax_account_id } = req.body ?? {};
        if (typeof subtotal_account_id !== "string" ||
            (tax_account_id !== undefined && tax_account_id !== null && typeof tax_account_id !== "string")) {
            return res.status(400).json({ message: "Select the eligible debit account(s) for the invoice subtotal and tax" });
        }
        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const invoice = await queryRunner.manager.findOne(SupplierInvoice, {
                where: { id: req.params.invoiceId as string },
                lock: { mode: "pessimistic_write" },
            });
            if (!invoice) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Supplier invoice not found" });
            }
            if (invoice.po_id || invoice.delivery_note_id) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Only manually entered invoices can use this review action" });
            }
            if (!req.user?.id) {
                await queryRunner.rollbackTransaction();
                return res.status(401).json({ message: "Reviewer identity is required" });
            }
            const alreadyRecognized = await queryRunner.manager.findOneBy(JournalEntry, {
                reference_id: invoice.id,
                reference_type: "SUPPLIER_INVOICE",
            });
            if (alreadyRecognized) {
                if (!invoice.manual_reviewed_at) {
                    invoice.manual_reviewed_at = new Date();
                    invoice.manual_reviewed_by = req.user.id;
                    await queryRunner.manager.save(invoice);
                }
                await queryRunner.commitTransaction();
                return res.status(200).json({
                    message: "Manual supplier invoice accounting was already recorded",
                    invoice,
                });
            }
            if (!invoice.manual_reviewed_at && invoice.status !== InvoiceStatus.PENDING) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Invoice is not awaiting manual review" });
            }
            const subtotalCents = parseKesToCents(String(invoice.subtotal));
            const taxCents = parseKesToCents(String(invoice.tax_amount));
            const totalCents = parseKesToCents(String(invoice.total_amount));
            try {
                validateManualInvoiceAmounts(subtotalCents, taxCents, totalCents);
            } catch (error) {
                await queryRunner.rollbackTransaction();
                if (error instanceof ManualSupplierInvoiceAccountingError) {
                    return res.status(409).json({ message: error.message });
                }
                throw error;
            }

            await AccountingService.recordManualSupplierInvoice(
                queryRunner.manager,
                invoice.id,
                normalizeInvoiceAccountingDate(invoice.invoice_date),
                subtotalCents,
                taxCents,
                totalCents,
                subtotal_account_id,
                tax_account_id ?? null,
            );
            if (!invoice.manual_reviewed_at) {
                invoice.manual_reviewed_at = new Date();
                invoice.manual_reviewed_by = req.user.id;
                await queryRunner.manager.save(invoice);
            }
            await queryRunner.commitTransaction();
            return res.json({ message: "Manual invoice reviewed and accounting recorded", invoice });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error("Error reviewing manual supplier invoice:", error);
            if (error instanceof ManualSupplierInvoiceAccountingError) {
                return res.status(400).json({ message: error.message });
            }
            return res.status(500).json({ message: "Error reviewing manual supplier invoice" });
        } finally {
            await queryRunner.release();
        }
    }

    static async recordSupplierPayment(req: AuthenticatedRequest, res: Response) {
        let payload: SupplierPaymentPayload;
        try {
            payload = sanitizeSupplierPaymentPayload(req.body);
        } catch (error) {
            return res.status(400).json({ message: error instanceof Error ? error.message : "Invalid payment amount" });
        }

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const { invoiceId } = req.params;
            const { amount, payment_method, reference_number, payment_date, notes, idempotency_key } = payload;
            const actorId = req.user?.id ?? null;
            const amountCents = parseKesToCents(amount);
            const effectivePaymentDate = payment_date ?? new Date().toISOString().slice(0, 10);

            await queryRunner.query(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                [`supplier-payment:${idempotency_key}`],
            );
            const existingPayment = await queryRunner.manager.findOne(SupplierPayment, {
                where: { idempotency_key },
                relations: ["supplier_invoice"],
            });
            if (existingPayment) {
                if (!isSameSupplierPaymentRequest(existingPayment, invoiceId, payload)) {
                    await queryRunner.rollbackTransaction();
                    return res.status(409).json({ message: "Payment request key was already used for different payment details" });
                }
                await queryRunner.commitTransaction();
                return res.status(200).json({
                    message: "Payment already recorded",
                    payment: existingPayment,
                    invoice: existingPayment.supplier_invoice,
                });
            }

            const invoice = await queryRunner.manager.findOne(SupplierInvoice, {
                where: { id: invoiceId },
                lock: { mode: "pessimistic_write" },
            });
            if (!invoice) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Supplier invoice not found" });
            }

            if (invoice.status !== InvoiceStatus.MATCHED && invoice.status !== InvoiceStatus.PENDING) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Supplier invoice must pass three-way matching before payment" });
            }
            if (invoice.po_id === null && !invoice.manual_reviewed_at) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Manually entered supplier invoices must be reviewed before payment" });
            }
            if (invoice.po_id === null) {
                const invoiceRecognition = await queryRunner.manager.findOneBy(JournalEntry, {
                    reference_id: invoice.id,
                    reference_type: "SUPPLIER_INVOICE",
                });
                if (!invoiceRecognition) {
                    await queryRunner.rollbackTransaction();
                    return res.status(409).json({ message: "Manual supplier invoice accounting must be completed before payment" });
                }
            }
            const supplier = await queryRunner.manager.findOne(Vendor, {
                where: { id: invoice.vendor_id },
                lock: { mode: "pessimistic_write" },
            });
            if (!supplier) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Supplier record for this invoice was not found" });
            }
            if (supplier.needs_review) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({ message: "Supplier record must be reviewed before payment" });
            }

            const balanceDueCents = parseKesToCents(String(invoice.balance_due ?? invoice.total_amount ?? 0));
            if (amountCents > balanceDueCents) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Payment amount exceeds invoice balance" });
            }

            if (!actorId) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Payment author is required" });
            }

            const payment = new SupplierPayment();
            payment.supplier_invoice_id = invoice.id;
            payment.vendor_id = invoice.vendor_id;
            payment.amount = amount;
            payment.payment_method = payment_method ?? SupplierPaymentMethod.BANK_TRANSFER;
            payment.reference_number = reference_number ?? null;
            payment.payment_date = new Date(`${effectivePaymentDate}T00:00:00.000Z`);
            payment.notes = notes ?? null;
            payment.paid_by = actorId;
            payment.idempotency_key = idempotency_key;
            await queryRunner.manager.save(payment);

            const newPaidAmountCents = parseKesToCents(String(invoice.paid_amount || 0)) + amountCents;
            const totalAmountCents = parseKesToCents(String(invoice.total_amount || 0));
            const newBalanceCents = totalAmountCents > newPaidAmountCents
                ? totalAmountCents - newPaidAmountCents
                : 0n;
            invoice.paid_amount = Number(centsToKesString(newPaidAmountCents));
            invoice.balance_due = Number(centsToKesString(newBalanceCents));
            if (newBalanceCents === 0n) invoice.status = InvoiceStatus.PAID;
            await queryRunner.manager.save(invoice);

            await AccountingService.recordSupplierPayment(
                queryRunner.manager,
                payment.id,
                invoice.id,
                amountCents,
                payment.payment_method,
                effectivePaymentDate,
            );

            await queryRunner.commitTransaction();
            return res.status(201).json({ message: "Payment recorded", payment, invoice });
        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error("Error recording supplier payment:", error);
            return res.status(500).json({ message: error instanceof Error ? error.message : "Error recording supplier payment" });
        } finally {
            await queryRunner.release();
        }
    }

    // -----------------------------------------------------
    // PURCHASE REQUISITIONS & HIERARCHIES
    // -----------------------------------------------------
    static async updateRequisitionStatus(req: AuthenticatedRequest, res: Response) {
        try {
            const id = req.params.id;
            const { status } = sanitizeRequisitionStatusPayload(req.body ?? {});

            const requisition = await reqRepo.findOne({ where: { id }, relations: ["product", "requester"] });
            if (!requisition) return res.status(404).json({ message: "Requisition not found" });

            // Ensure hierarchical flow
            if (status === RequisitionStatus.APPROVED || status === RequisitionStatus.REJECTED) {
                const approver = await AppDataSource.manager.findOneBy(User, { id: req.user!.id });
                if (!approver) return res.status(401).json({ message: "Invalid approver" });
                requisition.approver = approver;
            }

            requisition.status = status;
            await reqRepo.save(requisition);

            res.json(requisition);
        } catch (err) {
             res.status(400).json({ message: err instanceof Error ? err.message : "Failed to update requisition" });
        }
    }
}
