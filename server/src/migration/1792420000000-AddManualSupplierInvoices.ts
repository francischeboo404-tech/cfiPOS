import { MigrationInterface, QueryRunner } from "typeorm";

export class AddManualSupplierInvoices1792420000000 implements MigrationInterface {
    name = "AddManualSupplierInvoices1792420000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "supplier_invoices" ALTER COLUMN "po_id" DROP NOT NULL`);
        await queryRunner.query(`
            ALTER TABLE "supplier_invoices"
            ADD COLUMN IF NOT EXISTS "manual_reviewed_at" timestamptz
        `);
        await queryRunner.query(`
            ALTER TABLE "supplier_invoices"
            ADD COLUMN IF NOT EXISTS "manual_reviewed_by" uuid
        `);
        await queryRunner.query(`
            ALTER TABLE "vendors"
            ADD COLUMN IF NOT EXISTS "needs_review" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TABLE "vendors"
            ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz
        `);
        await queryRunner.query(`
            ALTER TABLE "vendors"
            ADD COLUMN IF NOT EXISTS "reviewed_by" uuid
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const manualInvoiceCount = await queryRunner.query(`
            SELECT count(*)::integer AS count
            FROM "supplier_invoices"
            WHERE "po_id" IS NULL
        `);
        if (manualInvoiceCount[0].count > 0) {
            throw new Error("Cannot revert manual supplier invoice support while unlinked invoices exist.");
        }

        await queryRunner.query(`ALTER TABLE "supplier_invoices" ALTER COLUMN "po_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP COLUMN IF EXISTS "manual_reviewed_by"`);
        await queryRunner.query(`ALTER TABLE "supplier_invoices" DROP COLUMN IF EXISTS "manual_reviewed_at"`);
        await queryRunner.query(`ALTER TABLE "vendors" DROP COLUMN IF EXISTS "reviewed_by"`);
        await queryRunner.query(`ALTER TABLE "vendors" DROP COLUMN IF EXISTS "reviewed_at"`);
        await queryRunner.query(`ALTER TABLE "vendors" DROP COLUMN IF EXISTS "needs_review"`);
    }
}
