import { AccountType } from "../entity/Account";

export type ManualInvoiceAccountPurpose = "subtotal" | "tax";

export interface ManualInvoiceAccountCandidate {
    id: string;
    code: string;
    type: AccountType;
    is_active: boolean;
}

export class ManualSupplierInvoiceAccountingError extends Error {}

const nonExpenseDebitCodes = new Set(["1000", "1010", "1020", "1200", "2000"]);

export const normalizeInvoiceAccountingDate = (value: Date | string): string => {
    if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) {
            throw new ManualSupplierInvoiceAccountingError("Invoice date is invalid");
        }
        return value.toISOString().slice(0, 10);
    }

    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value) {
        throw new ManualSupplierInvoiceAccountingError("Invoice date is invalid");
    }
    return value;
};

export const isEligibleManualInvoiceDebitAccount = (
    account: ManualInvoiceAccountCandidate,
    purpose: ManualInvoiceAccountPurpose,
): boolean =>
    account.is_active &&
    (account.type === AccountType.ASSET || account.type === AccountType.EXPENSE) &&
    !nonExpenseDebitCodes.has(account.code) &&
    (purpose === "tax" || account.code !== "1400");

export const validateManualInvoiceAmounts = (
    subtotalCents: bigint,
    taxCents: bigint,
    totalCents: bigint,
): void => {
    if (subtotalCents < 0n || taxCents < 0n || totalCents <= 0n) {
        throw new ManualSupplierInvoiceAccountingError(
            "Invoice amounts must be non-negative and the total must be positive",
        );
    }
    if (subtotalCents + taxCents !== totalCents) {
        throw new ManualSupplierInvoiceAccountingError(
            "Invoice total must equal subtotal plus tax exactly before accounting review",
        );
    }
};
