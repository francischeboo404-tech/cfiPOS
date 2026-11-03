import { EntityManager } from "typeorm";
import { Account, AccountType } from "../entity/Account";
import { JournalEntry } from "../entity/JournalEntry";
import { JournalLine } from "../entity/JournalLine";
import { SupplierPaymentMethod } from "../entity/SupplierPayment";
import { calculateInclusiveVatCents, centsToKesString } from "../lib/exactMoney";
import { processingFeeJournalLines } from "../lib/processingFeeAccounting";
import {
    isEligibleManualInvoiceDebitAccount,
    ManualSupplierInvoiceAccountingError,
    validateManualInvoiceAmounts,
} from "../lib/manualSupplierInvoiceAccounting";

export interface SaleSettlementAmounts {
    cash?: number;
    mpesa?: number;
    storeCredit?: number;
    mpesaRefundPayable?: number;
    receivable?: number;
}

export class AccountingService {
    /**
     * Helper to get or create default base accounts.
     */
    static async getOrCreateAccount(manager: EntityManager, code: string, name: string, type: AccountType): Promise<Account> {
        let account = await manager.findOneBy(Account, { code });
        if (!account) {
            account = new Account();
            account.code = code;
            account.name = name;
            account.type = type;
            await manager.save(account);
        }
        return account;
    }

    /**
     * Initialize all base chart of accounts.
     */
    static async initChartOfAccounts(manager: EntityManager) {
        await this.getOrCreateAccount(manager, "1000", "Cash", AccountType.ASSET);
        await this.getOrCreateAccount(manager, "1010", "M-Pesa Clearing", AccountType.ASSET);
        await this.getOrCreateAccount(manager, "1020", "Bank", AccountType.ASSET);
        await this.getOrCreateAccount(manager, "1200", "Accounts Receivable", AccountType.ASSET);
        await this.getOrCreateAccount(manager, "1300", "Inventory", AccountType.ASSET);
        await this.getOrCreateAccount(manager, "2000", "Accounts Payable", AccountType.LIABILITY);
        await this.getOrCreateAccount(manager, "2400", "M-Pesa Refunds Payable", AccountType.LIABILITY);
        await this.getOrCreateAccount(manager, "2200", "VAT Payable", AccountType.LIABILITY);
        await this.getOrCreateAccount(manager, "4000", "Sales Revenue", AccountType.REVENUE);
        await this.getOrCreateAccount(manager, "5000", "Cost of Goods Sold", AccountType.EXPENSE);
        await this.getOrCreateAccount(manager, "5100", "Inventory Shrinkage", AccountType.EXPENSE);
        await this.getOrCreateAccount(manager, "1400", "Recoverable Input VAT", AccountType.ASSET);
        await this.getOrCreateAccount(manager, "5200", "Electronic Payment Processing Fees", AccountType.EXPENSE);
    }

    static async recordSaleProcessingFee(
        manager: EntityManager,
        saleId: string,
        incurredDate: string,
        feeCents: bigint,
        recoverableVatCents: bigint,
        statementReference: string,
    ): Promise<void> {
        const lines = processingFeeJournalLines(feeCents, recoverableVatCents);
        await this.createProcessingFeeJournal(
            manager,
            saleId,
            "SALE_PROCESSING_FEE",
            incurredDate,
            `Electronic payment fee (${statementReference})`,
            lines,
        );
    }

