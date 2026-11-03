import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAccountingLedger1792480500000 implements MigrationInterface {
    name = "CreateAccountingLedger1792480500000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$
            BEGIN
                CREATE TYPE "accounts_type_enum" AS ENUM (
                    'asset', 'liability', 'equity', 'revenue', 'expense'
                );
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END;
            $$
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "accounts" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "code" varchar(255) NOT NULL,
                "name" varchar(255) NOT NULL,
                "type" "accounts_type_enum" NOT NULL,
                "is_active" boolean NOT NULL DEFAULT true,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "updated_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_accounts_code" UNIQUE ("code")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "journal_entries" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "reference_id" varchar(255) NOT NULL,
                "reference_type" varchar(255) NOT NULL,
                "description" text NULL,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "journal_lines" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "journal_entry_id" uuid NOT NULL,
                "account_id" uuid NOT NULL,
                "debit" numeric(15, 2) NOT NULL DEFAULT 0,
                "credit" numeric(15, 2) NOT NULL DEFAULT 0,
                CONSTRAINT "FK_journal_lines_journal_entry"
                    FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id"),
                CONSTRAINT "FK_journal_lines_account"
                    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_journal_entries_reference"
            ON "journal_entries" ("reference_type", "reference_id")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_journal_lines_journal_entry"
            ON "journal_lines" ("journal_entry_id")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_journal_lines_account"
            ON "journal_lines" ("account_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [{ hasAccountingData }] = await queryRunner.query(`
            SELECT EXISTS (SELECT 1 FROM "accounts")
                OR EXISTS (SELECT 1 FROM "journal_entries") AS "hasAccountingData"
        `);
        if (hasAccountingData) {
            throw new Error("Refusing to remove accounting ledger tables because they contain data.");
        }

        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_journal_lines_account"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_journal_lines_journal_entry"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_journal_entries_reference"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "journal_lines"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "journal_entries"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "accounts"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "accounts_type_enum"`);
    }
}
