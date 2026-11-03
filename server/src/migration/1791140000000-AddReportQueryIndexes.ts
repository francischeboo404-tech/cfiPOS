import { MigrationInterface, QueryRunner } from "typeorm";

export class AddReportQueryIndexes1791140000000 implements MigrationInterface {
    name = "AddReportQueryIndexes1791140000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_sales_status_created_at"
            ON "sales" ("status", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_sale_items_sale_id"
            ON "sale_items" ("sale_id")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_credit_notes_created_at"
            ON "credit_notes" ("created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_journal_entries_reference_created_at"
            ON "journal_entries" ("reference_type", "created_at")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_journal_lines_entry_account"
            ON "journal_lines" ("journal_entry_id", "account_id")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_return_items_request_sale"
            ON "return_items" ("return_request_id", "sale_item_id")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_credit_notes_sale_created_at"
            ON "credit_notes" ("sale_id", "created_at")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_credit_notes_sale_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_return_items_request_sale"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_journal_lines_entry_account"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_journal_entries_reference_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_credit_notes_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sale_items_sale_id"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sales_status_created_at"`);
    }
}
