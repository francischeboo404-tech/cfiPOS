import {
    centsToKesString,
    divideRoundHalfUp,
    parseKesToCents,
    percentageToBasisPoints,
    POSTGRES_BIGINT_MAX,
} from "./exactMoney";

export const INSTALLMENT_LIFECYCLE_READY = false;
export const isInstallmentSellingEnabled = (storedSetting: string | null | undefined): boolean =>
    INSTALLMENT_LIFECYCLE_READY && storedSetting === "true";

export type InstallmentFrequency = "WEEKLY" | "EVERY_2_WEEKS" | "MONTHLY";
export type InstallmentInterestType = "FLAT_TOTAL" | "FLAT_PER_MONTH";
export type InstallmentReleaseMode = "HOLD_UNTIL_PAID" | "RELEASE_AFTER_DEPOSIT";

export interface InstallmentPlanTerms {
    number_of_installments: number;
    frequency: InstallmentFrequency;
    min_deposit_percent_bps: number;
    interest_type: InstallmentInterestType;
    interest_rate_bps: number;
}

export interface InstallmentScheduleItem {
    installment_number: number;
    due_date: string;
    principal_cents: bigint;
    interest_cents: bigint;
}

export interface InstallmentQuote {
    price_total_cents: bigint;
    deposit_cents: bigint;
    financed_cents: bigint;
    interest_cents: bigint;
    total_payable_cents: bigint;
    schedule: InstallmentScheduleItem[];
    months_hundredths: number | null;
}

export interface SanitizedInstallmentPlan {
    name: string;
    active: boolean;
    number_of_installments: number;
    frequency: InstallmentFrequency;
    min_deposit_percent_bps: number;
    interest_type: InstallmentInterestType;
    interest_rate_bps: number;
    release_mode: InstallmentReleaseMode;
    min_financed_cents: string | null;
    max_financed_cents: string | null;
}

export interface SanitizedInstallmentQuoteRequest {
    customer_id: string;
    plan_id: string;
    warehouse_id: string | null;
    deposit_amount: string | null;
    items: Array<{ product_id: string; quantity: number }>;
}

export interface SanitizedInstallmentAgreementRequest extends SanitizedInstallmentQuoteRequest {
    idempotency_key: string;
    deposit_payment_method: "CASH" | "MPESA" | "BANK_TRANSFER" | "OTHER" | null;
    deposit_reference_number: string | null;
}

export const isInstallmentUuid = (value: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const parseInstallmentMoneyString = (value: unknown, message: string): bigint => {
    if (typeof value !== "string") throw new Error(message);
    try {
        return parseKesToCents(value);
    } catch {
        throw new Error(message);
    }
};

export const parseStoredInstallmentCents = (
    value: string | null | undefined,
    settingKey: string,
): string => {
    if (value === undefined || value === null || !/^\d+$/.test(value)) {
        throw new Error(`Invalid stored installment setting: ${settingKey}`);
    }
    const cents = BigInt(value);
    if (cents > POSTGRES_BIGINT_MAX) {
        throw new Error(`Invalid stored installment setting: ${settingKey}`);
    }
    return cents.toString();
};

export const sanitizeInstallmentQuoteRequest = (input: unknown): SanitizedInstallmentQuoteRequest => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Installment quote must be an object");
    }
    const value = input as Record<string, unknown>;
    const allowedKeys = new Set(["customer_id", "plan_id", "warehouse_id", "deposit_amount", "items"]);
    const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unknownKey) throw new Error(`Unknown installment quote field: ${unknownKey}`);
    const customerId = typeof value.customer_id === "string" ? value.customer_id.trim().toLowerCase() : "";
    const planId = typeof value.plan_id === "string" ? value.plan_id.trim().toLowerCase() : "";
    const warehouseId = value.warehouse_id === undefined || value.warehouse_id === null || value.warehouse_id === ""
        ? null
        : typeof value.warehouse_id === "string" ? value.warehouse_id.trim().toLowerCase() : "";
    if (!customerId) throw new Error("customer_id is required");
    if (!planId) throw new Error("plan_id is required");
    if (warehouseId === "") throw new Error("warehouse_id must be a string");
    if (!isInstallmentUuid(customerId)) throw new Error("customer_id must be a valid UUID");
    if (!isInstallmentUuid(planId)) throw new Error("plan_id must be a valid UUID");
    if (warehouseId !== null && !isInstallmentUuid(warehouseId)) throw new Error("warehouse_id must be a valid UUID");
    if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 100) {
        throw new Error("items must contain between 1 and 100 products");
    }
    const byProduct = new Map<string, number>();
    for (const entry of value.items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("Each installment item must be an object");
        }
        const item = entry as Record<string, unknown>;
        const unknownItemKey = Object.keys(item).find((key) =>
            key !== "product_id" && key !== "quantity");
        if (unknownItemKey) throw new Error(`Unknown installment item field: ${unknownItemKey}`);
        const productId = typeof item.product_id === "string" ? item.product_id.trim().toLowerCase() : "";
        const quantity = item.quantity;
        if (!productId) throw new Error("Each installment item requires a product_id");
        if (!isInstallmentUuid(productId)) throw new Error("Each product_id must be a valid UUID");
        if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1) {
            throw new Error("Item quantities must be positive whole numbers");
        }
        const combinedQuantity = (byProduct.get(productId) || 0) + quantity;
        if (!Number.isSafeInteger(combinedQuantity)) throw new Error("Combined item quantity is too large");
        byProduct.set(productId, combinedQuantity);
    }
    let depositAmount: string | null = null;
    if (value.deposit_amount !== undefined && value.deposit_amount !== null && value.deposit_amount !== "") {
        depositAmount = centsToKesString(parseInstallmentMoneyString(
            value.deposit_amount,
            "deposit_amount must be a non-negative KES decimal string with at most two decimal places",
        ));
    }
    return {
        customer_id: customerId,
        plan_id: planId,
        warehouse_id: warehouseId,
        deposit_amount: depositAmount,
        items: Array.from(byProduct, ([product_id, quantity]) => ({ product_id, quantity }))
            .sort((left, right) => left.product_id.localeCompare(right.product_id)),
    };
};

