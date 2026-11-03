import assert from "node:assert/strict";
import test from "node:test";
import {
    allocateInstallmentPayment,
    buildFullPaymentReversalAllocations,
    calculateCumulativeInstallmentPointsAdjustment,
    calculateInstallmentCancellationAmounts,
    sanitizeInstallmentCancellationRequest,
    sanitizeInstallmentPaymentReversalRequest,
    calculateInstallmentBalanceCents,
    calculateInstallmentPointsDelta,
    calculateInstallmentPointsReversal,
    deriveInstallmentStatus,
    InstallmentBalance,
    isVoucherValidOnPaymentDate,
    sanitizeInstallmentPaymentRequest,
    validateInstallmentWriteOffCents,
} from "./installmentPaymentRules";

const schedule: InstallmentBalance[] = [
    {
        installment_number: 1,
        principal_cents: 10_000n,
        interest_cents: 1_000n,
        principal_paid_cents: 0n,
        interest_paid_cents: 0n,
    },
    {
        installment_number: 2,
        principal_cents: 10_000n,
        interest_cents: 1_000n,
        principal_paid_cents: 0n,
        interest_paid_cents: 0n,
    },
];

test("partial payment splits principal and interest proportionally to the schedule", () => {
    assert.deepEqual(allocateInstallmentPayment(schedule, 5_000n), [{
        installment_number: 1,
        principal_cents: 4_545n,
        interest_cents: 455n,
    }]);
});

test("oldest-first payment spans installments and fully settles exact remainders", () => {
    const allocations = allocateInstallmentPayment(schedule, 13_500n);
    assert.deepEqual(allocations, [
        { installment_number: 1, principal_cents: 10_000n, interest_cents: 1_000n },
        { installment_number: 2, principal_cents: 2_273n, interest_cents: 227n },
    ]);
    assert.equal(
        allocations.reduce((sum, allocation) =>
            sum + allocation.principal_cents + allocation.interest_cents, 0n),
        13_500n,
    );

    const remainingSchedule = schedule.map((installment) => ({
        ...installment,
        principal_paid_cents: installment.installment_number === 1 ? 10_000n : 2_273n,
        interest_paid_cents: installment.installment_number === 1 ? 1_000n : 227n,
    }));
    assert.deepEqual(allocateInstallmentPayment(remainingSchedule, 8_500n), [{
        installment_number: 2,
        principal_cents: 7_727n,
        interest_cents: 773n,
    }]);
});

test("zero payments and payments above the remaining balance are rejected", () => {
    assert.throws(() => allocateInstallmentPayment(schedule, 0n), /greater than zero/);
    assert.throws(() => allocateInstallmentPayment(schedule, 22_001n), /exceeds the remaining/);
});

test("invalid or duplicated installment balances are rejected", () => {
    assert.throws(() => allocateInstallmentPayment([{
        ...schedule[0],
        principal_paid_cents: 10_001n,
    }], 1n), /cannot exceed/);
    assert.throws(() => allocateInstallmentPayment([schedule[0], schedule[0]], 1n), /must be unique/);
    assert.throws(() => allocateInstallmentPayment([
        { ...schedule[0], installment_number: 2 },
    ], 1n), /contiguous sequence starting at one/);
    assert.throws(() => allocateInstallmentPayment([
        schedule[0],
        { ...schedule[1], installment_number: 3 },
    ], 1n), /contiguous sequence starting at one/);
    assert.throws(() => allocateInstallmentPayment([
        { ...schedule[0], installment_number: 121 },
    ], 1n), /between 1 and 120/);
});

