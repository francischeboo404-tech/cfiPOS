import "reflect-metadata";
import { DataSource } from "typeorm";
import { AppDataSource } from "./data-source";

const confirmationRequired = "CREATE_SCHEMA_IN_EMPTY_DATABASE";
const confirmation = process.env.POS_DB_BOOTSTRAP_CONFIRM;
const databaseUrl = process.env.DATABASE_URL;
const migrationManagedEntityTables = new Set([
    "installment_plans",
    "installment_agreements",
    "installment_agreement_items",
    "installment_schedules",
    "installment_payments",
    "installment_payment_allocations",
    "installment_payment_reversals",
    "installment_reversal_allocations",
    "installment_stock_events",
    "installment_handover_events",
    "installment_cancellation_events",
    "installment_write_off_events",
    "installment_audit_events",
    "loyalty_enrolments",
]);

const getDatabaseName = (connectionString: string): string => {
    try {
        return decodeURIComponent(new URL(connectionString).pathname.replace(/^\/+/, ""));
    } catch {
        throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
};

const bootstrapDatabase = async (): Promise<void> => {
    if (confirmation !== confirmationRequired) {
        throw new Error(
            `Set POS_DB_BOOTSTRAP_CONFIRM=${confirmationRequired} only after confirming DATABASE_URL targets a new, empty POS database.`,
        );
    }
    if (!databaseUrl) {
        throw new Error("DATABASE_URL is required to provision the POS schema.");
    }

    const databaseName = getDatabaseName(databaseUrl);
    if (!databaseName || ["postgres", "template0", "template1"].includes(databaseName)) {
        throw new Error("Refusing to bootstrap a PostgreSQL maintenance or template database.");
    }

    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    let lockAcquired = false;

    try {
        await queryRunner.connect();
        const [{ acquired }] = await queryRunner.query(
            "SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext('cfi-pos-schema-bootstrap')) AS acquired",
        );
        if (!acquired) {
            throw new Error("Another POS schema bootstrap is already running for this database.");
        }
        lockAcquired = true;

        const existingRelations: Array<{ relation_name: string }> = await queryRunner.query(`
            SELECT c.relname AS relation_name
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND c.relname <> 'migrations'
            ORDER BY c.relname
        `);
        if (existingRelations.length > 0) {
            const names = existingRelations.slice(0, 10).map(({ relation_name }) => relation_name);
            throw new Error(
                `Refusing to bootstrap a non-empty public schema. Existing relations: ${names.join(", ")}${existingRelations.length > names.length ? ", ..." : ""}`,
            );
        }

        const migrationsTableExists = await queryRunner.hasTable("migrations");
        if (migrationsTableExists) {
            const [{ count }] = await queryRunner.query(`SELECT count(*)::integer AS count FROM "migrations"`);
            if (count > 0) {
                throw new Error("Refusing to bootstrap a database that already has recorded TypeORM migrations.");
            }
        }

        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

        console.info(`Creating the current TypeORM entity baseline in empty database "${databaseName}".`);
        const baselineEntities = AppDataSource.entityMetadatas
            .filter(({ tableName }) => !migrationManagedEntityTables.has(tableName))
            .map(({ target }) => target);
        const baselineDataSource = new DataSource({
            ...AppDataSource.options,
            entities: baselineEntities,
            migrations: [],
            synchronize: false,
        });
        await baselineDataSource.initialize();
        try {
            await baselineDataSource.synchronize(false);
        } finally {
            await baselineDataSource.destroy();
        }
        const appliedMigrations = await AppDataSource.runMigrations({ transaction: "all" });
        console.info(`Applied ${appliedMigrations.length} TypeORM migrations.`);
        console.info("POS database schema bootstrap completed.");
    } catch (error) {
        console.error(
            "POS database bootstrap failed. Do not start the API against this database; inspect the error and finish/recreate the empty database before retrying.",
        );
        throw error;
    } finally {
        if (lockAcquired) {
            await queryRunner.query(
                "SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('cfi-pos-schema-bootstrap'))",
            );
        }
        await queryRunner.release();
        await AppDataSource.destroy();
    }
};

bootstrapDatabase().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
