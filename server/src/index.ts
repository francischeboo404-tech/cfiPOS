import "reflect-metadata";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { ipKeyGenerator } from "express-rate-limit";
import { createServer } from "http";
import * as jwt from "jsonwebtoken";
import { AppDataSource } from "./data-source";
import { AuthController } from "./controllers/AuthController";
import { ProductController } from "./controllers/ProductController";
import { CategoryController } from "./controllers/CategoryController";
import { SalesController } from "./controllers/SalesController";
import { CustomerController } from "./controllers/CustomerController";
import { InstallmentPlanController } from "./controllers/InstallmentPlanController";
import { InstallmentController } from "./controllers/InstallmentController";
import { DashboardController } from "./controllers/DashboardController";
import { VendorController } from "./controllers/VendorController";
import { PurchaseOrderController } from "./controllers/PurchaseOrderController";
import { PaymentController } from "./controllers/PaymentController";
import { CheckoutController } from "./controllers/CheckoutController";
import { WarehouseController } from "./controllers/WarehouseController";
import { InventoryController } from "./controllers/InventoryController";
import { ProcurementController } from "./controllers/ProcurementController";
import { ShiftController } from "./controllers/ShiftController";
import { ReturnController } from "./controllers/ReturnController";
import { TaxController } from "./controllers/TaxController";
import { UserAdminController } from "./controllers/UserAdminController";
import { LoyaltyController } from "./controllers/LoyaltyController";
import { InvoiceController } from "./controllers/InvoiceController";
import { ReportController } from "./controllers/ReportController";
import { VoucherController } from "./controllers/VoucherController";
import { CostingReportController } from "./controllers/CostingReportController";
import { StockMovementController } from "./controllers/StockMovementController";
import { InventoryPredictionController } from "./controllers/InventoryPredictionController";
import { PromotionController } from "./controllers/PromotionController";
import { authenticateJWT, requireRole, requireRoles } from "./middleware/auth";
import { SocketService } from "./services/SocketService";
import { CronService } from "./services/CronService";
import { AccountingService } from "./services/AccountingService";
import { WarehouseService } from "./services/WarehouseService";
import { TaxService } from "./services/TaxService";
import { AdminSetupService } from "./services/AdminSetupService";
import { InventoryService } from "./services/InventoryService";
import { getOtpEmailConfigurationIssues } from "./services/EmailService";
import { EtimsService } from "./services/etims/EtimsService";
import {
    requestIdMiddleware,
    requestLoggingMiddleware,
    ErrorTracker,
    livenessHandler,
    readinessHandler,
    ObservabilityRequest,
} from "./lib/observability";
import { assertProductionConfigReady } from "./lib/configValidator";

export const app = express();
export const httpServer = createServer(app);

if (process.env.TRUST_PROXY) {
    app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : process.env.TRUST_PROXY);
}

const productImportUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const fileName = (file.originalname || "").toLowerCase();
        const isCsv = fileName.endsWith(".csv") || file.mimetype === "text/csv" || file.mimetype === "application/csv";
        const isExcel = fileName.endsWith(".xlsx") || file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

        if (isCsv || isExcel) {
            cb(null, true);
            return;
        }

        cb(new Error("Only CSV and Excel files are allowed for bulk product import."));
    },
});

const companyLogoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024, files: 1 },
});

const handleCompanyLogoUpload = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    companyLogoUpload.single("logo")(req, res, (error?: unknown) => {
        if (!error) {
            next();
            return;
        }

        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ message: "The company logo must be 3 MB or smaller." });
            return;
        }

        res.status(400).json({
            message: error instanceof Error ? error.message : "Unable to receive the company logo.",
        });
    });
};

const handleProductImportUpload = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const onUploadComplete: express.NextFunction = (error?: unknown) => {
        if (!error) {
            next();
            return;
        }

        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ message: "The import file must be 5 MB or smaller." });
            return;
        }

        res.status(400).json({
            message: error instanceof Error ? error.message : "Only CSV and XLSX files are supported for bulk product import.",
        });
    };

    productImportUpload.single("file")(req, res, onUploadComplete);
};

