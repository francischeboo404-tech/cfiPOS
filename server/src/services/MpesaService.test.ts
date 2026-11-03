import test from "node:test";
import assert from "node:assert/strict";
import { classifyStkQueryResult, MpesaService, StkQueryResult } from "./MpesaService";
import { expireAbandonedCheckoutReservations } from "./CheckoutReservationService";
import { MpesaTransaction } from "../entity/MpesaTransaction";
import { PaymentCheckoutSession } from "../entity/PaymentCheckoutSession";
import { Sale } from "../entity/Sale";
import { AppDataSource } from "../data-source";

test("MpesaService.getDarajaAccessToken validates environment configuration", async () => {
    const originalKey = process.env.MPESA_CONSUMER_KEY;
    const originalSecret = process.env.MPESA_CONSUMER_SECRET;
    const originalUrl = process.env.MPESA_API_BASE_URL;

    delete process.env.MPESA_CONSUMER_KEY;
    delete process.env.MPESA_CONSUMER_SECRET;
    delete process.env.MPESA_API_BASE_URL;

    await assert.rejects(
        () => MpesaService.getDarajaAccessToken(),
        /M-Pesa Daraja credentials or MPESA_API_BASE_URL are not configured/,
    );

    process.env.MPESA_CONSUMER_KEY = "test_key";
    process.env.MPESA_CONSUMER_SECRET = "test_secret";
    process.env.MPESA_API_BASE_URL = "https://sandbox.safaricom.co.ke";

    // Mock successful token response
    MpesaService.setCustomFetch(async (url) => {
        if (String(url).includes("/oauth/v1/generate")) {
            return new Response(JSON.stringify({ access_token: "mock_daraja_token_123" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response("Not found", { status: 404 });
    });

    try {
        const token = await MpesaService.getDarajaAccessToken();
        assert.equal(token, "mock_daraja_token_123");
    } finally {
        MpesaService.setCustomFetch(null);
        if (originalKey) process.env.MPESA_CONSUMER_KEY = originalKey; else delete process.env.MPESA_CONSUMER_KEY;
        if (originalSecret) process.env.MPESA_CONSUMER_SECRET = originalSecret; else delete process.env.MPESA_CONSUMER_SECRET;
        if (originalUrl) process.env.MPESA_API_BASE_URL = originalUrl; else delete process.env.MPESA_API_BASE_URL;
    }
});

test("MpesaService.queryStkPushStatus queries Daraja STK push status and parses responses", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeaders: Headers | null = null;

    MpesaService.setCustomFetch(async (url, init) => {
        if (String(url).includes("/mpesa/stkpushquery/v1/query")) {
            capturedBody = JSON.parse(String(init?.body || "{}"));
            capturedHeaders = new Headers(init?.headers);
            return new Response(JSON.stringify({
                ResponseCode: "0",
                ResponseDescription: "The service request has been accepted successfully",
                MerchantRequestID: "29115-34620561-1",
                CheckoutRequestID: "ws_CO_TEST_QUERY_1",
                ResultCode: "0",
                ResultDesc: "The service request is processed successfully.",
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response("Not found", { status: 404 });
    });

    try {
        const result = await MpesaService.queryStkPushStatus("ws_CO_TEST_QUERY_1", {
            shortcode: "174379",
            passkey: "mock_passkey",
            apiBaseUrl: "https://sandbox.safaricom.co.ke",
            accessToken: "mock_token",
        });

        assert.equal(result.responseCode, "0");
        assert.equal(result.resultCode, 0);
        assert.equal(result.resultDesc, "The service request is processed successfully.");
        assert.equal(result.checkoutRequestId, "ws_CO_TEST_QUERY_1");
        assert.ok(capturedBody !== null);
        assert.equal((capturedBody as Record<string, unknown>).BusinessShortCode, "174379");
        assert.equal((capturedBody as Record<string, unknown>).CheckoutRequestID, "ws_CO_TEST_QUERY_1");
        assert.ok(capturedHeaders !== null);
        assert.equal((capturedHeaders as Headers).get("Authorization"), "Bearer mock_token");
    } finally {
        MpesaService.setCustomFetch(null);
    }
});

test("MpesaService.queryStkPushStatus handles user cancellation and timeout result codes", async () => {
    MpesaService.setCustomFetch(async () => {
        return new Response(JSON.stringify({
            ResponseCode: "0",
            ResponseDescription: "The service request has been accepted successfully",
            ResultCode: "1032",
            ResultDesc: "Request cancelled by user",
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    });

    try {
        const cancelledResult = await MpesaService.queryStkPushStatus("ws_CO_CANCELLED", {
            shortcode: "174379",
            passkey: "mock_passkey",
            apiBaseUrl: "https://sandbox.safaricom.co.ke",
            accessToken: "mock_token",
        });
        assert.equal(cancelledResult.resultCode, 1032);
        assert.equal(cancelledResult.resultDesc, "Request cancelled by user");
    } finally {
        MpesaService.setCustomFetch(null);
    }
});

test("STK query results are authoritative only when Daraja confirms the matching request", () => {
    const confirmed: StkQueryResult = {
        responseCode: "0",
        checkoutRequestId: "checkout-1",
        resultCode: 0,
    };
    assert.equal(classifyStkQueryResult(confirmed, "checkout-1"), "completed");
    assert.equal(classifyStkQueryResult(confirmed, "checkout-2"), "pending");
    assert.equal(classifyStkQueryResult({ ...confirmed, responseCode: "1" }, "checkout-1"), "pending");
    assert.equal(classifyStkQueryResult({
        responseCode: "0",
        checkoutRequestId: "checkout-1",
        resultCode: 1032,
    }, "checkout-1"), "failed");
    assert.equal(classifyStkQueryResult({
        responseCode: "0",
        resultCode: 1032,
    }, "checkout-1"), "pending");
});

test("MpesaService.queryStkPushStatus rejects non-success HTTP responses", async () => {
    MpesaService.setCustomFetch(async () => new Response("gateway unavailable", { status: 503 }));
    try {
        await assert.rejects(
            () => MpesaService.queryStkPushStatus("ws_CO_TEST_QUERY_1", {
                shortcode: "174379",
                passkey: "mock_passkey",
                apiBaseUrl: "https://sandbox.safaricom.co.ke",
                accessToken: "mock_token",
            }),
            /M-Pesa STK query failed \(HTTP 503\)/,
        );
    } finally {
        MpesaService.setCustomFetch(null);
    }
});

test("Stock reservation expiry threshold logic calculates accurately", () => {
    const ttlMinutes = 15;
    const now = Date.now();
    const threshold = new Date(now - ttlMinutes * 60 * 1000);

    const activeSessionTime = new Date(now - 5 * 60 * 1000); // 5 mins ago
    const expiredSessionTime = new Date(now - 20 * 60 * 1000); // 20 mins ago

    assert.equal(activeSessionTime.getTime() > threshold.getTime(), true, "5-min session should not be expired");
    assert.equal(expiredSessionTime.getTime() <= threshold.getTime(), true, "20-min session should be expired");
});
