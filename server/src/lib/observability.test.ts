import test from "node:test";
import assert from "node:assert/strict";
import {
    sanitizeUrlForLogging,
    redactSensitiveObject,
    requestIdMiddleware,
    livenessHandler,
    readinessHandler,
    ObservabilityRequest,
} from "./observability";
import { validateSystemConfig, assertProductionConfigReady } from "./configValidator";
import { PesapalMockService } from "../services/PesapalMockService";

test("sanitizeUrlForLogging redacts callback tokens, OTPs, and secrets from query strings", () => {
    const rawUrl = "/api/webhooks/mpesa/c2b/validation?callback_token=abcdef123456&code=123456&name=retail_store";
    const sanitized = sanitizeUrlForLogging(rawUrl);

    assert.equal(sanitized.includes("abcdef123456"), false);
    assert.equal(sanitized.includes("code=123456"), false);
    assert.equal(sanitized.includes("callback_token=%5BREDACTED%5D") || sanitized.includes("callback_token=[REDACTED]"), true);
    assert.equal(sanitized.includes("name=retail_store"), true);
});

test("redactSensitiveObject strips passwords, tokens, auth headers, and session cookies", () => {
    const sensitivePayload = {
        email: "cashier@example.com",
        password: "super_secret_password",
        otp_token: "jwt.fake.token",
        headers: {
            authorization: "Bearer secret-token-value",
            cookie: "jwt_token=secret_cookie_val; path=/",
            host: "api.example.co.ke",
        },
    };

    const redacted = redactSensitiveObject(sensitivePayload) as Record<string, unknown>;
    assert.equal(redacted.password, "[REDACTED]");
    assert.equal(redacted.otp_token, "[REDACTED]");
    assert.equal((redacted.headers as Record<string, string>).authorization, "Bearer [REDACTED]");
    assert.equal((redacted.headers as Record<string, string>).cookie.includes("secret_cookie_val"), false);
    assert.equal((redacted.headers as Record<string, string>).host, "api.example.co.ke");
});

import type { Request, Response } from "express";

test("requestIdMiddleware propagates existing X-Request-Id or generates unique UUID", () => {
    const mockReqWithId = {
        headers: { "x-request-id": "custom-req-id-12345" },
    } as unknown as ObservabilityRequest;
    const headersSet: Record<string, string> = {};
    const mockRes = {
        setHeader: (key: string, val: string) => {
            headersSet[key] = val;
        },
    } as unknown as Response;

    let nextCalled = false;
    requestIdMiddleware(mockReqWithId, mockRes, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(mockReqWithId.id, "custom-req-id-12345");
    assert.equal(headersSet["X-Request-Id"], "custom-req-id-12345");

    const mockReqWithoutId = {
        headers: {},
    } as unknown as ObservabilityRequest;
    requestIdMiddleware(mockReqWithoutId, mockRes, () => {});

    assert.ok(mockReqWithoutId.id);
    assert.equal(mockReqWithoutId.id!.length >= 32, true);
});

test("livenessHandler returns 200 without touching database", () => {
    let responseStatus = 0;
    let responseBody = {} as { status?: string; uptime?: number };

    const mockRes = {
        status: (code: number) => {
            responseStatus = code;
            return {
                json: (body: { status?: string; uptime?: number }) => {
                    responseBody = body;
                },
            };
        },
    } as unknown as Response;

    livenessHandler({} as unknown as Request, mockRes);
    assert.equal(responseStatus, 200);
    assert.equal(responseBody.status, "ok");
    assert.equal(typeof responseBody.uptime, "number");
});

test("validateSystemConfig collects consolidated errors for missing settings in production", () => {
    const emptyEnv: NodeJS.ProcessEnv = {
        NODE_ENV: "production",
        PORT: "invalid",
        DATABASE_URL: "",
        JWT_SECRET: "short",
        ENCRYPTION_KEY: "not_hex",
        CORS_ORIGINS: "*",
        ETIMS_MODE: "invalid",
    };

    const result = validateSystemConfig("production", emptyEnv);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 5);

    assert.throws(
        () => assertProductionConfigReady("production", emptyEnv),
        /Production configuration validation failed/,
    );
});

test("validateSystemConfig passes when valid production configuration is supplied", () => {
    const validEnv: NodeJS.ProcessEnv = {
        NODE_ENV: "production",
        PORT: "3000",
        DATABASE_URL: "postgresql://user:pass@127.0.0.1:5432/pos_db",
        JWT_SECRET: "a".repeat(64),
        ENCRYPTION_KEY: "b".repeat(64),
        CORS_ORIGINS: "https://pos.example.co.ke",
        ETIMS_MODE: "off",
        RESEND_API_KEY: "re_valid_key_12345",
        RESEND_FROM_EMAIL: "CFI POS <billing@example.co.ke>",
        ENABLE_MPESA: "false",
    };

    const result = validateSystemConfig("production", validEnv);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
});

test("validateSystemConfig rejects live eTIMS until the VSCU integration is verified", () => {
    const liveEnv: NodeJS.ProcessEnv = {
        NODE_ENV: "production",
        PORT: "3000",
        DATABASE_URL: "postgresql://127.0.0.1:5432/pos_db",
        JWT_SECRET: "a".repeat(64),
        ENCRYPTION_KEY: "b".repeat(64),
        CORS_ORIGINS: "https://pos.example.co.ke",
        ETIMS_MODE: "live",
        RESEND_API_KEY: "re_valid_key_12345",
        RESEND_FROM_EMAIL: "CFI POS <billing@example.co.ke>",
        ENABLE_MPESA: "false",
    };

    const result = validateSystemConfig("production", liveEnv);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("ETIMS_MODE=live is disabled")));
});

test("Pesapal payments are blocked when ENABLE_PESAPAL_PAYMENTS is false", async () => {
    const origFlag = process.env.ENABLE_PESAPAL_PAYMENTS;
    const origEnv = process.env.NODE_ENV;

    try {
        process.env.ENABLE_PESAPAL_PAYMENTS = "false";
        process.env.NODE_ENV = "production";

        await assert.rejects(
            async () => PesapalMockService.requestPayment("sale-test", 100, "254700000000"),
            /Pesapal card payments are disabled/,
        );
    } finally {
        if (origFlag !== undefined) process.env.ENABLE_PESAPAL_PAYMENTS = origFlag;
        else delete process.env.ENABLE_PESAPAL_PAYMENTS;
        if (origEnv !== undefined) process.env.NODE_ENV = origEnv;
    }
});