const PORT = Number(process.env.PORT);

if (!process.env.JWT_SECRET) {
    console.error("FATAL: JWT_SECRET is not set. Configure it before starting the server.");
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error("FATAL: DATABASE_URL is not set. Configure it before starting the server.");
    process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error("FATAL: PORT must be configured as a valid TCP port.");
    process.exit(1);
}

if (process.env.NODE_ENV === "production") {
    const etimsMode = (process.env.ETIMS_MODE || "").trim().toLowerCase();
    if (etimsMode !== "off" && etimsMode !== "mock" && etimsMode !== "live") {
        console.error("FATAL: ETIMS_MODE must be explicitly set to 'off', 'mock', or 'live' in production. Configure ETIMS_MODE before starting the server.");
        process.exit(1);
    }
}

export const defaultAllowedOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
];

export const resolveAllowedCorsOrigins = (
    nodeEnv: string = process.env.NODE_ENV || "development",
    corsOriginsEnv: string = process.env.CORS_ORIGINS || "",
    frontendUrlEnv: string = process.env.FRONTEND_URL || "",
): string[] => {
    const configuredOrigins = `${corsOriginsEnv},${frontendUrlEnv}`
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

    if (nodeEnv === "production") {
        return Array.from(new Set(configuredOrigins));
    }

    return Array.from(new Set([...defaultAllowedOrigins, ...configuredOrigins]));
};

const allowedOrigins = resolveAllowedCorsOrigins();

// Security Middlewares
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'wasm-unsafe-eval'"],
            workerSrc: ["'self'", "blob:"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: process.env.NODE_ENV === "production"
                ? ["'self'", "https:", "wss:"]
                : ["'self'", "https:", "wss:", "http://localhost:3000", "ws://localhost:3000", "http://127.0.0.1:3000", "ws://127.0.0.1:3000"],
            fontSrc: ["'self'", "data:"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
        },
    },
    frameguard: { action: "deny" },
})); // Sets secure HTTP headers including strict CSP
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
})); // Restricted CORS
const captureRawBody = (req: express.Request & { rawBody?: Buffer }, _res: express.Response, buf: Buffer) => {
    req.rawBody = buf;
};
app.use("/api/admin/costing-baseline-verification", express.json({
    limit: "16mb",
    verify: captureRawBody,
}));
app.use(express.json({
    limit: "1mb",
    verify: captureRawBody,
}));

// Request ID & Logging Middleware
app.use(requestIdMiddleware);
app.use(requestLoggingMiddleware);

// Rate Limiting to prevent brute-force
interface RateLimitIdentity {
    key: string;
    authenticated: boolean;
}

type RateLimitedRequest = express.Request & { rateLimitIdentity?: RateLimitIdentity };

const attachRateLimitIdentity: express.RequestHandler = (req, _res, next) => {
    const rateLimitedRequest = req as RateLimitedRequest;
    const cookieHeader = req.headers.cookie;
    let cookieToken: string | undefined;
    if (cookieHeader) {
        const match = cookieHeader.match(/(?:^|;\s*)jwt_token=([^;]+)/);
        if (match) {
            cookieToken = decodeURIComponent(match[1]);
        }
    }
    const authorization = req.headers.authorization;
    const token = cookieToken || (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
    if (token && process.env.JWT_SECRET) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (typeof decoded === "object" && typeof decoded.id === "string" && decoded.id) {
                rateLimitedRequest.rateLimitIdentity = {
                    key: `user:${decoded.id}`,
                    authenticated: true,
                };
                next();
                return;
            }
        } catch {
            // Invalid and expired tokens use the unauthenticated IP bucket.
        }
    }

    rateLimitedRequest.rateLimitIdentity = {
        key: `ip:${ipKeyGenerator(req.ip || "127.0.0.1")}`,
        authenticated: false,
    };
    next();
};

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: (req) => {
        if (process.env.NODE_ENV === "test") {
            return 10000;
        }
        return (req as RateLimitedRequest).rateLimitIdentity?.authenticated ? 1200 : 120;
    },
    keyGenerator: (req) =>
        (req as RateLimitedRequest).rateLimitIdentity?.key || `ip:${ipKeyGenerator(req.ip || "127.0.0.1")}`,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
        req.path === "/health" ||
        req.path === "/ready" ||
        req.path === "/api/health" ||
        req.path === "/api/ready",
    message: "Too many requests. Please try again later.",
});
app.use("/api/", attachRateLimitIdentity, apiLimiter);

