export interface ProcessingFeeJournalLine {
    accountCode: "5200" | "1400" | "1010";
    debitCents: bigint;
    creditCents: bigint;
}

export const processingFeeJournalLines = (
    feeCents: bigint,
    recoverableVatCents: bigint,
): ProcessingFeeJournalLine[] => {
    if (feeCents < 0n || recoverableVatCents < 0n || recoverableVatCents > feeCents) {
        throw new Error("Processing fee and recoverable VAT amounts are invalid");
    }
    if (feeCents === 0n) return [];

    const lines: ProcessingFeeJournalLine[] = [];
    const expenseCents = feeCents - recoverableVatCents;
    if (expenseCents > 0n) lines.push({ accountCode: "5200", debitCents: expenseCents, creditCents: 0n });
    if (recoverableVatCents > 0n) lines.push({ accountCode: "1400", debitCents: recoverableVatCents, creditCents: 0n });
    lines.push({ accountCode: "1010", debitCents: 0n, creditCents: feeCents });
    return lines;
};
