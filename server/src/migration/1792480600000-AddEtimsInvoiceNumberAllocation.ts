import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEtimsInvoiceNumberAllocation1792480600000 implements MigrationInterface {
    name = "AddEtimsInvoiceNumberAllocation1792480600000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sales"
            ADD COLUMN IF NOT EXISTS "etims_invoice_number" bigint
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "etims_invoice_counters" (
                "id" smallint PRIMARY KEY CHECK ("id" = 1),
                "next_invoice_number" bigint NOT NULL CHECK ("next_invoice_number" > 0)
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [{ hasAllocatedNumbers }] = await queryRunner.query(`
            SELECT EXISTS (
                SELECT 1 FROM "sales" WHERE "etims_invoice_number" IS NOT NULL
            ) AS "hasAllocatedNumbers"
        `);
        const [{ hasCounter }] = await queryRunner.query(`
            SELECT EXISTS (SELECT 1 FROM "etims_invoice_counters") AS "hasCounter"
        `);
        if (hasAllocatedNumbers || hasCounter) {
            throw new Error("Refusing to remove VSCU invoice-number allocation data.");
        }

        await queryRunner.query(`DROP TABLE IF EXISTS "etims_invoice_counters"`);
        await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN IF EXISTS "etims_invoice_number"`);
    }
}
