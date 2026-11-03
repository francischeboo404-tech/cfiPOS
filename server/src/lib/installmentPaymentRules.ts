import { centsToKesString, divideRoundHalfUp, parseKesToCents, POSTGRES_BIGINT_MAX } from "./exactMoney";
import { calculateEarnedPoints, isVoucherExpired } from "./voucherRules";

export type InstallmentPaymentMethod = "CASH" | "MPESA" | "BANK_TRANSFER" | "OTHER";
export type InstallmentRefundMethod = "CASH" | "MPESA" | "BANK_TRANSFER";

export const isInstallmentPaymentMethod = (value: string): value is InstallmentPaymentMethod =>
    value === "CASH" || value === "MPESA" || value === "BANK_TRANSFER" || value === "OTHER";

export interface SanitizedInstallmentCancellationRequest {
    refund_method: InstallmentRefundMethod;
    refund_confirmed: true;
    refund_reference_number: string | null;
    reason: string;
}

export interface SanitizedInstallmentPaymentReversalRequest {
    reason: string;
}

export const sanitizeInstallmentPaymentReversalRequest = (
    input: unknown,
): SanitizedInstallmentPaymentReversalRequest => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Installment payment reversal must be an object");
    }
    const value = input as Record<string, unknown>;
    const unknownKey = Object.keys(value).find((key) => key !== "reason");
    if (unknownKey) throw new Error(`Unknown installment payment reversal field: ${unknownKey}`);

    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    if (!reason || reason.length > 1000) {
        throw new Error("reason must contain between 1 and 1000 characters");
    }
    return { reason };
};

export const sanitizeInstallmentCancellationRequest = (
    input: unknown,
): SanitizedInstallmentCancellationRequest => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Installment cancellation must be an object");
    }
    const value = input as Record<string, unknown>;
    const allowedKeys = new Set([
        "refund_method",
        "refund_confirmed",
        "refund_reference_number",
        "reason",
    ]);
    const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unknownKey) throw new Error(`Unknown installment cancellation field: ${unknownKey}`);

    if (!["CASH", "MPESA", "BANK_TRANSFER"].includes(String(value.refund_method))) {
        throw new Error("refund_method must be CASH, MPESA, or BANK_TRANSFER");
    }
    if (value.refund_confirmed !== true) {
        throw new Error("refund_confirmed must be true after the refund has been paid");
    }
    const refundReferenceNumber = typeof value.refund_reference_number === "string"
        ? value.refund_reference_number.trim()
        : "";
    if (value.refund_reference_number !== undefined &&
        (typeof value.refund_reference_number !== "string" ||
            value.refund_reference_number !== refundReferenceNumber ||
            refundReferenceNumber.length > 100)) {
        throw new Error("refund_reference_number must be a trimmed reference of at most 100 characters");
    }
    const refundMethod = value.refund_method as InstallmentRefundMethod;
    if (refundMethod !== "CASH" && !refundReferenceNumber) {
        throw new Error("refund_reference_number is required for non-cash refunds");
    }
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    if (!reason || reason.length > 1000) {
        throw new Error("reason must contain between 1 and 1000 characters");
    }

    return {
        refund_method: refundMethod,
        refund_confirmed: true,
        refund_reference_number: refundReferenceNumber || null,
        reason,
    };
};

export interface SanitizedInstallmentPaymentRequest {
    agreement_id: string;
    payment_date: string;
    amount: string;
    payment_method: InstallmentPaymentMethod;
    reference_number: string | null;
    idempotency_key: string;
}

export interface InstallmentBalance {
    installment_number: number;
    principal_cents: bigint;
    interest_cents: bigint;
    principal_paid_cents: bigint;
    interest_paid_cents: bigint;
}

export interface InstallmentPaymentAllocation {
    installment_number: number;
    principal_cents: bigint;
    interest_cents: bigint;
}

export interface InstallmentPaymentAllocationForReversal extends InstallmentPaymentAllocation {
    payment_allocation_id: string;
}

export interface InstallmentReversalAllocation extends InstallmentPaymentAllocation {
    payment_allocation_id: string;
}

