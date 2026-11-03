import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInstallmentRefundReference1792500000000 implements MigrationInterface {
    name = "AddInstallmentRefundReference1792500000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "installment_cancellation_events"
            ADD COLUMN "refund_reference_number" varchar(100)
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_installment_refund_reference"
            ON "installment_cancellation_events" ("refund_method", lower("refund_reference_number"))
            WHERE "refund_reference_number" IS NOT NULL
              AND btrim("refund_reference_number") <> ''
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "UQ_installment_refund_reference"
        `);
        await queryRunner.query(`
            ALTER TABLE "installment_cancellation_events"
            DROP COLUMN "refund_reference_number"
        `);
    }
}