const getNormalizedEmailFromReq = (req: express.Request): string => {
    const email = req.body?.email;
    if (typeof email === "string") {
        const trimmed = email.trim().toLowerCase();
        if (trimmed) return trimmed;
    }
    return "anonymous";
};

const getNormalizedOtpIdentityFromReq = (req: express.Request): string => {
    const token = req.body?.otp_token;
    if (typeof token === "string") {
        try {
            const decoded = jwt.decode(token) as { email?: string; id?: string } | null;
            if (decoded?.email) return decoded.email.trim().toLowerCase();
            if (decoded?.id) return `user:${decoded.id}`;
        } catch {
            return "anonymous";
        }
    }
    return "anonymous";
};

const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === "production" ? 10 : 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `login-acc:${ipKeyGenerator(req.ip || "127.0.0.1")}:${getNormalizedEmailFromReq(req)}`,
    message: { message: "Too many login attempts for this account. Please try again after 15 minutes." },
});

const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === "production" ? 100 : 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `login-ip:${ipKeyGenerator(req.ip || "127.0.0.1")}`,
    message: { message: "Too many login attempts from this network. Please try again after 15 minutes." },
});

const loginLimiter = [loginIpLimiter, loginAccountLimiter];

const otpAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === "production" ? 20 : 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `otp-acc:${ipKeyGenerator(req.ip || "127.0.0.1")}:${getNormalizedOtpIdentityFromReq(req)}`,
    message: { message: "Too many OTP attempts for this session. Please try again later." },
});

const otpIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === "production" ? 100 : 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `otp-ip:${ipKeyGenerator(req.ip || "127.0.0.1")}`,
    message: { message: "Too many OTP attempts from this network. Please try again later." },
});

const otpLimiter = [otpIpLimiter, otpAccountLimiter];

const loggingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.NODE_ENV === "production" ? 30 : 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `log-ip:${ipKeyGenerator(req.ip || "127.0.0.1")}`,
    message: { message: "Too many log submissions. Please try again after 15 minutes." },
});

const logPayloadSizeLimiter: express.RequestHandler = (req, res, next) => {
    const contentLength = Number(req.headers["content-length"]);
    if (contentLength && contentLength > 10 * 1024) {
        return res.status(413).json({ message: "Payload exceeds maximum allowed log size of 10KB." });
    }
    next();
};

// Liveness and Readiness routes
app.get("/health", livenessHandler);
app.get("/api/health", livenessHandler);
app.get("/ready", readinessHandler);
app.get("/api/ready", readinessHandler);
app.get("/", (_req, res) => {
    res.json({ status: "cfi-POS Techiez Limited Company API is running smoothly", version: "1.0.0" });
});
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Auth Routes
app.post("/api/auth/register", loginLimiter, AuthController.register);
app.post("/api/auth/login", loginLimiter, AuthController.login);
app.post("/api/auth/verify-otp", otpLimiter, AuthController.verifyOtp);
app.post("/api/auth/logout", AuthController.logout);
app.get("/api/auth/me", authenticateJWT, AuthController.getProfile);
app.post("/api/auth/change-password", authenticateJWT, loginLimiter, AuthController.changePassword);