    static async recordManualSupplierInvoice(
        manager: EntityManager,
        invoiceId: string,
        invoiceDate: string,
        subtotalCents: bigint,
        taxCents: bigint,
        totalCents: bigint,
        subtotalAccountId: string,
        taxAccountId: string | null,
    ): Promise<void> {
        validateManualInvoiceAmounts(subtotalCents, taxCents, totalCents);

        const subtotalAccount = await manager.findOneBy(Account, { id: subtotalAccountId });
        if (!subtotalAccount || !isEligibleManualInvoiceDebitAccount(subtotalAccount, "subtotal")) {
            throw new ManualSupplierInvoiceAccountingError(
                "Select an active expense or asset account eligible for the invoice subtotal",
            );
        }

        let taxAccount: Account | null = null;
        if (taxCents > 0n) {
            if (!taxAccountId) {
                throw new ManualSupplierInvoiceAccountingError(
                    "Select an eligible debit account for the invoice tax amount",
                );
            }
            taxAccount = await manager.findOneBy(Account, { id: taxAccountId });
            if (!taxAccount || !isEligibleManualInvoiceDebitAccount(taxAccount, "tax")) {
                throw new ManualSupplierInvoiceAccountingError(
                    "Select an active expense or asset account eligible for the invoice tax amount",
                );
            }
        } else if (taxAccountId) {
            throw new ManualSupplierInvoiceAccountingError(
                "A tax account must not be selected when the invoice has no tax",
            );
        }

        const payableAccount = await this.getOrCreateAccount(
            manager,
            "2000",
            "Accounts Payable",
            AccountType.LIABILITY,
        );
        const entry = manager.create(JournalEntry, {
            reference_id: invoiceId,
            reference_type: "SUPPLIER_INVOICE",
            description: `Manual supplier invoice recognition (${invoiceId})`,
        });
        await manager.save(entry);
        await manager.query(
            "UPDATE journal_entries SET created_at = $1 WHERE id = $2",
            [`${invoiceDate.slice(0, 10)}T00:00:00.000Z`, entry.id],
        );

        const lines = [
            {
                account: subtotalAccount,
                debit: Number(centsToKesString(subtotalCents)),
                credit: 0,
            },
            ...(taxCents > 0n && taxAccount
                ? [{
                    account: taxAccount,
                    debit: Number(centsToKesString(taxCents)),
                    credit: 0,
                }]
                : []),
            {
                account: payableAccount,
                debit: 0,
                credit: Number(centsToKesString(totalCents)),
            },
        ];
        for (const line of lines) {
            const journalLine = manager.create(JournalLine, {
                journal_entry: entry,
                account: line.account,
                debit: line.debit,
                credit: line.credit,
            });
            await manager.save(journalLine);
        }
    }

    static async correctSaleProcessingFee(
        manager: EntityManager,
        saleId: string,
        correctionDate: string,
        previousJournalEntryId: string | null,
        feeCents: bigint,
        recoverableVatCents: bigint,
        statementReference: string,
    ): Promise<{ reversalJournalEntryId: string | null; correctedJournalEntryId: string | null }> {
        let reversalJournalEntryId: string | null = null;
        if (previousJournalEntryId) {
            const reversal = manager.create(JournalEntry, {
                reference_id: saleId,
                reference_type: "SALE_PROCESSING_FEE_CORRECTION_REVERSAL",
                description: `Reversal of prior provider fee posting (${statementReference})`,
            });
            await manager.save(reversal);
            await manager.query(
                `UPDATE journal_entries SET created_at = $1 WHERE id = $2`,
                [`${correctionDate}T00:00:00.000Z`, reversal.id],
            );
            await manager.query(
                `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
                 SELECT $1, account_id, credit, debit
                 FROM journal_lines
                 WHERE journal_entry_id = $2`,
                [reversal.id, previousJournalEntryId],
            );
            reversalJournalEntryId = reversal.id;
        }

        const correctedJournalEntryId = await this.createProcessingFeeJournal(
            manager,
            saleId,
            "SALE_PROCESSING_FEE_CORRECTION",
            correctionDate,
            `Corrected electronic payment fee (${statementReference})`,
            processingFeeJournalLines(feeCents, recoverableVatCents),
        );
        return { reversalJournalEntryId, correctedJournalEntryId };
    }

