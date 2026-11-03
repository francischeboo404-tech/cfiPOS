import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSaleProcessingFeeCorrections1792361000000 implements MigrationInterface {
    name = "AddSaleProcessingFeeCorrections1792361000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "sale_processing_fee_corrections" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "fee_id" uuid NOT NULL,
                "revision" integer NOT NULL,
                "fee_cents" bigint NOT NULL,
                "recoverable_vat_cents" bigint NOT NULL,
                "incurred_date" date NOT NULL,
                "statement_reference" character varying(120) NOT NULL,
                "transaction_reference" character varying(120),
                "reason" text NOT NULL,
                "reversal_journal_entry_id" uuid,
                "corrected_journal_entry_id" uuid,
                "recorded_by" uuid NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_sale_processing_fee_corrections" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_sale_processing_fee_corrections_revision" UNIQUE ("fee_id", "revision"),
                CONSTRAINT "FK_sale_processing_fee_corrections_fee" FOREIGN KEY ("fee_id")
                    REFERENCES "sale_processing_fees"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "FK_sale_processing_fee_corrections_reversal_journal" FOREIGN KEY ("reversal_journal_entry_id")
                    REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "FK_sale_processing_fee_corrections_corrected_journal" FOREIGN KEY ("corrected_journal_entry_id")
                    REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "FK_sale_processing_fee_corrections_recorder" FOREIGN KEY ("recorded_by")
                    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
                CONSTRAINT "CHK_sale_processing_fee_corrections_values" CHECK (
                    "revision" > 0
                    AND "fee_cents" >= 0
                    AND "recoverable_vat_cents" >= 0
                    AND "recoverable_vat_cents" <= "fee_cents"
                    AND length(trim("statement_reference")) > 0
                    AND length(trim("reason")) > 0
                )
            )
        `);
        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'UQ_sale_processing_fee_corrections_revision'
                      AND conrelid = 'sale_processing_fee_corrections'::regclass
                ) THEN
                    ALTER TABLE "sale_processing_fee_corrections"
                    ADD CONSTRAINT "UQ_sale_processing_fee_corrections_revision" UNIQUE ("fee_id", "revision");
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'CHK_sale_processing_fee_corrections_values'
                      AND conrelid = 'sale_processing_fee_corrections'::regclass
                ) THEN
                    ALTER TABLE "sale_processing_fee_corrections"
                    ADD CONSTRAINT "CHK_sale_processing_fee_corrections_values" CHECK (
                        "revision" > 0
                        AND "fee_cents" >= 0
                        AND "recoverable_vat_cents" >= 0
                        AND "recoverable_vat_cents" <= "fee_cents"
                        AND length(trim("statement_reference")) > 0
                        AND length(trim("reason")) > 0
                    );
                END IF;
            END;
            $$
        `);
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION prevent_sale_processing_fee_correction_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Sale processing fee corrections are immutable';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "TR_sale_processing_fee_corrections_immutable" ON "sale_processing_fee_corrections"
        `);
        await queryRunner.query(`
            CREATE TRIGGER "TR_sale_processing_fee_corrections_immutable"
            BEFORE UPDATE OR DELETE ON "sale_processing_fee_corrections"
            FOR EACH ROW EXECUTE FUNCTION prevent_sale_processing_fee_correction_mutation()
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER IF EXISTS "TR_sale_processing_fee_corrections_immutable" ON "sale_processing_fee_corrections"`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_sale_processing_fee_correction_mutation()`);
        await queryRunner.query(`DROP TABLE IF EXISTS "sale_processing_fee_corrections"`);
    }
}