// PWA & Security Logging Routes
app.post("/api/auth/log_application_error", logPayloadSizeLimiter, loggingLimiter, AuthController.logEvent);
app.post("/api/auth/log_security_event", logPayloadSizeLimiter, loggingLimiter, AuthController.logEvent);
app.post("/api/auth/log_pwa_security_event", logPayloadSizeLimiter, loggingLimiter, AuthController.logEvent);
app.post("/api/auth/validate_input_data", logPayloadSizeLimiter, loggingLimiter, AuthController.validateData);
app.post("/api/auth/validate_pwa_cache_integrity", logPayloadSizeLimiter, loggingLimiter, AuthController.validateCacheIntegrity);

// Product Routes
app.get("/api/categories", authenticateJWT, CategoryController.list);
app.post("/api/categories", authenticateJWT, requireRoles(["admin", "manager"]), CategoryController.create);
app.put("/api/categories/:id", authenticateJWT, requireRoles(["admin", "manager"]), CategoryController.update);
app.delete("/api/categories/:id", authenticateJWT, requireRole("admin"), CategoryController.delete);
app.get("/api/products", authenticateJWT, ProductController.getAllProducts);
app.get("/api/products/template", authenticateJWT, requireRoles(["admin", "manager"]), ProductController.getImportTemplate);
app.post("/api/products/import", authenticateJWT, requireRoles(["admin", "manager"]), handleProductImportUpload, ProductController.importProducts);
app.get("/api/inventory/alerts", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), ProductController.getInventoryAlerts);
app.get("/api/inventory/predictions", authenticateJWT, requireRoles(["manager", "admin"]), InventoryPredictionController.getPredictions);
app.get("/api/products/:id", authenticateJWT, ProductController.getProduct);
app.post("/api/products", authenticateJWT, requireRoles(["admin", "manager"]), ProductController.createProduct);
app.put("/api/products/:id", authenticateJWT, requireRoles(["admin", "manager"]), ProductController.updateProduct);
app.delete("/api/products/:id", authenticateJWT, requireRole("admin"), ProductController.deleteProduct);

// Sales Routes
app.get("/api/sales", authenticateJWT, SalesController.getAllSales);
app.post("/api/sales/checkouts", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), CheckoutController.reserve);
app.get("/api/sales/checkouts/:checkoutSessionId", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), CheckoutController.get);
app.post("/api/sales/checkouts/:checkoutSessionId/confirm-cash", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), CheckoutController.confirmCash);
app.post("/api/sales/checkouts/:checkoutSessionId/cancel", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), CheckoutController.cancel);
app.post("/api/sales", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), SalesController.createSale);
app.get("/api/store-credits/:barcode", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), SalesController.getStoreCreditBalance);
app.post("/api/sales/park", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), SalesController.parkSale);
app.get("/api/sales/parked", authenticateJWT, SalesController.getParkedSales);
app.get("/api/sales/:id", authenticateJWT, SalesController.getSaleById);

// Timed promotion management and reporting
app.get("/api/promotions/active", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), PromotionController.active);
app.get("/api/promotions", authenticateJWT, requireRoles(["manager", "admin"]), PromotionController.list);
app.post("/api/promotions", authenticateJWT, requireRoles(["manager", "admin"]), PromotionController.create);
app.put("/api/promotions/:id", authenticateJWT, requireRoles(["manager", "admin"]), PromotionController.update);
app.post("/api/promotions/:id/cancel", authenticateJWT, requireRoles(["manager", "admin"]), PromotionController.cancel);
app.get("/api/promotions/:id/audit", authenticateJWT, requireRoles(["manager", "admin"]), PromotionController.audit);
app.get("/api/reports/promotions", authenticateJWT, requireRoles(["manager", "admin"]), PromotionController.performance);

// Customer invoice and receivables routes
app.get("/api/invoices", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), InvoiceController.list);
app.get("/api/invoices/:invoiceId/payments", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), InvoiceController.listPayments);
app.post("/api/invoices/:invoiceId/payments", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), InvoiceController.recordPayment);
// app.post("/api/sales/:id/void", authenticateJWT, requireRole("admin"), SalesController.voidSale); // DEPRECATED: Returns now go through Return Engine

