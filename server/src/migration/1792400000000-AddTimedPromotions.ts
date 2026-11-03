import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTimedPromotions1792400000000 implements MigrationInterface {
    name = "AddTimedPromotions1792400000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "promotions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" character varying(120) NOT NULL,
                "starts_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "ends_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "status_override" character varying(20),
                "created_by" uuid NOT NULL,
                "updated_by" uuid NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_promotions" PRIMARY KEY ("id"),
                CONSTRAINT "FK_promotions_created_by" FOREIGN KEY ("created_by")
                    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "FK_promotions_updated_by" FOREIGN KEY ("updated_by")
                    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "CHK_promotions_schedule" CHECK ("starts_at" < "ends_at"),
                CONSTRAINT "CHK_promotions_status_override" CHECK (
                    "status_override" IS NULL OR "status_override" = 'cancelled'
                ),
                CONSTRAINT "CHK_promotions_name" CHECK (length(trim("name")) > 0)
            )
        `);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "promotion_items" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "promotion_id" uuid NOT NULL,
                "product_id" uuid NOT NULL,
                "unit_of_measure" character varying(80) NOT NULL,
                "discount_type" character varying(20) NOT NULL,
                "discount_value" bigint NOT NULL,
                "min_qty" integer NOT NULL,
                "max_qty_per_sale" integer,
                "total_quota_qty" integer,
                "used_qty" integer NOT NULL DEFAULT 0,
                "loss_override_reason" text,
                "is_active" boolean NOT NULL DEFAULT true,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_promotion_items" PRIMARY KEY ("id"),
                CONSTRAINT "FK_promotion_items_promotion" FOREIGN KEY ("promotion_id")
                    REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "FK_promotion_items_product" FOREIGN KEY ("product_id")
                    REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "UQ_promotion_items_promotion_product_unit"
                    UNIQUE ("promotion_id", "product_id", "unit_of_measure"),
                CONSTRAINT "CHK_promotion_items_values" CHECK (
                    length(trim("unit_of_measure")) > 0
                    AND "min_qty" > 0
                    AND ("max_qty_per_sale" IS NULL OR "max_qty_per_sale" >= "min_qty")
                    AND ("total_quota_qty" IS NULL OR "total_quota_qty" >= 0)
                    AND "used_qty" >= 0
                    AND ("total_quota_qty" IS NULL OR "used_qty" <= "total_quota_qty")
                    AND (
                        ("discount_type" = 'percent' AND "discount_value" BETWEEN 1 AND 10000)
                        OR ("discount_type" = 'fixed_discount' AND "discount_value" > 0)
                        OR ("discount_type" = 'fixed_price' AND "discount_value" >= 0)
                    )
                )
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_promotion_items_product_active"
            ON "promotion_items" ("product_id", "unit_of_measure", "is_active")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_promotions_schedule"
            ON "promotions" ("starts_at", "ends_at", "status_override")
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "promotion_audit_events" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "promotion_id" uuid NOT NULL,
                "actor_id" uuid NOT NULL,
                "action" character varying(30) NOT NULL,
                "before_state" jsonb,
                "after_state" jsonb NOT NULL,
                "reason" text,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_promotion_audit_events" PRIMARY KEY ("id"),
                CONSTRAINT "FK_promotion_audit_events_promotion" FOREIGN KEY ("promotion_id")
                    REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "FK_promotion_audit_events_actor" FOREIGN KEY ("actor_id")
                    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "CHK_promotion_audit_events_action" CHECK (
                    "action" IN ('created', 'updated', 'cancelled', 'sale_redeemed', 'sale_reversed', 'loss_override_used')
                )
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_promotion_audit_events_promotion_created"
            ON "promotion_audit_events" ("promotion_id", "created_at" DESC)
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_promotion_audit_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Promotion audit events are immutable';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "TR_promotion_audit_events_immutable" ON "promotion_audit_events"
        `);
        await queryRunner.query(`
            CREATE TRIGGER "TR_promotion_audit_events_immutable"
            BEFORE UPDATE OR DELETE ON "promotion_audit_events"
            FOR EACH ROW EXECUTE FUNCTION prevent_promotion_audit_mutation()
        `);

        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION validate_promotion_item_overlap() RETURNS trigger AS $$
            DECLARE
                promotion_starts_at timestamptz;
                promotion_ends_at timestamptz;
                promotion_cancelled boolean;
            BEGIN
                SELECT "starts_at", "ends_at", "status_override" = 'cancelled'
                INTO promotion_starts_at, promotion_ends_at, promotion_cancelled
                FROM "promotions" WHERE "id" = NEW."promotion_id";
                IF NOT FOUND OR NOT NEW."is_active" OR promotion_cancelled THEN
                    RETURN NEW;
                END IF;

                PERFORM pg_advisory_xact_lock(
                    hashtextextended(NEW."product_id"::text || ':' || NEW."unit_of_measure", 0)
                );
                IF EXISTS (
                    SELECT 1
                    FROM "promotion_items" pi
                    JOIN "promotions" p ON p."id" = pi."promotion_id"
                    WHERE pi."product_id" = NEW."product_id"
                      AND pi."unit_of_measure" = NEW."unit_of_measure"
                      AND pi."is_active"
                      AND p."status_override" IS DISTINCT FROM 'cancelled'
                      AND p."starts_at" < promotion_ends_at
                      AND p."ends_at" > promotion_starts_at
                      AND pi."id" <> COALESCE(NEW."id", '00000000-0000-0000-0000-000000000000'::uuid)
                ) THEN
                    RAISE EXCEPTION 'An active promotion already overlaps for this product and unit';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "TR_promotion_items_no_overlap" ON "promotion_items"
        `);
        await queryRunner.query(`
            CREATE TRIGGER "TR_promotion_items_no_overlap"
            BEFORE INSERT OR UPDATE OF "promotion_id", "product_id", "unit_of_measure", "is_active"
            ON "promotion_items"
            FOR EACH ROW EXECUTE FUNCTION validate_promotion_item_overlap()
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION validate_promotion_schedule_overlap() RETURNS trigger AS $$
            DECLARE
                item_row record;
            BEGIN
                IF NEW."status_override" = 'cancelled' THEN
                    RETURN NEW;
                END IF;
                FOR item_row IN
                    SELECT "product_id", "unit_of_measure"
                    FROM "promotion_items"
                    WHERE "promotion_id" = NEW."id" AND "is_active"
                    ORDER BY "product_id", "unit_of_measure"
                LOOP
                    PERFORM pg_advisory_xact_lock(
                        hashtextextended(item_row."product_id"::text || ':' || item_row."unit_of_measure", 0)
                    );
                    IF EXISTS (
                        SELECT 1
                        FROM "promotion_items" pi
                        JOIN "promotions" p ON p."id" = pi."promotion_id"
                        WHERE pi."product_id" = item_row."product_id"
                          AND pi."unit_of_measure" = item_row."unit_of_measure"
                          AND pi."is_active"
                          AND pi."promotion_id" <> NEW."id"
                          AND p."status_override" IS DISTINCT FROM 'cancelled'
                          AND p."starts_at" < NEW."ends_at"
                          AND p."ends_at" > NEW."starts_at"
                    ) THEN
                        RAISE EXCEPTION 'An active promotion already overlaps for this product and unit';
                    END IF;
                END LOOP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "TR_promotions_no_overlap" ON "promotions"
        `);
        await queryRunner.query(`
            CREATE TRIGGER "TR_promotions_no_overlap"
            BEFORE UPDATE OF "starts_at", "ends_at", "status_override"
            ON "promotions"
            FOR EACH ROW EXECUTE FUNCTION validate_promotion_schedule_overlap()
        `);

        await queryRunner.query(`
            ALTER TABLE "sale_items"
            ADD COLUMN IF NOT EXISTS "promotion_id" uuid,
            ADD COLUMN IF NOT EXISTS "promotion_item_id" uuid,
            ADD COLUMN IF NOT EXISTS "promotion_name" character varying(120),
            ADD COLUMN IF NOT EXISTS "original_unit_price_cents" bigint,
            ADD COLUMN IF NOT EXISTS "promotion_discount_per_unit_cents" bigint,
            ADD COLUMN IF NOT EXISTS "promotion_quantity" integer
        `);
        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'FK_sale_items_promotion'
                      AND conrelid = 'sale_items'::regclass
                ) THEN
                    ALTER TABLE "sale_items" ADD CONSTRAINT "FK_sale_items_promotion"
                    FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id")
                    ON DELETE RESTRICT ON UPDATE NO ACTION;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'FK_sale_items_promotion_item'
                      AND conrelid = 'sale_items'::regclass
                ) THEN
                    ALTER TABLE "sale_items" ADD CONSTRAINT "FK_sale_items_promotion_item"
                    FOREIGN KEY ("promotion_item_id") REFERENCES "promotion_items"("id")
                    ON DELETE RESTRICT ON UPDATE NO ACTION;
                END IF;
            END;
            $$
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_sale_items_promotion_id"
            ON "sale_items" ("promotion_id")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sale_items_promotion_id"`);
        await queryRunner.query(`ALTER TABLE "sale_items" DROP CONSTRAINT IF EXISTS "FK_sale_items_promotion_item"`);
        await queryRunner.query(`ALTER TABLE "sale_items" DROP CONSTRAINT IF EXISTS "FK_sale_items_promotion"`);
        await queryRunner.query(`
            ALTER TABLE "sale_items"
            DROP COLUMN IF EXISTS "promotion_quantity",
            DROP COLUMN IF EXISTS "promotion_discount_per_unit_cents",
            DROP COLUMN IF EXISTS "original_unit_price_cents",
            DROP COLUMN IF EXISTS "promotion_name",
            DROP COLUMN IF EXISTS "promotion_item_id",
            DROP COLUMN IF EXISTS "promotion_id"
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TR_promotions_no_overlap" ON "promotions"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS validate_promotion_schedule_overlap()`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TR_promotion_items_no_overlap" ON "promotion_items"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS validate_promotion_item_overlap()`);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TR_promotion_audit_events_immutable" ON "promotion_audit_events"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_promotion_audit_mutation()`);
        await queryRunner.query(`DROP TABLE IF EXISTS "promotion_audit_events"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_promotions_schedule"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_promotion_items_product_active"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "promotion_items"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "promotions"`);
    }
}