    private static async createProcessingFeeJournal(
        manager: EntityManager,
        saleId: string,
        referenceType: string,
        postingDate: string,
        description: string,
        lines: ReturnType<typeof processingFeeJournalLines>,
    ): Promise<string | null> {
        if (lines.length === 0) return null;
        const accounts = new Map<string, Account>();
        for (const line of lines) {
            if (accounts.has(line.accountCode)) continue;
            const definitions: Record<string, { name: string; type: AccountType }> = {
                "5200": { name: "Electronic Payment Processing Fees", type: AccountType.EXPENSE },
                "1400": { name: "Recoverable Input VAT", type: AccountType.ASSET },
                "1010": { name: "M-Pesa Clearing", type: AccountType.ASSET },
            };
            const definition = definitions[line.accountCode];
            accounts.set(line.accountCode, await this.getOrCreateAccount(
                manager, line.accountCode, definition.name, definition.type,
            ));
        }

        const entry = manager.create(JournalEntry, {
            reference_id: saleId,
            reference_type: referenceType,
            description,
        });
        await manager.save(entry);
        await manager.query(
            `UPDATE journal_entries SET created_at = $1 WHERE id = $2`,
            [`${postingDate}T00:00:00.000Z`, entry.id],
        );

        for (const line of lines) {
            const account = accounts.get(line.accountCode);
            if (!account) throw new Error(`Missing processing fee account ${line.accountCode}`);
            await manager.query(
                `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
                 VALUES ($1, $2, $3, $4)`,
                [
                    entry.id,
                    account.id,
                    centsToKesString(line.debitCents),
                    centsToKesString(line.creditCents),
                ],
            );
        }
        return entry.id;
    }

    private static async writeSettlementLines(
        manager: EntityManager,
        entry: JournalEntry,
        totalAmount: number,
        settlement: SaleSettlementAmounts,
        side: "debit" | "credit"
    ) {
        if (!Number.isFinite(totalAmount) || totalAmount < 0) {
            throw new Error("Settlement total must be a valid non-negative amount");
        }

        const settlementAccounts = [
            { amount: settlement.cash, code: "1000", name: "Cash", type: AccountType.ASSET },
            { amount: settlement.mpesa, code: "1010", name: "M-Pesa Clearing", type: AccountType.ASSET },
            { amount: settlement.storeCredit, code: "2300", name: "Store Credit Liability", type: AccountType.LIABILITY },
            { amount: settlement.mpesaRefundPayable, code: "2400", name: "M-Pesa Refunds Payable", type: AccountType.LIABILITY },
            { amount: settlement.receivable, code: "1200", name: "Accounts Receivable", type: AccountType.ASSET },
        ];
        let remaining = totalAmount;

        for (const settlementAccount of settlementAccounts) {
            const requestedAmount = Number(settlementAccount.amount ?? 0);
            if (!Number.isFinite(requestedAmount) || requestedAmount < 0) {
                throw new Error("Settlement amounts must be valid non-negative amounts");
            }

            const amount = Math.min(remaining, requestedAmount);
            if (amount <= 0) continue;

            const account = await this.getOrCreateAccount(
                manager,
                settlementAccount.code,
                settlementAccount.name,
                settlementAccount.type
            );
            const line = new JournalLine();
            line.journal_entry = entry;
            line.account = account;
            line[side] = amount;
            await manager.save(line);
            remaining -= amount;
        }

        if (remaining > 0) {
            const account = await this.getOrCreateAccount(manager, "1200", "Accounts Receivable", AccountType.ASSET);
            const line = new JournalLine();
            line.journal_entry = entry;
            line.account = account;
            line[side] = remaining;
            await manager.save(line);
        }
    }

