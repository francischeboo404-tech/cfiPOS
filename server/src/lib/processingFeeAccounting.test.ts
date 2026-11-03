import test from "node:test";
import assert from "node:assert/strict";
import { processingFeeJournalLines } from "./processingFeeAccounting";

test("processing fee posting separates exact expense, recoverable VAT, and settlement", () => {
    const lines = processingFeeJournalLines(116n, 16n);
    assert.deepEqual(lines, [
        { accountCode: "5200", debitCents: 100n, creditCents: 0n },
        { accountCode: "1400", debitCents: 16n, creditCents: 0n },
        { accountCode: "1010", debitCents: 0n, creditCents: 116n },
    ]);
    assert.equal(
        lines.reduce((sum, line) => sum + line.debitCents, 0n),
        lines.reduce((sum, line) => sum + line.creditCents, 0n),
    );
});

test("processing fee posting handles wholly expense or zero-valued evidence without rounding", () => {
    assert.deepEqual(processingFeeJournalLines(101n, 0n), [
        { accountCode: "5200", debitCents: 101n, creditCents: 0n },
        { accountCode: "1010", debitCents: 0n, creditCents: 101n },
    ]);
    assert.deepEqual(processingFeeJournalLines(0n, 0n), []);
    assert.throws(() => processingFeeJournalLines(100n, 101n), /invalid/);
    assert.throws(() => processingFeeJournalLines(-1n, 0n), /invalid/);
});