export const sanitizeInstallmentAgreementRequest = (
    input: unknown,
): SanitizedInstallmentAgreementRequest => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Installment agreement must be an object");
    }
    const value = input as Record<string, unknown>;
    const allowed = new Set([
        "customer_id",
        "plan_id",
        "warehouse_id",
        "deposit_amount",
        "items",
        "idempotency_key",
        "deposit_payment_method",
        "deposit_reference_number",
    ]);
    const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
    if (unknownKey) throw new Error(`Unknown installment agreement field: ${unknownKey}`);

    const quoteInput = Object.fromEntries(
        ["customer_id", "plan_id", "warehouse_id", "deposit_amount", "items"]
            .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
            .map((key) => [key, value[key]]),
    );
    const quote = sanitizeInstallmentQuoteRequest(quoteInput);
    if (quote.deposit_amount === null) {
        throw new Error("deposit_amount is required when creating an installment agreement");
    }
    const idempotencyKey = typeof value.idempotency_key === "string"
        ? value.idempotency_key.trim().toLowerCase()
        : "";
    if (!isInstallmentUuid(idempotencyKey)) {
        throw new Error("idempotency_key must be a valid UUID");
    }

    const method = value.deposit_payment_method;
    if (method !== undefined && method !== null &&
        !["CASH", "MPESA", "BANK_TRANSFER", "OTHER"].includes(String(method))) {
        throw new Error("deposit_payment_method must be CASH, MPESA, BANK_TRANSFER, or OTHER");
    }
    const reference = value.deposit_reference_number === undefined ||
        value.deposit_reference_number === null
        ? null
        : typeof value.deposit_reference_number === "string"
            ? value.deposit_reference_number.trim()
            : "";
    if (reference === "" || (reference !== null && reference.length > 100)) {
        throw new Error("deposit_reference_number must be a string of 1 to 100 characters when provided");
    }
    const depositCents = parseKesToCents(quote.deposit_amount);
    const paymentMethod = method === undefined || method === null
        ? null
        : method as SanitizedInstallmentAgreementRequest["deposit_payment_method"];
    if (depositCents > 0n && !paymentMethod) {
        throw new Error("deposit_payment_method is required when the deposit is greater than zero");
    }
    if (depositCents === 0n && (paymentMethod || reference)) {
        throw new Error("Deposit payment details are not allowed when the deposit is zero");
    }
    if (depositCents > 0n && paymentMethod !== "CASH" && !reference) {
        throw new Error("deposit_reference_number is required for non-cash deposits");
    }

    return {
        ...quote,
        idempotency_key: idempotencyKey,
        deposit_payment_method: paymentMethod,
        deposit_reference_number: reference,
    };
};