export const isVoucherValidOnPaymentDate = (
    issueDate: string,
    expiryDate: string,
    paymentDate: string,
): boolean => {
    const isValidDate = (date: string): boolean => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
        const parsed = new Date(`${date}T00:00:00.000Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
    };
    if (!isValidDate(issueDate) || !isValidDate(expiryDate) || !isValidDate(paymentDate)) {
        throw new Error("Voucher dates must be valid YYYY-MM-DD dates");
    }
    if (expiryDate < issueDate) throw new Error("Voucher expiry date cannot precede its issue date");
    return issueDate <= paymentDate && !isVoucherExpired(expiryDate, paymentDate);
};

export const buildFullPaymentReversalAllocations = (
    allocations: InstallmentPaymentAllocationForReversal[],
    paymentAmountCents: bigint,
): InstallmentReversalAllocation[] => {
    if (paymentAmountCents <= 0n || allocations.length === 0) {
        throw new Error("A reversal requires a positive payment and at least one allocation");
    }
    const seenAllocationIds = new Set<string>();
    const seenInstallmentNumbers = new Set<number>();
    const totalAllocatedCents = allocations.reduce((total, allocation) => {
        const allocationId = typeof allocation.payment_allocation_id === "string"
            ? allocation.payment_allocation_id.trim()
            : "";
        if (!allocationId || allocationId !== allocation.payment_allocation_id ||
            seenAllocationIds.has(allocationId)) {
            throw new Error("Payment allocation identifiers must be non-empty and unique");
        }
        seenAllocationIds.add(allocationId);
        if (!Number.isSafeInteger(allocation.installment_number) || allocation.installment_number < 0 ||
            allocation.installment_number > 120 ||
            seenInstallmentNumbers.has(allocation.installment_number) ||
            allocation.principal_cents < 0n || allocation.interest_cents < 0n ||
            allocation.principal_cents + allocation.interest_cents <= 0n) {
            throw new Error("Payment reversal allocation amounts are invalid");
        }
        seenInstallmentNumbers.add(allocation.installment_number);
        return total + allocation.principal_cents + allocation.interest_cents;
    }, 0n);
    if (totalAllocatedCents !== paymentAmountCents) {
        throw new Error("Payment allocations must equal the payment amount before reversal");
    }
    return allocations.map((allocation) => ({ ...allocation }));
};

export const calculateInstallmentPointsDelta = (
    previouslyEligiblePrincipalCents: bigint,
    newlyEligiblePrincipalCents: bigint,
    pointsPerKes100: bigint,
): bigint => {
    if (previouslyEligiblePrincipalCents < 0n || newlyEligiblePrincipalCents < 0n ||
        pointsPerKes100 < 0n) {
        throw new Error("Eligible principal and voucher rate must be non-negative");
    }
    return calculateCumulativeInstallmentPointsAdjustment(
        previouslyEligiblePrincipalCents,
        previouslyEligiblePrincipalCents + newlyEligiblePrincipalCents,
        pointsPerKes100,
    );
};

export const calculateCumulativeInstallmentPointsAdjustment = (
    previouslyEligiblePrincipalCents: bigint,
    nextEligiblePrincipalCents: bigint,
    pointsPerKes100: bigint,
): bigint => {
    if (previouslyEligiblePrincipalCents < 0n || nextEligiblePrincipalCents < 0n ||
        pointsPerKes100 < 0n) {
        throw new Error("Eligible principal and voucher rate must be non-negative");
    }
    const adjustment = calculateEarnedPoints(nextEligiblePrincipalCents, pointsPerKes100) -
        calculateEarnedPoints(previouslyEligiblePrincipalCents, pointsPerKes100);
    if (adjustment > POSTGRES_BIGINT_MAX || adjustment < -POSTGRES_BIGINT_MAX) {
        throw new Error("Installment points adjustment exceeds the maximum supported database amount");
    }
    return adjustment;
};

export const calculateInstallmentPointsReversal = (pointsCredited: bigint): bigint => {
    if (pointsCredited < 0n) {
        throw new Error("Credited points must be non-negative");
    }
    if (pointsCredited > POSTGRES_BIGINT_MAX) {
        throw new Error("Credited points are outside the supported database amount");
    }
    return -pointsCredited;
};

export type InstallmentAgreementStatus =
    | "ACTIVE"
    | "OVERDUE"
    | "COMPLETED"
    | "CANCELLED"
    | "WRITTEN_OFF";

export interface InstallmentStatusScheduleLine {
    due_date: string;
    principal_cents: bigint;
    interest_cents: bigint;
    principal_paid_cents: bigint;
    interest_paid_cents: bigint;
}

export interface DerivedInstallmentStatus {
    status: InstallmentAgreementStatus;
    ready_for_handover: boolean;
}

export const deriveInstallmentStatus = (input: {
    todayDate: string;
    releaseMode: "HOLD_UNTIL_PAID" | "RELEASE_AFTER_DEPOSIT";
    released: boolean;
    cancelled: boolean;
    writtenOff: boolean;
    schedule: InstallmentStatusScheduleLine[];
}): DerivedInstallmentStatus => {
    const validDate = (date: string): boolean => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
        const parsed = new Date(`${date}T00:00:00.000Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
    };
    if (!validDate(input.todayDate)) throw new Error("todayDate must be a valid YYYY-MM-DD date");
    if (input.releaseMode !== "HOLD_UNTIL_PAID" && input.releaseMode !== "RELEASE_AFTER_DEPOSIT") {
        throw new Error("Release mode is invalid");
    }
    if (input.schedule.length === 0) throw new Error("An installment agreement must have a schedule");

    let hasOutstanding = false;
    let overdue = false;
    let previousDueDate: string | null = null;
    for (const line of input.schedule) {
        if (!validDate(line.due_date)) throw new Error("Schedule due dates must be valid YYYY-MM-DD dates");
        if (previousDueDate !== null && line.due_date <= previousDueDate) {
            throw new Error("Schedule due dates must be in strictly increasing order");
        }
        previousDueDate = line.due_date;
        if (line.principal_cents < 0n || line.interest_cents < 0n ||
            line.principal_paid_cents < 0n || line.interest_paid_cents < 0n ||
            line.principal_paid_cents > line.principal_cents ||
            line.interest_paid_cents > line.interest_cents) {
            throw new Error("Schedule paid amounts must be within their non-negative scheduled amounts");
        }
        const lineOutstanding = line.principal_paid_cents < line.principal_cents ||
            line.interest_paid_cents < line.interest_cents;
        hasOutstanding ||= lineOutstanding;
        overdue ||= line.due_date < input.todayDate && lineOutstanding;
    }

    if (input.cancelled && input.writtenOff) {
        throw new Error("An agreement cannot be both cancelled and written off");
    }
    if (input.cancelled && input.released) {
        throw new Error("A released agreement cannot be cancelled");
    }
    if (input.writtenOff && !input.released) {
        throw new Error("An agreement cannot be written off before goods are released");
    }
    if (input.releaseMode === "HOLD_UNTIL_PAID" && input.released && hasOutstanding) {
        throw new Error("A held agreement cannot be released before its schedule is paid");
    }
    if (input.releaseMode === "RELEASE_AFTER_DEPOSIT" && !input.released && !input.cancelled) {
        throw new Error("A release-after-deposit agreement must have a release event");
    }
    if (input.cancelled) return { status: "CANCELLED", ready_for_handover: false };
    if (input.writtenOff) return { status: "WRITTEN_OFF", ready_for_handover: false };
    if (!hasOutstanding) {
        const readyForHandover = input.releaseMode === "HOLD_UNTIL_PAID" && !input.released;
        return {
            status: readyForHandover ? "ACTIVE" : "COMPLETED",
            ready_for_handover: readyForHandover,
        };
    }
    return { status: overdue ? "OVERDUE" : "ACTIVE", ready_for_handover: false };
};

