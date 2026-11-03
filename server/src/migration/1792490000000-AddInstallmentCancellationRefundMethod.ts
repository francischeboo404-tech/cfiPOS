import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInstallmentCancellationRefundMethod1792490000000 implements MigrationInterface {
    name = "AddInstallmentCancellationRefundMethod1792490000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "installment_cancellation_events"
            ADD COLUMN "refund_method" varchar(20)
            CHECK ("refund_method" IS NULL OR "refund_method" IN ('CASH', 'MPESA', 'BANK_TRANSFER'))
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "installment_cancellation_events"
            DROP COLUMN "refund_method"
        `);
    }
}
