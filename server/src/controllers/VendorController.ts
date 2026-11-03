import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppDataSource } from "../data-source";
import { Vendor } from "../entity/Vendor";
import { PurchaseOrder } from "../entity/PurchaseOrder";
import { SupplierInvoice } from "../entity/SupplierInvoice";

const VENDOR_ALLOWED_FIELDS = new Set([
    "name",
    "contact_person",
    "phone",
    "email",
    "address",
    "payment_terms",
]);

export const sanitizeVendorPayload = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {} as Partial<Vendor>;
    }

    const sanitized: Partial<Vendor> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!VENDOR_ALLOWED_FIELDS.has(key) || value === undefined || value === null) {
            continue;
        }

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed === "" && (key === "name" || key === "email" || key === "phone")) continue;
            if (key === "name") sanitized.name = trimmed;
            else if (key === "contact_person") sanitized.contact_person = trimmed;
            else if (key === "phone") sanitized.phone = trimmed;
            else if (key === "email") sanitized.email = trimmed;
            else if (key === "address") sanitized.address = trimmed;
            else if (key === "payment_terms") sanitized.payment_terms = trimmed;
        }
    }

    return sanitized;
};

export class VendorController {
    static async getPortalData(req: AuthenticatedRequest, res: Response) {
        try {
            const email = req.user?.email;
            if (!email) {
                return res.status(400).json({ message: "Authenticated email is required" });
            }

            const vendor = await AppDataSource.getRepository(Vendor).findOne({ where: { email } });
            if (!vendor) {
                return res.status(404).json({ message: "No vendor account found for this email" });
            }

            const [purchaseOrders, invoices] = await Promise.all([
                AppDataSource.getRepository(PurchaseOrder).find({
                    where: { vendor_id: vendor.id },
                    order: { created_at: "DESC" },
                }),
                AppDataSource.getRepository(SupplierInvoice).find({
                    where: { vendor_id: vendor.id },
                    order: { created_at: "DESC" },
                }),
            ]);

            res.json({ vendor, purchaseOrders, invoices });
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching vendor portal data" });
        }
    }

    static async getAllVendors(req: Request, res: Response) {
        try {
            const vendorRepo = AppDataSource.getRepository(Vendor);
            const vendors = await vendorRepo.find({ order: { name: "ASC" } });
            res.json(vendors);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching vendors" });
        }
    }

    static async getVendor(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const vendorRepo = AppDataSource.getRepository(Vendor);
            const vendor = await vendorRepo.findOne({ where: { id } });
            if (!vendor) {
                return res.status(404).json({ message: "Vendor not found" });
            }
            res.json(vendor);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error fetching vendor" });
        }
    }

    static async createVendor(req: Request, res: Response) {
        try {
            const vendorRepo = AppDataSource.getRepository(Vendor);
            const payload = sanitizeVendorPayload(req.body);
            if (!payload.name) {
                return res.status(400).json({ message: "Vendor name is required" });
            }

            const newVendor = vendorRepo.create(payload);
            await vendorRepo.save(newVendor);
            res.status(201).json(newVendor);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error creating vendor" });
        }
    }

    static async updateVendor(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const vendorRepo = AppDataSource.getRepository(Vendor);
            const vendor = await vendorRepo.findOne({ where: { id } });
            if (!vendor) {
                return res.status(404).json({ message: "Vendor not found" });
            }
            vendorRepo.merge(vendor, sanitizeVendorPayload(req.body));
            await vendorRepo.save(vendor);
            res.json(vendor);
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error updating vendor" });
        }
    }

    static async markVendorReviewed(req: AuthenticatedRequest, res: Response) {
        try {
            const vendorRepo = AppDataSource.getRepository(Vendor);
            const vendor = await vendorRepo.findOne({ where: { id: req.params.id as string } });
            if (!vendor) {
                return res.status(404).json({ message: "Supplier not found" });
            }
            if (!req.user?.id) {
                return res.status(401).json({ message: "Reviewer identity is required" });
            }
            vendor.needs_review = false;
            vendor.reviewed_at = new Date();
            vendor.reviewed_by = req.user.id;
            await vendorRepo.save(vendor);
            return res.json(vendor);
        } catch (error) {
            console.error("Error reviewing supplier:", error);
            return res.status(500).json({ message: "Error reviewing supplier" });
        }
    }

    static async deleteVendor(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const vendorRepo = AppDataSource.getRepository(Vendor);
            const vendor = await vendorRepo.findOne({ where: { id } });
            if (!vendor) {
                return res.status(404).json({ message: "Vendor not found" });
            }
            await vendorRepo.remove(vendor);
            res.status(204).send();
        } catch (error) {
            console.error(error);
            res.status(500).json({ message: "Error deleting vendor" });
        }
    }
}