export const calculateInstallmentBalanceCents = (input: {
    totalPayableCents: bigint;
    allocatedPaymentCents: bigint;
    reversedPaymentCents: bigint;
    writtenOffCents: bigint;
}): bigint => {
    if (input.totalPayableCents < 0n || input.allocatedPaymentCents < 0n ||
        input.reversedPaymentCents < 0n || input.writtenOffCents < 0n ||
        input.reversedPaymentCents > input.allocatedPaymentCents) {
        throw new Error("Installment reconciliation amounts are invalid");
    }
    const balance = input.totalPayableCents - input.allocatedPaymentCents +
        input.reversedPaymentCents - input.writtenOffCents;
    if (balance < 0n) throw new Error("Installment reconciliation would produce a negative balance");
    return balance;
};

export const calculateInstallmentCancellationAmounts = (
    paidCents: bigint,
    cancellationFeePercentBps: number,
): { feeCents: bigint; refundCents: bigint } => {
    if (paidCents < 0n || !Number.isSafeInteger(cancellationFeePercentBps) ||
        cancellationFeePercentBps < 0 || cancellationFeePercentBps > 10_000) {
        throw new Error("Cancellation paid amount or fee percent is invalid");
    }
    const feeCents = divideRoundHalfUp(paidCents * BigInt(cancellationFeePercentBps), 10_000n);
    return { feeCents, refundCents: paidCents - feeCents };
};