test("payment requests normalize exact amounts and validate identifiers, dates, and method", () => {
    assert.deepEqual(sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-10-19",
        amount: "12.5",
        payment_method: "MPESA",
        reference_number: "  ABC123  ",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    }, "2026-10-19"), {
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-10-19",
        amount: "12.50",
        payment_method: "MPESA",
        reference_number: "ABC123",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    });
    assert.throws(() => sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-10-20",
        amount: "12.50",
        payment_method: "CASH",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    }, "2026-10-19"), /cannot be in the future/);
    assert.throws(() => sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-02-30",
        amount: "12.50",
        payment_method: "CASH",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    }, "2026-10-19"), /valid YYYY-MM-DD/);
    assert.throws(() => sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-10-19",
        amount: "0.00",
        payment_method: "CASH",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    }, "2026-10-19"), /greater than zero/);
    for (const amount of [12.5, 12, null, true]) {
        assert.throws(() => sanitizeInstallmentPaymentRequest({
            agreement_id: "00000000-0000-0000-0000-000000000001",
            payment_date: "2026-10-19",
            amount,
            payment_method: "CASH",
            idempotency_key: "00000000-0000-0000-0000-000000000002",
        }, "2026-10-19"), /decimal string/);
    }
    assert.throws(() => sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-10-19",
        amount: "12.50",
        payment_method: "CARD",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    }, "2026-10-19"), /payment_method/);
    assert.throws(() => sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-10-19",
        amount: "12.50",
        payment_method: "BANK_TRANSFER",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    }, "2026-10-19"), /reference_number is required/);
    assert.equal(sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001".toUpperCase(),
        payment_date: "2026-10-19",
        amount: "12.50",
        payment_method: "CASH",
        idempotency_key: "00000000-0000-0000-0000-000000000002".toUpperCase(),
    }, "2026-10-19").idempotency_key, "00000000-0000-0000-0000-000000000002");
    assert.equal(sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-10-19",
        amount: "92233720368547758.07",
        payment_method: "CASH",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    }, "2026-10-19").amount, "92233720368547758.07");
    assert.throws(() => sanitizeInstallmentPaymentRequest({
        agreement_id: "00000000-0000-0000-0000-000000000001",
        payment_date: "2026-10-19",
        amount: "92233720368547758.08",
        payment_method: "CASH",
        idempotency_key: "00000000-0000-0000-0000-000000000002",
    }, "2026-10-19"), /maximum supported database amount/);
});

test("agreement status uses Nairobi date semantics and waits for held handover", () => {
    const line = {
        due_date: "2026-10-19",
        principal_cents: 10_000n,
        interest_cents: 1_000n,
        principal_paid_cents: 0n,
        interest_paid_cents: 0n,
    };
    assert.deepEqual(deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "RELEASE_AFTER_DEPOSIT",
        released: true,
        cancelled: false,
        writtenOff: false,
        schedule: [line],
    }), { status: "ACTIVE", ready_for_handover: false });
    assert.deepEqual(deriveInstallmentStatus({
        todayDate: "2026-10-20",
        releaseMode: "RELEASE_AFTER_DEPOSIT",
        released: true,
        cancelled: false,
        writtenOff: false,
        schedule: [line],
    }), { status: "OVERDUE", ready_for_handover: false });
    assert.deepEqual(deriveInstallmentStatus({
        todayDate: "2026-10-20",
        releaseMode: "HOLD_UNTIL_PAID",
        released: false,
        cancelled: false,
        writtenOff: false,
        schedule: [{
            ...line,
            principal_paid_cents: 10_000n,
            interest_paid_cents: 1_000n,
        }],
    }), { status: "ACTIVE", ready_for_handover: true });
    assert.deepEqual(deriveInstallmentStatus({
        todayDate: "2026-10-20",
        releaseMode: "HOLD_UNTIL_PAID",
        released: true,
        cancelled: false,
        writtenOff: false,
        schedule: [{
            ...line,
            principal_paid_cents: 10_000n,
            interest_paid_cents: 1_000n,
        }],
    }), { status: "COMPLETED", ready_for_handover: false });
    assert.deepEqual(deriveInstallmentStatus({
        todayDate: "2026-10-20",
        releaseMode: "HOLD_UNTIL_PAID",
        released: false,
        cancelled: true,
        writtenOff: false,
        schedule: [line],
    }), { status: "CANCELLED", ready_for_handover: false });
});

