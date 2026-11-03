import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Customer } from "../entity/Customer";
import { AuthenticatedRequest } from "../middleware/auth";
import { VoucherService } from "../services/VoucherService";

const customerRepository = AppDataSource.getRepository(Customer);

const CUSTOMER_ALLOWED_FIELDS = new Set([
    "name",
    "phone",
    "email",
    "national_id",
    "alternative_phone",
    "address",
    "total_purchases",
    "purchase_count",
    "is_frequent",
    "credit_limit",
    "credit_balance",
    "store_credit_balance",
]);

export const sanitizeCustomerPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {} as Partial<Customer>;
    }

    const sanitized: Partial<Customer> = {};
    const textFields = new Set(["name", "phone", "email", "national_id", "alternative_phone", "address"]);
    const numericFields = new Set([
        "total_purchases",
        "purchase_count",
        "credit_limit",
        "credit_balance",
        "store_credit_balance",
    ]);
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!CUSTOMER_ALLOWED_FIELDS.has(key) || value === undefined) {
            continue;
        }
        if (value === null) {
            if (key === "national_id") sanitized.national_id = null;
            else if (key === "alternative_phone") sanitized.alternative_phone = null;
            else if (key === "address") sanitized.address = null;
            continue;
        }

        if (textFields.has(key) && typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed === "" && (key === "name" || key === "phone")) continue;
            if ((key === "national_id" && trimmed.length > 64) ||
                (key === "alternative_phone" && trimmed.length > 32)) {
                throw new Error(`${key} exceeds its maximum length`);
            }
            if (key === "name") sanitized.name = trimmed;
            else if (key === "phone") sanitized.phone = trimmed;
            else if (key === "email") {
                if (trimmed) sanitized.email = trimmed;
            }
            else if (key === "national_id") sanitized.national_id = trimmed || null;
            else if (key === "alternative_phone") sanitized.alternative_phone = trimmed || null;
            else sanitized.address = trimmed || null;
            continue;
        }

        if (numericFields.has(key)) {
            const numericValue = typeof value === "number"
                ? value
                : typeof value === "string" && value.trim()
                    ? Number(value)
                    : Number.NaN;
            if (!Number.isFinite(numericValue)) continue;
            if (key === "total_purchases") sanitized.total_purchases = numericValue;
            else if (key === "purchase_count") sanitized.purchase_count = numericValue;
            else if (key === "credit_limit") sanitized.credit_limit = numericValue;
            else if (key === "credit_balance") sanitized.credit_balance = numericValue;
            else sanitized.store_credit_balance = numericValue;
            continue;
        }

        if (key === "is_frequent" && typeof value === "boolean") {
            sanitized.is_frequent = value;
        }
    }

    return sanitized;
};

