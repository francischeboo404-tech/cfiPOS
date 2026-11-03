import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSupplierPaymentIdempotency1792410000000 implements MigrationInterface {
    name = "AddSupplierPaymentIdempotency1792410000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "supplier_payments"
            ADD COLUMN IF NOT EXISTS "idempotency_key" uuid
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_supplier_payments_idempotency_key"
            ON "supplier_payments" ("idempotency_key")
            WHERE "idempotency_key" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_supplier_payments_idempotency_key"`);
        await queryRunner.query(`
            ALTER TABLE "supplier_payments"
            DROP COLUMN IF EXISTS "idempotency_key"
        `);
    }
}