export const sanitizeInstallmentSettingsPayload = (input: unknown): Record<string, string> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Installment settings must be an object");
    }
    const value = input as Record<string, unknown>;
    const allowed = new Set([
        "installments_enabled",
        "installment_max_open_credit_amount",
        "installment_cancellation_fee_percent",
        "installment_charge_vat_on_interest",
        "installment_retention_years",
    ]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new Error(`Unknown installment setting: ${key}`);
    }
    const sanitized: Record<string, string> = {};
    if (value.installments_enabled !== undefined) {
        if (typeof value.installments_enabled !== "boolean") {
            throw new Error("installments_enabled must be a boolean");
        }
        sanitized.installments_enabled = String(value.installments_enabled);
    }
    if (value.installment_charge_vat_on_interest !== undefined) {
        if (typeof value.installment_charge_vat_on_interest !== "boolean") {
            throw new Error("installment_charge_vat_on_interest must be a boolean");
        }
        sanitized.installment_charge_vat_on_interest = String(value.installment_charge_vat_on_interest);
    }
    if (value.installment_max_open_credit_amount !== undefined) {
        const maxOpenCreditCents = parseInstallmentMoneyString(
            value.installment_max_open_credit_amount,
            "installment_max_open_credit_amount must be a non-negative KES decimal string with at most two decimal places",
        );
        if (maxOpenCreditCents > POSTGRES_BIGINT_MAX) {
            throw new Error("installment_max_open_credit_amount exceeds the maximum supported database amount");
        }
        sanitized.installment_max_open_credit_cents = maxOpenCreditCents.toString();
    }
    if (value.installment_cancellation_fee_percent !== undefined) {
        if (typeof value.installment_cancellation_fee_percent !== "string") {
            throw new Error("installment_cancellation_fee_percent must be a decimal percentage string");
        }
        let basisPoints: number;
        try {
            basisPoints = percentageToBasisPoints(value.installment_cancellation_fee_percent);
        } catch {
            throw new Error("installment_cancellation_fee_percent must be a percentage with at most two decimal places");
        }
        if (basisPoints > 10_000) {
            throw new Error("installment_cancellation_fee_percent must be between 0 and 100");
        }
        sanitized.installment_cancellation_fee_percent_bps = String(basisPoints);
    }
    if (value.installment_retention_years !== undefined) {
        const years = value.installment_retention_years;
        if (typeof years !== "number" || !Number.isSafeInteger(years) || years < 7 || years > 100) {
            throw new Error("installment_retention_years must be an integer between 7 and 100");
        }
        sanitized.installment_retention_years = String(years);
    }
    if (Object.keys(sanitized).length === 0) throw new Error("At least one installment setting is required");
    return sanitized;
};

export const sanitizeInstallmentPlanPayload = (input: unknown): SanitizedInstallmentPlan => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Installment plan must be an object");
    }
    const value = input as Record<string, unknown>;
    const allowedKeys = new Set([
        "name",
        "active",
        "number_of_installments",
        "frequency",
        "min_deposit_percent",
        "interest_type",
        "interest_rate_percent",
        "release_mode",
        "min_financed_amount",
        "max_financed_amount",
    ]);
    const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unknownKey) throw new Error(`Unknown installment plan field: ${unknownKey}`);
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!name || name.length > 100) throw new Error("Plan name must contain 1 to 100 characters");
    const count = value.number_of_installments;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 120) {
        throw new Error("number_of_installments must be an integer between 1 and 120");
    }
    if (value.active !== undefined && typeof value.active !== "boolean") {
        throw new Error("active must be a boolean");
    }
    if (!["WEEKLY", "EVERY_2_WEEKS", "MONTHLY"].includes(String(value.frequency))) {
        throw new Error("frequency must be WEEKLY, EVERY_2_WEEKS, or MONTHLY");
    }
    if (!["FLAT_TOTAL", "FLAT_PER_MONTH"].includes(String(value.interest_type))) {
        throw new Error("interest_type must be FLAT_TOTAL or FLAT_PER_MONTH");
    }
    if (!["HOLD_UNTIL_PAID", "RELEASE_AFTER_DEPOSIT"].includes(String(value.release_mode))) {
        throw new Error("release_mode must be HOLD_UNTIL_PAID or RELEASE_AFTER_DEPOSIT");
    }
    let minDepositPercentBps: number;
    let interestRateBps: number;
    if (typeof value.min_deposit_percent !== "string") {
        throw new Error("min_deposit_percent must be a decimal percentage string");
    }
    if (typeof value.interest_rate_percent !== "string") {
        throw new Error("interest_rate_percent must be a decimal percentage string");
    }
    try {
        minDepositPercentBps = percentageToBasisPoints(value.min_deposit_percent);
    } catch {
        throw new Error("min_deposit_percent must be a percentage with at most two decimal places");
    }
    try {
        interestRateBps = percentageToBasisPoints(value.interest_rate_percent);
    } catch {
        throw new Error("interest_rate_percent must be a percentage with at most two decimal places");
    }
    if (minDepositPercentBps > 10_000) throw new Error("min_deposit_percent must be between 0 and 100");
    if (interestRateBps > 100_000) throw new Error("interest_rate_percent must not exceed 1000");

    const parseOptionalMoney = (amount: unknown, nameLabel: string): string | null => {
        if (amount === undefined || amount === null || amount === "") return null;
        const cents = parseInstallmentMoneyString(
            amount,
            `${nameLabel} must be a non-negative KES decimal string with at most two decimal places`,
        );
        if (cents > POSTGRES_BIGINT_MAX) {
            throw new Error(`${nameLabel} exceeds the maximum supported database amount`);
        }
        return cents.toString();
    };
    const minFinancedCents = parseOptionalMoney(value.min_financed_amount, "min_financed_amount");
    const maxFinancedCents = parseOptionalMoney(value.max_financed_amount, "max_financed_amount");
    if (minFinancedCents !== null && maxFinancedCents !== null &&
        BigInt(minFinancedCents) > BigInt(maxFinancedCents)) {
        throw new Error("min_financed_amount must not exceed max_financed_amount");
    }
    return {
        name,
        active: value.active === undefined ? true : value.active as boolean,
        number_of_installments: count,
        frequency: value.frequency as InstallmentFrequency,
        min_deposit_percent_bps: minDepositPercentBps,
        interest_type: value.interest_type as InstallmentInterestType,
        interest_rate_bps: interestRateBps,
        release_mode: value.release_mode as InstallmentReleaseMode,
        min_financed_cents: minFinancedCents,
        max_financed_cents: maxFinancedCents,
    };
};

