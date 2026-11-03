import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { CustomerVoucher } from "../entity/CustomerVoucher";
import { AuthenticatedRequest } from "../middleware/auth";
import { VoucherService } from "../services/VoucherService";
import { Shift, ShiftStatus } from "../entity/Shift";
import { parseKesToCents } from "../lib/exactMoney";
import { Setting } from "../entity/Setting";
import { parseSupportedRenewalFeeCents } from "../lib/voucherRules";

const actorId = (req: AuthenticatedRequest): string => {
    if (!req.user?.id) throw new Error("Authenticated user is required");
    return req.user.id;
};

export class VoucherController {
    static async startRenewalCheckout(req: AuthenticatedRequest, res: Response) {
        try {
            const userId = actorId(req);
            const result = await AppDataSource.transaction(async (manager) => {
                const setting = await manager.findOneBy(Setting, { key: "voucher_renewal_fee_cents" });
                const feeCents = parseSupportedRenewalFeeCents(setting?.value ?? "0");
                if (feeCents === 0n) {
                    const freeRenewal = await VoucherService.renew(manager, req.params.id, userId);
                    return {
                        renewed: true as const,
                        result: {
                            number: freeRenewal.voucher.voucher_number,
                            expiryDate: freeRenewal.voucher.expiry_date,
                            balance: String(freeRenewal.balance),
                            renewalId: freeRenewal.renewal.id,
                        },
                    };
                }
                const shift = await manager.findOne(Shift, {
                    where: { cashier_id: userId, status: ShiftStatus.OPEN },
                    lock: { mode: "pessimistic_write" },
                });
                if (!shift) throw new Error("Open a shift before starting a paid voucher renewal");
                const checkout = await VoucherService.startRenewalCheckout(manager, req.params.id, userId);
                return {
                    renewed: false as const,
                    result: await VoucherService.renewalCheckoutStatus(manager, checkout, userId),
                };
            });
            return res.status(result.renewed ? 200 : 201).json(result.result);
        } catch (error) {
            console.error("Error starting voucher renewal checkout:", error);
            return res.status(400).json({
                message: error instanceof Error ? error.message : "Unable to start voucher renewal checkout",
            });
        }
    }

    static async recordRenewalCash(req: AuthenticatedRequest, res: Response) {
        try {
            const rawAmount = typeof req.body?.amount === "string" || typeof req.body?.amount === "number"
                ? String(req.body.amount)
                : "";
            const tenderCents = parseKesToCents(rawAmount);
            const checkout = await AppDataSource.transaction(async (manager) => {
                const shift = await manager.findOne(Shift, {
                    where: { cashier_id: actorId(req), status: ShiftStatus.OPEN },
                    lock: { mode: "pessimistic_write" },
                });
                if (!shift) throw new Error("An open shift is required to record cash");
                return VoucherService.recordRenewalCashPayment(
                    manager,
                    String(req.params.checkoutSessionId || ""),
                    actorId(req),
                    tenderCents,
                );
            });
            return res.json(await VoucherService.renewalCheckoutStatus(
                AppDataSource.manager,
                checkout,
                actorId(req),
            ));
        } catch (error) {
            console.error("Error recording voucher renewal cash payment:", error);
            return res.status(400).json({
                message: error instanceof Error ? error.message : "Unable to record cash payment",
            });
        }
    }

    static async completeRenewalCheckout(req: AuthenticatedRequest, res: Response) {
        try {
            const result = await AppDataSource.transaction((manager) =>
                VoucherService.completeRenewalCheckout(
                    manager,
                    String(req.params.checkoutSessionId || ""),
                    actorId(req),
                ));
            return res.json({
                number: result.voucher.voucher_number,
                expiryDate: result.voucher.expiry_date,
                balance: String(result.balance),
                renewalId: result.renewal.id,
            });
        } catch (error) {
            console.error("Error completing voucher renewal checkout:", error);
            return res.status(409).json({
                message: error instanceof Error ? error.message : "Unable to complete voucher renewal",
            });
        }
    }

    static async findByNumber(req: Request, res: Response) {
        try {
            const number = typeof req.params.number === "string" ? req.params.number : "";
            if (!/^\d{10}$/.test(number)) return res.status(400).json({ message: "Voucher number must contain 10 digits" });
            const voucher = await AppDataSource.getRepository(CustomerVoucher).findOne({
                where: { voucher_number: number },
                relations: ["customer"],
            });
            if (!voucher) return res.status(404).json({ message: "Voucher not found" });
            const balance = await VoucherService.getBalance(AppDataSource.manager, voucher.id);
            return res.json({
                id: voucher.id,
                number: voucher.voucher_number,
                issueDate: voucher.issue_date,
                expiryDate: voucher.expiry_date,
                customer: { id: voucher.customer.id, name: voucher.customer.name, phone: voucher.customer.phone },
                balance: String(balance),
                ...VoucherService.voucherState(voucher),
            });
        } catch (error) {
            console.error("Error looking up customer voucher:", error);
            return res.status(500).json({ message: "Unable to look up voucher" });
        }
    }

    static async renew(req: AuthenticatedRequest, res: Response) {
        try {
            const result = await AppDataSource.transaction((manager) =>
                VoucherService.renew(manager, req.params.id, actorId(req)));
            return res.json({
                number: result.voucher.voucher_number,
                expiryDate: result.voucher.expiry_date,
                balance: String(result.balance),
                renewalId: result.renewal.id,
            });
        } catch (error) {
            console.error("Error renewing customer voucher:", error);
            return res.status(400).json({ message: error instanceof Error ? error.message : "Unable to renew voucher" });
        }
    }

    static async adjust(req: AuthenticatedRequest, res: Response) {
        try {
            const rawPoints = typeof req.body?.points === "string" || typeof req.body?.points === "number"
                ? String(req.body.points)
                : "";
            const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
            if (!/^-?\d+$/.test(rawPoints) || BigInt(rawPoints) === 0n || reason.length < 3 || reason.length > 500) {
                return res.status(400).json({ message: "A non-zero whole points adjustment and a reason are required" });
            }
            const balance = await AppDataSource.transaction((manager) =>
                VoucherService.adjust(manager, req.params.id, actorId(req), BigInt(rawPoints), reason));
            return res.json({ balance: String(balance) });
        } catch (error) {
            console.error("Error adjusting voucher points:", error);
            return res.status(400).json({ message: error instanceof Error ? error.message : "Unable to adjust voucher points" });
        }
    }

    static async logPrint(req: AuthenticatedRequest, res: Response) {
        try {
            const voucher = await AppDataSource.getRepository(CustomerVoucher).findOneBy({ id: req.params.id });
            if (!voucher) return res.status(404).json({ message: "Voucher not found" });
            await VoucherService.logPrint(AppDataSource.manager, voucher.id, actorId(req));
            return res.status(204).send();
        } catch (error) {
            console.error("Error logging voucher print:", error);
            return res.status(500).json({ message: "Unable to log voucher print" });
        }
    }
}
