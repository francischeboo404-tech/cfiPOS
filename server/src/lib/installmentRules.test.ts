import assert from "node:assert/strict";
import test from "node:test";
import {
    calculatePlanMonthsHundredths,
    createInstallmentQuote,
    isInstallmentUuid,
    isInstallmentSellingEnabled,
    minimumInstallmentDepositCents,
    parseStoredInstallmentCents,
    sanitizeInstallmentAgreementRequest,
    sanitizeInstallmentPlanPayload,
    sanitizeInstallmentQuoteRequest,
    sanitizeInstallmentSettingsPayload,
} from "./installmentRules";

const terms = {
    number_of_installments: 5,
    frequency: "MONTHLY" as const,
    min_deposit_percent_bps: 0,
    interest_type: "FLAT_TOTAL" as const,
    interest_rate_bps: 500,
};

test("installment route identifiers accept UUIDs and reject malformed values", () => {
    assert.equal(isInstallmentUuid("00000000-0000-0000-0000-000000000001"), true);
    assert.equal(isInstallmentUuid("00000000-0000-0000-0000-000000000001".toUpperCase()), true);
    assert.equal(isInstallmentUuid("not-a-uuid"), false);
});

test("flat-total quote and schedule reconcile exact cents", () => {
    const quote = createInstallmentQuote({
        priceTotalCents: 1_200_000n,
        depositCents: 200_000n,
        agreementDate: "2026-01-31",
        terms,
    });
    assert.equal(quote.financed_cents, 1_000_000n);
    assert.equal(quote.interest_cents, 50_000n);
    assert.equal(quote.total_payable_cents, 1_250_000n);
    assert.deepEqual(quote.schedule.map((item) => item.due_date), [
        "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30",
    ]);
    assert.equal(
        quote.schedule.reduce((sum, item) => sum + item.principal_cents + item.interest_cents, 0n),
        quote.financed_cents + quote.interest_cents,
    );
});

test("monthly due dates clamp across leap day and year boundaries", () => {
    const quote = createInstallmentQuote({
        priceTotalCents: 10_000n,
        depositCents: 0n,
        agreementDate: "2028-01-31",
        terms: { ...terms, number_of_installments: 2, interest_rate_bps: 0 },
    });
    assert.deepEqual(quote.schedule.map((item) => item.due_date), ["2028-02-29", "2028-03-31"]);

    const yearEndQuote = createInstallmentQuote({
        priceTotalCents: 10_000n,
        depositCents: 0n,
        agreementDate: "2026-11-30",
        terms: { ...terms, number_of_installments: 2, interest_rate_bps: 0 },
    });
    assert.deepEqual(yearEndQuote.schedule.map((item) => item.due_date), ["2026-12-30", "2027-01-30"]);
});

test("weekly flat-per-month interest applies documented hundredth-month rounding", () => {
    assert.equal(calculatePlanMonthsHundredths("WEEKLY", 5), 117);
    const quote = createInstallmentQuote({
        priceTotalCents: 1_200_000n,
        depositCents: 200_000n,
        agreementDate: "2026-10-19",
        terms: {
            number_of_installments: 5,
            frequency: "WEEKLY",
            min_deposit_percent_bps: 0,
            interest_type: "FLAT_PER_MONTH",
            interest_rate_bps: 500,
        },
    });
    assert.equal(quote.interest_cents, 58_500n);
    assert.equal(quote.schedule.reduce((sum, item) => sum + item.principal_cents + item.interest_cents, 0n),
        quote.financed_cents + quote.interest_cents);
});

test("quote calculations reject unsupported runtime frequency and interest terms", () => {
    assert.throws(() => calculatePlanMonthsHundredths("INVALID" as "MONTHLY", 5), /frequency must be/);
    assert.throws(() => createInstallmentQuote({
        priceTotalCents: 10_000n,
        depositCents: 0n,
        agreementDate: "2026-10-19",
        terms: { ...terms, frequency: "INVALID" as "MONTHLY" },
    }), /frequency must be/);
    assert.throws(() => createInstallmentQuote({
        priceTotalCents: 10_000n,
        depositCents: 0n,
        agreementDate: "2026-10-19",
        terms: { ...terms, interest_type: "INVALID" as "FLAT_TOTAL" },
    }), /interest_type must be/);
});

