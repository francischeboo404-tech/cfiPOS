import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import { Setting } from "../entity/Setting";
import { LoyaltyMember } from "../entity/LoyaltyMember";
import { Customer } from "../entity/Customer";
import { normalizeProductUnitOfMeasures } from "../services/ProductCatalogSettings";
import { VoucherService } from "../services/VoucherService";
import { AuthenticatedRequest } from "../middleware/auth";

const settingRepository = AppDataSource.getRepository(Setting);
const loyaltyMemberRepository = AppDataSource.getRepository(LoyaltyMember);
const customerRepository = AppDataSource.getRepository(Customer);

const RECEIPT_SETTING_KEYS = new Set([
    "company_name",
    "company_address",
    "company_phone",
    "tax_pin",
    "company_logo",
    "receipt_footer",
    "mpesa_paybill",
    "mpesa_till_number",
    "mpesa_shortcode",
]);

const SETTINGS_KEYS = new Set([
    "company_name",
    "company_address",
    "company_phone",
    "tax_pin",
    "mpesa_paybill",
    "mpesa_till_number",
    "mpesa_shortcode",
    "mpesa_stk_account_type",
    "mpesa_callback_url",
    "receipt_footer",
    "loyalty_points_rate",
    "loyalty_points_per_amount",
    "loyalty_points_value",
    "voucher_points_per_100_kes",
    "voucher_renewal_fee_cents",
    "allow_negative_stock",
    "loyalty_tier_silver_min",
    "loyalty_tier_gold_min",
    "loyalty_tier_platinum_min",
    "product_unit_of_measures",
]);

const getTierFromSpent = (totalSpent: number): string => {
    if (totalSpent >= 300000) return "Platinum";
    if (totalSpent >= 150000) return "Gold";
    if (totalSpent >= 50000) return "Silver";
    return "Bronze";
};

const LOYALTY_TIERS = new Set(["Bronze", "Silver", "Gold", "Platinum"]);

export const sanitizeLoyaltyMemberPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Loyalty member payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const customer_id = typeof payload.customer_id === "string" ? payload.customer_id.trim() : "";
    const points = Number(payload.points);
    const total_spent = Number(payload.total_spent);
    const tier = typeof payload.tier === "string" ? payload.tier.trim() : "";

    if (!customer_id) throw new Error("customer_id is required");
    if (!Number.isFinite(points) || points < 0) throw new Error("points must be a non-negative number");
    if (!Number.isFinite(total_spent) || total_spent < 0) throw new Error("total_spent must be a non-negative number");
    if (!tier || !LOYALTY_TIERS.has(tier)) throw new Error("tier is invalid");

    return {
        customer_id,
        points,
        total_spent,
        tier,
    };
};

export const sanitizeLoyaltyPointsPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Loyalty points payload must be an object");
    }

    const payload = input as Record<string, unknown>;
    const points = Number(payload.points);
    const amount = Number(payload.amount);

    if (!Number.isFinite(points) || points <= 0) throw new Error("points must be a positive number");
    if (!Number.isFinite(amount) || amount < 0) throw new Error("amount must be a non-negative number");

    return { points, amount };
};