export const percentFromBasisPoints = (basisPoints: number): string => {
    const whole = Math.floor(basisPoints / 100);
    const fractional = String(basisPoints % 100).padStart(2, "0");
    return `${whole}.${fractional}`;
};

export const kesFromCents = (cents: string | bigint | null): string | null =>
    cents === null ? null : centsToKesString(typeof cents === "bigint" ? cents : BigInt(cents));

export const minimumInstallmentDepositCents = (priceTotalCents: bigint, minimumPercentBps: number): bigint => {
    if (priceTotalCents < 0n || !Number.isSafeInteger(minimumPercentBps) ||
        minimumPercentBps < 0 || minimumPercentBps > 10_000) {
        throw new Error("Invalid price total or minimum deposit percent");
    }
    if (priceTotalCents > POSTGRES_BIGINT_MAX) {
        throw new Error("Installment price total exceeds the maximum supported database amount");
    }
    const numerator = priceTotalCents * BigInt(minimumPercentBps);
    return (numerator + 9_999n) / 10_000n;
};

const assertNonNegativeCents = (value: bigint, name: string): void => {
    if (value < 0n) throw new Error(`${name} must be non-negative`);
};

export const calculatePlanMonthsHundredths = (
    frequency: InstallmentFrequency,
    numberOfInstallments: number,
): number => {
    if (frequency !== "WEEKLY" && frequency !== "EVERY_2_WEEKS" && frequency !== "MONTHLY") {
        throw new Error("frequency must be WEEKLY, EVERY_2_WEEKS, or MONTHLY");
    }
    if (!Number.isSafeInteger(numberOfInstallments) || numberOfInstallments < 1 || numberOfInstallments > 120) {
        throw new Error("number_of_installments must be an integer between 1 and 120");
    }
    if (frequency === "MONTHLY") return numberOfInstallments * 100;

    const daysPerInstallment = frequency === "WEEKLY" ? 7 : 14;
    const numerator = numberOfInstallments * daysPerInstallment * 100;
    return Math.floor((numerator * 2 + 30) / 60);
};

const addDays = (date: string, days: number): string => {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
};

const addMonthsClamped = (date: string, months: number): string => {
    const [year, month, day] = date.split("-").map(Number);
    const targetMonthIndex = year * 12 + (month - 1) + months;
    const targetYear = Math.floor(targetMonthIndex / 12);
    const targetMonth = targetMonthIndex % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    return [
        String(targetYear).padStart(4, "0"),
        String(targetMonth + 1).padStart(2, "0"),
        String(Math.min(day, lastDay)).padStart(2, "0"),
    ].join("-");
};