    /**
     * Record a sale journal entry.
     */
    static async recordSale(
        manager: EntityManager,
        saleId: string,
        totalAmount: number,
        subtotal: number,
        taxAmount: number,
        totalCogs: number,
        isCash: boolean,
        cashAmount?: number,
        mpesaAmount?: number,
        storeCreditAmount?: number,
        receivableAmount?: number,
    ) {
        const salesRevenueAcc = await this.getOrCreateAccount(manager, "4000", "Sales Revenue", AccountType.REVENUE);
        const vatPayableAcc = await this.getOrCreateAccount(manager, "2200", "VAT Payable", AccountType.LIABILITY);
        const cogsAcc = await this.getOrCreateAccount(manager, "5000", "Cost of Goods Sold", AccountType.EXPENSE);
        const inventoryAcc = await this.getOrCreateAccount(manager, "1300", "Inventory", AccountType.ASSET);

        // Create Journal Entry
        const entry = new JournalEntry();
        entry.reference_id = saleId;
        entry.reference_type = "SALE";
        entry.description = `Sale entry for Sale ID: ${saleId}`;
        await manager.save(entry);

        // Debit the actual settlement accounts; legacy callers retain the cash/receivable behavior.
        if (cashAmount !== undefined || mpesaAmount !== undefined || storeCreditAmount !== undefined) {
            await this.writeSettlementLines(manager, entry, totalAmount, {
                cash: cashAmount,
                mpesa: mpesaAmount,
                storeCredit: storeCreditAmount,
                receivable: receivableAmount,
            }, "debit");
        } else {
            await this.writeSettlementLines(manager, entry, totalAmount, {
                cash: isCash ? totalAmount : 0,
                receivable: isCash ? 0 : totalAmount,
            }, "debit");
        }

        // Credit Sales for subtotal
        const creditSales = new JournalLine();
        creditSales.journal_entry = entry;
        creditSales.account = salesRevenueAcc;
        creditSales.credit = subtotal;
        await manager.save(creditSales);

        // Credit VAT Payable for taxAmount
        if (taxAmount > 0) {
            const creditVat = new JournalLine();
            creditVat.journal_entry = entry;
            creditVat.account = vatPayableAcc;
            creditVat.credit = taxAmount;
            await manager.save(creditVat);
        }

        // --- COGS / Inventory Reduction ---
        if (totalCogs > 0) {
            const debitCogs = new JournalLine();
            debitCogs.journal_entry = entry;
            debitCogs.account = cogsAcc;
            debitCogs.debit = totalCogs;
            await manager.save(debitCogs);

            const creditInventory = new JournalLine();
            creditInventory.journal_entry = entry;
            creditInventory.account = inventoryAcc;
            creditInventory.credit = totalCogs;
            await manager.save(creditInventory);
        }
    }

    static async recordVoucherRenewal(
        manager: EntityManager,
        renewalId: string,
        feeCents: bigint,
        cashPaidCents: bigint,
        mpesaPaidCents: bigint,
    ) {
        if (feeCents <= 0n || cashPaidCents < 0n || mpesaPaidCents < 0n ||
            cashPaidCents + mpesaPaidCents !== feeCents) {
            throw new Error("Voucher renewal accounting requires exact, fully settled payment");
        }
        const { netRevenueCents, vatCents } = calculateInclusiveVatCents(feeCents, 1_600);
        const entry = manager.create(JournalEntry, {
            reference_id: renewalId,
            reference_type: "VOUCHER_RENEWAL",
            description: `Paid voucher renewal ${renewalId}`,
        });
        await manager.save(entry);
        for (const settlement of [
            { cents: cashPaidCents, code: "1000", name: "Cash", type: AccountType.ASSET },
            { cents: mpesaPaidCents, code: "1010", name: "M-Pesa Clearing", type: AccountType.ASSET },
        ]) {
            if (settlement.cents === 0n) continue;
            const account = await this.getOrCreateAccount(manager, settlement.code, settlement.name, settlement.type);
            await manager.save(manager.create(JournalLine, {
                journal_entry: entry,
                account,
                debit: Number(centsToKesString(settlement.cents)),
            }));
        }
        if (netRevenueCents > 0n) {
            const revenue = await this.getOrCreateAccount(manager, "4000", "Sales Revenue", AccountType.REVENUE);
            await manager.save(manager.create(JournalLine, {
                journal_entry: entry,
                account: revenue,
                credit: Number(centsToKesString(netRevenueCents)),
            }));
        }
        if (vatCents > 0n) {
            const vat = await this.getOrCreateAccount(manager, "2200", "VAT Payable", AccountType.LIABILITY);
            await manager.save(manager.create(JournalLine, {
                journal_entry: entry,
                account: vat,
                credit: Number(centsToKesString(vatCents)),
            }));
        }
    }