test("minimum deposit rounds up fractional cents so it cannot fall below the configured rate", () => {
    assert.equal(minimumInstallmentDepositCents(1n, 1), 1n);
    assert.equal(minimumInstallmentDepositCents(10_001n, 1), 2n);
    assert.equal(minimumInstallmentDepositCents(10_000n, 1), 1n);
    assert.throws(
        () => minimumInstallmentDepositCents(9_223_372_036_854_775_808n, 0),
        /maximum supported database amount/,
    );
});

test("quote totals cannot exceed PostgreSQL bigint storage", () => {
    assert.throws(() => createInstallmentQuote({
        priceTotalCents: 9_223_372_036_854_775_808n,
        depositCents: 0n,
        agreementDate: "2026-10-19",
        terms: { ...terms, interest_rate_bps: 0 },
    }), /price total exceeds the maximum supported database amount/);
    assert.throws(() => createInstallmentQuote({
        priceTotalCents: 9_223_372_036_854_775_807n,
        depositCents: 0n,
        agreementDate: "2026-10-19",
        terms: { ...terms, interest_rate_bps: 1 },
    }), /total payable exceeds the maximum supported database amount/);
});

test("installment selling cannot be enabled until the lifecycle is ready", () => {
    assert.equal(isInstallmentSellingEnabled("false"), false);
    assert.equal(isInstallmentSellingEnabled(null), false);
    assert.equal(isInstallmentSellingEnabled("true"), false);
});

test("installment plan payload validates percentages, money limits, and term count", () => {
    const plan = sanitizeInstallmentPlanPayload({
        name: "  Weekly  ",
        number_of_installments: 5,
        frequency: "WEEKLY",
        min_deposit_percent: "10.25",
        interest_type: "FLAT_PER_MONTH",
        interest_rate_percent: "2.5",
        release_mode: "RELEASE_AFTER_DEPOSIT",
        min_financed_amount: "100.00",
        max_financed_amount: "5000.00",
    });

    assert.equal(plan.name, "Weekly");
    assert.equal(plan.min_deposit_percent_bps, 1025);
    assert.equal(plan.interest_rate_bps, 250);
    assert.equal(plan.min_financed_cents, "10000");
    assert.equal(plan.max_financed_cents, "500000");

    assert.throws(() => sanitizeInstallmentPlanPayload({
        name: "Bad", number_of_installments: 0, frequency: "MONTHLY",
        min_deposit_percent: "0", interest_type: "FLAT_TOTAL",
        interest_rate_percent: "0", release_mode: "HOLD_UNTIL_PAID",
    }), /between 1 and 120/);
    assert.throws(() => sanitizeInstallmentPlanPayload({
        name: "Bad", number_of_installments: 1, frequency: "MONTHLY",
        min_deposit_percent: "0", interest_type: "FLAT_TOTAL",
        interest_rate_percent: "0", release_mode: "HOLD_UNTIL_PAID",
        min_financed_amount: "10.001",
    }), /at most two decimal places/);
    assert.throws(() => sanitizeInstallmentPlanPayload({
        name: "Bad", number_of_installments: 1, frequency: "MONTHLY",
        min_deposit_percent: "0", interest_type: "FLAT_TOTAL",
        interest_rate_percent: "0", release_mode: "HOLD_UNTIL_PAID",
        instalment_count: 2,
    }), /Unknown installment plan field: instalment_count/);
    assert.throws(() => sanitizeInstallmentPlanPayload({
        name: "Bad", number_of_installments: "1", frequency: "MONTHLY",
        min_deposit_percent: "0", interest_type: "FLAT_TOTAL",
        interest_rate_percent: "0", release_mode: "HOLD_UNTIL_PAID",
    }), /number_of_installments must be an integer/);
    assert.throws(() => sanitizeInstallmentPlanPayload({
        name: "Bad", number_of_installments: 1, frequency: "MONTHLY",
        min_deposit_percent: 10, interest_type: "FLAT_TOTAL",
        interest_rate_percent: "0", release_mode: "HOLD_UNTIL_PAID",
    }), /min_deposit_percent must be a decimal percentage string/);
    assert.throws(() => sanitizeInstallmentPlanPayload({
        name: "Bad", number_of_installments: 1, frequency: "MONTHLY",
        min_deposit_percent: "0", interest_type: "FLAT_TOTAL",
        interest_rate_percent: 5, release_mode: "HOLD_UNTIL_PAID",
    }), /interest_rate_percent must be a decimal percentage string/);
    assert.throws(() => sanitizeInstallmentPlanPayload({
        name: "Bad", number_of_installments: 1, frequency: "MONTHLY",
        min_deposit_percent: "0", interest_type: "FLAT_TOTAL",
        interest_rate_percent: "0", release_mode: "HOLD_UNTIL_PAID",
        max_financed_amount: "92233720368547758.08",
    }), /maximum supported database amount/);
    assert.throws(() => sanitizeInstallmentPlanPayload({
        name: "Bad", number_of_installments: 1, frequency: "MONTHLY",
        min_deposit_percent: "0", interest_type: "FLAT_TOTAL",
        interest_rate_percent: "0", release_mode: "HOLD_UNTIL_PAID",
        max_financed_amount: 10,
    }), /decimal string/);
});