export const createInstallmentQuote = (input: {
    priceTotalCents: bigint;
    depositCents: bigint;
    agreementDate: string;
    terms: InstallmentPlanTerms;
}): InstallmentQuote => {
    const { priceTotalCents, depositCents, agreementDate, terms } = input;
    assertNonNegativeCents(priceTotalCents, "price total");
    assertNonNegativeCents(depositCents, "deposit");
    if (priceTotalCents === 0n || depositCents > priceTotalCents) {
        throw new Error("Deposit must not exceed the positive price total");
    }
    const parsedAgreementDate = new Date(`${agreementDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(agreementDate) ||
        !Number.isFinite(parsedAgreementDate.getTime()) ||
        parsedAgreementDate.toISOString().slice(0, 10) !== agreementDate) {
        throw new Error("agreement date must be a valid YYYY-MM-DD date");
    }
    if (!Number.isSafeInteger(terms.min_deposit_percent_bps) ||
        terms.min_deposit_percent_bps < 0 || terms.min_deposit_percent_bps > 10_000) {
        throw new Error("minimum deposit percent must be between 0 and 100");
    }
    if (!Number.isSafeInteger(terms.interest_rate_bps) || terms.interest_rate_bps < 0 ||
        terms.interest_rate_bps > 100_000) {
        throw new Error("interest rate percent is outside the supported range");
    }
    if (terms.frequency !== "WEEKLY" && terms.frequency !== "EVERY_2_WEEKS" &&
        terms.frequency !== "MONTHLY") {
        throw new Error("frequency must be WEEKLY, EVERY_2_WEEKS, or MONTHLY");
    }
    if (terms.interest_type !== "FLAT_TOTAL" && terms.interest_type !== "FLAT_PER_MONTH") {
        throw new Error("interest_type must be FLAT_TOTAL or FLAT_PER_MONTH");
    }
    const installmentCount = terms.number_of_installments;
    if (!Number.isSafeInteger(installmentCount) || installmentCount < 1 || installmentCount > 120) {
        throw new Error("number_of_installments must be an integer between 1 and 120");
    }

    const minimumDepositCents = minimumInstallmentDepositCents(priceTotalCents, terms.min_deposit_percent_bps);
    if (depositCents < minimumDepositCents) {
        throw new Error("Deposit is below the plan minimum");
    }

    const financedCents = priceTotalCents - depositCents;
    const monthsHundredths = terms.interest_type === "FLAT_PER_MONTH"
        ? calculatePlanMonthsHundredths(terms.frequency, installmentCount)
        : null;
    const interestCents = terms.interest_type === "FLAT_TOTAL"
        ? divideRoundHalfUp(financedCents * BigInt(terms.interest_rate_bps), 10_000n)
        : monthsHundredths === null
            ? 0n
            : divideRoundHalfUp(
                financedCents * BigInt(terms.interest_rate_bps) * BigInt(monthsHundredths),
                1_000_000n,
            );
    const totalPayableCents = priceTotalCents + interestCents;
    if (interestCents > POSTGRES_BIGINT_MAX || totalPayableCents > POSTGRES_BIGINT_MAX) {
        throw new Error("Installment total payable exceeds the maximum supported database amount");
    }
    const basePrincipalCents = financedCents / BigInt(installmentCount);
    const baseInterestCents = interestCents / BigInt(installmentCount);
    const schedule: InstallmentScheduleItem[] = [];

    for (let index = 1; index <= installmentCount; index += 1) {
        const isLast = index === installmentCount;
        const dueDate = terms.frequency === "MONTHLY"
            ? addMonthsClamped(agreementDate, index)
            : addDays(agreementDate, index * (terms.frequency === "WEEKLY" ? 7 : 14));
        schedule.push({
            installment_number: index,
            due_date: dueDate,
            principal_cents: isLast
                ? financedCents - basePrincipalCents * BigInt(installmentCount - 1)
                : basePrincipalCents,
            interest_cents: isLast
                ? interestCents - baseInterestCents * BigInt(installmentCount - 1)
                : baseInterestCents,
        });
    }

    if (schedule.reduce((sum, item) => sum + item.principal_cents + item.interest_cents, 0n) !==
        financedCents + interestCents) {
        throw new Error("Installment schedule does not reconcile to financed amount and interest");
    }

    return {
        price_total_cents: priceTotalCents,
        deposit_cents: depositCents,
        financed_cents: financedCents,
        interest_cents: interestCents,
        total_payable_cents: totalPayableCents,
        schedule,
        months_hundredths: monthsHundredths,
    };
};