test("agreement status validates every schedule line and the release mode", () => {
    const validUnpaidLine = {
        due_date: "2026-10-20",
        principal_cents: 10_000n,
        interest_cents: 1_000n,
        principal_paid_cents: 0n,
        interest_paid_cents: 0n,
    };
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "RELEASE_AFTER_DEPOSIT",
        released: true,
        cancelled: false,
        writtenOff: false,
        schedule: [
            validUnpaidLine,
            { ...validUnpaidLine, due_date: "2026-02-30" },
        ],
    }), /Schedule due dates must be valid/);
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "RELEASE_AFTER_DEPOSIT",
        released: true,
        cancelled: false,
        writtenOff: false,
        schedule: [
            validUnpaidLine,
            { ...validUnpaidLine, due_date: "2026-10-20" },
        ],
    }), /strictly increasing order/);
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "RELEASE_AFTER_DEPOSIT",
        released: true,
        cancelled: false,
        writtenOff: false,
        schedule: [
            { ...validUnpaidLine, due_date: "2026-10-21" },
            validUnpaidLine,
        ],
    }), /strictly increasing order/);
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "INVALID" as "HOLD_UNTIL_PAID",
        released: true,
        cancelled: false,
        writtenOff: false,
        schedule: [validUnpaidLine],
    }), /Release mode is invalid/);
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "RELEASE_AFTER_DEPOSIT",
        released: false,
        cancelled: false,
        writtenOff: false,
        schedule: [validUnpaidLine],
    }), /must have a release event/);
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "HOLD_UNTIL_PAID",
        released: true,
        cancelled: false,
        writtenOff: false,
        schedule: [validUnpaidLine],
    }), /cannot be released before its schedule is paid/);
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "HOLD_UNTIL_PAID",
        released: true,
        cancelled: true,
        writtenOff: false,
        schedule: [validUnpaidLine],
    }), /released agreement cannot be cancelled/);
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "HOLD_UNTIL_PAID",
        released: false,
        cancelled: true,
        writtenOff: true,
        schedule: [validUnpaidLine],
    }), /both cancelled and written off/);
    assert.throws(() => deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "HOLD_UNTIL_PAID",
        released: false,
        cancelled: false,
        writtenOff: true,
        schedule: [validUnpaidLine],
    }), /cannot be written off before goods are released/);
    assert.deepEqual(deriveInstallmentStatus({
        todayDate: "2026-10-19",
        releaseMode: "RELEASE_AFTER_DEPOSIT",
        released: true,
        cancelled: false,
        writtenOff: true,
        schedule: [validUnpaidLine],
    }), { status: "WRITTEN_OFF", ready_for_handover: false });
});

test("agreement reconciliation includes reversals and write-offs without floating point", () => {
    assert.equal(calculateInstallmentBalanceCents({
        totalPayableCents: 1_250_000n,
        allocatedPaymentCents: 450_000n,
        reversedPaymentCents: 100_000n,
        writtenOffCents: 50_000n,
    }), 850_000n);
    assert.throws(() => calculateInstallmentBalanceCents({
        totalPayableCents: 100n,
        allocatedPaymentCents: 50n,
        reversedPaymentCents: 60n,
        writtenOffCents: 0n,
    }), /amounts are invalid/);
    assert.throws(() => calculateInstallmentBalanceCents({
        totalPayableCents: 100n,
        allocatedPaymentCents: 100n,
        reversedPaymentCents: 0n,
        writtenOffCents: 1n,
    }), /negative balance/);
});

test("held agreement cancellation fee and refund reconcile to every cent", () => {
    assert.deepEqual(calculateInstallmentCancellationAmounts(10_001n, 500), {
        feeCents: 500n,
        refundCents: 9_501n,
    });
    assert.deepEqual(calculateInstallmentCancellationAmounts(1n, 5_000), {
        feeCents: 1n,
        refundCents: 0n,
    });
    assert.deepEqual(calculateInstallmentCancellationAmounts(100n, 0), {
        feeCents: 0n,
        refundCents: 100n,
    });
    assert.throws(() => calculateInstallmentCancellationAmounts(-1n, 0), /fee percent is invalid/);
    assert.throws(() => calculateInstallmentCancellationAmounts(100n, 10_001), /fee percent is invalid/);
});

