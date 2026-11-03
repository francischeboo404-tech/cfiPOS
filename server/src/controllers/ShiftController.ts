import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Shift, ShiftStatus } from "../entity/Shift";
import { User } from "../entity/User";
import { Sale, SaleStatus } from "../entity/Sale";
import { Between, In } from "typeorm";
import { ReturnRequest, ReturnStatus, RefundMethod, MpesaRefundStatus } from "../entity/ReturnRequest";
import { CreditNote } from "../entity/CreditNote";
import { MpesaTransaction } from "../entity/MpesaTransaction";
import { VoucherRenewal } from "../entity/VoucherRenewal";
import { getErrorMessage } from "../utils/errors";
import { centsToKesString, divideRoundHalfUp, parseKesToCents } from "../lib/exactMoney";

const shiftRepo = AppDataSource.getRepository(Shift);

export const sanitizeShiftCurrency = (value: unknown, fieldName: string) => {
    const input = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(input)) {
        throw new Error(`${fieldName} must be a non-negative number with at most two decimal places`);
    }
    return centsToKesString(parseKesToCents(input));
};

export class ShiftController {
    
    // Open Register
    static async openShift(req: AuthenticatedRequest, res: Response) {
        try {
            const { opening_float } = req.body;
            const cashier = await AppDataSource.manager.findOneBy(User, { id: req.user!.id });

            if (!cashier) return res.status(401).json({ message: "Invalid user" });

            const parsedOpeningFloat = sanitizeShiftCurrency(opening_float ?? 0, "opening_float");

            // Give a clear response for the common case; the unique index handles concurrent opens.
            const existing = await shiftRepo.findOneBy({ cashier_id: cashier.id, status: ShiftStatus.OPEN });
            if (existing) {
                return res.status(409).json({ message: "You already have an open shift. Close it before opening a new one." });
            }

            const shift = new Shift();
            shift.cashier = cashier;
            shift.opening_float = parsedOpeningFloat;
            await shiftRepo.save(shift);

            res.status(201).json(shift);
        } catch (err) {
            const databaseCode = err && typeof err === "object" && "code" in err
                ? err.code
                : err && typeof err === "object" && "driverError" in err
                    ? (err as { driverError?: { code?: unknown } }).driverError?.code
                    : undefined;
            if (databaseCode === "23505") {
                return res.status(409).json({ message: "You already have an open shift. Close it before opening a new one." });
            }
            console.error("Failed to open shift:", err);
            res.status(400).json({ message: "Failed to open shift", error: getErrorMessage(err, "Unknown error") });
        }
    }