// Returns & Refunds Workflow
app.get("/api/returns/search", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), ReturnController.searchReturnableSales);
app.post("/api/returns/request", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), ReturnController.requestReturn);
app.get("/api/returns", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), ReturnController.getAllRequests);
app.post("/api/admin/returns/approve/:id", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), ReturnController.approveReturn);
app.post("/api/admin/returns/:id/mpesa-payout", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), ReturnController.confirmMpesaRefundPayout);
app.post("/api/admin/returns/reject/:id", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), ReturnController.rejectReturn);

// Customer Routes
app.get("/api/customers", authenticateJWT, CustomerController.getAllCustomers);
app.get("/api/customers/:id", authenticateJWT, CustomerController.getCustomer);
app.post("/api/customers", authenticateJWT, CustomerController.createCustomer);
app.put("/api/customers/:id", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), CustomerController.updateCustomer);
app.delete("/api/customers/:id", authenticateJWT, requireRole("admin"), CustomerController.deleteCustomer);
app.post("/api/installments/quote", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), InstallmentController.quote);
app.post("/api/installments/agreements", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), InstallmentController.createAgreement);
app.post("/api/installments/payments", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), InstallmentController.recordPayment);
app.post("/api/installments/payments/:paymentId/reverse", authenticateJWT, requireRoles(["manager", "admin"]), InstallmentController.reversePayment);
app.post("/api/installments/agreements/:agreementId/cancel", authenticateJWT, requireRoles(["manager", "admin"]), InstallmentController.cancelAgreement);
app.get("/api/installments/plans", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), InstallmentPlanController.listPlans);
app.post("/api/installments/plans", authenticateJWT, requireRoles(["manager", "admin"]), InstallmentPlanController.createPlan);
app.put("/api/installments/plans/:id", authenticateJWT, requireRoles(["manager", "admin"]), InstallmentPlanController.updatePlan);
app.delete("/api/installments/plans/:id", authenticateJWT, requireRoles(["manager", "admin"]), InstallmentPlanController.deactivatePlan);
app.get("/api/installments/settings", authenticateJWT, requireRoles(["manager", "admin"]), InstallmentPlanController.getSettings);
app.put("/api/installments/settings", authenticateJWT, requireRole("admin"), InstallmentPlanController.saveSettings);
app.get("/api/vouchers/lookup/:number", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), VoucherController.findByNumber);
app.post("/api/vouchers/:id/renew", authenticateJWT, requireRoles(["manager", "admin"]), VoucherController.renew);
app.post("/api/vouchers/:id/renewal-checkouts", authenticateJWT, requireRoles(["manager", "admin"]), VoucherController.startRenewalCheckout);
app.post("/api/vouchers/renewal-checkouts/:checkoutSessionId/cash", authenticateJWT, requireRoles(["manager", "admin"]), VoucherController.recordRenewalCash);
app.post("/api/vouchers/renewal-checkouts/:checkoutSessionId/complete", authenticateJWT, requireRoles(["manager", "admin"]), VoucherController.completeRenewalCheckout);
app.post("/api/vouchers/:id/adjust", authenticateJWT, requireRole("admin"), VoucherController.adjust);
app.post("/api/vouchers/:id/print", authenticateJWT, VoucherController.logPrint);
app.get("/api/reports/costing", authenticateJWT, requireRoles(["manager", "admin"]), CostingReportController.get);
app.get("/api/reports/costing/closes", authenticateJWT, requireRoles(["manager", "admin"]), CostingReportController.listPeriodCloses);
app.post("/api/reports/costing/closes", authenticateJWT, requireRoles(["manager", "admin"]), CostingReportController.closePeriod);
app.get("/api/admin/costing-baseline-verification", authenticateJWT, requireRole("admin"), CostingReportController.getBaselineVerification);
app.post("/api/admin/costing-baseline-verification", authenticateJWT, requireRole("admin"), CostingReportController.verifyBaseline);