test("installment cancellation requires a supported refund tender and bounded reason", () => {
    assert.deepEqual(sanitizeInstallmentCancellationRequest({
        refund_method: "MPESA",
        refund_confirmed: true,
        refund_reference_number: "MPESA-REF-123",
        reason: "  Customer requested cancellation  ",
    }), {
        refund_method: "MPESA",
        refund_confirmed: true,
        refund_reference_number: "MPESA-REF-123",
        reason: "Customer requested cancellation",
    });
    assert.throws(() => sanitizeInstallmentCancellationRequest({
        refund_method: "OTHER",
        refund_confirmed: true,
        refund_reference_number: "REF-1",
        reason: "Refund",
    }), /refund_method must be/);
    assert.throws(() => sanitizeInstallmentCancellationRequest({
        refund_method: "CASH",
        refund_confirmed: true,
        reason: " ",
    }), /reason must contain/);
    assert.throws(() => sanitizeInstallmentCancellationRequest({
        refund_method: "MPESA",
        refund_confirmed: true,
        reason: "Refund",
    }), /refund_reference_number is required/);
    assert.throws(() => sanitizeInstallmentCancellationRequest({
        refund_method: "BANK_TRANSFER",
        refund_confirmed: true,
        refund_reference_number: ` ${"x".repeat(100)} `,
        reason: "Refund",
    }), /trimmed reference/);
    assert.throws(() => sanitizeInstallmentCancellationRequest({
        refund_method: "CASH",
        reason: "Refund",
    }), /refund_confirmed must be true/);
    assert.throws(() => sanitizeInstallmentCancellationRequest({
        refund_method: "CASH",
        refund_confirmed: true,
        refund_reference_number: "CASH-REF-1",
        reason: "Valid reason",
        refund_cents: "100",
    }), /Unknown installment cancellation field/);
});

test("write-offs must be positive and bounded by the remaining receivable", () => {
    assert.equal(validateInstallmentWriteOffCents(10_000n, 1n), 1n);
    assert.equal(validateInstallmentWriteOffCents(10_000n, 10_000n), 10_000n);
    assert.throws(() => validateInstallmentWriteOffCents(10_000n, 0n), /must be positive/);
    assert.throws(() => validateInstallmentWriteOffCents(10_000n, 10_001n), /cannot exceed/);
});

test("payment reversal copies all original principal and interest allocations exactly", () => {
    assert.deepEqual(buildFullPaymentReversalAllocations([
        {
            payment_allocation_id: "allocation-1",
            installment_number: 1,
            principal_cents: 10_000n,
            interest_cents: 1_000n,
        },
        {
            payment_allocation_id: "allocation-2",
            installment_number: 2,
            principal_cents: 2_273n,
            interest_cents: 227n,
        },
    ], 13_500n), [
        {
            payment_allocation_id: "allocation-1",
            installment_number: 1,
            principal_cents: 10_000n,
            interest_cents: 1_000n,
        },
        {
            payment_allocation_id: "allocation-2",
            installment_number: 2,
            principal_cents: 2_273n,
            interest_cents: 227n,
        },
    ]);
    assert.throws(() => buildFullPaymentReversalAllocations([{
        payment_allocation_id: "allocation-1",
        installment_number: 1,
        principal_cents: 10_000n,
        interest_cents: 1_000n,
    }], 12_000n), /must equal the payment amount/);
    assert.throws(() => buildFullPaymentReversalAllocations([
        {
            payment_allocation_id: "allocation-1",
            installment_number: 1,
            principal_cents: 10_000n,
            interest_cents: 0n,
        },
        {
            payment_allocation_id: "allocation-2",
            installment_number: 1,
            principal_cents: 0n,
            interest_cents: 1_000n,
        },
    ], 11_000n), /allocation amounts are invalid/);
    assert.throws(() => buildFullPaymentReversalAllocations([{
        payment_allocation_id: " allocation-1 ",
        installment_number: 1,
        principal_cents: 10_000n,
        interest_cents: 1_000n,
    }], 11_000n), /identifiers must be non-empty and unique/);
    assert.throws(() => buildFullPaymentReversalAllocations([{
        payment_allocation_id: "allocation-121",
        installment_number: 121,
        principal_cents: 10_000n,
        interest_cents: 1_000n,
    }], 11_000n), /allocation amounts are invalid/);
});

