import { AppDataSource } from "../../data-source";
import { Sale } from "../../entity/Sale";

const readPositiveSafeInteger = (rawValue: string | undefined): number => {
    const value = rawValue?.trim() || "";
    if (!/^[1-9]\d*$/.test(value)) {
        throw new Error("ETIMS_INITIAL_INVOICE_NUMBER must be a positive integer reconciled with the VSCU daemon.");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error("ETIMS_INITIAL_INVOICE_NUMBER exceeds the safe integer range.");
    }
    return parsed;
};

export class EtimsInvoiceNumberAllocator {
    static async reserveForSale(sale: Sale): Promise<number> {
        const queryRunner = AppDataSource.createQueryRunner();
        let connected = false;
        let transactionStarted = false;
        try {
            await queryRunner.connect();
            connected = true;
            await queryRunner.startTransaction();
            transactionStarted = true;

            const currentSale = await queryRunner.manager.findOne(Sale, {
                where: { id: sale.id },
                lock: { mode: "pessimistic_write" },
            });
            if (!currentSale) throw new Error("Sale no longer exists; cannot reserve a VSCU invoice number.");
            if (currentSale.etims_invoice_number) {
                const existingNumber = Number(currentSale.etims_invoice_number);
                if (!Number.isSafeInteger(existingNumber) || existingNumber <= 0) {
                    throw new Error("Stored VSCU invoice number is invalid; reconcile the sale before retrying.");
                }
                sale.etims_invoice_number = currentSale.etims_invoice_number;
                await queryRunner.commitTransaction();
                transactionStarted = false;
                return existingNumber;
            }

            let rows: Array<{ next_invoice_number: string }> = await queryRunner.query(
                `SELECT "next_invoice_number"::text AS "next_invoice_number"
                 FROM "etims_invoice_counters"
                 WHERE "id" = 1
                 FOR UPDATE`,
            );
            if (rows.length === 0) {
                const configuredInitialNumber = readPositiveSafeInteger(process.env.ETIMS_INITIAL_INVOICE_NUMBER);
                await queryRunner.query(
                    `INSERT INTO "etims_invoice_counters" ("id", "next_invoice_number")
                     VALUES (1, $1)
                     ON CONFLICT ("id") DO NOTHING`,
                    [configuredInitialNumber],
                );
                rows = await queryRunner.query(
                    `SELECT "next_invoice_number"::text AS "next_invoice_number"
                     FROM "etims_invoice_counters"
                     WHERE "id" = 1
                     FOR UPDATE`,
                );
            }
            const invoiceNumber = Number(rows[0]?.next_invoice_number);
            if (!Number.isSafeInteger(invoiceNumber) || invoiceNumber <= 0 ||
                invoiceNumber >= Number.MAX_SAFE_INTEGER) {
                throw new Error("VSCU invoice counter is invalid or exhausted; reconcile its value before submitting.");
            }

            await queryRunner.query(
                `UPDATE "etims_invoice_counters"
                 SET "next_invoice_number" = $1
                 WHERE "id" = 1`,
                [String(invoiceNumber + 1)],
            );
            await queryRunner.manager.update(Sale, { id: sale.id }, {
                etims_invoice_number: String(invoiceNumber),
            });
            await queryRunner.commitTransaction();
            transactionStarted = false;
            sale.etims_invoice_number = String(invoiceNumber);
            return invoiceNumber;
        } catch (error) {
            if (transactionStarted) {
                await queryRunner.rollbackTransaction();
            }
            throw error;
        } finally {
            if (connected) {
                await queryRunner.release();
            }
        }
    }
}
