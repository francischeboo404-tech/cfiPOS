import { parseKesDecimalToCents } from "../lib/exactMoney";

export const sumKesAmountsToCents = (values: unknown[]): bigint =>
    values.reduce<bigint>((sum, value) => sum + parseKesDecimalToCents(value), 0n);

export const dashboardMoneyCents = (snapshotCents: string | null, legacyDecimal: unknown): bigint => {
    if (snapshotCents === null) return parseKesDecimalToCents(legacyDecimal);
    if (!/^-?\d+$/.test(snapshotCents)) {
        throw new Error(`Invalid integer-cent dashboard snapshot: ${snapshotCents}`);
    }
    return BigInt(snapshotCents);
};