// Vendor Routes
app.get("/api/vendors", authenticateJWT, requireRoles(["manager", "admin"]), VendorController.getAllVendors);
app.get("/api/vendors/:id", authenticateJWT, requireRoles(["manager", "admin"]), VendorController.getVendor);
app.post("/api/vendors", authenticateJWT, requireRoles(["manager", "admin"]), VendorController.createVendor);
app.put("/api/vendors/:id", authenticateJWT, requireRoles(["manager", "admin"]), VendorController.updateVendor);
app.post("/api/vendors/:id/review", authenticateJWT, requireRoles(["manager", "admin"]), VendorController.markVendorReviewed);
app.delete("/api/vendors/:id", authenticateJWT, requireRole("admin"), VendorController.deleteVendor);
app.get("/api/vendor-portal", authenticateJWT, requireRoles(["manager", "admin"]), VendorController.getPortalData);

// Purchase Order Routes
app.get("/api/purchase-orders", authenticateJWT, requireRoles(["manager", "admin"]), PurchaseOrderController.getAll);
app.get("/api/purchase-orders/:id", authenticateJWT, requireRoles(["manager", "admin"]), PurchaseOrderController.getById);
app.post("/api/purchase-orders", authenticateJWT, requireRoles(["manager", "admin"]), PurchaseOrderController.create);
app.put("/api/purchase-orders/:id/status", authenticateJWT, requireRoles(["manager", "admin"]), PurchaseOrderController.updateStatus);
app.post("/api/purchase-orders/:id/email", authenticateJWT, requireRoles(["manager", "admin"]), PurchaseOrderController.sendEmail);
app.post("/api/purchase-orders/:id/receive", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), PurchaseOrderController.receive);
app.get("/api/delivery-notes", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), PurchaseOrderController.getDeliveryNotes);
app.get("/api/delivery-notes/:id", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), PurchaseOrderController.getDeliveryNoteById);

// Procurement (Invoices & Requisitions) Routes
app.get("/api/procurement/invoices", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.listSupplierInvoices);
app.get("/api/procurement/supplier-invoices", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.listSupplierInvoices);
app.get("/api/procurement/supplier-invoice-accounts", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.listManualSupplierInvoiceAccounts);
app.get("/api/procurement/supplier-invoices/:invoiceId/payments", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.listSupplierPayments);
app.post("/api/procurement/invoice", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.createSupplierInvoice);
app.post("/api/procurement/invoices", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.createSupplierInvoice);
app.post("/api/procurement/supplier-invoices", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.createSupplierInvoice);
app.post("/api/procurement/supplier-invoices/:invoiceId/review", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.reviewManualSupplierInvoice);
app.post("/api/procurement/supplier-invoices/:invoiceId/payments", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.recordSupplierPayment);
app.put("/api/procurement/requisitions/:id/status", authenticateJWT, requireRoles(["manager", "admin"]), ProcurementController.updateRequisitionStatus);

// Shift / Cash Drawer Reconciliation Routes
app.post("/api/shifts/open", authenticateJWT, ShiftController.openShift);
app.post("/api/shifts/:id/close", authenticateJWT, ShiftController.closeShift);
app.get("/api/shifts/current", authenticateJWT, ShiftController.getCurrentShift);
app.get("/api/shifts", authenticateJWT, ShiftController.getAllShifts);

// Warehouse Routes
app.get("/api/warehouses", authenticateJWT, WarehouseController.getAll);
app.post("/api/warehouses", authenticateJWT, requireRole("admin"), WarehouseController.create);
app.put("/api/warehouses/:id", authenticateJWT, requireRole("admin"), WarehouseController.update);
app.delete("/api/warehouses/:id", authenticateJWT, requireRole("admin"), WarehouseController.delete);

