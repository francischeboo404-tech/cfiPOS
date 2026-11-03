import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEtimsProductMapping1792440000000 implements MigrationInterface {
    name = "AddEtimsProductMapping1792440000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "products"
            ADD COLUMN IF NOT EXISTS "etims_item_code" varchar(20),
            ADD COLUMN IF NOT EXISTS "etims_item_class_code" varchar(10),
            ADD COLUMN IF NOT EXISTS "etims_product_type_code" varchar(5),
            ADD COLUMN IF NOT EXISTS "etims_origin_country_code" varchar(5),
            ADD COLUMN IF NOT EXISTS "etims_packaging_unit_code" varchar(5),
            ADD COLUMN IF NOT EXISTS "etims_quantity_unit_code" varchar(5),
            ADD COLUMN IF NOT EXISTS "etims_tax_type_code" varchar(5)
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_products_etims_item_code"
            ON "products" ("etims_item_code")
            WHERE "etims_item_code" IS NOT NULL
        `);
        await queryRunner.query(`
            ALTER TABLE "sale_items"
            ADD COLUMN IF NOT EXISTS "etims_item_snapshot" jsonb
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "sale_items"
            DROP COLUMN IF EXISTS "etims_item_snapshot"
        `);
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_products_etims_item_code"`);
        await queryRunner.query(`
            ALTER TABLE "products"
            DROP COLUMN IF EXISTS "etims_tax_type_code",
            DROP COLUMN IF EXISTS "etims_quantity_unit_code",
            DROP COLUMN IF EXISTS "etims_packaging_unit_code",
            DROP COLUMN IF EXISTS "etims_origin_country_code",
            DROP COLUMN IF EXISTS "etims_product_type_code",
            DROP COLUMN IF EXISTS "etims_item_class_code",
            DROP COLUMN IF EXISTS "etims_item_code"
        `);
    }
}
