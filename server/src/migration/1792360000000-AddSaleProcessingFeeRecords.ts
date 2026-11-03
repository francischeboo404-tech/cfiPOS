import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSaleProcessingFeeRecords1792360000000 implements MigrationInterface {
    name = "AddSaleProcessingFeeRecords1792360000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "sale_processing_fees" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "sale_id" uuid NOT NULL,
                "fee_cents" bigint NOT NULL,
                "recoverable_vat_cents" bigint NOT NULL,
                "incurred_date" date NOT NULL,
                "statement_reference" character varying(120) NOT NULL,
                "transaction_reference" character varying(120),
                "recorded_by" uuid NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_sale_processing_fees" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_sale_processing_fees_sale" UNIQUE ("sale_id"),
                CONSTRAINT "FK_sale_processing_fees_sale" FOREIGN KEY ("sale_id")
                    REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "FK_sale_processing_fees_recorder" FOREIGN KEY ("recorded_by")
                    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "CHK_sale_processing_fees_amounts" CHECK (
                    "fee_cents" >= 0
                    AND "recoverable_vat_cents" >= 0
                    AND "recoverable_vat_cents" <= "fee_cents"
                )
            )
        `);
        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'CHK_sale_processing_fees_amounts'
                      AND conrelid = 'sale_processing_fees'::regclass
                ) THEN
                    ALTER TABLE "sale_processing_fees"
                    ADD CONSTRAINT "CHK_sale_processing_fees_amounts" CHECK (
                        "fee_cents" >= 0
                        AND "recoverable_vat_cents" >= 0
                        AND "recoverable_vat_cents" <= "fee_cents"
                    );
                END IF;
            END;
            $$
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_sale_processing_fee_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Sale processing fee records are immutable';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "TR_sale_processing_fees_immutable" ON "sale_processing_fees"
        `);
        await queryRunner.query(`
            CREATE TRIGGER "TR_sale_processing_fees_immutable"
            BEFORE UPDATE OR DELETE ON "sale_processing_fees"
            FOR EACH ROW EXECUTE FUNCTION prevent_sale_processing_fee_mutation()
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TR_sale_processing_fees_immutable" ON "sale_processing_fees"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_sale_processing_fee_mutation()`);
        await queryRunner.query(`DROP TABLE IF EXISTS "sale_processing_fees"`);
    }
}