// Dashboard Routes
app.get("/api/dashboard/stats", authenticateJWT, DashboardController.getDashboardStats);
app.get("/api/reports/summary", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), ReportController.getSummary.bind(ReportController));
app.get("/api/admin/reports/payment-fees", authenticateJWT, requireRole("admin"), ReportController.listUnrecordedProcessingFees.bind(ReportController));
app.post("/api/admin/payment-fees", authenticateJWT, requireRole("admin"), ReportController.recordProcessingFee.bind(ReportController));
app.get("/api/admin/payment-fees", authenticateJWT, requireRole("admin"), ReportController.listRecordedProcessingFees.bind(ReportController));
app.post("/api/admin/payment-fees/:sale_id/corrections", authenticateJWT, requireRole("admin"), ReportController.correctProcessingFee.bind(ReportController));
app.get("/api/inventory/movements", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), StockMovementController.list);

// Admin user management and settings
app.get("/api/users", authenticateJWT, requireRole("admin"), UserAdminController.listUsers);
app.post("/api/users", authenticateJWT, requireRole("admin"), UserAdminController.createUser);
app.put("/api/users/:id", authenticateJWT, requireRole("admin"), UserAdminController.updateUser);
app.put("/api/users/:id/role", authenticateJWT, requireRole("admin"), UserAdminController.setUserRole);
app.delete("/api/users/:id", authenticateJWT, requireRole("admin"), UserAdminController.deleteUser);

app.get("/api/settings", authenticateJWT, requireRole("admin"), LoyaltyController.getSettings);
app.get("/api/receipt-settings", authenticateJWT, LoyaltyController.getReceiptSettings);
// Branding images are public assets so browser img and receipt markup can load them directly.
app.get("/api/company-logo", LoyaltyController.getCompanyLogo);
app.post("/api/settings", authenticateJWT, requireRole("admin"), LoyaltyController.saveSettings);
app.post("/api/settings/company-logo", authenticateJWT, requireRole("admin"), handleCompanyLogoUpload, LoyaltyController.uploadCompanyLogo);
app.delete("/api/settings/company-logo", authenticateJWT, requireRole("admin"), LoyaltyController.deleteCompanyLogo);
app.get("/api/loyalty/settings", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), LoyaltyController.getSettings);
app.post("/api/loyalty/settings", authenticateJWT, requireRole("admin"), LoyaltyController.saveSettings);
app.get("/api/loyalty/members", authenticateJWT, LoyaltyController.getMembers);
app.post("/api/loyalty/members", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), LoyaltyController.createMember);
app.post("/api/loyalty/members/:id/points", authenticateJWT, requireRoles(["manager", "admin"]), LoyaltyController.addPoints);
app.post("/api/loyalty/members/:id/redeem", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), LoyaltyController.redeemPoints);

// Inventory Discrepancy Routes
app.get("/api/inventory/adjustments", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), InventoryController.getAdjustments);
app.post("/api/inventory/adjustment", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.createAdjustment);
app.post("/api/inventory/adjustments", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.createAdjustment);

app.get("/api/inventory/transfers", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), InventoryController.getTransfers);
app.post("/api/inventory/transfer", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.createTransfer);
app.post("/api/inventory/transfers", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.createTransfer);
app.put("/api/inventory/transfer/:id/status", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.updateTransferStatus);
app.put("/api/inventory/transfers/:id/status", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.updateTransferStatus);

app.get("/api/inventory/stock-takes", authenticateJWT, requireRoles(["supervisor", "manager", "admin"]), InventoryController.getAllStockTakes);
app.post("/api/inventory/stock-takes", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.initiateStockTake);
app.post("/api/inventory/stock-takes/initiate", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.initiateStockTake);
app.put("/api/inventory/stock-takes/:id/items", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.updateStockTakeCounts);
app.put("/api/inventory/stock-takes/:id/counts", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.updateStockTakeCounts);
app.post("/api/inventory/stock-takes/:id/complete", authenticateJWT, requireRoles(["admin", "manager", "supervisor"]), InventoryController.completeStockTake);

// Tax Engine Routes
app.get("/api/taxes", authenticateJWT, TaxController.getAll);
app.post("/api/taxes", authenticateJWT, requireRole("admin"), TaxController.create);
app.put("/api/taxes/:id", authenticateJWT, requireRole("admin"), TaxController.update);
app.delete("/api/taxes/:id", authenticateJWT, requireRole("admin"), TaxController.delete);