test("installment settings validate types, money, fee bounds, and retention minimum", () => {
    assert.deepEqual(sanitizeInstallmentSettingsPayload({
        installments_enabled: true,
        installment_max_open_credit_amount: "12500.50",
        installment_cancellation_fee_percent: "2.5",
        installment_charge_vat_on_interest: false,
        installment_retention_years: 7,
    }), {
        installments_enabled: "true",
        installment_max_open_credit_cents: "1250050",
        installment_cancellation_fee_percent_bps: "250",
        installment_charge_vat_on_interest: "false",
        installment_retention_years: "7",
    });
    assert.throws(() => sanitizeInstallmentSettingsPayload({ installment_retention_years: 6 }), /between 7 and 100/);
    assert.throws(() => sanitizeInstallmentSettingsPayload({ installment_retention_years: "7" }), /must be an integer/);
    assert.throws(() => sanitizeInstallmentSettingsPayload({ installments_enabled: "true" }), /must be a boolean/);
    assert.throws(() => sanitizeInstallmentSettingsPayload({
        installment_max_open_credit_amount: 12.5,
    }), /decimal string/);
    assert.throws(() => sanitizeInstallmentSettingsPayload({
        installment_cancellation_fee_percent: 2.5,
    }), /decimal percentage string/);
});

test("stored maximum open-credit setting preserves bigint precision", () => {
    assert.equal(
        parseStoredInstallmentCents("9223372036854775807", "installment_max_open_credit_cents"),
        "9223372036854775807",
    );
    assert.throws(
        () => parseStoredInstallmentCents("9223372036854775808", "installment_max_open_credit_cents"),
        /Invalid stored installment setting/,
    );
    assert.throws(
        () => parseStoredInstallmentCents("1.50", "installment_max_open_credit_cents"),
        /Invalid stored installment setting/,
    );
});

test("installment quote input combines duplicate product lines and normalizes exact deposit", () => {
    assert.deepEqual(sanitizeInstallmentQuoteRequest({
        customer_id: "00000000-0000-0000-0000-000000000001",
        plan_id: "00000000-0000-0000-0000-000000000002",
        warehouse_id: null,
        deposit_amount: "12.5",
        items: [
            { product_id: "00000000-0000-0000-0000-000000000003", quantity: 2 },
            { product_id: "00000000-0000-0000-0000-000000000003", quantity: 1 },
        ],
    }), {
        customer_id: "00000000-0000-0000-0000-000000000001",
        plan_id: "00000000-0000-0000-0000-000000000002",
        warehouse_id: null,
        deposit_amount: "12.50",
        items: [{ product_id: "00000000-0000-0000-0000-000000000003", quantity: 3 }],
    });
    assert.throws(() => sanitizeInstallmentQuoteRequest({
        customer_id: "not-a-uuid",
        plan_id: "00000000-0000-0000-0000-000000000002",
        items: [{ product_id: "00000000-0000-0000-0000-000000000003", quantity: 1 }],
    }), /valid UUID/);
});