export const sanitizeSettingsPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {} as Record<string, string>;
    }

    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!SETTINGS_KEYS.has(key) || value === undefined || value === null) {
            continue;
        }

        if (key === "product_unit_of_measures") {
            let parsed: unknown;
            try {
                parsed = typeof value === "string" ? JSON.parse(value) : value;
            } catch {
                throw new Error("Product units must be a valid JSON list.");
            }
            sanitized[key] = JSON.stringify(normalizeProductUnitOfMeasures(parsed));
            continue;
        }

        if (key === "mpesa_stk_account_type") {
            if (value !== "till" && value !== "paybill") {
                throw new Error("M-Pesa STK account type must be Till or Paybill.");
            }
            sanitized[key] = value;
            continue;
        }

        if (key === "mpesa_callback_url") {
            const url = String(value).trim();
            if (url) {
                let parsed: URL;
                try {
                    parsed = new URL(url);
                } catch {
                    throw new Error("mpesa_callback_url must be a valid HTTPS URL ending in /api/webhooks/mpesa/callback");
                }
                const isLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
                    parsed.hostname.endsWith(".local") ||
                    /^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(parsed.hostname);
                const pathOk = parsed.pathname.replace(/\/+$/, "").endsWith("/api/webhooks/mpesa/callback");
                if (parsed.protocol !== "https:" || parsed.username || parsed.password || isLocal || !pathOk) {
                    throw new Error("STK callback URL must be a public HTTPS URL ending in /api/webhooks/mpesa/callback");
                }
            }
            sanitized[key] = url;
            continue;
        }

        if (key === "voucher_points_per_100_kes" || key === "voucher_renewal_fee_cents") {
            const integerValue = String(value).trim();
            if (!/^\d{1,10}$/.test(integerValue)) {
                throw new Error(`${key} must be a non-negative whole number.`);
            }
            sanitized[key] = integerValue;
            continue;
        }

        if (key === "allow_negative_stock") {
            if (value !== "true" && value !== "false" && value !== true && value !== false) {
                throw new Error("allow_negative_stock must be true or false.");
            }
            sanitized[key] = String(value);
            continue;
        }

        if (key === "mpesa_shortcode" || key === "mpesa_till_number" || key === "mpesa_paybill") {
            const number = String(value).trim();
            if (number !== "" && !/^\d{5,7}$/.test(number)) {
                throw new Error(`${key} must be a valid 5 to 7 digit M-Pesa number.`);
            }
            sanitized[key] = number;
            continue;
        }

        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            sanitized[key] = String(value);
        }
    }

    return sanitized;
};

export const getCompanyLogoMimeType = (buffer: Buffer): string | null => {
    if (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
        return "image/png";
    }
    if (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
    ) {
        return "image/jpeg";
    }
    if (
        buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
        return "image/webp";
    }
    return null;
};

const buildSettingsMap = (settings: Setting[]) => {
    const settingsMap = settings.reduce((acc, setting) => {
        if (setting.key === "company_logo") {
            return acc;
        }
        acc[setting.key] = setting.value ?? "";
        return acc;
    }, {} as Record<string, string>);
    const logoSetting = settings.find((setting) => setting.key === "company_logo");
    if (logoSetting) {
        settingsMap.company_logo = `/api/company-logo?v=${logoSetting.updated_at.getTime()}`;
    }
    return settingsMap;
};

export class LoyaltyController {
    static async getReceiptSettings(req: Request, res: Response) {
        try {
            const settings = await settingRepository.find();
            return res.json(buildSettingsMap(settings.filter((setting) => RECEIPT_SETTING_KEYS.has(setting.key))));
        } catch (error) {
            console.error("Error fetching receipt settings:", error);
            return res.status(500).json({ message: "Error fetching receipt settings" });
        }
    }

    static async getSettings(req: Request, res: Response) {
        try {
            const settings = await settingRepository.find();
            return res.json(buildSettingsMap(settings));
        } catch (error) {
            console.error("Error fetching loyalty settings:", error);
            return res.status(500).json({ message: "Error fetching loyalty settings" });
        }
    }

    static async saveSettings(req: Request, res: Response) {
        try {
            const incoming = sanitizeSettingsPayload(req.body.settings ?? req.body);
            if (!incoming || Object.keys(incoming).length === 0) {
                return res.status(400).json({ message: "Invalid settings payload" });
            }

            const existing = await settingRepository.find();
            const existingMap = new Map(existing.map((item) => [item.key, item]));

            for (const [key, value] of Object.entries(incoming)) {
                const record = existingMap.get(key) ?? new Setting();
                record.key = key;
                record.value = value;
                existingMap.set(key, record);
            }

            await settingRepository.save(Array.from(existingMap.values()));
            const saved = await settingRepository.find();
            return res.json(buildSettingsMap(saved));
        } catch (error) {
            console.error("Error saving loyalty settings:", error);
            if (error instanceof Error && /Product unit|Configure at least|Configure no more|Product units|Nonzero voucher renewal|allow_negative_stock|STK callback URL|mpesa_callback_url/.test(error.message)) {
                return res.status(400).json({ message: error.message });
            }
            return res.status(500).json({ message: "Error saving loyalty settings" });
        }
    }

    static async uploadCompanyLogo(req: Request & { file?: { size: number; buffer: Buffer } }, res: Response) {
        try {
            const file = req.file;
            if (!file || file.size === 0) {
                return res.status(400).json({ message: "Choose a non-empty PNG, JPEG, or WebP logo file." });
            }

            const mimeType = getCompanyLogoMimeType(file.buffer);
            if (!mimeType) {
                return res.status(400).json({ message: "The logo must be a valid PNG, JPEG, or WebP image." });
            }

            const record = settingRepository.create({
                key: "company_logo",
                value: `data:${mimeType};base64,${file.buffer.toString("base64")}`,
            });
            const saved = await settingRepository.save(record);
            return res.status(200).json({
                company_logo: `/api/company-logo?v=${saved.updated_at.getTime()}`,
            });
        } catch (error) {
            console.error("Error saving company logo:", error);
            return res.status(500).json({ message: "Unable to save the company logo. Please try again." });
        }
    }