// Payment Webhooks
app.post("/api/payments/mpesa/stk-push", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), PaymentController.initiateMpesaStk);
app.get("/api/payments/mpesa/config", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), PaymentController.getMpesaPaymentConfig);
app.post("/api/payments/mpesa/paybill-intent", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), PaymentController.initiateMpesaPaybill);
app.post("/api/payments/mpesa/c2b/register", authenticateJWT, requireRole("admin"), PaymentController.registerMpesaC2bUrls);
app.get("/api/payments/mpesa/session/:checkoutSessionId", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), PaymentController.getMpesaSessionStatus);
app.get("/api/payments/mpesa/:checkoutRequestId", authenticateJWT, requireRoles(["cashier", "supervisor", "manager", "admin"]), PaymentController.getMpesaStatus);
app.post("/api/webhooks/mpesa/callback", PaymentController.mpesaCallback);
app.post("/api/webhooks/mpesa/c2b/validation", PaymentController.mpesaC2bValidation);
app.post("/api/webhooks/mpesa/c2b/confirmation", PaymentController.mpesaC2bConfirmation);
app.post("/api/webhooks/pesapal/ipn", PaymentController.pesapalWebhook);
app.get("/api/webhooks/pesapal/ipn", PaymentController.pesapalWebhook);

// Admin M-Pesa reconciliation and review
app.get("/api/admin/mpesa/unresolved", authenticateJWT, requireRole("admin"), PaymentController.getUnresolvedMpesaTransactions);
app.post("/api/admin/mpesa/:id/resolve", authenticateJWT, requireRole("admin"), PaymentController.resolveMpesaTransaction);

// Sample protected route
app.get("/api/admin-only", authenticateJWT, requireRole("admin"), (req, res) => {
    res.json({ message: "Welcome Admin!" });
});

// Global 404 handler for API routes
app.use((req, res, next) => {
    res.status(404).json({ error: "Not Found" });
});

// Global error handler
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    ErrorTracker.captureException(err, {
        requestId: (req as ObservabilityRequest).id,
        path: req.originalUrl || req.url || req.path,
    });
    console.error(err instanceof Error ? err.stack : err);
    res.status(500).json({ error: "Internal Server Error" });
});

export const startServer = async () => {
    try {
        if (process.env.NODE_ENV === "production") {
            assertProductionConfigReady();
        }
        ErrorTracker.init();

        await AppDataSource.initialize();
        console.log("Database connection established.");

        await AccountingService.initChartOfAccounts(AppDataSource.manager);
        console.log("Chart of accounts initialized.");

        await WarehouseService.initDefaultWarehouse(AppDataSource.manager);

        await TaxService.initDefaultTaxClass(AppDataSource.manager);

        await AdminSetupService.initDefaultAdmin(AppDataSource.manager);
        const costingBaselineReady = await InventoryService.initializeCostingBaseline(AppDataSource.manager);
        if (!costingBaselineReady) {
            console.warn("Inventory costing baseline remains unavailable until an administrator account exists.");
        }

        await SocketService.init(httpServer);
        CronService.init();

        await new Promise<void>((resolve) => {
            httpServer.listen(PORT, () => {
                console.log(`Server and WebSockets listening on port ${PORT}`);
                resolve();
            });
        });
    } catch (error) {
        console.error("FATAL: API startup failed:", error);
        process.exit(1);
    }
};

if (require.main === module) {
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}; shutting down gracefully.`);
        CronService.stop();

        const forcedShutdown = setTimeout(() => {
            console.error("Graceful shutdown timed out; closing active HTTP connections.");
            httpServer.closeAllConnections();
            process.exit(1);
        }, 30000);
        forcedShutdown.unref();

        try {
            await SocketService.close();
            if (AppDataSource.isInitialized) {
                await AppDataSource.destroy();
            }
            clearTimeout(forcedShutdown);
        } catch (error) {
            console.error("Graceful shutdown failed.", error);
            process.exitCode = 1;
        }
    };

    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
    startServer();
}