test("payment reversal supports deposit allocation zero and validates the reversal reason", () => {
    assert.deepEqual(buildFullPaymentReversalAllocations([{
        payment_allocation_id: "deposit-allocation",
        installment_number: 0,
        principal_cents: 10_000n,
        interest_cents: 0n,
    }], 10_000n), [{
        payment_allocation_id: "deposit-allocation",
        installment_number: 0,
        principal_cents: 10_000n,
        interest_cents: 0n,
    }]);
    assert.deepEqual(sanitizeInstallmentPaymentReversalRequest({ reason: "  Incorrect receipt  " }), {
        reason: "Incorrect receipt",
    });
    assert.throws(() => sanitizeInstallmentPaymentReversalRequest({ reason: " " }), /reason must contain/);
    assert.throws(() => sanitizeInstallmentPaymentReversalRequest({
        reason: "Valid",
        amount: "1.00",
    }), /Unknown installment payment reversal field/);
});

test("cumulative installment points do not lose value across many small payments", () => {
    let cumulativePrincipalCents = 0n;
    let cumulativePoints = 0n;
    for (let payment = 0; payment < 50; payment += 1) {
        const pointsDelta = calculateInstallmentPointsDelta(cumulativePrincipalCents, 200n, 1n);
        cumulativePrincipalCents += 200n;
        cumulativePoints += pointsDelta;
    }
    assert.equal(cumulativePrincipalCents, 10_000n);
    assert.equal(cumulativePoints, 1n);
    assert.equal(calculateInstallmentPointsReversal(cumulativePoints), -1n);
    assert.throws(() => calculateInstallmentPointsReversal(-1n), /non-negative/);
});

test("reversing an older payment adjusts cumulative points even if that payment earned none", () => {
    assert.equal(calculateCumulativeInstallmentPointsAdjustment(10_000n, 9_800n, 1n), -1n);
    assert.equal(calculateCumulativeInstallmentPointsAdjustment(9_800n, 10_000n, 1n), 1n);
});

test("installment loyalty ledger adjustments stay within PostgreSQL bigint range", () => {
    const maxPoints = 9_223_372_036_854_775_807n;
    assert.equal(calculateCumulativeInstallmentPointsAdjustment(
        0n,
        maxPoints * 10_000n,
        1n,
    ), maxPoints);
    assert.throws(() => calculateCumulativeInstallmentPointsAdjustment(
        0n,
        (maxPoints + 1n) * 10_000n,
        1n,
    ), /maximum supported database amount/);
    assert.equal(calculateInstallmentPointsReversal(maxPoints), -maxPoints);
    assert.throws(() => calculateInstallmentPointsReversal(maxPoints + 1n), /supported database amount/);
});

test("voucher eligibility for installment points follows the payment date and inclusive expiry", () => {
    assert.equal(isVoucherValidOnPaymentDate("2026-01-01", "2026-10-19", "2026-10-19"), true);
    assert.equal(isVoucherValidOnPaymentDate("2026-01-01", "2026-10-19", "2026-10-20"), false);
    assert.equal(isVoucherValidOnPaymentDate("2026-01-01", "2026-10-19", "2025-12-31"), false);
    assert.throws(() => isVoucherValidOnPaymentDate("2026-02-30", "2026-10-19", "2026-10-19"), /valid YYYY-MM-DD/);
});
