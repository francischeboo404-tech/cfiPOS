import { Sale } from "../../entity/Sale";
import { CreditNote } from "../../entity/CreditNote";
import { randomBytes } from "crypto";
import { PaymentMethod } from "../../entity/Sale";
import { EtimsVscuClient } from "./EtimsVscuClient";
import { buildEtimsSalesPayload, toEtimsSignResult } from "./EtimsSalesPayload";
import { EtimsInvoiceNumberAllocator } from "./EtimsInvoiceNumberAllocator";

export type EtimsMode = "off" | "mock" | "live";

export const ETIMS_LIVE_MODE_AVAILABLE = false;

export enum EtimsStatus {
    NOT_APPLICABLE = "not_applicable",
    PENDING = "pending",
    SUBMITTED = "submitted",
    FAILED = "failed",
}

export const ETIMS_MOCK_DISCLAIMER = "TEST RECEIPT - NOT A VALID TAX INVOICE";
export const ETIMS_OFF_DISCLAIMER = "CUSTOMER RECEIPT - NOT A KRA TAX INVOICE";

export const getEtimsPaymentTypeSettingName = (paymentMethod: PaymentMethod | string): string => {
    switch (paymentMethod) {
        case PaymentMethod.CASH:
            return "ETIMS_PAYMENT_TYPE_CASH";
        case PaymentMethod.MPESA:
            return "ETIMS_PAYMENT_TYPE_MPESA";
        case PaymentMethod.STORE_CREDIT:
            return "ETIMS_PAYMENT_TYPE_STORE_CREDIT";
        case PaymentMethod.HYBRID:
            throw new Error("Live eTIMS does not support hybrid-tender sales until KRA tender allocation is defined.");
        default:
            throw new Error(`Live eTIMS does not support payment method '${paymentMethod}'.`);
    }
};

export interface EtimsSignResult {
    receipt_no: string;
    qr_code: string;
    signature: string;
    is_mock: boolean;
    disclaimer: string;
}

export interface EtimsCreditNoteSignResult {
    note_no: string;
    qr_code: string;
    signature: string;
    is_mock: boolean;
    disclaimer: string;
}

export interface EtimsProvider {
    readonly mode: EtimsMode;
    signInvoice(sale: Sale): Promise<EtimsSignResult | null>;
    signCreditNote(creditNote: CreditNote): Promise<EtimsCreditNoteSignResult | null>;
}

/**
 * Off Provider: No tax submission.
 * Issued as ordinary commercial receipt with clear non-eTIMS notice.
 */
export class OffEtimsProvider implements EtimsProvider {
    readonly mode: EtimsMode = "off";

    async signInvoice(_sale: Sale): Promise<EtimsSignResult | null> {
        return null;
    }

    async signCreditNote(_creditNote: CreditNote): Promise<EtimsCreditNoteSignResult | null> {
        return null;
    }
}

/**
 * Mock Provider: Simulates KRA eTIMS signing with prominent test disclaimers.
 * Allowed in production only if explicitly set via ETIMS_MODE=mock.
 */
export class MockEtimsProvider implements EtimsProvider {
    readonly mode: EtimsMode = "mock";

    async signInvoice(_sale: Sale): Promise<EtimsSignResult | null> {
        await new Promise((resolve) =>
            setTimeout(resolve, process.env.NODE_ENV === "test" ? 10 : 600),
        );

        const suffix = randomBytes(4).toString("hex").toUpperCase();
        const receiptNo = `TEST-ETIMS-${Date.now().toString().slice(-6)}-${suffix}`;
        const signature = `TEST-SIG-${randomBytes(8).toString("hex").toUpperCase()}`;

        const qrCode = new URL("https://etims.invalid/verify");
        qrCode.searchParams.set("invoice", receiptNo);
        qrCode.searchParams.set("sig", signature);
        qrCode.searchParams.set("mock", "true");

        return {
            receipt_no: receiptNo,
            qr_code: qrCode.toString(),
            signature,
            is_mock: true,
            disclaimer: ETIMS_MOCK_DISCLAIMER,
        };
    }

    async signCreditNote(_creditNote: CreditNote): Promise<EtimsCreditNoteSignResult | null> {
        await new Promise((resolve) =>
            setTimeout(resolve, process.env.NODE_ENV === "test" ? 10 : 600),
        );

        const suffix = randomBytes(4).toString("hex").toUpperCase();
        const noteNo = `TEST-CN-ETIMS-${Date.now().toString().slice(-6)}-${suffix}`;
        const signature = `TEST-CNSIG-${randomBytes(8).toString("hex").toUpperCase()}`;

        const qrCode = new URL("https://etims.invalid/verify-cn");
        qrCode.searchParams.set("invoice", noteNo);
        qrCode.searchParams.set("sig", signature);
        qrCode.searchParams.set("mock", "true");

        return {
            note_no: noteNo,
            qr_code: qrCode.toString(),
            signature,
            is_mock: true,
            disclaimer: ETIMS_MOCK_DISCLAIMER,
        };
    }
}

