import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInventoryPeriodCloses1792260000001 implements MigrationInterface {
    name = "AddInventoryPeriodCloses1792260000001";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "inventory_period_closes" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "period_end_date" date NOT NULL UNIQUE,
                "opening_value_cents" bigint NOT NULL,
                "purchase_value_cents" bigint NOT NULL,
                "cogs_cents" bigint NOT NULL,
                "write_offs_cents" bigint NOT NULL,
                "adjustments_cents" bigint NOT NULL,
                "closing_value_cents" bigint NOT NULL,
                "closed_by" uuid NOT NULL REFERENCES "users"("id"),
                "closed_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_inventory_period_close_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Inventory period closes are immutable';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_inventory_period_close_immutable" ON "inventory_period_closes"`);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_inventory_period_close_immutable"
            BEFORE UPDATE OR DELETE ON "inventory_period_closes"
            FOR EACH ROW EXECUTE FUNCTION prevent_inventory_period_close_mutation()
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_inventory_period_close_immutable" ON "inventory_period_closes"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_inventory_period_close_mutation()`);
        await queryRunner.query(`DROP TABLE IF EXISTS "inventory_period_closes"`);
    }
}
