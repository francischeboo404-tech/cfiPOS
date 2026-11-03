import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

const loadModule = createRequire(__filename);
const dotenv = loadModule("dotenv");
dotenv.config();

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
    throw new Error("Integration tests require TEST_DATABASE_URL pointing to a dedicated test database.");
}

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl;
process.env.TYPEORM_SYNCHRONIZE = "false";

const { app } = loadModule("../index") as typeof import("../index");
const { AppDataSource } = loadModule("../data-source") as typeof import("../data-source");
const { User, AppRole } = loadModule("../entity/User") as typeof import("../entity/User");
const { Profile } = loadModule("../entity/Profile") as typeof import("../entity/Profile");
const { getJwtSecret } = loadModule("../middleware/auth") as typeof import("../middleware/auth");

interface RouteSpec {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    allowedRoles: string[] | "public";
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
}

const testCallbackToken = process.env.MPESA_C2B_CALLBACK_TOKEN || "a".repeat(64);
process.env.MPESA_C2B_CALLBACK_TOKEN = testCallbackToken;

const PERMISSION_MATRIX: RouteSpec[] = [
    // 1. Public routes
    { method: "GET", path: "/health", allowedRoles: "public" },
    { method: "GET", path: "/api/health", allowedRoles: "public" },
    { method: "GET", path: "/ready", allowedRoles: "public" },
    { method: "GET", path: "/api/ready", allowedRoles: "public" },
    { method: "GET", path: "/", allowedRoles: "public" },
    { method: "GET", path: "/favicon.ico", allowedRoles: "public" },
    { method: "POST", path: "/api/auth/register", allowedRoles: "public" },
    { method: "POST", path: "/api/auth/login", allowedRoles: "public", body: { email: "invalid@example.com", password: "wrong" } },
    { method: "POST", path: "/api/auth/verify-otp", allowedRoles: "public", body: { code: "123456" } },
    { method: "POST", path: "/api/auth/logout", allowedRoles: "public" },
    { method: "POST", path: "/api/auth/log_application_error", allowedRoles: "public", body: { event_type: "test", message: "test" } },
    { method: "POST", path: "/api/auth/log_security_event", allowedRoles: "public", body: { event_type: "test", message: "test" } },
    { method: "POST", path: "/api/auth/log_pwa_security_event", allowedRoles: "public", body: { event_type: "test", message: "test" } },
    { method: "POST", path: "/api/auth/validate_input_data", allowedRoles: "public", body: { event_type: "test", message: "test" } },
    { method: "POST", path: "/api/auth/validate_pwa_cache_integrity", allowedRoles: "public", body: { event_type: "test", message: "test" } },
    { method: "GET", path: "/api/company-logo", allowedRoles: "public" },
    { method: "POST", path: "/api/webhooks/mpesa/callback", allowedRoles: "public", body: { Body: { stkCallback: { ResultCode: 0, CallbackMetadata: { Item: [] } } } } },
    { method: "POST", path: "/api/webhooks/mpesa/c2b/validation", allowedRoles: "public", headers: { "x-callback-token": testCallbackToken }, body: {} },
    { method: "POST", path: "/api/webhooks/mpesa/c2b/confirmation", allowedRoles: "public", headers: { "x-callback-token": testCallbackToken }, body: {} },
    { method: "POST", path: "/api/webhooks/pesapal/ipn", allowedRoles: "public", body: {} },
    { method: "GET", path: "/api/webhooks/pesapal/ipn", allowedRoles: "public" },

    // 2. All authenticated roles (cashier, supervisor, manager, admin)
    { method: "GET", path: "/api/auth/me", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/auth/change-password", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: { current_password: "old", new_password: "new" } },
    { method: "GET", path: "/api/categories", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/products", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/products/00000000-0000-0000-0000-000000000001", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/sales", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/sales/checkouts", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/sales/checkouts/test-session-id", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/sales/checkouts/test-session-id/confirm-cash", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/sales/checkouts/test-session-id/cancel", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/sales", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/store-credits/SC-TEST-BARCODE", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/sales/park", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/sales/parked", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/sales/00000000-0000-0000-0000-000000000001", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/returns/search", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/returns/request", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/returns", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/customers", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/customers/00000000-0000-0000-0000-000000000001", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/customers", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/shifts/open", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/shifts/00000000-0000-0000-0000-000000000001/close", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/shifts/current", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/shifts", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/warehouses", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/dashboard/stats", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/receipt-settings", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/loyalty/members", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/loyalty/members", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/loyalty/members/00000000-0000-0000-0000-000000000001/redeem", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/taxes", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/payments/mpesa/stk-push", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/payments/mpesa/config", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/payments/mpesa/paybill-intent", allowedRoles: ["cashier", "supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/payments/mpesa/session/test-session", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/payments/mpesa/test-checkout-req", allowedRoles: ["cashier", "supervisor", "manager", "admin"] },

    // 3. Supervisory and management (supervisor, manager, admin)
    { method: "GET", path: "/api/inventory/alerts", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/invoices", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/invoices/00000000-0000-0000-0000-000000000001/payments", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/invoices/00000000-0000-0000-0000-000000000001/payments", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/admin/returns/approve/00000000-0000-0000-0000-000000000001", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/admin/returns/00000000-0000-0000-0000-000000000001/mpesa-payout", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/admin/returns/reject/00000000-0000-0000-0000-000000000001", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "PUT", path: "/api/customers/00000000-0000-0000-0000-000000000001", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/purchase-orders/00000000-0000-0000-0000-000000000001/receive", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/delivery-notes", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/delivery-notes/00000000-0000-0000-0000-000000000001", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/reports/summary", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/reports/costing", allowedRoles: ["manager", "admin"] },
    { method: "GET", path: "/api/reports/costing/closes", allowedRoles: ["manager", "admin"] },
    { method: "POST", path: "/api/reports/costing/closes", allowedRoles: ["manager", "admin"], body: { end_date: "invalid" } },
    { method: "GET", path: "/api/admin/costing-baseline-verification", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/admin/costing-baseline-verification", allowedRoles: ["admin"], body: {} },
    { method: "GET", path: "/api/admin/reports/payment-fees?start_date=2026-01-01&end_date=2026-01-01", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/admin/payment-fees", allowedRoles: ["admin"], body: {} },
    { method: "GET", path: "/api/admin/payment-fees?start_date=2026-01-01&end_date=2026-01-01", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/admin/payment-fees/00000000-0000-0000-0000-000000000001/corrections", allowedRoles: ["admin"], body: {} },
    { method: "GET", path: "/api/inventory/movements", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/loyalty/settings", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "GET", path: "/api/inventory/adjustments", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/inventory/adjustment", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/inventory/adjustments", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/inventory/transfers", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/inventory/transfer", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/inventory/transfers", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "PUT", path: "/api/inventory/transfer/00000000-0000-0000-0000-000000000001/status", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "PUT", path: "/api/inventory/transfers/00000000-0000-0000-0000-000000000001/status", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "GET", path: "/api/inventory/stock-takes", allowedRoles: ["supervisor", "manager", "admin"] },
    { method: "POST", path: "/api/inventory/stock-takes", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/inventory/stock-takes/initiate", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "PUT", path: "/api/inventory/stock-takes/00000000-0000-0000-0000-000000000001/items", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "PUT", path: "/api/inventory/stock-takes/00000000-0000-0000-0000-000000000001/counts", allowedRoles: ["supervisor", "manager", "admin"], body: {} },
    { method: "POST", path: "/api/inventory/stock-takes/00000000-0000-0000-0000-000000000001/complete", allowedRoles: ["supervisor", "manager", "admin"], body: {} },

    // 4. Management and admin (manager, admin)
    { method: "POST", path: "/api/categories", allowedRoles: ["manager", "admin"], body: {} },
    { method: "PUT", path: "/api/categories/00000000-0000-0000-0000-000000000001", allowedRoles: ["manager", "admin"], body: {} },
    { method: "GET", path: "/api/products/template", allowedRoles: ["manager", "admin"] },
    { method: "GET", path: "/api/inventory/predictions", allowedRoles: ["manager", "admin"] },
    { method: "POST", path: "/api/products", allowedRoles: ["manager", "admin"], body: {} },
    { method: "PUT", path: "/api/products/00000000-0000-0000-0000-000000000001", allowedRoles: ["manager", "admin"], body: {} },
    { method: "GET", path: "/api/vendors", allowedRoles: ["manager", "admin"] },
    { method: "GET", path: "/api/vendors/00000000-0000-0000-0000-000000000001", allowedRoles: ["manager", "admin"] },
    { method: "POST", path: "/api/vendors", allowedRoles: ["manager", "admin"], body: {} },
    { method: "POST", path: "/api/vendors/00000000-0000-0000-0000-000000000001/review", allowedRoles: ["manager", "admin"], body: {} },
    { method: "PUT", path: "/api/vendors/00000000-0000-0000-0000-000000000001", allowedRoles: ["manager", "admin"], body: {} },
    { method: "GET", path: "/api/vendor-portal", allowedRoles: ["manager", "admin"] },
    { method: "GET", path: "/api/purchase-orders", allowedRoles: ["manager", "admin"] },
    { method: "GET", path: "/api/purchase-orders/00000000-0000-0000-0000-000000000001", allowedRoles: ["manager", "admin"] },
    { method: "POST", path: "/api/purchase-orders", allowedRoles: ["manager", "admin"], body: {} },
    { method: "PUT", path: "/api/purchase-orders/00000000-0000-0000-0000-000000000001/status", allowedRoles: ["manager", "admin"], body: {} },
    { method: "POST", path: "/api/purchase-orders/00000000-0000-0000-0000-000000000001/email", allowedRoles: ["manager", "admin"], body: {} },
    { method: "GET", path: "/api/procurement/invoices", allowedRoles: ["manager", "admin"] },
    { method: "GET", path: "/api/procurement/supplier-invoices", allowedRoles: ["manager", "admin"] },
    { method: "GET", path: "/api/procurement/supplier-invoices/00000000-0000-0000-0000-000000000001/payments", allowedRoles: ["manager", "admin"] },
    { method: "POST", path: "/api/procurement/invoice", allowedRoles: ["manager", "admin"], body: {} },
    { method: "POST", path: "/api/procurement/invoices", allowedRoles: ["manager", "admin"], body: {} },
    { method: "POST", path: "/api/procurement/supplier-invoices", allowedRoles: ["manager", "admin"], body: {} },
    { method: "POST", path: "/api/procurement/supplier-invoices/00000000-0000-0000-0000-000000000001/payments", allowedRoles: ["manager", "admin"], body: {} },
    { method: "POST", path: "/api/procurement/supplier-invoices/00000000-0000-0000-0000-000000000001/review", allowedRoles: ["manager", "admin"], body: {} },
    { method: "PUT", path: "/api/procurement/requisitions/00000000-0000-0000-0000-000000000001/status", allowedRoles: ["manager", "admin"], body: {} },
    { method: "POST", path: "/api/loyalty/members/00000000-0000-0000-0000-000000000001/points", allowedRoles: ["manager", "admin"], body: {} },

    // 5. Admin only
    { method: "DELETE", path: "/api/categories/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"] },
    { method: "DELETE", path: "/api/products/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"] },
    { method: "DELETE", path: "/api/customers/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"] },
    { method: "DELETE", path: "/api/vendors/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/warehouses", allowedRoles: ["admin"], body: {} },
    { method: "PUT", path: "/api/warehouses/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"], body: {} },
    { method: "DELETE", path: "/api/warehouses/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"] },
    { method: "GET", path: "/api/users", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/users", allowedRoles: ["admin"], body: {} },
    { method: "PUT", path: "/api/users/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"], body: {} },
    { method: "PUT", path: "/api/users/00000000-0000-0000-0000-000000000001/role", allowedRoles: ["admin"], body: {} },
    { method: "DELETE", path: "/api/users/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"] },
    { method: "GET", path: "/api/settings", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/settings", allowedRoles: ["admin"], body: {} },
    { method: "DELETE", path: "/api/settings/company-logo", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/loyalty/settings", allowedRoles: ["admin"], body: {} },
    { method: "POST", path: "/api/taxes", allowedRoles: ["admin"], body: {} },
    { method: "PUT", path: "/api/taxes/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"], body: {} },
    { method: "DELETE", path: "/api/taxes/00000000-0000-0000-0000-000000000001", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/payments/mpesa/c2b/register", allowedRoles: ["admin"], body: {} },
    { method: "GET", path: "/api/admin/mpesa/unresolved", allowedRoles: ["admin"] },
    { method: "POST", path: "/api/admin/mpesa/00000000-0000-0000-0000-000000000001/resolve", allowedRoles: ["admin"], body: {} },
    { method: "GET", path: "/api/admin-only", allowedRoles: ["admin"] },
];

test("Phase 5 Permission Matrix: 401/403/2xx enforcement per role for all routes", async () => {
    if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
    }

    const server = createHttpServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const userRepo = AppDataSource.getRepository(User);
    const profileRepo = AppDataSource.getRepository(Profile);

    // Create 4 test users for each role
    const roles = [AppRole.ADMIN, AppRole.MANAGER, AppRole.SUPERVISOR, AppRole.CASHIER];
    const userTokens: Record<string, string> = {};

    for (const role of roles) {
        const email = `matrix-${role}-${Date.now()}@example.com`;
        let user = await userRepo.findOneBy({ email });
        if (!user) {
            user = new User();
            user.email = email;
            user.password_hash = "mock_hash";
            user.role = role;
            user.is_active = true;
            user = await userRepo.save(user);

            const profile = new Profile();
            profile.user = user;
            profile.full_name = `Test ${role}`;
            await profileRepo.save(profile);
        }
        userTokens[role] = jwt.sign(
            { id: user.id, email: user.email, role: user.role, name: `Test ${role}` },
            getJwtSecret(),
            { expiresIn: "1h" },
        );
    }

    const otpChallengeToken = jwt.sign(
        { id: "otp-user-id", email: "otp@example.com", is_otp_phase: true },
        getJwtSecret(),
        { expiresIn: "10m" },
    );

    const makeRequest = async (
        method: string,
        path: string,
        token?: string,
        body?: Record<string, unknown>,
        extraHeaders?: Record<string, string>,
    ) => {
        const headers: Record<string, string> = { ...(extraHeaders || {}) };
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        if (body && Object.keys(body).length > 0) {
            headers["Content-Type"] = "application/json";
        }
        const options: RequestInit = {
            method,
            headers,
            body: body && ["POST", "PUT", "PATCH"].includes(method) ? JSON.stringify(body) : undefined,
        };
        return fetch(`${baseUrl}${path}`, options);
    };

    try {
        let testedRoutes = 0;
        for (const spec of PERMISSION_MATRIX) {
            testedRoutes++;

            // 1. Unauthenticated request
            if (spec.allowedRoles === "public") {
                const res = await makeRequest(spec.method, spec.path, undefined, spec.body, spec.headers);
                assert.notEqual(
                    res.status,
                    401,
                    `Public route ${spec.method} ${spec.path} should not return 401 when unauthenticated (got ${res.status})`,
                );
            } else {
                const resNoAuth = await makeRequest(spec.method, spec.path, undefined, spec.body, spec.headers);
                assert.equal(
                    resNoAuth.status,
                    401,
                    `Protected route ${spec.method} ${spec.path} must return 401 when unauthenticated (got ${resNoAuth.status})`,
                );

                const resOtp = await makeRequest(spec.method, spec.path, otpChallengeToken, spec.body, spec.headers);
                assert.equal(
                    resOtp.status,
                    401,
                    `Protected route ${spec.method} ${spec.path} must return 401 when token has is_otp_phase: true (got ${resOtp.status})`,
                );

                // 2. Test each role
                for (const role of roles) {
                    const token = userTokens[role];
                    const res = await makeRequest(spec.method, spec.path, token, spec.body, spec.headers);
                    const isAllowed = spec.allowedRoles.includes(role);

                    if (isAllowed) {
                        assert.notEqual(
                            res.status,
                            401,
                            `Route ${spec.method} ${spec.path} should not return 401 for allowed role ${role}`,
                        );
                        assert.notEqual(
                            res.status,
                            403,
                            `Route ${spec.method} ${spec.path} should not return 403 for allowed role ${role}`,
                        );
                    } else {
                        assert.equal(
                            res.status,
                            403,
                            `Route ${spec.method} ${spec.path} must return 403 for forbidden role ${role} (got ${res.status})`,
                        );
                    }
                }
            }
        }

        const adminToken = userTokens[AppRole.ADMIN];
        const feeListResponse = await makeRequest(
            "GET",
            "/api/admin/reports/payment-fees?start_date=2026-01-01&end_date=2026-01-01",
            adminToken,
        );
        assert.equal(feeListResponse.status, 200, "Admin fee report should load successfully");
        const invalidFeeResponse = await makeRequest("POST", "/api/admin/payment-fees", adminToken, {});
        assert.equal(invalidFeeResponse.status, 400, "Invalid fee data should be rejected with a validation response");
        const summaryResponse = await makeRequest(
            "GET",
            "/api/reports/summary?start=2026-01-01&end=2026-01-02",
            adminToken,
        );
        const summaryBody = await summaryResponse.text();
        assert.equal(summaryResponse.status, 200, `Financial report handler should retain its controller context: ${summaryBody}`);

        for (const role of [AppRole.ADMIN, AppRole.CASHIER]) {
            const dashboardResponse = await makeRequest("GET", "/api/dashboard/stats", userTokens[role]);
            assert.equal(dashboardResponse.status, 200, `Dashboard stats should load for ${role}`);
            const dashboard = await dashboardResponse.json() as {
                todaySalesCents: string;
                recentTransactions: Array<{ amountCents: string }>;
                salesByMethod: Array<{ amountCents: string }>;
                weeklyTrend: Array<{ salesCents: string }>;
                topProducts: Array<{ revenueCents: string }>;
            };
            const integerCents = /^-?\d+$/;
            assert.match(dashboard.todaySalesCents, integerCents);
            assert.ok(dashboard.recentTransactions.every((row) => integerCents.test(row.amountCents)));
            assert.ok(dashboard.salesByMethod.every((row) => integerCents.test(row.amountCents)));
            assert.ok(dashboard.weeklyTrend.every((row) => integerCents.test(row.salesCents)));
            assert.ok(dashboard.topProducts.every((row) => integerCents.test(row.revenueCents)));
        }

        assert.ok(testedRoutes >= 70, `Matrix should test at least 70 routes (tested ${testedRoutes})`);
    } finally {
        server.close();
    }
});
