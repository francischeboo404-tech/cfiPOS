import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPaidVoucherRenewalCheckout1792328000000 implements MigrationInterface {
    name = "AddPaidVoucherRenewalCheckout1792328000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "payment_checkout_sessions"
            ADD COLUMN IF NOT EXISTS "purpose" varchar(32) NOT NULL DEFAULT 'sale',
            ADD COLUMN IF NOT EXISTS "renewal_voucher_id" uuid NULL,
            ADD CONSTRAINT "CHK_payment_checkout_sessions_purpose"
                CHECK ("purpose" IN ('sale', 'voucher_renewal')),
            ADD CONSTRAINT "CHK_payment_checkout_sessions_renewal_voucher"
                CHECK (
                    ("purpose" = 'sale' AND "renewal_voucher_id" IS NULL) OR
                    ("purpose" = 'voucher_renewal' AND "renewal_voucher_id" IS NOT NULL)
                ),
            ADD CONSTRAINT "FK_payment_checkout_sessions_renewal_voucher"
                FOREIGN KEY ("renewal_voucher_id")
                REFERENCES "customer_vouchers"("id") ON DELETE RESTRICT
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_active_voucher_renewal_checkout"
            ON "payment_checkout_sessions" ("renewal_voucher_id")
            WHERE "purpose" = 'voucher_renewal' AND "status" = 'reserved'
        `);
        await queryRunner.query(`
            ALTER TABLE "voucher_renewals"
            ADD COLUMN IF NOT EXISTS "checkout_session_id" uuid NULL,
            ADD COLUMN IF NOT EXISTS "cash_paid_cents" bigint NULL,
            ADD COLUMN IF NOT EXISTS "mpesa_paid_cents" bigint NULL,
            ADD COLUMN IF NOT EXISTS "payment_reference" text NULL,
            ADD CONSTRAINT "FK_voucher_renewals_checkout_session"
                FOREIGN KEY ("checkout_session_id")
                REFERENCES "payment_checkout_sessions"("id") ON DELETE RESTRICT
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_voucher_renewals_checkout_session"
            ON "voucher_renewals" ("checkout_session_id")
            WHERE "checkout_session_id" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_voucher_renewals_checkout_session"`);
        await queryRunner.query(`ALTER TABLE "voucher_renewals" DROP CONSTRAINT IF EXISTS "FK_voucher_renewals_checkout_session"`);
        await queryRunner.query(`
            ALTER TABLE "voucher_renewals"
            DROP COLUMN IF EXISTS "payment_reference",
            DROP COLUMN IF EXISTS "mpesa_paid_cents",
            DROP COLUMN IF EXISTS "cash_paid_cents",
            DROP COLUMN IF EXISTS "checkout_session_id"
        `);
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_active_voucher_renewal_checkout"`);
        await queryRunner.query(`ALTER TABLE "payment_checkout_sessions" DROP CONSTRAINT IF EXISTS "FK_payment_checkout_sessions_renewal_voucher"`);
        await queryRunner.query(`ALTER TABLE "payment_checkout_sessions" DROP CONSTRAINT IF EXISTS "CHK_payment_checkout_sessions_renewal_voucher"`);
        await queryRunner.query(`ALTER TABLE "payment_checkout_sessions" DROP CONSTRAINT IF EXISTS "CHK_payment_checkout_sessions_purpose"`);
        await queryRunner.query(`
            ALTER TABLE "payment_checkout_sessions"
            DROP COLUMN IF EXISTS "renewal_voucher_id",
            DROP COLUMN IF EXISTS "purpose"
        `);
    }
}