    /**
     * Record inventory receipt from Purchase Order
     */
    static async recordInventoryReceipt(
        manager: EntityManager,
        poId: string,
        totalCostCents: bigint
    ) {
        const inventoryAcc = await this.getOrCreateAccount(manager, "1300", "Inventory", AccountType.ASSET);
        const apAcc = await this.getOrCreateAccount(manager, "2000", "Accounts Payable", AccountType.LIABILITY);

        const entry = new JournalEntry();
        entry.reference_id = poId;
        entry.reference_type = "PURCHASE";
        entry.description = `Inventory receipt for PO ID: ${poId}`;
        await manager.save(entry);

        // Debit Inventory
        const debitInv = new JournalLine();
        debitInv.journal_entry = entry;
        debitInv.account = inventoryAcc;
        debitInv.debit = Number(centsToKesString(totalCostCents));
        await manager.save(debitInv);

        // Credit Accounts Payable
        const creditAp = new JournalLine();
        creditAp.journal_entry = entry;
        creditAp.account = apAcc;
        creditAp.credit = Number(centsToKesString(totalCostCents));
        await manager.save(creditAp);
    }

    static async recordInvoicePayment(
        manager: EntityManager,
        invoiceId: string,
        amountCents: bigint
    ) {
        const amount = Number(centsToKesString(amountCents));
        const cashAcc = await this.getOrCreateAccount(manager, "1000", "Cash", AccountType.ASSET);
        const arAcc = await this.getOrCreateAccount(manager, "1200", "Accounts Receivable", AccountType.ASSET);

        const entry = new JournalEntry();
        entry.reference_id = invoiceId;
        entry.reference_type = "INVOICE_PAYMENT";
        entry.description = `Payment received for Invoice ID: ${invoiceId}`;
        await manager.save(entry);

        const debitCash = new JournalLine();
        debitCash.journal_entry = entry;
        debitCash.account = cashAcc;
        debitCash.debit = amount;
        await manager.save(debitCash);

        const creditReceivable = new JournalLine();
        creditReceivable.journal_entry = entry;
        creditReceivable.account = arAcc;
        creditReceivable.credit = amount;
        await manager.save(creditReceivable);
    }

    static async recordInstallmentAdvance(
        manager: EntityManager,
        paymentId: string,
        amountCents: bigint,
        paymentMethod: "CASH" | "MPESA" | "BANK_TRANSFER" | "OTHER",
        paymentDate: string,
    ): Promise<void> {
        if (amountCents <= 0n) {
            throw new Error("Installment advance must be greater than zero");
        }
        const source = paymentMethod === "CASH"
            ? { code: "1000", name: "Cash" }
            : paymentMethod === "MPESA"
                ? { code: "1010", name: "M-Pesa Clearing" }
                : paymentMethod === "BANK_TRANSFER"
                    ? { code: "1020", name: "Bank" }
                    : { code: "1030", name: "Other Payment Clearing" };
        const sourceAccount = await this.getOrCreateAccount(
            manager,
            source.code,
            source.name,
            AccountType.ASSET,
        );
        const advanceAccount = await this.getOrCreateAccount(
            manager,
            "2350",
            "Installment Customer Advances",
            AccountType.LIABILITY,
        );
        const amount = Number(centsToKesString(amountCents));
        const entry = manager.create(JournalEntry, {
            reference_id: paymentId,
            reference_type: "INSTALLMENT_PAYMENT",
            description: `Customer advance received for installment payment ${paymentId}`,
        });
        await manager.save(entry);
        await manager.query(
            `UPDATE journal_entries SET created_at = $1 WHERE id = $2`,
            [`${paymentDate}T00:00:00.000Z`, entry.id],
        );
        await manager.save(manager.create(JournalLine, {
            journal_entry: entry,
            account: sourceAccount,
            debit: amount,
        }));
        await manager.save(manager.create(JournalLine, {
            journal_entry: entry,
            account: advanceAccount,
            credit: amount,
        }));
    }