test("installment quote input canonicalizes UUID casing before combining products", () => {
    const customerId = "00000000-0000-0000-0000-000000000001";
    const planId = "00000000-0000-0000-0000-000000000002";
    const productId = "00000000-0000-0000-0000-000000000003";
    assert.deepEqual(sanitizeInstallmentQuoteRequest({
        customer_id: customerId.toUpperCase(),
        plan_id: planId.toUpperCase(),
        warehouse_id: "00000000-0000-0000-0000-000000000004".toUpperCase(),
        items: [
            { product_id: productId.toUpperCase(), quantity: 1 },
            { product_id: productId, quantity: 2 },
        ],
    }), {
        customer_id: customerId,
        plan_id: planId,
        warehouse_id: "00000000-0000-0000-0000-000000000004",
        deposit_amount: null,
        items: [{ product_id: productId, quantity: 3 }],
    });

    assert.throws(() => sanitizeInstallmentQuoteRequest({
        customer_id: "00000000-0000-0000-0000-000000000001",
        plan_id: "00000000-0000-0000-0000-000000000002",
        deposit_amount: "12.50",
        depost_amount: "0.00",
        items: [{ product_id: "00000000-0000-0000-0000-000000000003", quantity: 1 }],
    }), /Unknown installment quote field: depost_amount/);
    assert.throws(() => sanitizeInstallmentQuoteRequest({
        customer_id: "00000000-0000-0000-0000-000000000001",
        plan_id: "00000000-0000-0000-0000-000000000002",
        deposit_amount: 12.5,
        items: [{ product_id: "00000000-0000-0000-0000-000000000003", quantity: 1 }],
    }), /decimal string/);
    assert.throws(() => sanitizeInstallmentQuoteRequest({
        customer_id: "00000000-0000-0000-0000-000000000001",
        plan_id: "00000000-0000-0000-0000-000000000002",
        items: [{
            product_id: "00000000-0000-0000-0000-000000000003",
            quantity: 1,
            unit_price: "0.01",
        }],
    }), /Unknown installment item field: unit_price/);
    for (const quantity of ["1", true]) {
        assert.throws(() => sanitizeInstallmentQuoteRequest({
            customer_id: "00000000-0000-0000-0000-000000000001",
            plan_id: "00000000-0000-0000-0000-000000000002",
            items: [{ product_id: "00000000-0000-0000-0000-000000000003", quantity }],
        }), /Item quantities must be positive whole numbers/);
    }
});

test("installment agreement requests require canonical idempotency and paid-deposit details", () => {
    const productOne = "00000000-0000-0000-0000-000000000003";
    const productTwo = "00000000-0000-0000-0000-000000000005";
    const request = sanitizeInstallmentAgreementRequest({
        customer_id: "00000000-0000-0000-0000-000000000001".toUpperCase(),
        plan_id: "00000000-0000-0000-0000-000000000002",
        items: [
            { product_id: productTwo, quantity: 1 },
            { product_id: productOne, quantity: 1 },
        ],
        deposit_amount: "10",
        deposit_payment_method: "MPESA",
        deposit_reference_number: "  MPESA123  ",
        idempotency_key: "00000000-0000-0000-0000-000000000006".toUpperCase(),
    });
    assert.deepEqual(request.items.map((item) => item.product_id), [productOne, productTwo]);
    assert.equal(request.customer_id, "00000000-0000-0000-0000-000000000001");
    assert.equal(request.idempotency_key, "00000000-0000-0000-0000-000000000006");
    assert.equal(request.deposit_amount, "10.00");
    assert.equal(request.deposit_reference_number, "MPESA123");

    const base = {
        customer_id: "00000000-0000-0000-0000-000000000001",
        plan_id: "00000000-0000-0000-0000-000000000002",
        items: [{ product_id: productOne, quantity: 1 }],
        deposit_amount: "0.00",
        idempotency_key: "00000000-0000-0000-0000-000000000006",
    };
    assert.throws(() => sanitizeInstallmentAgreementRequest({
        ...base,
        deposit_payment_method: "CASH",
    }), /deposit is zero/);
    assert.throws(() => sanitizeInstallmentAgreementRequest({
        ...base,
        deposit_amount: "10.00",
        deposit_payment_method: "CASH",
        idempotency_key: "bad",
    }), /idempotency_key must be/);
    assert.throws(() => sanitizeInstallmentAgreementRequest({
        ...base,
        deposit_amount: "10.00",
        deposit_payment_method: "BANK_TRANSFER",
    }), /reference_number is required/);
    assert.throws(() => sanitizeInstallmentAgreementRequest({
        ...base,
        deposit_amount: undefined,
    }), /deposit_amount is required/);
});
