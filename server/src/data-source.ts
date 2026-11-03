import "reflect-metadata";
import { DataSource } from "typeorm";
import * as dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PurchaseRequisition } from "./entity/PurchaseRequisition";
import { Shift } from "./entity/Shift";
import { OtpCode } from "./entity/OtpCode";
import { ReturnRequest } from "./entity/ReturnRequest";
import { ReturnItem } from "./entity/ReturnItem";
import { SaleItemBatch } from "./entity/SaleItemBatch";

const serverEnvironmentPath = path.resolve(__dirname, "../.env");
const rootEnvironmentPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: serverEnvironmentPath });

if (existsSync(rootEnvironmentPath)) {
    const rootEnvironment = dotenv.parse(readFileSync(rootEnvironmentPath));
    const backendIntegrationKeys = [
        "RESEND_API_KEY",
        "RESEND_FROM_EMAIL",
        "MPESA_CONSUMER_KEY",
        "MPESA_CONSUMER_SECRET",
        "MPESA_PASSKEY",
        "MPESA_API_BASE_URL",
        "MPESA_CALLBACK_URL",
        "MPESA_C2B_CALLBACK_BASE_URL",
        "MPESA_C2B_CALLBACK_TOKEN",
        "ENCRYPTION_KEY",
        "PESAPAL_IPN_SECRET",
        "PESAPAL_SECRET",
        "PESAPAL_API_SECRET",
        "PESAPAL_MOCK_IFRAME_URL",
        "ETIMS_QR_VERIFY_URL",
        "ETIMS_CREDIT_NOTE_QR_VERIFY_URL",
        "ETIMS_MODE",
        "ETIMS_VSCU_BASE_URL",
        "ETIMS_KRA_PIN",
        "ETIMS_BRANCH_ID",
        "ETIMS_DEVICE_SERIAL",
        "ETIMS_INITIAL_INVOICE_NUMBER",
        "ETIMS_PAYMENT_TYPE_CASH",
        "ETIMS_PAYMENT_TYPE_MPESA",
        "ETIMS_PAYMENT_TYPE_STORE_CREDIT",
        "GEMINI_API_KEY",
        "AI_GATEWAY_URL",
        "AI_MODEL",
        "CORS_ORIGINS",
    ];

    for (const key of backendIntegrationKeys) {
        if (!process.env[key] && rootEnvironment[key]) {
            process.env[key] = rootEnvironment[key];
        }
    }
}

if (!process.env.ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY)) {
    throw new Error("ENCRYPTION_KEY must be configured as 64 hexadecimal characters (32 bytes).");
}

export const KNOWN_DEFAULT_ENCRYPTION_KEYS = new Set([
    "854b1203f9667e40f1b2f9c98e24b76a296b1f265eaaaf1d6d64954d1bafa9d3".toLowerCase(),
]);

export const KNOWN_DEFAULT_JWT_SECRETS = new Set([
    "e2e738d0341c20993ff3a19a8e840efa9dc826dab287b27376e69bb9ef6562d1".toLowerCase(),
    "secret",
    "jwt_secret",
    "changeme",
]);

if (process.env.NODE_ENV === "production") {
    if (process.env.ENCRYPTION_KEY && KNOWN_DEFAULT_ENCRYPTION_KEYS.has(process.env.ENCRYPTION_KEY.toLowerCase())) {
        throw new Error("FATAL: Default static ENCRYPTION_KEY detected in production. Generate a unique 64 hexadecimal character key.");
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret) {
        if (jwtSecret.length < 32 || KNOWN_DEFAULT_JWT_SECRETS.has(jwtSecret.toLowerCase())) {
            throw new Error("FATAL: JWT_SECRET in production must be at least 32 characters and cannot match sample/default keys.");
        }
    }
}

if (process.env.NODE_ENV === "production" && process.env.TYPEORM_SYNCHRONIZE === "true") {
    throw new Error("TYPEORM_SYNCHRONIZE must be disabled in production; apply reviewed migrations instead.");
}

const parsePoolSetting = (name: string, fallback: number, minimum: number, maximum: number) => {
    const rawValue = process.env[name];
    if (rawValue === undefined || rawValue.trim() === "") {
        return fallback;
    }

    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }

    return value;
};

const postgresPoolMax = parsePoolSetting("PG_POOL_MAX", 10, 1, 100);
const postgresConnectionTimeoutMillis = parsePoolSetting("PG_CONNECTION_TIMEOUT_MS", 5000, 1000, 60000);

export const AppDataSource = new DataSource({
    type: "postgres",
    url: process.env.DATABASE_URL,
    synchronize: process.env.TYPEORM_SYNCHRONIZE === "true",
    logging: ["error"],
    extra: {
        max: postgresPoolMax,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: postgresConnectionTimeoutMillis,
        options: `-c app.encryption_key=${process.env.ENCRYPTION_KEY}`,
    },
    entities: [PurchaseRequisition, Shift, OtpCode, ReturnRequest, ReturnItem, SaleItemBatch, __dirname + "/entity/*.{js,ts}"],
    migrations: [__dirname + "/migration/*.{js,ts}"],
    subscribers: [],
});