    static async reverseInstallmentAdvance(
        manager: EntityManager,
        reversalId: string,
        amountCents: bigint,
        paymentMethod: "CASH" | "MPESA" | "BANK_TRANSFER" | "OTHER",
        reversalDate: string,
    ): Promise<void> {
        if (amountCents <= 0n) {
            throw new Error("Installment advance reversal must be greater than zero");
        }
        const source = paymentMethod === "CASH"
            ? { code: "1000", name: "Cash" }
            : paymentMethod === "MPESA"
                ? { code: "1010", name: "M-Pesa Clearing" }
                : paymentMethod === "BANK_TRANSFER"
                    ? { code: "1020", name: "Bank" }
                    : { code: "1030", name: "Other Payment Clearing" };
        const sourceAccount = await this.getOrCreateAccount(
            manager,
            source.code,
            source.name,
            AccountType.ASSET,
        );
        const advanceAccount = await this.getOrCreateAccount(
            manager,
            "2350",
            "Installment Customer Advances",
            AccountType.LIABILITY,
        );
        const amount = Number(centsToKesString(amountCents));
        const entry = manager.create(JournalEntry, {
            reference_id: reversalId,
            reference_type: "INSTALLMENT_PAYMENT_REVERSAL",
            description: `Reversal of installment customer advance ${reversalId}`,
        });
        await manager.save(entry);
        await manager.query(
            `UPDATE journal_entries SET created_at = $1 WHERE id = $2`,
            [`${reversalDate}T00:00:00.000Z`, entry.id],
        );
        await manager.save(manager.create(JournalLine, {
            journal_entry: entry,
            account: advanceAccount,
            debit: amount,
        }));
        await manager.save(manager.create(JournalLine, {
            journal_entry: entry,
            account: sourceAccount,
            credit: amount,
        }));
    }

    static async recordInstallmentCancellation(
        manager: EntityManager,
        cancellationId: string,
        paidCents: bigint,
        feeCents: bigint,
        refundCents: bigint,
        refundMethod: "CASH" | "MPESA" | "BANK_TRANSFER",
        cancellationDate: string,
    ): Promise<void> {
        if (paidCents < 0n || feeCents < 0n || refundCents < 0n ||
            feeCents + refundCents !== paidCents) {
            throw new Error("Installment cancellation amounts do not reconcile");
        }
        if (paidCents === 0n) return;

        const refundSource = refundMethod === "CASH"
            ? { code: "1000", name: "Cash" }
            : refundMethod === "MPESA"
                ? { code: "1010", name: "M-Pesa Clearing" }
                : { code: "1020", name: "Bank" };
        const advanceAccount = await this.getOrCreateAccount(
            manager,
            "2350",
            "Installment Customer Advances",
            AccountType.LIABILITY,
        );
        const refundAccount = await this.getOrCreateAccount(
            manager,
            refundSource.code,
            refundSource.name,
            AccountType.ASSET,
        );
        const feeAccount = feeCents > 0n
            ? await this.getOrCreateAccount(
                manager,
                "4090",
                "Installment Cancellation Fee Revenue",
                AccountType.REVENUE,
            )
            : null;
        const entry = manager.create(JournalEntry, {
            reference_id: cancellationId,
            reference_type: "INSTALLMENT_CANCELLATION",
            description: `Installment agreement cancellation ${cancellationId}`,
        });
        await manager.save(entry);
        await manager.query(
            `UPDATE journal_entries SET created_at = $1 WHERE id = $2`,
            [`${cancellationDate}T00:00:00.000Z`, entry.id],
        );
        await manager.save(manager.create(JournalLine, {
            journal_entry: entry,
            account: advanceAccount,
            debit: Number(centsToKesString(paidCents)),
        }));
        if (refundCents > 0n) {
            await manager.save(manager.create(JournalLine, {
                journal_entry: entry,
                account: refundAccount,
                credit: Number(centsToKesString(refundCents)),
            }));
        }
        if (feeCents > 0n && feeAccount) {
            await manager.save(manager.create(JournalLine, {
                journal_entry: entry,
                account: feeAccount,
                credit: Number(centsToKesString(feeCents)),
            }));
        }
    }

