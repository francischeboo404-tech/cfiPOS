import { KNOWN_DEFAULT_ENCRYPTION_KEYS, KNOWN_DEFAULT_JWT_SECRETS } from "../data-source";
import { getOtpEmailConfigurationIssues } from "../services/EmailService";
import { ETIMS_LIVE_MODE_AVAILABLE } from "../services/etims/EtimsProvider";

export interface ConfigValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * Validates system configuration for production readiness.
 * Returns a consolidated list of every missing or weak setting.
 */
export function validateSystemConfig(
    nodeEnv: string = process.env.NODE_ENV || "development",
    env: NodeJS.ProcessEnv = process.env,
): ConfigValidationResult {
    const isProduction = nodeEnv === "production";
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Database URL
    if (!env.DATABASE_URL || env.DATABASE_URL.trim() === "") {
        errors.push("DATABASE_URL is not set. A valid PostgreSQL connection string is required.");
    } else {
        try {
            const url = new URL(env.DATABASE_URL);
            if (!["postgresql:", "postgres:"].includes(url.protocol)) {
                errors.push("DATABASE_URL must be a postgresql:// or postgres:// connection string.");
            }
        } catch {
            errors.push("DATABASE_URL is not a valid URL string.");
        }
    }

    // 2. Port
    const portNum = Number(env.PORT);
    if (!env.PORT || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        errors.push("PORT must be configured as a valid TCP port number (1-65535).");
    }

    // 3. JWT Secret
    const jwtSecret = (env.JWT_SECRET || "").trim();
    if (!jwtSecret) {
        errors.push("JWT_SECRET is missing. A strong cryptographic key is required for session signing.");
    } else if (isProduction) {
        if (jwtSecret.length < 32) {
            errors.push(`JWT_SECRET is too short in production (${jwtSecret.length} chars). Minimum 32 characters required.`);
        }
        if (KNOWN_DEFAULT_JWT_SECRETS.has(jwtSecret.toLowerCase())) {
            errors.push("JWT_SECRET matches a known default development key. Generate a unique, cryptographically random key.");
        }
    }

    // 4. Encryption Key
    const encKey = (env.ENCRYPTION_KEY || "").trim();
    if (!encKey || !/^[0-9a-fA-F]{64}$/.test(encKey)) {
        errors.push("ENCRYPTION_KEY must be configured as 64 hexadecimal characters (32 bytes AES-256).");
    } else if (isProduction && KNOWN_DEFAULT_ENCRYPTION_KEYS.has(encKey.toLowerCase())) {
        errors.push("ENCRYPTION_KEY matches a known default key. Generate a unique 64-hex key.");
    }

    // 5. CORS Origins
    const corsOrigins = env.CORS_ORIGINS?.trim() || "";
    const frontendUrl = env.FRONTEND_URL?.trim() || "";
    if (isProduction) {
        if (!corsOrigins && !frontendUrl) {
            errors.push("CORS_ORIGINS or FRONTEND_URL must be explicitly configured in production to restrict API access.");
        } else if (corsOrigins.includes("*")) {
            errors.push("CORS_ORIGINS cannot contain wildcard '*' in production when credentials are enabled.");
        }
    }

    // 6. ETIMS Mode
    const etimsMode = (env.ETIMS_MODE || "").trim().toLowerCase();
    if (isProduction) {
        if (!etimsMode || !["off", "mock", "live"].includes(etimsMode)) {
            errors.push("ETIMS_MODE must be explicitly set to 'off', 'mock', or 'live' in production.");
        } else if (etimsMode === "live" && !ETIMS_LIVE_MODE_AVAILABLE) {
            errors.push("ETIMS_MODE=live is disabled until the KRA VSCU integration is implemented and verified.");
        }
    }

    // 7. Email Configuration (for OTP delivery)
    if (isProduction) {
        const emailIssues = getOtpEmailConfigurationIssues();
        for (const issue of emailIssues) {
            errors.push(`Email Config: ${issue}`);
        }
    }

    // 8. M-Pesa Configuration (when M-Pesa is enabled)
    const mpesaEnabled = env.ENABLE_MPESA !== "false";
    const hasAnyMpesaConfig = Boolean(
        env.MPESA_CONSUMER_KEY || env.MPESA_PASSKEY || env.MPESA_PAYBILL || env.MPESA_SHORTCODE
    );

    if (isProduction && mpesaEnabled && hasAnyMpesaConfig) {
        if (!env.MPESA_CONSUMER_KEY?.trim()) {
            errors.push("MPESA_CONSUMER_KEY is missing but M-Pesa is enabled.");
        }
        if (!env.MPESA_CONSUMER_SECRET?.trim()) {
            errors.push("MPESA_CONSUMER_SECRET is missing but M-Pesa is enabled.");
        }
        if (!env.MPESA_PASSKEY?.trim()) {
            errors.push("MPESA_PASSKEY is missing for Daraja STK Push.");
        }
        const callbackUrl = env.MPESA_CALLBACK_URL?.trim();
        if (!callbackUrl) {
            errors.push("MPESA_CALLBACK_URL is missing. Daraja requires a public HTTPS callback endpoint.");
        } else if (!callbackUrl.startsWith("https://")) {
            errors.push("MPESA_CALLBACK_URL must start with https:// for production callbacks.");
        }
        const c2bToken = env.MPESA_C2B_CALLBACK_TOKEN?.trim();
        if (c2bToken && !/^[0-9a-fA-F]{64,128}$/.test(c2bToken)) {
            errors.push("MPESA_C2B_CALLBACK_TOKEN must be 64-128 hexadecimal characters.");
        }
    }

    // 9. Warnings for optional services
    if (!env.SENTRY_DSN) {
        warnings.push("SENTRY_DSN is not configured; external error reporting is disabled.");
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * Validates config at startup and outputs a clean readable block if invalid.
 */
export function assertProductionConfigReady(
    nodeEnv: string = process.env.NODE_ENV || "development",
    env: NodeJS.ProcessEnv = process.env,
): void {
    const result = validateSystemConfig(nodeEnv, env);

    if (result.warnings.length > 0 && nodeEnv === "production") {
        for (const warning of result.warnings) {
            console.warn(`[CONFIG WARNING] ${warning}`);
        }
    }

    if (!result.valid) {
        const errorList = result.errors.map((err, i) => `  ${i + 1}. ${err}`).join("\n");
        const message = [
            "\n" + "=".repeat(80),
            `FATAL: PRODUCTION CONFIGURATION VALIDATION FAILED (${result.errors.length} issue(s))`,
            "=".repeat(80),
            errorList,
            "-".repeat(80),
            "Configure all required environment variables in your deployment before starting.",
            "=".repeat(80) + "\n",
        ].join("\n");

        console.error(message);
        throw new Error(`Production configuration validation failed with ${result.errors.length} error(s).`);
    }
}