/**
 * Candidate direct-VSCU provider. Production mode remains disabled until the
 * contract and end-to-end behavior are verified against the official sandbox.
 */
export class LiveEtimsProvider implements EtimsProvider {
    readonly mode: EtimsMode = "live";
    private client: EtimsVscuClient | null = null;
    private initialization: Promise<void> | null = null;

    constructor() {
        this.validateLiveConfiguration();
    }

    validateLiveConfiguration(): void {
        if (!ETIMS_LIVE_MODE_AVAILABLE) {
            throw new Error(
                "Live eTIMS is disabled until the KRA VSCU integration is implemented and verified. Use ETIMS_MODE=off or mock.",
            );
        }

        const requiredEnv = [
            "ETIMS_KRA_PIN",
            "ETIMS_BRANCH_ID",
            "ETIMS_DEVICE_SERIAL",
            "ETIMS_VSCU_BASE_URL",
            "ETIMS_INITIAL_INVOICE_NUMBER",
            "ETIMS_PAYMENT_TYPE_CASH",
            "ETIMS_PAYMENT_TYPE_MPESA",
            "ETIMS_PAYMENT_TYPE_STORE_CREDIT",
        ];
        const missing = requiredEnv.filter((key) => !process.env[key]?.trim());
        if (missing.length > 0) {
            throw new Error(
                `eTIMS Live configuration is incomplete. Missing environment variables: ${missing.join(", ")}. See docs/ETIMS_INTEGRATION.md.`,
            );
        }
    }

    private getClient(): EtimsVscuClient {
        if (!this.client) {
            const baseUrl = process.env.ETIMS_VSCU_BASE_URL?.trim();
            if (!baseUrl) throw new Error("ETIMS_VSCU_BASE_URL is required for live VSCU.");
            this.client = new EtimsVscuClient(baseUrl);
        }
        return this.client;
    }

    private async ensureInitialized(): Promise<void> {
        const client = this.getClient();
        if (!this.initialization) {
            this.initialization = client.initializeDevice({
                tin: process.env.ETIMS_KRA_PIN!.trim(),
                bhId: process.env.ETIMS_BRANCH_ID!.trim(),
                dvcId: process.env.ETIMS_DEVICE_SERIAL!.trim(),
            }).then(() => undefined).catch((error: unknown) => {
                this.initialization = null;
                throw error;
            });
        }
        await this.initialization;
    }

    private getPaymentTypeCode(paymentMethod: PaymentMethod): string {
        const settingName = getEtimsPaymentTypeSettingName(paymentMethod);
        const paymentTypeCode = process.env[settingName]?.trim();
        if (!paymentTypeCode) throw new Error(`${settingName} is required for live VSCU submissions.`);
        return paymentTypeCode;
    }

    async signInvoice(sale: Sale): Promise<EtimsSignResult> {
        await this.ensureInitialized();
        const existingInvoiceNumber = sale.etims_invoice_number
            ? Number(sale.etims_invoice_number)
            : null;
        if (existingInvoiceNumber !== null &&
            (!Number.isSafeInteger(existingInvoiceNumber) || existingInvoiceNumber <= 0)) {
            throw new Error("Sale has an invalid reserved VSCU invoice number; reconcile it before submission.");
        }

        const client = this.getClient();
        const payload = buildEtimsSalesPayload(sale, {
            tin: process.env.ETIMS_KRA_PIN!.trim(),
            branchId: process.env.ETIMS_BRANCH_ID!.trim(),
            deviceId: process.env.ETIMS_DEVICE_SERIAL!.trim(),
            invoiceNumber: existingInvoiceNumber || 1,
            paymentTypeCode: this.getPaymentTypeCode(sale.payment_method),
        });
        const invoiceNumber = existingInvoiceNumber ??
            await EtimsInvoiceNumberAllocator.reserveForSale(sale);
        payload.invcNo = invoiceNumber;
        return toEtimsSignResult(await client.saveSales(payload));
    }

    async signCreditNote(_creditNote: CreditNote): Promise<EtimsCreditNoteSignResult | null> {
        throw new Error(
            "Live VSCU credit-note submission is not implemented; the original invoice-number reference and return-line payload must be verified before submission.",
        );
    }
}