    static async recordSupplierPayment(
        manager: EntityManager,
        paymentId: string,
        invoiceId: string,
        amountCents: bigint,
        paymentMethod: SupplierPaymentMethod,
        paymentDate: string,
    ) {
        const sourceAccount = paymentMethod === SupplierPaymentMethod.CASH
            ? { code: "1000", name: "Cash" }
            : paymentMethod === SupplierPaymentMethod.MPESA
                ? { code: "1010", name: "M-Pesa Clearing" }
                : paymentMethod === SupplierPaymentMethod.BANK_TRANSFER ||
                    paymentMethod === SupplierPaymentMethod.CHEQUE
                    ? { code: "1020", name: "Bank" }
                    : null;
        if (!sourceAccount) throw new Error("Supplier payment method has no accounting source account");
        const amount = Number(centsToKesString(amountCents));
        const sourceAcc = await this.getOrCreateAccount(
            manager,
            sourceAccount.code,
            sourceAccount.name,
            AccountType.ASSET,
        );
        const apAcc = await this.getOrCreateAccount(manager, "2000", "Accounts Payable", AccountType.LIABILITY);

        const entry = new JournalEntry();
        entry.reference_id = paymentId;
        entry.reference_type = "SUPPLIER_PAYMENT";
        entry.description = `Payment for supplier invoice ID: ${invoiceId}`;
        await manager.save(entry);
        await manager.query(
            `UPDATE journal_entries SET created_at = $1 WHERE id = $2`,
            [`${paymentDate}T00:00:00.000Z`, entry.id],
        );

        const debitPayable = new JournalLine();
        debitPayable.journal_entry = entry;
        debitPayable.account = apAcc;
        debitPayable.debit = amount;
        await manager.save(debitPayable);

        const creditSource = new JournalLine();
        creditSource.journal_entry = entry;
        creditSource.account = sourceAcc;
        creditSource.credit = amount;
        await manager.save(creditSource);
    }

    /**
     * Record a sale reversal journal entry (Void/Credit Note).
     */
    static async recordSaleReversal(
        manager: EntityManager,
        saleId: string,
        totalAmount: number,
        subtotal: number,
        taxAmount: number,
        totalCogs: number,
        settlement: SaleSettlementAmounts
    ) {
        const salesRevenueAcc = await this.getOrCreateAccount(manager, "4000", "Sales Revenue", AccountType.REVENUE);
        const vatPayableAcc = await this.getOrCreateAccount(manager, "2200", "VAT Payable", AccountType.LIABILITY);
        const cogsAcc = await this.getOrCreateAccount(manager, "5000", "Cost of Goods Sold", AccountType.EXPENSE);
        const inventoryAcc = await this.getOrCreateAccount(manager, "1300", "Inventory", AccountType.ASSET);

        // Create Journal Entry
        const entry = new JournalEntry();
        entry.reference_id = saleId;
        entry.reference_type = "SALE_VOID";
        entry.description = `Reversal entry for Voided Sale ID: ${saleId}`;
        await manager.save(entry);

        await this.writeSettlementLines(manager, entry, totalAmount, settlement, "credit");

        // Debit Sales for subtotal
        const debitSales = new JournalLine();
        debitSales.journal_entry = entry;
        debitSales.account = salesRevenueAcc;
        debitSales.debit = subtotal;
        await manager.save(debitSales);

        // Debit VAT Payable for taxAmount
        if (taxAmount > 0) {
            const debitVat = new JournalLine();
            debitVat.journal_entry = entry;
            debitVat.account = vatPayableAcc;
            debitVat.debit = taxAmount;
            await manager.save(debitVat);
        }

        // --- Reverse COGS / Inventory Reduction ---
        if (totalCogs > 0) {
            const creditCogs = new JournalLine();
            creditCogs.journal_entry = entry;
            creditCogs.account = cogsAcc;
            creditCogs.credit = totalCogs;
            await manager.save(creditCogs);

            const debitInventory = new JournalLine();
            debitInventory.journal_entry = entry;
            debitInventory.account = inventoryAcc;
            debitInventory.debit = totalCogs;
            await manager.save(debitInventory);
        }
    }

    static async recordMpesaRefundPayout(manager: EntityManager, returnRequestId: string, amount: number) {
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("M-Pesa refund payout must be a valid positive amount");
        }

