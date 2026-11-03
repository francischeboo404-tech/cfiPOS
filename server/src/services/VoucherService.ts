import { EntityManager } from "typeorm";
import { randomUUID } from "node:crypto";
import { CustomerVoucher } from "../entity/CustomerVoucher";
import { LoyaltyEnrolment } from "../entity/InstallmentEntities";
import { Customer } from "../entity/Customer";
import { Setting } from "../entity/Setting";
import { VoucherCardPrintLog } from "../entity/VoucherCardPrintLog";
import { VoucherLedgerEntry, VoucherEntryType } from "../entity/VoucherLedgerEntry";
import { VoucherRenewal } from "../entity/VoucherRenewal";
import { addCalendarYear, isVoucherExpired, parseSupportedRenewalFeeCents, renewedExpiryDate } from "../lib/voucherRules";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { MpesaTransaction } from "../entity/MpesaTransaction";
import { AccountingService } from "./AccountingService";
import { Shift, ShiftStatus } from "../entity/Shift";
import {
    calculateInclusiveVatCents,
    centsToKesString,
    parseKesDecimalToCents,
    parseKesToCents,
} from "../lib/exactMoney";

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

export class VoucherService {
    static async ensureForCustomer(
        manager: EntityManager,
        customerId: string,
        actorId: string,
        source: "customers_screen" | "pos" | "installment_agreement" = "pos",
    ): Promise<CustomerVoucher> {
        const customer = await manager.findOne(Customer, {
            where: { id: customerId },
            lock: { mode: "pessimistic_write" },
        });
        if (!customer) throw new Error("Customer not found");

        let voucher = await manager.findOne(CustomerVoucher, {
            where: { customer_id: customerId },
            lock: { mode: "pessimistic_write" },
        });
        if (!voucher) {
            const rows: Array<{ number: string }> = await manager.query(
                `SELECT nextval('"customer_voucher_number_seq"')::text AS number`,
            );
            const voucherNumber = rows[0]?.number;
            if (!voucherNumber || voucherNumber.length !== 10) {
                throw new Error("Voucher number sequence has reached its 10-digit limit");
            }
            const issueDate = todayUtc();
            voucher = await manager.save(CustomerVoucher, manager.create(CustomerVoucher, {
                customer_id: customerId,
                voucher_number: voucherNumber,
                issue_date: issueDate,
                expiry_date: addCalendarYear(issueDate),
            }));
        }

        const enrolment = await manager.findOneBy(LoyaltyEnrolment, { customer_id: customerId });
        if (!enrolment) {
            const actorIsUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId);
            await manager.save(LoyaltyEnrolment, manager.create(LoyaltyEnrolment, {
                customer_id: customerId,
                voucher_id: voucher.id,
                enrolled_by: actorIsUuid ? actorId : null,
                source,
            }));
        }
        return voucher;
    }

    static async getBalance(manager: EntityManager, voucherId: string): Promise<bigint> {
        const row = await manager.getRepository(VoucherLedgerEntry).createQueryBuilder("entry")
            .select("COALESCE(SUM(entry.points), 0)", "balance")
            .where("entry.voucher_id = :voucherId", { voucherId })
            .getRawOne<{ balance: string }>();
        return BigInt(row?.balance || "0");
    }

    static async append(
        manager: EntityManager,
        input: {
            voucherId: string;
            type: VoucherEntryType;
            points: bigint;
            actorId: string;
            saleId?: string | null;
            reference?: string | null;
            reason?: string | null;
        },
    ): Promise<VoucherLedgerEntry> {
        if (input.points === 0n) throw new Error("Voucher ledger entries must change the balance");
        const entry = manager.create(VoucherLedgerEntry, {
            voucher_id: input.voucherId,
            type: input.type,
            points: String(input.points),
            sale_id: input.saleId ?? null,
            reference: input.reference ?? null,
            reason: input.reason ?? null,
            created_by: input.actorId,
        });
        return manager.save(entry);
    }

    static async renew(manager: EntityManager, voucherId: string, actorId: string, renewalDate = todayUtc()) {
        const voucher = await manager.findOne(CustomerVoucher, {
            where: { id: voucherId },
            lock: { mode: "pessimistic_write" },
        });
        if (!voucher) throw new Error("Voucher not found");
        const previousRenewal = await manager.findOne(VoucherRenewal, {
            where: { voucher_id: voucher.id },
            order: { renewed_at: "DESC" },
        });
        if (previousRenewal) {
            const nextEligibleDate = addCalendarYear(previousRenewal.renewed_at.toISOString().slice(0, 10));
            if (renewalDate < nextEligibleDate) {
                throw new Error(`Voucher was already renewed this year; next renewal is available on ${nextEligibleDate}`);
            }
        }
        const previousExpiry = voucher.expiry_date;
        const newExpiry = renewedExpiryDate(previousExpiry, renewalDate);
        const setting = await manager.findOneBy(Setting, { key: "voucher_renewal_fee_cents" });
        const feeCents = parseSupportedRenewalFeeCents(setting?.value ?? "0");
        if (feeCents !== 0n) {
            throw new Error("A paid voucher renewal checkout is required before renewing this voucher");
        }
        const activeCheckout = await manager.findOneBy(PaymentCheckoutSession, {
            renewal_voucher_id: voucher.id,
            purpose: "voucher_renewal",
            status: "reserved",
        });
        if (activeCheckout) {
            throw new Error("Complete or cancel the active paid voucher renewal checkout first");
        }
        const renewal = await manager.save(VoucherRenewal, manager.create(VoucherRenewal, {
            voucher_id: voucher.id,
            previous_expiry_date: previousExpiry,
            new_expiry_date: newExpiry,
            fee_cents: String(feeCents),
            checkout_session_id: null,
            cash_paid_cents: null,
            mpesa_paid_cents: null,
            payment_reference: null,
            renewed_by: actorId,
        }));
        voucher.expiry_date = newExpiry;
        await manager.save(voucher);
        return { voucher, renewal, balance: await this.getBalance(manager, voucher.id) };
    }

    static async startRenewalCheckout(manager: EntityManager, voucherId: string, actorId: string) {
        const voucher = await manager.findOne(CustomerVoucher, {
            where: { id: voucherId },
            lock: { mode: "pessimistic_write" },
        });
        if (!voucher) throw new Error("Voucher not found");
        await this.assertRenewalEligible(manager, voucher.id, todayUtc());
        const setting = await manager.findOneBy(Setting, { key: "voucher_renewal_fee_cents" });
        const feeCents = parseSupportedRenewalFeeCents(setting?.value ?? "0");
        if (feeCents === 0n) throw new Error("Voucher renewal is free; use the free renewal action");

        const activeCheckout = await manager.findOne(PaymentCheckoutSession, {
            where: {
                renewal_voucher_id: voucher.id,
                purpose: "voucher_renewal",
                status: "reserved",
            },
            lock: { mode: "pessimistic_write" },
        });
        if (activeCheckout) {
            if (activeCheckout.cashier_id !== actorId) {
                throw new Error("An active voucher renewal checkout already exists for another user");
            }
            return activeCheckout;
        }

        const { netRevenueCents, vatCents } = calculateInclusiveVatCents(feeCents, 1_600);
        const checkout = manager.create(PaymentCheckoutSession, {
            id: randomUUID(),
            cashier_id: actorId,
            warehouse_id: null,
            customer_id: voucher.customer_id,
            store_credit_barcode: null,
            voucher_number: null,
            voucher_points_redeemed: "0",
            purpose: "voucher_renewal",
            renewal_voucher_id: voucher.id,
            items: [],
            subtotal: Number(centsToKesString(netRevenueCents)),
            tax_amount: Number(centsToKesString(vatCents)),
            total_amount: Number(centsToKesString(feeCents)),
            loyalty_discount: 0,
            cash_amount: 0,
            store_credit_amount: 0,
            status: "reserved",
        });
        return manager.save(checkout);
    }

    static async recordRenewalCashPayment(
        manager: EntityManager,
        checkoutSessionId: string,
        actorId: string,
        tenderCents: bigint,
    ) {
        if (tenderCents <= 0n) throw new Error("Cash payment must be positive");
        const checkout = await manager.findOne(PaymentCheckoutSession, {
            where: { id: checkoutSessionId },
            lock: { mode: "pessimistic_write" },
        });
        if (!checkout || checkout.purpose !== "voucher_renewal" || !checkout.renewal_voucher_id) {
            throw new Error("Voucher renewal checkout not found");
        }
        if (checkout.cashier_id !== actorId || checkout.status !== "reserved") {
            throw new Error("Voucher renewal checkout is not active for this user");
        }
        const priorCashCents = parseKesToCents(String(checkout.cash_amount));
        const transactions = await manager.find(MpesaTransaction, {
            where: { checkout_session_id: checkout.id, cashier_id: actorId },
        });
        if (transactions.some((transaction) => transaction.status === "pending")) {
            throw new Error("Wait for the pending M-Pesa payment to finish before recording cash");
        }
        if (transactions.some((transaction) => transaction.status === "needs_review")) {
            throw new Error("An M-Pesa payment is under review; ask an administrator to resolve it before taking more payment");
        }
        const completedMpesaCents = transactions
            .filter((transaction) => transaction.status === "completed")
            .reduce((sum, transaction) => sum + parseKesToCents(String(transaction.amount)), 0n);
        const feeCents = parseKesToCents(String(checkout.total_amount));
        if (priorCashCents + completedMpesaCents + tenderCents > feeCents) {
            throw new Error("Cash tender exceeds the remaining voucher renewal fee");
        }
        checkout.cash_amount = Number(centsToKesString(priorCashCents + tenderCents));
        return manager.save(checkout);
    }

    static async renewalCheckoutStatus(manager: EntityManager, checkout: PaymentCheckoutSession, actorId: string) {
        const transactions = await manager.find(MpesaTransaction, {
            where: { checkout_session_id: checkout.id, cashier_id: actorId },
            order: { created_at: "ASC" },
        });
        const cashPaidCents = parseKesToCents(String(checkout.cash_amount));
        const mpesaPaidCents = transactions
            .filter((transaction) => transaction.status === "completed")
            .reduce((sum, transaction) => sum + parseKesToCents(String(transaction.amount)), 0n);
        const totalCents = parseKesToCents(String(checkout.total_amount));
        const remainingCents = totalCents - cashPaidCents - mpesaPaidCents;
        const hasUnresolvedMpesa = transactions.some((transaction) =>
            transaction.status === "pending" || transaction.status === "needs_review");
        return {
            id: checkout.id,
            status: checkout.status,
            total_amount: String(checkout.total_amount),
            cash_amount: String(checkout.cash_amount),
            cash_paid_cents: String(cashPaidCents),
            mpesa_paid_cents: String(mpesaPaidCents),
            remaining_cents: String(remainingCents),
            max_mpesa_shillings: String(remainingCents > 0n ? remainingCents / 100n : 0n),
            fully_paid: remainingCents === 0n && !hasUnresolvedMpesa,
            store_credit_amount: String(checkout.store_credit_amount),
            store_credit_barcode: checkout.store_credit_barcode,
            items: checkout.items,
            mpesa_transactions: transactions.map((transaction) => ({
                id: transaction.id,
                status: transaction.status,
                amount: String(transaction.amount),
                mpesa_receipt_number: transaction.mpesa_receipt_number,
                checkout_request_id: transaction.checkout_request_id,
                account_reference: transaction.account_reference,
                result_desc: transaction.result_desc,
                mismatch_reason: transaction.mismatch_reason,
            })),
        };
    }

    static async completeRenewalCheckout(manager: EntityManager, checkoutSessionId: string, actorId: string) {
        const initialCheckout = await manager.findOneBy(PaymentCheckoutSession, { id: checkoutSessionId });
        if (!initialCheckout || initialCheckout.purpose !== "voucher_renewal" || !initialCheckout.renewal_voucher_id) {
            throw new Error("Voucher renewal checkout not found");
        }
        if (initialCheckout.cashier_id !== actorId) throw new Error("Checkout belongs to another user");
        if (initialCheckout.status === "completed") {
            const checkout = initialCheckout;
            const existingRenewal = await manager.findOneBy(VoucherRenewal, { checkout_session_id: checkout.id });
            if (!existingRenewal) throw new Error("Completed renewal checkout is missing its renewal record");
            const voucher = await manager.findOneByOrFail(CustomerVoucher, { id: existingRenewal.voucher_id });
            return { voucher, renewal: existingRenewal, balance: await this.getBalance(manager, voucher.id) };
        }
        if (initialCheckout.status !== "reserved") throw new Error("Voucher renewal checkout is no longer active");

        const shift = await manager.findOne(Shift, {
            where: { cashier_id: actorId, status: ShiftStatus.OPEN },
            lock: { mode: "pessimistic_write" },
        });
        if (!shift) throw new Error("An open shift is required to complete voucher renewal");
        const voucher = await manager.findOne(CustomerVoucher, {
            where: { id: initialCheckout.renewal_voucher_id },
            lock: { mode: "pessimistic_write" },
        });
        if (!voucher) throw new Error("Voucher not found");
        const checkout = await manager.findOne(PaymentCheckoutSession, {
            where: { id: checkoutSessionId },
            lock: { mode: "pessimistic_write" },
        });
        if (!checkout || checkout.purpose !== "voucher_renewal" ||
            checkout.renewal_voucher_id !== voucher.id || checkout.cashier_id !== actorId) {
            throw new Error("Voucher renewal checkout changed while being completed");
        }
        if (checkout.status === "completed") {
            const existingRenewal = await manager.findOneBy(VoucherRenewal, { checkout_session_id: checkout.id });
            if (!existingRenewal) throw new Error("Completed renewal checkout is missing its renewal record");
            return { voucher, renewal: existingRenewal, balance: await this.getBalance(manager, voucher.id) };
        }
        if (checkout.status !== "reserved") throw new Error("Voucher renewal checkout is no longer active");

        const transactions = await manager.find(MpesaTransaction, {
            where: { checkout_session_id: checkout.id, cashier_id: actorId },
            order: { created_at: "ASC" },
        });
        if (transactions.some((transaction) => transaction.status === "pending")) {
            throw new Error("An M-Pesa payment is still pending for this voucher renewal");
        }
        if (transactions.some((transaction) => transaction.status === "needs_review")) {
            throw new Error("An M-Pesa payment is under review; an administrator must resolve it before completing renewal");
        }
        const completedTransactions = transactions.filter((transaction) => transaction.status === "completed");
        const cashPaidCents = parseKesToCents(String(checkout.cash_amount));
        const mpesaPaidCents = completedTransactions.reduce(
            (sum, transaction) => sum + parseKesToCents(String(transaction.amount)),
            0n,
        );
        const feeCents = parseKesToCents(String(checkout.total_amount));
        if (cashPaidCents + mpesaPaidCents !== feeCents) {
            throw new Error("The full voucher renewal fee must be paid before renewal");
        }
        const renewalDate = todayUtc();
        await this.assertRenewalEligible(manager, voucher.id, renewalDate);
        const previousExpiry = voucher.expiry_date;
        const newExpiry = renewedExpiryDate(previousExpiry, renewalDate);
        const paymentReference = [
            `checkout:${checkout.id}`,
            ...completedTransactions.map((transaction) =>
                `mpesa:${transaction.mpesa_receipt_number || transaction.transaction_code}`),
        ].join(";");
        const renewal = await manager.save(VoucherRenewal, manager.create(VoucherRenewal, {
            voucher_id: voucher.id,
            previous_expiry_date: previousExpiry,
            new_expiry_date: newExpiry,
            fee_cents: String(feeCents),
            checkout_session_id: checkout.id,
            cash_paid_cents: String(cashPaidCents),
            mpesa_paid_cents: String(mpesaPaidCents),
            payment_reference: paymentReference,
            renewed_by: actorId,
        }));
        voucher.expiry_date = newExpiry;
        await manager.save(voucher);
        await AccountingService.recordVoucherRenewal(
            manager,
            renewal.id,
            feeCents,
            cashPaidCents,
            mpesaPaidCents,
        );
        shift.expected_cash = centsToKesString(
            parseKesDecimalToCents(String(shift.expected_cash)) + cashPaidCents,
        );
        shift.mpesa_total = centsToKesString(
            parseKesDecimalToCents(String(shift.mpesa_total)) + mpesaPaidCents,
        );
        shift.total_sales = centsToKesString(
            parseKesToCents(String(shift.total_sales)) + feeCents,
        );
        await manager.save(shift);
        checkout.status = "completed";
        await manager.save(checkout);
        return { voucher, renewal, balance: await this.getBalance(manager, voucher.id) };
    }

    private static async assertRenewalEligible(manager: EntityManager, voucherId: string, renewalDate: string) {
        const previousRenewal = await manager.findOne(VoucherRenewal, {
            where: { voucher_id: voucherId },
            order: { renewed_at: "DESC" },
        });
        if (previousRenewal) {
            const nextEligibleDate = addCalendarYear(previousRenewal.renewed_at.toISOString().slice(0, 10));
            if (renewalDate < nextEligibleDate) {
                throw new Error(`Voucher was already renewed this year; next renewal is available on ${nextEligibleDate}`);
            }
        }
    }

    static async adjust(
        manager: EntityManager,
        voucherId: string,
        actorId: string,
        signedPoints: bigint,
        reason: string,
    ) {
        if (!reason.trim()) throw new Error("A reason is required for voucher point adjustments");
        const voucher = await manager.findOne(CustomerVoucher, {
            where: { id: voucherId },
            lock: { mode: "pessimistic_write" },
        });
        if (!voucher) throw new Error("Voucher not found");
        const balance = await this.getBalance(manager, voucher.id);
        if (balance + signedPoints < 0n) throw new Error("Adjustment cannot make the voucher balance negative");
        await this.append(manager, {
            voucherId,
            type: "adjustment",
            points: signedPoints,
            actorId,
            reason: reason.trim(),
        });
        return this.getBalance(manager, voucherId);
    }

    static async logPrint(manager: EntityManager, voucherId: string, actorId: string): Promise<void> {
        await manager.save(VoucherCardPrintLog, manager.create(VoucherCardPrintLog, {
            voucher_id: voucherId,
            printed_by: actorId,
        }));
    }

    static voucherState(voucher: Pick<CustomerVoucher, "expiry_date">, date = todayUtc()) {
        return {
            expired: isVoucherExpired(voucher.expiry_date, date),
            canEarnOrRedeem: !isVoucherExpired(voucher.expiry_date, date),
        };
    }
}
