import { AppDataSource } from "../../data-source";
import { Sale } from "../../entity/Sale";
import { CreditNote } from "../../entity/CreditNote";
import {
    EtimsMode,
    EtimsProvider,
    EtimsStatus,
    OffEtimsProvider,
    MockEtimsProvider,
    LiveEtimsProvider,
    ETIMS_LIVE_MODE_AVAILABLE,
} from "./EtimsProvider";
import { SocketService } from "../SocketService";
import { EtimsMockService } from "../EtimsMockService";

export class EtimsService {
    private static cachedProvider: EtimsProvider | null = null;
    private static cachedMode: EtimsMode | null = null;

    /**
     * Resolves the configured eTIMS operating mode.
     * In production, ETIMS_MODE must be explicitly declared as 'off', 'mock', or 'live'.
     */
    static resolveEtimsMode(): EtimsMode {
        const rawMode = (process.env.ETIMS_MODE || "").trim().toLowerCase();
        if (rawMode === "off" || rawMode === "mock" || rawMode === "live") {
            if (rawMode === "live" && !ETIMS_LIVE_MODE_AVAILABLE) {
                throw new Error(
                    "Live eTIMS is disabled until the KRA VSCU integration is implemented and verified. Use ETIMS_MODE=off or mock.",
                );
            }
            return rawMode as EtimsMode;
        }

        if (rawMode !== "") {
            throw new Error(`Invalid ETIMS_MODE '${rawMode}'. Supported modes are 'off', 'mock', or 'live'.`);
        }

        // Deprecated backward-compatible alias
        if (process.env.ALLOW_SIMULATED_ETIMS === "true") {
            return "mock";
        }

        if (process.env.NODE_ENV === "production") {
            throw new Error(
                "FATAL: ETIMS_MODE must be explicitly set to 'off', 'mock', or 'live' in production.",
            );
        }

        return "mock";
    }

    /**
     * Retrieves or instantiates the active EtimsProvider.
     */
    static getProvider(): EtimsProvider {
        const mode = this.resolveEtimsMode();
        if (this.cachedProvider && this.cachedMode === mode) {
            return this.cachedProvider;
        }

        this.cachedMode = mode;
        switch (mode) {
            case "off":
                this.cachedProvider = new OffEtimsProvider();
                break;
            case "mock":
                this.cachedProvider = new MockEtimsProvider();
                break;
            case "live":
                this.cachedProvider = new LiveEtimsProvider();
                break;
        }

        return this.cachedProvider;
    }

    /**
     * Clear cached provider (useful for test isolation).
     */
    static resetProvider(): void {
        this.cachedProvider = null;
        this.cachedMode = null;
    }

    /**
     * Signs a committed sale asynchronously outside the database transaction.
     */
    static async processSaleSigning(saleId: string): Promise<Sale | null> {
        const saleRepository = AppDataSource.getRepository(Sale);
        const sale = await saleRepository.findOne({
            where: { id: saleId },
            relations: ["items", "items.product", "customer", "warehouse"],
        });

        if (!sale) return null;
        if (sale.etims_status === EtimsStatus.SUBMITTED || sale.etims_status === EtimsStatus.NOT_APPLICABLE) {
            return sale;
        }

        const provider = this.getProvider();
        if (provider.mode === "off") {
            sale.etims_status = EtimsStatus.NOT_APPLICABLE;
            sale.etims_last_error = null;
            return await saleRepository.save(sale);
        }

        sale.etims_attempts = (sale.etims_attempts || 0) + 1;

        try {
            const signed = await EtimsMockService.signInvoice(sale);
            if (signed) {
                sale.etims_receipt_no = signed.receipt_no;
                sale.etims_qr_code = signed.qr_code;
                sale.etims_signature = signed.signature;
                sale.etims_status = EtimsStatus.SUBMITTED;
                sale.etims_submitted_at = new Date();
                sale.etims_last_error = null;
            } else {
                sale.etims_status = EtimsStatus.NOT_APPLICABLE;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (provider.mode === "live") {
                sale.etims_status = EtimsStatus.FAILED;
                sale.etims_last_error = `${message} Live submission outcome may be uncertain. Reconcile invoice ${sale.etims_invoice_number || "number unavailable"} with the VSCU daemon before retrying.`;
            } else if (sale.etims_attempts >= 5) {
                sale.etims_status = EtimsStatus.FAILED;
                sale.etims_last_error = message;
            } else {
                sale.etims_status = EtimsStatus.PENDING;
                sale.etims_last_error = message;
            }
        }

        const savedSale = await saleRepository.save(sale);
        try {
            SocketService.emitEtimsStatusUpdated(
                savedSale.id,
                savedSale.etims_status,
                savedSale.etims_receipt_no,
            );
        } catch {
            // Non-blocking socket emission
        }

        return savedSale;
    }

    /**
     * Signs a committed credit note asynchronously outside the database transaction.
     */
    static async processCreditNoteSigning(creditNoteId: string): Promise<CreditNote | null> {
        const creditNoteRepository = AppDataSource.getRepository(CreditNote);
        const creditNote = await creditNoteRepository.findOne({
            where: { id: creditNoteId },
            relations: ["sale", "return_request", "cashier"],
        });

        if (!creditNote) return null;
        if (creditNote.etims_status === EtimsStatus.SUBMITTED || creditNote.etims_status === EtimsStatus.NOT_APPLICABLE) {
            return creditNote;
        }

        const provider = this.getProvider();
        if (provider.mode === "off") {
            creditNote.etims_status = EtimsStatus.NOT_APPLICABLE;
            creditNote.etims_last_error = null;
            return await creditNoteRepository.save(creditNote);
        }

        creditNote.etims_attempts = (creditNote.etims_attempts || 0) + 1;

        try {
            const signed = await EtimsMockService.signCreditNote(creditNote);
            if (signed) {
                creditNote.etims_note_no = signed.note_no;
                creditNote.etims_qr_code = signed.qr_code;
                creditNote.etims_signature = signed.signature;
                creditNote.etims_status = EtimsStatus.SUBMITTED;
                creditNote.etims_submitted_at = new Date();
                creditNote.etims_last_error = null;
            } else {
                creditNote.etims_status = EtimsStatus.NOT_APPLICABLE;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (provider.mode === "live") {
                creditNote.etims_status = EtimsStatus.FAILED;
                creditNote.etims_last_error = `${message} Live submission outcome may be uncertain. Reconcile the credit note with the VSCU daemon before retrying.`;
            } else if (creditNote.etims_attempts >= 5) {
                creditNote.etims_status = EtimsStatus.FAILED;
                creditNote.etims_last_error = message;
            } else {
                creditNote.etims_status = EtimsStatus.PENDING;
                creditNote.etims_last_error = message;
            }
        }

        const savedCreditNote = await creditNoteRepository.save(creditNote);
        try {
            SocketService.emitEtimsStatusUpdated(
                savedCreditNote.id,
                savedCreditNote.etims_status,
                savedCreditNote.etims_note_no,
            );
        } catch {
            // Non-blocking socket emission
        }

        return savedCreditNote;
    }
}