    static async deleteCompanyLogo(_req: Request, res: Response) {
        try {
            await settingRepository.delete({ key: "company_logo" });
            return res.status(200).json({ company_logo: null });
        } catch (error) {
            console.error("Error removing company logo:", error);
            return res.status(500).json({ message: "Unable to remove the company logo. Please try again." });
        }
    }

    static async getCompanyLogo(_req: Request, res: Response) {
        try {
            const setting = await settingRepository.findOneBy({ key: "company_logo" });
            const match = setting?.value?.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
            if (!match) {
                return res.status(404).json({ message: "No company logo has been uploaded." });
            }

            const buffer = Buffer.from(match[2], "base64");
            if (getCompanyLogoMimeType(buffer) !== match[1]) {
                return res.status(500).json({ message: "The saved company logo is invalid." });
            }

            return res
                .status(200)
                .set({
                    "Content-Type": match[1],
                    "Content-Length": String(buffer.length),
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "X-Content-Type-Options": "nosniff",
                })
                .send(buffer);
        } catch (error) {
            console.error("Error loading company logo:", error);
            return res.status(500).json({ message: "Unable to load the company logo." });
        }
    }

    static async getMembers(req: Request, res: Response) {
        try {
            const vouchers: Array<Record<string, unknown>> = await AppDataSource.query(`
                SELECT voucher.id, voucher.customer_id,
                    COALESCE(SUM(entry.points), 0)::text AS points,
                    'Bronze' AS tier,
                    customer.total_purchases AS total_spent,
                    voucher.created_at,
                    json_build_object('id', customer.id, 'name', customer.name, 'phone', customer.phone) AS customer
                FROM customer_vouchers voucher
                JOIN customers customer ON customer.id = voucher.customer_id
                LEFT JOIN voucher_ledger entry ON entry.voucher_id = voucher.id
                GROUP BY voucher.id, customer.id
                ORDER BY COALESCE(SUM(entry.points), 0) DESC
            `);
            return res.json(vouchers);
        } catch (error) {
            console.error("Error fetching loyalty members:", error);
            return res.status(500).json({ message: "Error fetching loyalty members" });
        }
    }

    static async createMember(req: AuthenticatedRequest, res: Response) {
        try {
            const customerId = typeof req.body?.customer_id === "string" ? req.body.customer_id.trim() : "";
            if (!customerId || !req.user?.id) return res.status(400).json({ message: "customer_id is required" });
            const customer = await customerRepository.findOneBy({ id: customerId });
            if (!customer) return res.status(404).json({ message: "Customer not found" });
            const voucher = await AppDataSource.transaction((manager) =>
                VoucherService.ensureForCustomer(manager, customer.id, req.user!.id, "customers_screen"));
            return res.status(201).json({
                id: voucher.id,
                customer_id: customer.id,
                points: String(await VoucherService.getBalance(AppDataSource.manager, voucher.id)),
                tier: getTierFromSpent(Number(customer.total_purchases || 0)),
                total_spent: customer.total_purchases,
                customer: { id: customer.id, name: customer.name, phone: customer.phone },
            });
        } catch (error) {
            console.error("Error creating loyalty member:", error);
            return res.status(400).json({ message: error instanceof Error ? error.message : "Error creating loyalty member" });
        }
    }

    static async addPoints(req: Request, res: Response) {
        return res.status(410).json({ message: "Direct points editing is disabled; voucher points are earned through completed sales or an audited admin adjustment." });
    }

    static async redeemPoints(req: Request, res: Response) {
        return res.status(410).json({ message: "Direct points editing is disabled; redeem voucher points during checkout." });
    }

    static async ensureMemberForCustomer(customerId: string, _saleAmount: number, _pointsToAward: number) {
        const customer = await customerRepository.findOneBy({ id: customerId });
        if (!customer) return null;
        return AppDataSource.transaction((manager) =>
            VoucherService.ensureForCustomer(manager, customerId, "system"));
    }
}