export class CustomerController {
    static async getAllCustomers(req: Request, res: Response) {
        try {
            const customers = await AppDataSource.query(`
                WITH payment_totals AS (
                    SELECT payment.agreement_id,
                        SUM(payment.amount_cents) FILTER (WHERE reversal.id IS NULL) AS paid_cents
                    FROM installment_payments payment
                    LEFT JOIN installment_payment_reversals reversal ON reversal.payment_id = payment.id
                    GROUP BY payment.agreement_id
                ),
                write_off_totals AS (
                    SELECT agreement_id, SUM(amount_cents) AS written_off_cents
                    FROM installment_write_off_events
                    GROUP BY agreement_id
                ),
                schedule_allocations AS (
                    SELECT allocation.agreement_id, allocation.installment_number,
                        SUM(allocation.principal_cents + allocation.interest_cents) AS allocated_cents,
                        SUM(reversal_allocation.principal_cents + reversal_allocation.interest_cents) AS reversed_cents
                    FROM installment_payment_allocations allocation
                    LEFT JOIN installment_reversal_allocations reversal_allocation
                        ON reversal_allocation.payment_allocation_id = allocation.id
                    GROUP BY allocation.agreement_id, allocation.installment_number
                ),
                overdue_totals AS (
                    SELECT schedule.agreement_id,
                        SUM(GREATEST(
                            schedule.principal_cents + schedule.interest_cents
                            - COALESCE(allocation.allocated_cents, 0)
                            + COALESCE(allocation.reversed_cents, 0),
                            0
                        )) FILTER (WHERE schedule.due_date <
                            (now() AT TIME ZONE 'Africa/Nairobi')::date) AS overdue_cents
                    FROM installment_schedules schedule
                    LEFT JOIN schedule_allocations allocation
                        ON allocation.agreement_id = schedule.agreement_id
                        AND allocation.installment_number = schedule.installment_number
                    GROUP BY schedule.agreement_id
                ),
                agreement_balances AS (
                    SELECT agreement.id, agreement.customer_id, agreement.release_mode,
                        GREATEST(
                            agreement.total_payable_cents
                            - COALESCE(payment.paid_cents, 0)
                            - COALESCE(write_off.written_off_cents, 0),
                            0
                        ) AS balance_cents,
                        COALESCE(overdue.overdue_cents, 0) AS overdue_cents,
                        EXISTS (
                            SELECT 1 FROM installment_cancellation_events cancellation
                            WHERE cancellation.agreement_id = agreement.id
                        ) AS cancelled,
                        EXISTS (
                            SELECT 1 FROM installment_handover_events handover
                            WHERE handover.agreement_id = agreement.id
                        ) AS handed_over,
                        COALESCE(write_off.written_off_cents, 0) > 0 AS written_off
                    FROM installment_agreements agreement
                    LEFT JOIN payment_totals payment ON payment.agreement_id = agreement.id
                    LEFT JOIN write_off_totals write_off ON write_off.agreement_id = agreement.id
                    LEFT JOIN overdue_totals overdue ON overdue.agreement_id = agreement.id
                ),
                customer_installments AS (
                    SELECT customer_id,
                        SUM(balance_cents) FILTER (WHERE NOT cancelled AND NOT written_off
                            AND (balance_cents > 0 OR (release_mode = 'HOLD_UNTIL_PAID' AND NOT handed_over))) AS open_balance_cents,
                        SUM(overdue_cents) FILTER (WHERE NOT cancelled AND NOT written_off) AS overdue_cents,
                        COUNT(*) FILTER (WHERE NOT cancelled AND NOT written_off
                            AND (balance_cents > 0 OR (release_mode = 'HOLD_UNTIL_PAID' AND NOT handed_over))) AS active_agreement_count
                    FROM agreement_balances
                    GROUP BY customer_id
                )
                SELECT customer.*,
                    CASE WHEN voucher.id IS NULL THEN NULL ELSE json_build_object(
                        'id', voucher.id,
                        'number', voucher.voucher_number,
                        'issueDate', voucher.issue_date,
                        'expiryDate', voucher.expiry_date,
                        'balance', COALESCE(ledger.balance, 0)::text
                    ) END AS voucher
                    , (enrolment.customer_id IS NOT NULL) AS loyalty_enrolled
                    , CASE
                        WHEN voucher.id IS NULL THEN 'Not enrolled'
                        WHEN voucher.expiry_date < (now() AT TIME ZONE 'Africa/Nairobi')::date THEN 'Expired'
                        ELSE 'Active'
                    END AS voucher_status
                    , COALESCE(installment.open_balance_cents, 0)::text AS open_installment_balance_cents
                    , COALESCE(installment.overdue_cents, 0)::text AS installment_overdue_cents
                    , COALESCE(installment.active_agreement_count, 0)::integer AS active_installment_agreements
                FROM customers customer
                LEFT JOIN customer_vouchers voucher ON voucher.customer_id = customer.id
                LEFT JOIN loyalty_enrolments enrolment ON enrolment.customer_id = customer.id
                LEFT JOIN (
                    SELECT voucher_id, SUM(points) AS balance
                    FROM voucher_ledger
                    GROUP BY voucher_id
                ) ledger ON ledger.voucher_id = voucher.id
                LEFT JOIN customer_installments installment ON installment.customer_id = customer.id
                ORDER BY customer.purchase_count DESC
            `);
            return res.json(customers);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching customers" });
        }
    }

    static async getCustomer(req: Request, res: Response) {
        try {
            const customer = await customerRepository.findOneBy({ id: req.params.id as string });
            if (!customer) return res.status(404).json({ message: "Customer not found" });
            res.json(customer);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching customer" });
        }
    }

    static async createCustomer(req: AuthenticatedRequest, res: Response) {
        try {
            const payload = sanitizeCustomerPayload(req.body);
            const { name, phone, email, national_id, alternative_phone, address } = payload;

            if (!name || !phone) {
                return res.status(400).json({ message: "Customer name and phone are required" });
            }

            const existing = await customerRepository.findOneBy({ phone });
            if (existing) {
                return res.status(400).json({ message: "Customer with this phone number already exists" });
            }

            if (!req.user?.id) return res.status(401).json({ message: "Authenticated user is required" });
            const result = await AppDataSource.transaction(async (manager) => {
                const customer = await manager.save(Customer, manager.create(Customer, {
                    name,
                    phone,
                    email,
                    national_id: national_id ?? null,
                    alternative_phone: alternative_phone ?? null,
                    address: address ?? null,
                }));
                const voucher = await VoucherService.ensureForCustomer(
                    manager,
                    customer.id,
                    req.user!.id,
                    "customers_screen",
                );
                return { ...customer, voucher: {
                    id: voucher.id,
                    number: voucher.voucher_number,
                    issueDate: voucher.issue_date,
                    expiryDate: voucher.expiry_date,
                    balance: "0",
                } };
            });
            return res.status(201).json(result);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error creating customer" });
        }
    }

    static async updateCustomer(req: Request, res: Response) {
        try {
            const customer = await customerRepository.findOneBy({ id: req.params.id as string });
            if (!customer) return res.status(404).json({ message: "Customer not found" });

            customerRepository.merge(customer, sanitizeCustomerPayload(req.body));
            const results = await customerRepository.save(customer);
            res.json(results);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error updating customer" });
        }
    }

    static async deleteCustomer(req: Request, res: Response) {
        try {
            const installmentRecords = await AppDataSource.query(`
                SELECT EXISTS (
                    SELECT 1 FROM installment_agreements
                    WHERE customer_id = $1
                ) AS has_installment_records
            `, [req.params.id]) as Array<{ has_installment_records: boolean }>;
            if (installmentRecords[0]?.has_installment_records) {
                return res.status(409).json({
                    message: "Customers with installment agreements or payments cannot be deleted",
                });
            }
            const results = await customerRepository.delete(req.params.id as string);
            res.json(results);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error deleting customer" });
        }
    }
}
