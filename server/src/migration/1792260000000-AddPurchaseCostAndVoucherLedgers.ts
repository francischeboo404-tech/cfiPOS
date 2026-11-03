import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPurchaseCostAndVoucherLedgers1792260000000 implements MigrationInterface {
    name = "AddPurchaseCostAndVoucherLedgers1792260000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "value_change_cents" bigint`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_stock_movements_location_created"
            ON "stock_movements" ("location_id", "created_at")
        `);
        await queryRunner.query(`
            ALTER TABLE "warehouse_stocks"
            ADD COLUMN IF NOT EXISTS "stock_value_cents" bigint
        `);
        await queryRunner.query(`
            UPDATE "warehouse_stocks" ws
            SET "stock_value_cents" = ROUND(ws."stock_on_hand" * p."unit_cost" * 100)::bigint
            FROM "products" p
            WHERE ws."product_id" = p."id" AND ws."stock_value_cents" IS NULL
        `);
        await queryRunner.query(`
            CREATE TABLE "inventory_costing_baselines" (
                "id" smallint PRIMARY KEY CHECK ("id" = 1),
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "created_by" uuid NOT NULL REFERENCES "users"("id"),
                "valuation_method" varchar(64) NOT NULL
            )
        `);
        await queryRunner.query(`
            INSERT INTO "inventory_costing_baselines" ("id", "created_by", "valuation_method")
            SELECT 1, "id", 'legacy_product_unit_cost_snapshot'
            FROM "users" ORDER BY "created_at", "id" LIMIT 1
        `);
        await queryRunner.query(`
            INSERT INTO "stock_movements" (
                "product_id", "movement_type", "quantity", "quantity_before", "quantity_after",
                "unit_cost", "value_change_cents", "reference_type", "location_id", "notes",
                "created_by", "created_at"
            )
            SELECT ws."product_id", 'costing_opening_balance', ws."stock_on_hand", 0,
                ws."stock_on_hand", p."unit_cost", ws."stock_value_cents",
                'costing_opening_balance', ws."warehouse_id",
                'Opening valued-stock snapshot created by costing migration',
                actor."id", now()
            FROM "warehouse_stocks" ws
            JOIN "products" p ON p."id" = ws."product_id"
            CROSS JOIN (SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1) actor
            WHERE ws."stock_on_hand" > 0 AND ws."stock_value_cents" IS NOT NULL
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_warehouse_stock_product_warehouse" ON "warehouse_stocks" ("product_id", "warehouse_id")`);
        await queryRunner.query(`
            ALTER TABLE "sale_items"
            ADD COLUMN IF NOT EXISTS "net_revenue_cents" bigint,
            ADD COLUMN IF NOT EXISTS "vat_cents" bigint,
            ADD COLUMN IF NOT EXISTS "unit_cost_cents" bigint,
            ADD COLUMN IF NOT EXISTS "cogs_total_cents" bigint,
            ADD COLUMN IF NOT EXISTS "unit_cost_basis_cents" bigint,
            ADD COLUMN IF NOT EXISTS "unit_cost_basis_quantity" bigint,
            ADD COLUMN IF NOT EXISTS "line_total_cents" bigint,
            ADD COLUMN IF NOT EXISTS "discount_cents" bigint
        `);
        await queryRunner.query(`
            UPDATE "sale_items"
            SET "unit_cost_cents" = ROUND("unit_cost" * 100)::bigint,
                "cogs_total_cents" = ROUND("cogs_total" * 100)::bigint
            WHERE "unit_cost" IS NOT NULL AND "cogs_total" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "purchases" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "vendor_id" uuid NULL REFERENCES "vendors"("id"),
                "warehouse_id" uuid NOT NULL REFERENCES "warehouses"("id"),
                "delivery_note_id" uuid NULL REFERENCES "delivery_notes"("id"),
                "reference" varchar(120) NULL,
                "purchase_kind" varchar(24) NOT NULL DEFAULT 'receipt',
                "purchased_at" timestamptz NOT NULL,
                "created_by" uuid NOT NULL REFERENCES "users"("id"),
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "purchase_items" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "purchase_id" uuid NOT NULL REFERENCES "purchases"("id"),
                "product_id" uuid NOT NULL REFERENCES "products"("id"),
                "quantity" integer NOT NULL CHECK ("quantity" > 0),
                "unit_cost_cents" bigint NOT NULL CHECK ("unit_cost_cents" >= 0),
                "total_cost_cents" bigint NOT NULL CHECK ("total_cost_cents" >= 0)
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_purchases_vendor_date" ON "purchases" ("vendor_id", "purchased_at")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_purchase_items_purchase_product" ON "purchase_items" ("purchase_id", "product_id")`);
        await queryRunner.query(`
            ALTER TABLE "payment_checkout_sessions"
            ADD COLUMN IF NOT EXISTS "voucher_number" varchar(10),
            ADD COLUMN IF NOT EXISTS "voucher_points_redeemed" bigint NOT NULL DEFAULT 0
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "customer_vouchers" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "customer_id" uuid NOT NULL UNIQUE REFERENCES "customers"("id") ON DELETE RESTRICT,
                "voucher_number" varchar(10) NOT NULL UNIQUE CHECK ("voucher_number" ~ '^[0-9]{10}$'),
                "issue_date" date NOT NULL,
                "expiry_date" date NOT NULL,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "customer_voucher_number_seq" START WITH 9000000001 INCREMENT BY 1 NO CYCLE`);
        await queryRunner.query(`
            INSERT INTO "customer_vouchers" ("customer_id", "voucher_number", "issue_date", "expiry_date")
            SELECT customer."id",
                   nextval('"customer_voucher_number_seq"')::text,
                   CURRENT_DATE,
                   (CURRENT_DATE + INTERVAL '1 year')::date
            FROM "customers" customer
            WHERE NOT EXISTS (
                SELECT 1 FROM "customer_vouchers" voucher WHERE voucher."customer_id" = customer."id"
            )
            ORDER BY customer."created_at", customer."id"
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "voucher_ledger" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "voucher_id" uuid NOT NULL REFERENCES "customer_vouchers"("id"),
                "type" varchar(16) NOT NULL CHECK ("type" IN ('earn', 'redeem', 'reversal', 'adjustment')),
                "points" bigint NOT NULL CHECK ("points" <> 0),
                "sale_id" uuid NULL REFERENCES "sales"("id"),
                "reference" varchar(120) NULL,
                "reason" text NULL,
                "created_by" uuid NOT NULL REFERENCES "users"("id"),
                "created_at" timestamptz NOT NULL DEFAULT now(),
                CHECK (
                    ("type" = 'earn' AND "points" > 0) OR
                    ("type" = 'redeem' AND "points" < 0) OR
                    "type" IN ('reversal', 'adjustment')
                )
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_voucher_ledger_voucher_date" ON "voucher_ledger" ("voucher_id", "created_at")`);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "voucher_renewals" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "voucher_id" uuid NOT NULL REFERENCES "customer_vouchers"("id"),
                "previous_expiry_date" date NOT NULL,
                "new_expiry_date" date NOT NULL,
                "fee_cents" bigint NOT NULL CHECK ("fee_cents" >= 0),
                "renewed_by" uuid NOT NULL REFERENCES "users"("id"),
                "renewed_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "voucher_card_print_logs" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "voucher_id" uuid NOT NULL REFERENCES "customer_vouchers"("id"),
                "printed_by" uuid NOT NULL REFERENCES "users"("id"),
                "printed_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "sales"
            ADD COLUMN IF NOT EXISTS "voucher_id" uuid NULL REFERENCES "customer_vouchers"("id"),
            ADD COLUMN IF NOT EXISTS "voucher_points_earned" bigint NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "voucher_points_redeemed" bigint NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "voucher_balance_after" bigint NULL,
            ADD COLUMN IF NOT EXISTS "voucher_expiry_date" date NULL
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Append-only records cannot be updated or deleted';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_voucher_ledger_append_only" ON "voucher_ledger"`);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_voucher_ledger_append_only"
            BEFORE UPDATE OR DELETE ON "voucher_ledger"
            FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation()
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_purchase_item_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Purchase history cannot be updated or deleted';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_purchase_items_append_only" ON "purchase_items"`);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_purchase_items_append_only"
            BEFORE UPDATE OR DELETE ON "purchase_items"
            FOR EACH ROW EXECUTE FUNCTION prevent_purchase_item_mutation()
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_voucher_identity_mutation() RETURNS trigger AS $$
            BEGIN
                IF NEW."voucher_number" <> OLD."voucher_number" OR NEW."customer_id" <> OLD."customer_id" OR
                   NEW."issue_date" <> OLD."issue_date" THEN
                    RAISE EXCEPTION 'Voucher identity is immutable';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_voucher_identity_immutable" ON "customer_vouchers"`);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_voucher_identity_immutable"
            BEFORE UPDATE ON "customer_vouchers"
            FOR EACH ROW EXECUTE FUNCTION prevent_voucher_identity_mutation()
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_voucher_identity_immutable" ON "customer_vouchers"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_voucher_identity_mutation()`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_purchase_items_append_only" ON "purchase_items"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_purchase_item_mutation()`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_voucher_ledger_append_only" ON "voucher_ledger"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_ledger_mutation()`);
        await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN IF EXISTS "voucher_expiry_date", DROP COLUMN IF EXISTS "voucher_balance_after", DROP COLUMN IF EXISTS "voucher_points_redeemed", DROP COLUMN IF EXISTS "voucher_points_earned", DROP COLUMN IF EXISTS "voucher_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "voucher_card_print_logs"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "voucher_renewals"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "voucher_ledger"`);
        await queryRunner.query(`DROP SEQUENCE IF EXISTS "customer_voucher_number_seq"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "customer_vouchers"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_purchase_items_purchase_product"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_purchases_vendor_date"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "purchase_items"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "purchases"`);
        await queryRunner.query(`ALTER TABLE "payment_checkout_sessions" DROP COLUMN IF EXISTS "voucher_points_redeemed", DROP COLUMN IF EXISTS "voucher_number"`);
        await queryRunner.query(`ALTER TABLE "sale_items" DROP COLUMN IF EXISTS "discount_cents", DROP COLUMN IF EXISTS "line_total_cents", DROP COLUMN IF EXISTS "unit_cost_basis_quantity", DROP COLUMN IF EXISTS "unit_cost_basis_cents", DROP COLUMN IF EXISTS "cogs_total_cents", DROP COLUMN IF EXISTS "unit_cost_cents", DROP COLUMN IF EXISTS "vat_cents", DROP COLUMN IF EXISTS "net_revenue_cents"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_warehouse_stock_product_warehouse"`);
        await queryRunner.query(`DELETE FROM "stock_movements" WHERE "movement_type" = 'costing_opening_balance' AND "reference_type" = 'costing_opening_balance'`);
        await queryRunner.query(`DROP TABLE IF EXISTS "inventory_costing_baselines"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_stock_movements_location_created"`);
        await queryRunner.query(`ALTER TABLE "stock_movements" DROP COLUMN IF EXISTS "value_change_cents"`);
        await queryRunner.query(`ALTER TABLE "warehouse_stocks" DROP COLUMN IF EXISTS "stock_value_cents"`);
    }
}
