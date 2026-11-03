import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCostingBaselineVerification1792350000000 implements MigrationInterface {
    name = "AddCostingBaselineVerification1792350000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "inventory_costing_baseline_verifications" (
                "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                "previous_baseline_at" timestamptz NULL,
                "previous_valuation_method" varchar(64) NOT NULL,
                "baseline_at" timestamptz NOT NULL,
                "evidence_reference" varchar(120) NOT NULL,
                "reason" text NOT NULL,
                "line_count" integer NOT NULL CHECK ("line_count" >= 0),
                "total_value_cents" bigint NOT NULL CHECK ("total_value_cents" >= 0),
                "stock_snapshot" jsonb NOT NULL,
                "verified_by" uuid NOT NULL REFERENCES "users"("id"),
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_inventory_costing_baseline_verifications_created_at"
            ON "inventory_costing_baseline_verifications" ("created_at" DESC)
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_costing_baseline_verification_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Costing baseline verification records are immutable';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            CREATE TRIGGER "TRG_inventory_costing_baseline_verification_immutable"
            BEFORE UPDATE OR DELETE ON "inventory_costing_baseline_verifications"
            FOR EACH ROW EXECUTE FUNCTION prevent_costing_baseline_verification_mutation()
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TRG_inventory_costing_baseline_verification_immutable" ON "inventory_costing_baseline_verifications"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_costing_baseline_verification_mutation()`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inventory_costing_baseline_verifications_created_at"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "inventory_costing_baseline_verifications"`);
    }
}