        const refundPayableAcc = await this.getOrCreateAccount(
            manager,
            "2400",
            "M-Pesa Refunds Payable",
            AccountType.LIABILITY
        );
        const mpesaAcc = await this.getOrCreateAccount(manager, "1010", "M-Pesa Clearing", AccountType.ASSET);
        const entry = new JournalEntry();
        entry.reference_id = returnRequestId;
        entry.reference_type = "MPESA_REFUND_PAYOUT";
        entry.description = `Confirmed M-Pesa refund payout for return ${returnRequestId}`;
        await manager.save(entry);

        const debitPayable = new JournalLine();
        debitPayable.journal_entry = entry;
        debitPayable.account = refundPayableAcc;
        debitPayable.debit = amount;
        await manager.save(debitPayable);

        const creditMpesa = new JournalLine();
        creditMpesa.journal_entry = entry;
        creditMpesa.account = mpesaAcc;
        creditMpesa.credit = amount;
        await manager.save(creditMpesa);
    }

    static async recordMpesaReceivablePayment(
        manager: EntityManager,
        saleId: string,
        amount: number,
        referenceType: "MPESA_PAYMENT" | "PESAPAL_PAYMENT" = "MPESA_PAYMENT"
    ) {
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("M-Pesa payment amount must be a valid positive amount");
        }

        const mpesaAcc = await this.getOrCreateAccount(manager, "1010", "M-Pesa Clearing", AccountType.ASSET);
        const receivableAcc = await this.getOrCreateAccount(manager, "1200", "Accounts Receivable", AccountType.ASSET);
        const entry = new JournalEntry();
        entry.reference_id = saleId;
        entry.reference_type = referenceType;
        entry.description = `M-Pesa payment received for Sale ID: ${saleId}`;
        await manager.save(entry);

        const debitMpesa = new JournalLine();
        debitMpesa.journal_entry = entry;
        debitMpesa.account = mpesaAcc;
        debitMpesa.debit = amount;
        await manager.save(debitMpesa);

        const creditReceivable = new JournalLine();
        creditReceivable.journal_entry = entry;
        creditReceivable.account = receivableAcc;
        creditReceivable.credit = amount;
        await manager.save(creditReceivable);
    }

    /**
     * Record an inventory adjustment (Shrinkage, Damage)
     */
    static async recordInventoryAdjustment(manager: EntityManager, adjustmentId: string, totalValue: number, isShrinkage: boolean) {
        if (totalValue <= 0) return;

        const inventoryAcc = await this.getOrCreateAccount(manager, "1300", "Inventory", AccountType.ASSET);
        const shrinkageAcc = await this.getOrCreateAccount(manager, "5100", "Inventory Shrinkage", AccountType.EXPENSE);

        const entry = new JournalEntry();
        entry.reference_id = adjustmentId;
        entry.reference_type = "INVENTORY_ADJUSTMENT";
        entry.description = `Inventory adjustment for ID: ${adjustmentId}`;
        await manager.save(entry);

        if (isShrinkage) {
            // Negative adjustment - Expense goes up (debit), Inventory goes down (credit)
            const debitShrinkage = new JournalLine();
            debitShrinkage.journal_entry = entry;
            debitShrinkage.account = shrinkageAcc;
            debitShrinkage.debit = totalValue;
            await manager.save(debitShrinkage);

            const creditInventory = new JournalLine();
            creditInventory.journal_entry = entry;
            creditInventory.account = inventoryAcc;
            creditInventory.credit = totalValue;
            await manager.save(creditInventory);
        } else {
            // Positive adjustment - Inventory goes up (debit), Expense goes down (credit)
            const debitInventory = new JournalLine();
            debitInventory.journal_entry = entry;
            debitInventory.account = inventoryAcc;
            debitInventory.debit = totalValue;
            await manager.save(debitInventory);

            const creditShrinkage = new JournalLine();
            creditShrinkage.journal_entry = entry;
            creditShrinkage.account = shrinkageAcc;
            creditShrinkage.credit = totalValue;
            await manager.save(creditShrinkage);
        }
    }
}