export const validateInstallmentWriteOffCents = (
    remainingBalanceCents: bigint,
    writeOffCents: bigint,
): bigint => {
    if (remainingBalanceCents < 0n || writeOffCents <= 0n ||
        writeOffCents > remainingBalanceCents) {
        throw new Error("Write-off amount must be positive and cannot exceed the remaining balance");
    }
    return writeOffCents;
};

export const sanitizeInstallmentPaymentRequest = (
    input: unknown,
    todayDate: string,
): SanitizedInstallmentPaymentRequest => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Installment payment must be an object");
    }
    const value = input as Record<string, unknown>;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const agreementId = typeof value.agreement_id === "string" ? value.agreement_id.trim().toLowerCase() : "";
    const idempotencyKey = typeof value.idempotency_key === "string"
        ? value.idempotency_key.trim().toLowerCase()
        : "";
    if (!uuidPattern.test(agreementId)) throw new Error("agreement_id must be a valid UUID");
    if (!uuidPattern.test(idempotencyKey)) throw new Error("idempotency_key must be a valid UUID");

    if (typeof value.payment_date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.payment_date)) {
        throw new Error("payment_date must be a valid YYYY-MM-DD date");
    }
    const parsedPaymentDate = new Date(`${value.payment_date}T00:00:00.000Z`);
    if (!Number.isFinite(parsedPaymentDate.getTime()) ||
        parsedPaymentDate.toISOString().slice(0, 10) !== value.payment_date) {
        throw new Error("payment_date must be a valid YYYY-MM-DD date");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(todayDate) ||
        !Number.isFinite(new Date(`${todayDate}T00:00:00.000Z`).getTime()) ||
        new Date(`${todayDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== todayDate) {
        throw new Error("todayDate must be a valid YYYY-MM-DD date");
    }
    if (value.payment_date > todayDate) throw new Error("payment_date cannot be in the future");

    if (typeof value.amount !== "string") {
        throw new Error("amount must be a positive KES decimal string with at most two decimal places");
    }
    let amountCents: bigint;
    try {
        amountCents = parseKesToCents(value.amount);
    } catch {
        throw new Error("amount must be a positive KES decimal string with at most two decimal places");
    }
    if (amountCents <= 0n) throw new Error("amount must be greater than zero");
    if (amountCents > POSTGRES_BIGINT_MAX) {
        throw new Error("amount exceeds the maximum supported database amount");
    }

    if (!["CASH", "MPESA", "BANK_TRANSFER", "OTHER"].includes(String(value.payment_method))) {
        throw new Error("payment_method must be CASH, MPESA, BANK_TRANSFER, or OTHER");
    }
    const referenceNumber = value.reference_number === undefined || value.reference_number === null
        ? null
        : typeof value.reference_number === "string" ? value.reference_number.trim() : "";
    if (referenceNumber === "" || (referenceNumber !== null && referenceNumber.length > 100)) {
        throw new Error("reference_number must be a string of 1 to 100 characters when provided");
    }
    if (value.payment_method !== "CASH" && referenceNumber === null) {
        throw new Error("reference_number is required for non-cash installment payments");
    }

    const allowedKeys = new Set([
        "agreement_id",
        "payment_date",
        "amount",
        "payment_method",
        "reference_number",
        "idempotency_key",
    ]);
    const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unknownKey) throw new Error(`Unknown installment payment field: ${unknownKey}`);

    return {
        agreement_id: agreementId,
        payment_date: value.payment_date,
        amount: centsToKesString(amountCents),
        payment_method: value.payment_method as InstallmentPaymentMethod,
        reference_number: referenceNumber,
        idempotency_key: idempotencyKey,
    };
};

export const allocateInstallmentPayment = (
    installments: InstallmentBalance[],
    amountCents: bigint,
): InstallmentPaymentAllocation[] => {
    if (amountCents <= 0n) {
        throw new Error("Payment amount must be greater than zero");
    }

    const seenInstallments = new Set<number>();
    const balances = installments.map((installment) => {
        if (!Number.isSafeInteger(installment.installment_number) ||
            installment.installment_number < 1 || installment.installment_number > 120) {
            throw new Error("Installment numbers must be whole numbers between 1 and 120");
        }
        if (seenInstallments.has(installment.installment_number)) {
            throw new Error("Installment numbers must be unique");
        }
        seenInstallments.add(installment.installment_number);

        const amounts = [
            installment.principal_cents,
            installment.interest_cents,
            installment.principal_paid_cents,
            installment.interest_paid_cents,
        ];
        if (amounts.some((amount) => amount < 0n)) {
            throw new Error("Installment amounts and paid amounts cannot be negative");
        }

        const principalRemaining = installment.principal_cents - installment.principal_paid_cents;
        const interestRemaining = installment.interest_cents - installment.interest_paid_cents;
        if (principalRemaining < 0n || interestRemaining < 0n) {
            throw new Error("Paid installment amounts cannot exceed the scheduled amounts");
        }
        return {
            installment_number: installment.installment_number,
            principalRemaining,
            interestRemaining,
            totalRemaining: principalRemaining + interestRemaining,
        };
    }).sort((left, right) => left.installment_number - right.installment_number);

    for (let index = 0; index < balances.length; index += 1) {
        if (balances[index].installment_number !== index + 1) {
            throw new Error("Installment numbers must form a contiguous sequence starting at one");
        }
    }

    const totalRemaining = balances.reduce((sum, balance) => sum + balance.totalRemaining, 0n);
    if (amountCents > totalRemaining) {
        throw new Error("Payment amount exceeds the remaining agreement balance");
    }

    let unappliedCents = amountCents;
    const allocations: InstallmentPaymentAllocation[] = [];
    for (const balance of balances) {
        if (unappliedCents === 0n) break;
        if (balance.totalRemaining === 0n) continue;

        const allocationCents = unappliedCents < balance.totalRemaining
            ? unappliedCents
            : balance.totalRemaining;
        let principalCents: bigint;
        let interestCents: bigint;
        if (allocationCents === balance.totalRemaining) {
            principalCents = balance.principalRemaining;
            interestCents = balance.interestRemaining;
        } else {
            const proportionalPrincipal = divideRoundHalfUp(
                allocationCents * balance.principalRemaining,
                balance.totalRemaining,
            );
            const minimumPrincipal = allocationCents > balance.interestRemaining
                ? allocationCents - balance.interestRemaining
                : 0n;
            const maximumPrincipal = allocationCents < balance.principalRemaining
                ? allocationCents
                : balance.principalRemaining;
            principalCents = proportionalPrincipal < minimumPrincipal
                ? minimumPrincipal
                : proportionalPrincipal > maximumPrincipal
                    ? maximumPrincipal
                    : proportionalPrincipal;
            interestCents = allocationCents - principalCents;
        }

        allocations.push({
            installment_number: balance.installment_number,
            principal_cents: principalCents,
            interest_cents: interestCents,
        });
        unappliedCents -= allocationCents;
    }

    if (unappliedCents !== 0n) {
        throw new Error("Payment could not be fully allocated to the installment schedule");
    }
    return allocations;
};