    // Z-Report / Close Register
    static async closeShift(req: AuthenticatedRequest, res: Response) {
        const queryRunner = AppDataSource.createQueryRunner();
        try {
            const id = req.params.id;
            const { actual_cash, notes } = req.body;
            if (actual_cash === undefined || actual_cash === null ||
                (typeof actual_cash === "string" && actual_cash.trim() === "")) {
                throw new Error("actual_cash is required when closing a shift");
            }

            await queryRunner.connect();
            await queryRunner.startTransaction();

            const shift = await queryRunner.manager.findOne(Shift, {
                where: { id },
                lock: { mode: "pessimistic_write" },
            });
            if (!shift) {
                await queryRunner.rollbackTransaction();
                return res.status(404).json({ message: "Shift not found" });
            }

            if (shift.status === ShiftStatus.CLOSED) {
                await queryRunner.rollbackTransaction();
                return res.status(400).json({ message: "Shift is already closed." });
            }

            if (shift.cashier_id !== req.user!.id && req.user!.role !== "admin") {
                await queryRunner.rollbackTransaction();
                return res.status(403).json({ message: "Not authorized to close this shift." });
            }

            const parsedActualCash = sanitizeShiftCurrency(actual_cash, "actual_cash");
            const sanitizedNotes = typeof notes === "string" ? notes.trim().slice(0, 500) : "";
            const unresolvedPayments = await queryRunner.manager.createQueryBuilder(MpesaTransaction, "payment")
                .setLock("pessimistic_write")
                .where(`payment."cashier_id" = :cashierId`, { cashierId: shift.cashier_id })
                .andWhere(`(
                    payment."status" IN ('pending', 'needs_review') OR
                    (payment."status" = 'completed' AND payment."sale_id" IS NULL AND NOT EXISTS (
                        SELECT 1
                        FROM "payment_checkout_sessions" checkout
                        JOIN "voucher_renewals" renewal
                            ON renewal."checkout_session_id" = checkout."id"
                        WHERE checkout."id" = payment."checkout_session_id"
                            AND checkout."purpose" = 'voucher_renewal'
                            AND checkout."status" = 'completed'
                    ))
                )`)
                .getMany();
            if (unresolvedPayments.length > 0) {
                await queryRunner.rollbackTransaction();
                return res.status(409).json({
                    message: "Resolve pending or review-required M-Pesa payments and finalize completed checkouts before closing this shift.",
                });
            }

            shift.end_time = new Date();

            // Calculate Expectancies
            const sales = await queryRunner.manager.find(Sale, {
                where: {
                    cashier: { id: shift.cashier_id },
                    created_at: Between(shift.start_time, shift.end_time),
                    status: In([SaleStatus.COMPLETED, SaleStatus.PARTIALLY_REFUNDED])
                }
            });

            let expectedCashCents = parseKesToCents(String(shift.opening_float));
            let mpesaTotalCents = 0n;
            let totalSalesCents = 0n;

            for (const sale of sales) {
                const saleCashCents = parseKesToCents(String(sale.cash_amount));
                const changeCents = parseKesToCents(String(sale.change_amount || 0));
                expectedCashCents += saleCashCents > changeCents ? saleCashCents - changeCents : 0n;
                mpesaTotalCents += parseKesToCents(String(sale.mpesa_amount));
                totalSalesCents += parseKesToCents(String(sale.total_amount));
            }
            const voucherRenewals = await queryRunner.manager.find(VoucherRenewal, {
                where: {
                    renewed_by: shift.cashier_id,
                    renewed_at: Between(shift.start_time, shift.end_time),
                },
            });
            for (const renewal of voucherRenewals) {
                expectedCashCents += BigInt(renewal.cash_paid_cents || "0");
                mpesaTotalCents += BigInt(renewal.mpesa_paid_cents || "0");
                totalSalesCents += BigInt(renewal.fee_cents);
            }

            const refunds = await queryRunner.manager.find(ReturnRequest, {
                where: [
                    {
                        requested_by: { id: shift.cashier_id },
                        status: ReturnStatus.APPROVED,
                        refund_method: RefundMethod.CASH,
                        updated_at: Between(shift.start_time, shift.end_time),
                    },
                    {
                        mpesa_refund_completed_by: { id: shift.cashier_id },
                        status: ReturnStatus.APPROVED,
                        refund_method: RefundMethod.MPESA,
                        mpesa_refund_status: MpesaRefundStatus.COMPLETED,
                        mpesa_refund_completed_at: Between(shift.start_time, shift.end_time),
                    },
                ],
                relations: ["items", "items.sale_item"],
            });
            const refundIds = refunds.map((refund) => refund.id);
            const creditNotes = refundIds.length > 0
                ? await queryRunner.manager.find(CreditNote, {
                    where: { return_request: { id: In(refundIds) } },
                    relations: ["return_request"],
                })
                : [];
            const refundAmounts = new Map(
                creditNotes
                    .filter((creditNote) => creditNote.return_request)
                    .map((creditNote) => [creditNote.return_request!.id, parseKesToCents(String(creditNote.amount))]),
            );

            for (const returnRequest of refunds) {
                if (returnRequest.refund_method === RefundMethod.CASH) {
                    const recordedRefundAmount = refundAmounts.get(returnRequest.id);
                    if (recordedRefundAmount !== undefined) {
                        expectedCashCents -= recordedRefundAmount;
                    } else {
                        for (const returnItem of returnRequest.items) {
                            const saleItem = returnItem.sale_item;
                            const lineTotalCents = parseKesToCents(String(saleItem.line_total));
                            expectedCashCents -= divideRoundHalfUp(
                                lineTotalCents * BigInt(returnItem.quantity),
                                BigInt(saleItem.quantity),
                            );
                        }
                    }
                }
                if (returnRequest.refund_method === RefundMethod.MPESA) {
                    mpesaTotalCents -= parseKesToCents(String(returnRequest.mpesa_refund_amount));
                }
            }

            shift.expected_cash = centsToKesString(expectedCashCents);
            shift.mpesa_total = centsToKesString(mpesaTotalCents);
            shift.total_sales = centsToKesString(totalSalesCents);
            shift.actual_cash = parsedActualCash;
            shift.notes = sanitizedNotes;
            shift.status = ShiftStatus.CLOSED;

            await queryRunner.manager.save(shift);
            await queryRunner.commitTransaction();

            res.json({
                message: "Shift closed. Z-Report generated.",
                shift
            });

        } catch (err) {
            if (queryRunner.isTransactionActive) {
                await queryRunner.rollbackTransaction();
            }
            res.status(400).json({ message: "Failed to close shift", error: getErrorMessage(err, "Unknown error") });
        } finally {
            await queryRunner.release();
        }
    }

    static async getCurrentShift(req: AuthenticatedRequest, res: Response) {
        try {
            const shift = await shiftRepo.findOne({
                where: { cashier_id: req.user!.id, status: ShiftStatus.OPEN },
                relations: ["cashier"]
            });
            if (!shift) return res.status(404).json({ message: "No open shift found" });
            res.json(shift);
        } catch (err) {
            res.status(400).json({ message: "Failed to fetch shift" });
        }
    }

    static async getAllShifts(req: AuthenticatedRequest, res: Response) {
        try {
            const canViewAll = ["supervisor", "manager", "admin"].includes(req.user!.role);
            const whereClause = canViewAll ? {} : { cashier_id: req.user!.id };
            const shifts = await shiftRepo.find({
                where: whereClause,
                relations: ["cashier"],
                order: { start_time: "DESC" },
                take: 50 // Limit to last 50 shifts for performance
            });
            res.json(shifts);
        } catch (err) {
            res.status(400).json({ message: "Failed to fetch shifts", error: getErrorMessage(err, "Unknown error") });
        }
    }
}
