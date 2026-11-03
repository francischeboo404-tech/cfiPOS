require("dotenv").config();

const { Client } = require("pg");
const { spawnSync } = require("child_process");
const { randomBytes, randomUUID } = require("crypto");
const assert = require("node:assert/strict");
const { existsSync, readFileSync, readdirSync } = require("fs");
const path = require("path");

const rootEnvironmentPath = path.resolve(process.cwd(), "../.env");
if (existsSync(rootEnvironmentPath)) {
    const rootEnvironment = require("dotenv").parse(readFileSync(rootEnvironmentPath));
    if (!process.env.ENCRYPTION_KEY && rootEnvironment.ENCRYPTION_KEY) {
        process.env.ENCRYPTION_KEY = rootEnvironment.ENCRYPTION_KEY;
    }
}

const run = async () => {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required to create an isolated integration database.");
    }
    if (!process.env.ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY)) {
        throw new Error("ENCRYPTION_KEY must be configured as 64 hexadecimal characters before integration tests run.");
    }

    const configuredDatabaseUrl = new URL(process.env.DATABASE_URL);
    const isLocalDatabase = ["localhost", "127.0.0.1", "::1"].includes(configuredDatabaseUrl.hostname);
    if (!isLocalDatabase && process.env.ALLOW_REMOTE_INTEGRATION_DB !== "true") {
        throw new Error("Refusing to create a temporary database on a remote host without ALLOW_REMOTE_INTEGRATION_DB=true.");
    }

    const databaseName = `pos_integration_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const admin = new Client({ connectionString: process.env.DATABASE_URL });
    let databaseCreated = false;
    let exitCode = 1;

    try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;

        const testDatabaseUrl = new URL(configuredDatabaseUrl);
        testDatabaseUrl.pathname = `/${databaseName}`;
        const legacyKey = randomBytes(16).toString("hex");

        const migrationClient = new Client({
            connectionString: testDatabaseUrl.toString(),
            options: `-c app.encryption_key=${process.env.ENCRYPTION_KEY} -c app.legacy_encryption_key=${legacyKey}`,
        });
        try {
            await migrationClient.connect();
            await migrationClient.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
            await migrationClient.query("CREATE TABLE public.customers (phone TEXT, phone_encrypted TEXT)");
            await migrationClient.query("CREATE TABLE public.mpesa_transactions (phone_number TEXT, phone_encrypted TEXT)");
            await migrationClient.query("CREATE TABLE public.audit_logs (old_values JSONB, new_values JSONB)");
            await migrationClient.query("CREATE TABLE public.offline_transaction_queue (encrypted_data TEXT)");

            const legacyCustomerPhone = "254700000001";
            const legacyMpesaPhone = "254700000002";
            const legacyAuditPhone = "254700000003";
            const legacyOfflineData = JSON.stringify({ type: "sale", marker: randomUUID() });
            const encryptLegacy = async (plaintext) => {
                const result = await migrationClient.query(
                    "SELECT encode(encrypt(convert_to($1, 'UTF8'), convert_to(rpad($2, 32, '0'), 'UTF8'), 'aes'), 'hex') AS ciphertext",
                    [plaintext, legacyKey]
                );
                return result.rows[0].ciphertext;
            };

            await migrationClient.query("INSERT INTO public.customers (phone) VALUES ($1)", [legacyCustomerPhone]);
            await migrationClient.query("INSERT INTO public.mpesa_transactions (phone_number) VALUES ($1)", [legacyMpesaPhone]);
            await migrationClient.query(
                "INSERT INTO public.audit_logs (old_values) VALUES (jsonb_build_object('phone_encrypted', $1::text))",
                [await encryptLegacy(legacyAuditPhone)]
            );
            await migrationClient.query(
                "INSERT INTO public.offline_transaction_queue (encrypted_data) VALUES ($1)",
                [await encryptLegacy(legacyOfflineData)]
            );

            const encryptionMigrationPath = path.resolve(
                __dirname,
                "../test-fixtures/require_encryption_key_setting.sql"
            );
            await migrationClient.query(readFileSync(encryptionMigrationPath, "utf8"));

            const rekeyed = await migrationClient.query(`
                SELECT
                    (SELECT public.decrypt_sensitive_data(phone_encrypted) FROM public.customers LIMIT 1) AS customer_phone,
                    (SELECT public.decrypt_sensitive_data(phone_encrypted) FROM public.mpesa_transactions LIMIT 1) AS mpesa_phone,
                    (SELECT public.decrypt_sensitive_data(old_values->>'phone_encrypted') FROM public.audit_logs LIMIT 1) AS audit_phone,
                    (SELECT public.decrypt_sensitive_data(encrypted_data) FROM public.offline_transaction_queue LIMIT 1) AS offline_data
            `);
            assert.equal(rekeyed.rows[0].customer_phone, legacyCustomerPhone);
            assert.equal(rekeyed.rows[0].mpesa_phone, legacyMpesaPhone);
            assert.equal(rekeyed.rows[0].audit_phone, legacyAuditPhone);
            assert.equal(rekeyed.rows[0].offline_data, legacyOfflineData);

            await migrationClient.query(`
                CREATE FUNCTION public.create_secure_sale(
                    p_cashier_id UUID,
                    p_payment_method TEXT,
                    p_items JSONB,
                    p_customer_id UUID DEFAULT NULL,
                    p_loyalty_discount NUMERIC DEFAULT 0,
                    p_idempotency_key TEXT DEFAULT NULL
                )
                RETURNS INTEGER
                LANGUAGE SQL
                SECURITY DEFINER
                AS $$ SELECT 1 $$;
                GRANT EXECUTE ON FUNCTION
                    public.create_secure_sale(UUID, TEXT, JSONB, UUID, NUMERIC, TEXT)
                    TO PUBLIC;
            `);

            const rpcPrivilegeMigrationPath = path.resolve(
                __dirname,
                "../test-fixtures/restrict_secure_sale_rpc.sql"
            );
            const rpcPrivilegeMigration = readFileSync(rpcPrivilegeMigrationPath, "utf8");
            await migrationClient.query(rpcPrivilegeMigration);
            await migrationClient.query(rpcPrivilegeMigration);

            const publicRpcPrivilege = await migrationClient.query(`
                SELECT EXISTS (
                    SELECT 1
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    CROSS JOIN LATERAL aclexplode(
                        COALESCE(p.proacl, acldefault('f', p.proowner))
                    ) privilege
                    WHERE n.nspname = 'public'
                      AND p.proname = 'create_secure_sale'
                      AND privilege.grantee = 0
                      AND privilege.privilege_type = 'EXECUTE'
                ) AS public_can_execute
            `);
            assert.equal(publicRpcPrivilege.rows[0].public_can_execute, false);

            const apiRolePrivileges = await migrationClient.query(`
                SELECT r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can_execute
                FROM pg_roles r
                CROSS JOIN pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
                  AND n.nspname = 'public'
                  AND p.proname = 'create_secure_sale'
            `);
            assert.equal(apiRolePrivileges.rows.some((row) => row.can_execute), false);

            await migrationClient.query(`
                DROP TABLE public.customers;
                DROP TABLE public.mpesa_transactions;
                DROP TABLE public.audit_logs;
                DROP TABLE public.offline_transaction_queue;
            `);
        } finally {
            await migrationClient.end().catch(() => {});
        }

        const bootstrapDatabaseName = `pos_bootstrap_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
        let bootstrapDatabaseCreated = false;
        try {
            await admin.query(`CREATE DATABASE "${bootstrapDatabaseName}"`);
            bootstrapDatabaseCreated = true;
            const bootstrapDatabaseUrl = new URL(configuredDatabaseUrl);
            bootstrapDatabaseUrl.pathname = `/${bootstrapDatabaseName}`;
            const bootstrapEnvironment = {
                ...process.env,
                DATABASE_URL: bootstrapDatabaseUrl.toString(),
                POS_DB_BOOTSTRAP_CONFIRM: "CREATE_SCHEMA_IN_EMPTY_DATABASE",
                TYPEORM_SYNCHRONIZE: "false",
                NODE_ENV: "test",
            };
            const bootstrapResult = spawnSync(
                process.execPath,
                ["--require", "ts-node/register", "src/bootstrap.ts"],
                { cwd: process.cwd(), stdio: "inherit", env: bootstrapEnvironment },
            );
            if (bootstrapResult.error) throw bootstrapResult.error;
            assert.equal(bootstrapResult.status, 0, "fresh database bootstrap must succeed");

            const bootstrapClient = new Client({ connectionString: bootstrapDatabaseUrl.toString() });
            try {
                await bootstrapClient.connect();
                const baseline = await bootstrapClient.query(`
                    SELECT
                        (SELECT count(*)::integer FROM public.migrations) AS migration_count,
                        EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sales'
                        ) AS has_sales,
                        EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'stock_movements'
                        ) AS has_stock_movement_ledger,
                        EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'purchases'
                        ) AS has_purchases,
                        EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'voucher_ledger'
                        ) AS has_voucher_ledger,
                        EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'inventory_period_closes'
                        ) AS has_inventory_period_closes,
                        to_regclass('public.customer_voucher_number_seq') IS NOT NULL AS has_voucher_sequence,
                        EXISTS (
                            SELECT 1 FROM pg_trigger
                            WHERE tgname = 'TRG_inventory_period_close_immutable'
                              AND NOT tgisinternal
                        ) AS has_period_close_immutability_trigger
                `);
                const migrationsDir = path.resolve(__dirname, "../src/migration");
                const expectedMigrationCount = readdirSync(migrationsDir).filter(
                    (file) => (file.endsWith(".ts") || file.endsWith(".js")) && !file.endsWith(".d.ts"),
                ).length;
                assert.equal(baseline.rows[0].migration_count, expectedMigrationCount);
                assert.equal(baseline.rows[0].has_sales, true);
                assert.equal(baseline.rows[0].has_stock_movement_ledger, true);
                assert.equal(baseline.rows[0].has_purchases, true);
                assert.equal(baseline.rows[0].has_voucher_ledger, true);
                assert.equal(baseline.rows[0].has_inventory_period_closes, true);
                assert.equal(baseline.rows[0].has_voucher_sequence, true);
                assert.equal(baseline.rows[0].has_period_close_immutability_trigger, true);
            } finally {
                await bootstrapClient.end();
            }

            const secondBootstrapResult = spawnSync(
                process.execPath,
                ["--require", "ts-node/register", "src/bootstrap.ts"],
                { cwd: process.cwd(), encoding: "utf8", env: bootstrapEnvironment },
            );
            assert.notEqual(secondBootstrapResult.status, 0, "bootstrap must reject a populated database");
            assert.match(
                secondBootstrapResult.stderr,
                /Refusing to bootstrap a non-empty public schema/,
            );
        } finally {
            if (bootstrapDatabaseCreated) {
                await admin.query(`DROP DATABASE "${bootstrapDatabaseName}"`);
            }
        }

        await admin.query(`DROP DATABASE "${databaseName}"`);
        databaseCreated = false;
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        const integrationBootstrapEnvironment = {
            ...process.env,
            DATABASE_URL: testDatabaseUrl.toString(),
            POS_DB_BOOTSTRAP_CONFIRM: "CREATE_SCHEMA_IN_EMPTY_DATABASE",
            TYPEORM_SYNCHRONIZE: "false",
            NODE_ENV: "test",
        };
        const integrationBootstrapResult = spawnSync(
            process.execPath,
            ["--require", "ts-node/register", "src/bootstrap.ts"],
            { cwd: process.cwd(), encoding: "utf8", env: integrationBootstrapEnvironment },
        );
        if (integrationBootstrapResult.error) throw integrationBootstrapResult.error;
        if (integrationBootstrapResult.status !== 0) {
            throw new Error("Could not bootstrap the isolated API integration database.");
        }
        const apiDatabaseClient = new Client({
            connectionString: testDatabaseUrl.toString(),
            options: `-c app.encryption_key=${process.env.ENCRYPTION_KEY}`,
        });
        try {
            await apiDatabaseClient.connect();
            await apiDatabaseClient.query(`
                ALTER TABLE public.customers
                ADD COLUMN IF NOT EXISTS phone_encrypted TEXT;
                ALTER TABLE public.mpesa_transactions
                ADD COLUMN IF NOT EXISTS phone_encrypted TEXT;
            `);
            const encryptionMigrationPath = path.resolve(
                __dirname,
                "../test-fixtures/require_encryption_key_setting.sql",
            );
            await apiDatabaseClient.query(readFileSync(encryptionMigrationPath, "utf8"));
        } finally {
            await apiDatabaseClient.end().catch(() => {});
        }

        const testEnvironment = {
            ...process.env,
            TEST_DATABASE_URL: testDatabaseUrl.toString(),
        };

        const apiTestArguments = ["--require", "ts-node/register", "--test"];
        const testConcurrency = process.env.POS_INTEGRATION_TEST_CONCURRENCY;
        if (testConcurrency !== undefined) {
            if (!/^[1-9]\d*$/.test(testConcurrency)) {
                throw new Error("POS_INTEGRATION_TEST_CONCURRENCY must be a positive integer.");
            }
            apiTestArguments.push("--test-concurrency", testConcurrency);
        }
        const testNamePattern = process.env.POS_INTEGRATION_TEST_NAME_PATTERN;
        if (testNamePattern) {
            apiTestArguments.push("--test-name-pattern", testNamePattern);
        }
        apiTestArguments.push(
            "src/tests/business-workflow.integration.test.ts",
            "src/tests/permission-matrix.integration.test.ts",
        );

        const apiResult = spawnSync(process.execPath, apiTestArguments, {
            cwd: process.cwd(),
            stdio: "inherit",
            env: testEnvironment,
        });
        if (apiResult.error) throw apiResult.error;
        exitCode = apiResult.status ?? 1;

        if (exitCode === 0) {
            const erpResult = spawnSync(
                process.execPath,
                ["--require", "ts-node/register", "src/tests/erp-integration.ts"],
                {
                    cwd: process.cwd(),
                    stdio: "inherit",
                    env: {
                        ...testEnvironment,
                        DATABASE_URL: testDatabaseUrl.toString(),
                        TYPEORM_SYNCHRONIZE: "true",
                    },
                }
            );
            if (erpResult.error) throw erpResult.error;
            exitCode = erpResult.status ?? 1;
        }
    } catch (error) {
        console.error("Integration test run failed:", error.message);
    } finally {
        if (databaseCreated) {
            try {
                await admin.query(`DROP DATABASE "${databaseName}"`);
            } catch (error) {
                console.error("Could not drop temporary integration database:", error.message);
                exitCode = 1;
            }
        }
        await admin.end().catch(() => {});
    }

    process.exitCode = exitCode;
};

run().catch((error) => {
    console.error("Integration test run failed:", error.message);
    process.exitCode = 1;
});