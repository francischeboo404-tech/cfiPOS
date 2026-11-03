export const parseKesToCents = (input: string | number): number => {
  const value = String(input).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("KES amount must have at most two decimal places");
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0");
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("KES amount is too large");
  return Number(cents);
};

export const centsToKesString = (cents: number | bigint): string => {
  if (typeof cents === "number" && !Number.isSafeInteger(cents)) {
    throw new Error("KES cents must be a safe integer");
  }
  const centsBigInt = BigInt(cents);
  const negative = centsBigInt < 0n;
  const absolute = negative ? -centsBigInt : centsBigInt;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

export const formatKesCents = (cents: number | bigint): string => {
  if (typeof cents === "number" && !Number.isSafeInteger(cents)) {
    throw new Error("KES cents must be a safe integer");
  }
  const centsBigInt = BigInt(cents);
  const negative = centsBigInt < 0n;
  const absolute = negative ? -centsBigInt : centsBigInt;
  const whole = new Intl.NumberFormat("en-KE").format(absolute / 100n);
  return `${negative ? "-" : ""}KES ${whole}.${String(absolute % 100n).padStart(2, "0")}`;
};
