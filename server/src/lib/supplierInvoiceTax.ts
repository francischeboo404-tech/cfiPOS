import { divideRoundHalfUp, parseKesToCents, percentageToBasisPoints } from "./exactMoney";

export interface SupplierInvoiceTaxLine {
    line_total: number | string;
    product: {
        tax_class?: { rate: number | string } | null;
        tax_rate?: number | string;
    } | null;
}

export const calculateExpectedSupplierInvoiceTaxCents = (
    lines: SupplierInvoiceTaxLine[],
): bigint =>
    lines.reduce((taxCents, line) => {
        if (!line.product) {
            throw new Error("Received invoice items must include their product tax classification");
        }
        const taxRate = line.product.tax_class?.rate ?? line.product.tax_rate ?? 0;
        const rateBasisPoints = percentageToBasisPoints(String(taxRate));
        const lineValueCents = parseKesToCents(String(line.line_total));
        return taxCents + divideRoundHalfUp(
            lineValueCents * BigInt(rateBasisPoints),
            10_000n,
        );
    }, 0n);

export const validateSupplierInvoiceTax = (
    requestedTaxCents: bigint,
    expectedTaxCents: bigint,
): void => {
    if (requestedTaxCents !== expectedTaxCents) {
        throw new Error(
            "Invoice tax amount must equal the tax calculated from the received items and their tax classes",
        );
    }
};
