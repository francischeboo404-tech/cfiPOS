import { MigrationInterface, QueryRunner } from "typeorm";

export class EnforceCostingVoucherAppendOnly1792270000000 implements MigrationInterface {
    name = "EnforceCostingVoucherAppendOnly1792270000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "return_items"
            ADD COLUMN IF NOT EXISTS "net_revenue_cents" bigint,
            ADD COLUMN IF NOT EXISTS "vat_cents" bigint,
            ADD COLUMN IF NOT EXISTS "cogs_total_cents" bigint
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_costing_audit_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Costing and voucher audit records cannot be updated or deleted';
            END;
            $$ LANGUAGE plpgsql
        `);
        for (const table of ["purchases", "stock_movements", "voucher_renewals", "voucher_card_print_logs"]) {
            const trigger = `TRG_${table}_append_only`;
            await queryRunner.query(`DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`);
            await queryRunner.query(`
                CREATE TRIGGER "${trigger}"
                BEFORE UPDATE OR DELETE ON "${table}"
                FOR EACH ROW EXECUTE FUNCTION prevent_costing_audit_mutation()
            `);
        }

        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_voucher_identity_mutation() RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'Voucher numbers cannot be reused; vouchers cannot be deleted';
                END IF;
                IF NEW."voucher_number" <> OLD."voucher_number" OR
                   NEW."customer_id" <> OLD."customer_id" OR
                   NEW."issue_date" <> OLD."issue_date" THEN
                    RAISE EXCEPTION 'Voucher identity is immutable';
                END IF;
                IF NEW."expiry_date" IS DISTINCT FROM OLD."expiry_date" AND NOT EXISTS (
                    SELECT 1
                    FROM "voucher_renewals" renewal
                    WHERE renewal."voucher_id" = OLD."id"
                        AND renewal."previous_expiry_date" = OLD."expiry_date"
                        AND renewal."new_expiry_date" = NEW."expiry_date"
                ) THEN
                    RAISE EXCEPTION 'Voucher expiry changes require a renewal record';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_voucher_identity_immutable" ON "customer_vouchers"`);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_voucher_identity_immutable"
            BEFORE UPDATE OR DELETE ON "customer_vouchers"
            FOR EACH ROW EXECUTE FUNCTION prevent_voucher_identity_mutation()
        `);

        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_final_sale_item_mutation() RETURNS trigger AS $$
            DECLARE
                parent_status text;
            BEGIN
                SELECT "status" INTO parent_status
                FROM "sales"
                WHERE "id" = OLD."sale_id";
                IF parent_status IS NULL AND TG_OP = 'DELETE' THEN
                    RETURN OLD;
                END IF;
                IF parent_status IS DISTINCT FROM 'parked' THEN
                    RAISE EXCEPTION 'Finalized sale lines and their cost snapshots are immutable';
                END IF;
                IF TG_OP = 'DELETE' THEN
                    RETURN OLD;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_final_sale_items_immutable" ON "sale_items"`);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_final_sale_items_immutable"
            BEFORE UPDATE OR DELETE ON "sale_items"
            FOR EACH ROW EXECUTE FUNCTION prevent_final_sale_item_mutation()
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_final_sale_deletion() RETURNS trigger AS $$
            BEGIN
                IF OLD."status" <> 'parked' THEN
                    RAISE EXCEPTION 'Finalized sales and their audit history are immutable';
                END IF;
                RETURN OLD;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_final_sales_immutable" ON "sales"`);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_final_sales_immutable"
            BEFORE DELETE ON "sales"
            FOR EACH ROW EXECUTE FUNCTION prevent_final_sale_deletion()
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_approved_return_item_mutation() RETURNS trigger AS $$
            DECLARE
                request_status text;
            BEGIN
                SELECT "status"::text INTO request_status
                FROM "return_requests"
                WHERE "id" = OLD."return_request_id";
                IF request_status = 'approved' THEN
                    RAISE EXCEPTION 'Approved return history is immutable';
                END IF;
                IF TG_OP = 'DELETE' THEN
                    RETURN OLD;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_approved_return_items_immutable" ON "return_items"`);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_approved_return_items_immutable"
            BEFORE UPDATE OR DELETE ON "return_items"
            FOR EACH ROW EXECUTE FUNCTION prevent_approved_return_item_mutation()
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_approved_return_items_immutable" ON "return_items"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_approved_return_item_mutation()`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_final_sales_immutable" ON "sales"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_final_sale_deletion()`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_final_sale_items_immutable" ON "sale_items"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_final_sale_item_mutation()`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_voucher_identity_immutable" ON "customer_vouchers"`);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_voucher_identity_mutation() RETURNS trigger AS $$
            BEGIN
                IF NEW."voucher_number" <> OLD."voucher_number" OR
                   NEW."customer_id" <> OLD."customer_id" OR
                   NEW."issue_date" <> OLD."issue_date" THEN
                    RAISE EXCEPTION 'Voucher identity is immutable';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_voucher_identity_immutable"
            BEFORE UPDATE ON "customer_vouchers"
            FOR EACH ROW EXECUTE FUNCTION prevent_voucher_identity_mutation()
        `);
        for (const table of ["purchases", "stock_movements", "voucher_renewals", "voucher_card_print_logs"]) {
            await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_${table}_append_only" ON "${table}"`);
        }
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_costing_audit_mutation()`);
        await queryRunner.query(`ALTER TABLE "return_items" DROP COLUMN IF EXISTS "cogs_total_cents", DROP COLUMN IF EXISTS "vat_cents", DROP COLUMN IF EXISTS "net_revenue_cents"`);
    }
}
