require("dotenv").config();

const { spawnSync } = require("child_process");
const { randomUUID } = require("crypto");
const { existsSync, readFileSync } = require("fs");
const path = require("path");
const { Client } = require("pg");

const rootEnvironmentPath = path.resolve(process.cwd(), "../.env");
if (existsSync(rootEnvironmentPath)) {
    const rootEnvironment = require("dotenv").parse(readFileSync(rootEnvironmentPath));
    if (!process.env.ENCRYPTION_KEY && rootEnvironment.ENCRYPTION_KEY) {
        process.env.ENCRYPTION_KEY = rootEnvironment.ENCRYPTION_KEY;
    }
}

const run = async () => {
    if (process.env.NODE_ENV === "production") {
        throw new Error("Refusing to run eTIMS allocator integration tests with NODE_ENV=production.");
    }
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required to create an isolated eTIMS integration database.");
    }
    if (!process.env.ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY)) {
        throw new Error("ENCRYPTION_KEY must be configured as 64 hexadecimal characters before integration tests run.");
    }

    const configuredDatabaseUrl = new URL(process.env.DATABASE_URL);
    const isLocalDatabase = ["localhost", "127.0.0.1", "::1"].includes(configuredDatabaseUrl.hostname);
    if (!isLocalDatabase && process.env.ALLOW_REMOTE_INTEGRATION_DB !== "true") {
        throw new Error("Refusing to create a temporary database on a remote host without ALLOW_REMOTE_INTEGRATION_DB=true.");
    }

    const databaseName = `pos_etims_allocator_test_${randomUUID().replace(/-/g, "")}`;
    const testDatabaseUrl = new URL(configuredDatabaseUrl);
    testDatabaseUrl.pathname = `/${databaseName}`;
    const admin = new Client({ connectionString: configuredDatabaseUrl.toString() });
    let databaseCreated = false;
    let exitCode = 1;

    try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;

        const result = spawnSync(
            process.execPath,
            [
                "--require",
                "ts-node/register",
                "--test",
                "src/tests/etims-invoice-allocation.integration.test.ts",
            ],
            {
                cwd: process.cwd(),
                stdio: "inherit",
                env: {
                    ...process.env,
                    DATABASE_URL: testDatabaseUrl.toString(),
                    TEST_DATABASE_URL: testDatabaseUrl.toString(),
                    TYPEORM_SYNCHRONIZE: "true",
                    NODE_ENV: "test",
                },
            },
        );
        if (result.error) throw result.error;
        exitCode = result.status ?? 1;
    } finally {
        if (databaseCreated) {
            try {
                await admin.query(`DROP DATABASE "${databaseName}"`);
            } catch (error) {
                console.error("Could not drop temporary eTIMS integration database:", error.message);
                exitCode = 1;
            }
        }
        await admin.end().catch(() => {});
    }

    process.exitCode = exitCode;
};

run().catch((error) => {
    console.error("eTIMS allocator integration run failed:", error.message);
    process.exitCode = 1;
});
