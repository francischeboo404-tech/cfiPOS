import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateInstallmentSales1792430000000 implements MigrationInterface {
    name = "CreateInstallmentSales1792430000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const duplicatePhones = await queryRunner.query(`
            SELECT "phone", count(*)::integer AS count
            FROM "customers"
            GROUP BY "phone"
            HAVING count(*) > 1
            LIMIT 1
        `);
        if (duplicatePhones.length > 0) {
            throw new Error("Cannot enforce unique customer phones until existing duplicate phone numbers are resolved.");
        }

        await queryRunner.query(`
            ALTER TABLE "customers"
            ADD COLUMN IF NOT EXISTS "national_id" varchar(64),
            ADD COLUMN IF NOT EXISTS "alternative_phone" varchar(32),
            ADD COLUMN IF NOT EXISTS "address" text
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_customers_phone_installment"
            ON "customers" ("phone")
        `);
        await queryRunner.query(`
            CREATE SEQUENCE IF NOT EXISTS "installment_agreement_number_seq"
            START WITH 1 INCREMENT BY 1 NO CYCLE
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_plans" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "name" varchar(100) NOT NULL UNIQUE,
                "active" boolean NOT NULL DEFAULT true,
                "number_of_installments" integer NOT NULL CHECK ("number_of_installments" BETWEEN 1 AND 120),
                "frequency" varchar(20) NOT NULL CHECK ("frequency" IN ('WEEKLY', 'EVERY_2_WEEKS', 'MONTHLY')),
                "min_deposit_percent_bps" integer NOT NULL CHECK ("min_deposit_percent_bps" BETWEEN 0 AND 10000),
                "interest_type" varchar(20) NOT NULL CHECK ("interest_type" IN ('FLAT_TOTAL', 'FLAT_PER_MONTH')),
                "interest_rate_bps" integer NOT NULL CHECK ("interest_rate_bps" BETWEEN 0 AND 100000),
                "release_mode" varchar(30) NOT NULL CHECK ("release_mode" IN ('HOLD_UNTIL_PAID', 'RELEASE_AFTER_DEPOSIT')),
                "min_financed_cents" bigint CHECK ("min_financed_cents" IS NULL OR "min_financed_cents" >= 0),
                "max_financed_cents" bigint CHECK ("max_financed_cents" IS NULL OR "max_financed_cents" >= 0),
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "updated_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "CHK_installment_plan_financed_range"
                    CHECK ("min_financed_cents" IS NULL OR "max_financed_cents" IS NULL OR "min_financed_cents" <= "max_financed_cents")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_agreements" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "agreement_number" varchar(20) NOT NULL UNIQUE,
                "idempotency_key" uuid NOT NULL UNIQUE,
                "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
                "plan_id" uuid REFERENCES "installment_plans"("id") ON DELETE RESTRICT,
                "terms_snapshot" jsonb NOT NULL,
                "customer_name_snapshot" varchar(100) NOT NULL,
                "customer_phone_snapshot" varchar(32) NOT NULL,
                "customer_national_id_snapshot" varchar(64) NOT NULL,
                "warehouse_id" uuid REFERENCES "warehouses"("id") ON DELETE RESTRICT,
                "agreement_date" date NOT NULL,
                "price_total_cents" bigint NOT NULL CHECK ("price_total_cents" > 0),
                "deposit_cents" bigint NOT NULL CHECK ("deposit_cents" >= 0),
                "financed_cents" bigint NOT NULL CHECK ("financed_cents" >= 0),
                "interest_cents" bigint NOT NULL CHECK ("interest_cents" >= 0),
                "total_payable_cents" bigint NOT NULL CHECK ("total_payable_cents" >= 0),
                "release_mode" varchar(30) NOT NULL CHECK ("release_mode" IN ('HOLD_UNTIL_PAID', 'RELEASE_AFTER_DEPOSIT')),
                "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "CHK_installment_agreement_amounts"
                    CHECK ("price_total_cents" = "deposit_cents" + "financed_cents"
                        AND "total_payable_cents" = "price_total_cents" + "interest_cents")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_installment_agreements_customer" ON "installment_agreements" ("customer_id", "created_at" DESC)
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_agreement_items" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "agreement_id" uuid NOT NULL REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
                "product_name_snapshot" varchar(200) NOT NULL,
                "sku_snapshot" varchar(100) NOT NULL,
                "unit_of_measure_snapshot" varchar(64) NOT NULL,
                "quantity" integer NOT NULL CHECK ("quantity" > 0),
                "unit_price_cents" bigint NOT NULL CHECK ("unit_price_cents" >= 0),
                "line_total_cents" bigint NOT NULL CHECK ("line_total_cents" >= 0),
                "tax_rate_bps" integer NOT NULL CHECK ("tax_rate_bps" BETWEEN 0 AND 99999),
                "price_snapshot" jsonb NOT NULL,
                CONSTRAINT "CHK_installment_item_total" CHECK ("line_total_cents" = "unit_price_cents" * "quantity")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_schedules" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "agreement_id" uuid NOT NULL REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "installment_number" integer NOT NULL CHECK ("installment_number" BETWEEN 1 AND 120),
                "due_date" date NOT NULL,
                "principal_cents" bigint NOT NULL CHECK ("principal_cents" >= 0),
                "interest_cents" bigint NOT NULL CHECK ("interest_cents" >= 0),
                CONSTRAINT "UQ_installment_schedules_number" UNIQUE ("agreement_id", "installment_number")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_installment_schedules_due_date" ON "installment_schedules" ("due_date")
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_payments" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "agreement_id" uuid NOT NULL REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "payment_date" date NOT NULL,
                "amount_cents" bigint NOT NULL CHECK ("amount_cents" > 0),
                "payment_method" varchar(20) NOT NULL CHECK ("payment_method" IN ('CASH', 'MPESA', 'BANK_TRANSFER', 'OTHER')),
                "reference_number" varchar(100),
                "recorded_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
                "idempotency_key" uuid NOT NULL UNIQUE,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_installment_payment_reference"
            ON "installment_payments" ("payment_method", lower("reference_number"))
            WHERE "reference_number" IS NOT NULL AND btrim("reference_number") <> ''
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_installment_payments_agreement_date"
            ON "installment_payments" ("agreement_id", "payment_date", "created_at")
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_payment_allocations" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "payment_id" uuid NOT NULL REFERENCES "installment_payments"("id") ON DELETE RESTRICT,
                "agreement_id" uuid NOT NULL REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "installment_number" integer NOT NULL CHECK ("installment_number" BETWEEN 0 AND 120),
                "principal_cents" bigint NOT NULL CHECK ("principal_cents" >= 0),
                "interest_cents" bigint NOT NULL CHECK ("interest_cents" >= 0),
                CONSTRAINT "CHK_installment_allocation_nonzero"
                    CHECK ("principal_cents" + "interest_cents" > 0)
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_payment_reversals" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "payment_id" uuid NOT NULL UNIQUE REFERENCES "installment_payments"("id") ON DELETE RESTRICT,
                "agreement_id" uuid NOT NULL REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "amount_cents" bigint NOT NULL CHECK ("amount_cents" > 0),
                "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
                "reversed_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_reversal_allocations" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "reversal_id" uuid NOT NULL REFERENCES "installment_payment_reversals"("id") ON DELETE RESTRICT,
                "payment_allocation_id" uuid NOT NULL REFERENCES "installment_payment_allocations"("id") ON DELETE RESTRICT,
                "installment_number" integer NOT NULL CHECK ("installment_number" BETWEEN 0 AND 120),
                "principal_cents" bigint NOT NULL CHECK ("principal_cents" >= 0),
                "interest_cents" bigint NOT NULL CHECK ("interest_cents" >= 0),
                CONSTRAINT "CHK_installment_reversal_allocation_nonzero"
                    CHECK ("principal_cents" + "interest_cents" > 0),
                CONSTRAINT "UQ_installment_reversal_allocation"
                    UNIQUE ("reversal_id", "payment_allocation_id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_stock_events" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "agreement_id" uuid NOT NULL REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "agreement_item_id" uuid NOT NULL REFERENCES "installment_agreement_items"("id") ON DELETE RESTRICT,
                "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
                "warehouse_id" uuid REFERENCES "warehouses"("id") ON DELETE RESTRICT,
                "quantity_delta" integer NOT NULL CHECK ("quantity_delta" <> 0),
                "event_type" varchar(20) NOT NULL CHECK ("event_type" IN ('RESERVE', 'RELEASE', 'CONSUME')),
                "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
                "reason" text,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT "CHK_installment_stock_event_sign" CHECK (
                    ("event_type" = 'RESERVE' AND "quantity_delta" > 0)
                    OR ("event_type" IN ('RELEASE', 'CONSUME') AND "quantity_delta" < 0)
                )
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_installment_stock_reservations"
            ON "installment_stock_events" ("product_id", "warehouse_id", "created_at")
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_handover_events" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "agreement_id" uuid NOT NULL UNIQUE REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "sale_id" uuid NOT NULL UNIQUE REFERENCES "sales"("id") ON DELETE RESTRICT,
                "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_cancellation_events" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "agreement_id" uuid NOT NULL UNIQUE REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "fee_cents" bigint NOT NULL CHECK ("fee_cents" >= 0),
                "refund_cents" bigint NOT NULL CHECK ("refund_cents" >= 0),
                "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
                "cancelled_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_write_off_events" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "agreement_id" uuid NOT NULL REFERENCES "installment_agreements"("id") ON DELETE RESTRICT,
                "amount_cents" bigint NOT NULL CHECK ("amount_cents" > 0),
                "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
                "written_off_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "installment_audit_events" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "subject_type" varchar(30) NOT NULL,
                "subject_id" uuid NOT NULL,
                "action" varchar(40) NOT NULL,
                "before_state" jsonb,
                "after_state" jsonb NOT NULL,
                "reason" text,
                "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_installment_audit_subject"
            ON "installment_audit_events" ("subject_type", "subject_id", "created_at")
        `);
        await queryRunner.query(`
            CREATE TABLE "loyalty_enrolments" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "customer_id" uuid NOT NULL UNIQUE REFERENCES "customers"("id") ON DELETE RESTRICT,
                "voucher_id" uuid NOT NULL UNIQUE REFERENCES "customer_vouchers"("id") ON DELETE RESTRICT,
                "enrolled_at" timestamptz NOT NULL DEFAULT now(),
                "enrolled_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
                "source" varchar(30) NOT NULL CHECK ("source" IN ('customers_screen', 'pos', 'installment_agreement', 'import'))
            )
        `);
        await queryRunner.query(`
            INSERT INTO "loyalty_enrolments" ("customer_id", "voucher_id", "enrolled_at", "source")
            SELECT "customer_id", "id", "created_at", 'import'
            FROM "customer_vouchers"
            ON CONFLICT ("customer_id") DO NOTHING
        `);

        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_installment_record_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Installment and loyalty enrolment records are append-only';
            END;
            $$ LANGUAGE plpgsql
        `);
        for (const table of [
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
        ]) {
            await queryRunner.query(`
                CREATE TRIGGER "TRG_${table}_append_only"
                BEFORE UPDATE OR DELETE ON "${table}"
                FOR EACH ROW EXECUTE FUNCTION prevent_installment_record_mutation()
            `);
        }

        await queryRunner.query(`
            INSERT INTO "settings" ("key", "value") VALUES
                ('installments_enabled', 'false'),
                ('installment_max_open_credit_cents', '0'),
                ('installment_cancellation_fee_percent_bps', '0'),
                ('installment_charge_vat_on_interest', 'false'),
                ('installment_retention_years', '7')
            ON CONFLICT ("key") DO NOTHING
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const populatedData = await queryRunner.query(`
            SELECT (
                (SELECT count(*) FROM "installment_plans") +
                (SELECT count(*) FROM "installment_agreements") +
                (SELECT count(*) FROM "installment_payments") +
                (SELECT count(*) FROM "installment_audit_events") +
                (SELECT count(*) FROM "loyalty_enrolments" WHERE "source" <> 'import')
            )::bigint AS count
        `);
        if (BigInt(populatedData[0].count) > 0n) {
            throw new Error("Cannot revert installment sales while plans, installment records, audit events, or new enrolments exist.");
        }
        const populatedCustomerFields = await queryRunner.query(`
            SELECT count(*)::bigint AS count
            FROM "customers"
            WHERE "national_id" IS NOT NULL OR "alternative_phone" IS NOT NULL OR "address" IS NOT NULL
        `);
        if (BigInt(populatedCustomerFields[0].count) > 0n) {
            throw new Error("Cannot remove installment customer fields while they contain data.");
        }

        for (const table of [
            "installment_audit_events",
            "installment_write_off_events",
            "installment_cancellation_events",
            "installment_handover_events",
            "installment_stock_events",
            "installment_reversal_allocations",
            "installment_payment_reversals",
            "installment_payment_allocations",
            "installment_payments",
            "installment_schedules",
            "installment_agreement_items",
            "installment_agreements",
            "installment_plans",
            "loyalty_enrolments",
        ]) {
            await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
        }
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_installment_record_mutation()`);
        await queryRunner.query(`DROP SEQUENCE IF EXISTS "installment_agreement_number_seq"`);
        await queryRunner.query(`
            DELETE FROM "settings"
            WHERE ("key", "value") IN (
                ('installments_enabled', 'false'),
                ('installment_max_open_credit_cents', '0'),
                ('installment_cancellation_fee_percent_bps', '0'),
                ('installment_charge_vat_on_interest', 'false'),
                ('installment_retention_years', '7')
            )
        `);
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_customers_phone_installment"`);
        await queryRunner.query(`
            ALTER TABLE "customers"
            DROP COLUMN IF EXISTS "national_id",
            DROP COLUMN IF EXISTS "alternative_phone",
            DROP COLUMN IF EXISTS "address"
        `);
    }
}
