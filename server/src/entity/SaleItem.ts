import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { Sale } from "./Sale";
import { Product } from "./Product";
import { EtimsItemMappingSnapshot } from "../services/etims/EtimsItemMapping";

@Entity("sale_items")
export class SaleItem {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @ManyToOne(() => Sale, sale => sale.items, { onDelete: "CASCADE" })
    @JoinColumn({ name: "sale_id" })
    sale: Sale;

    @ManyToOne(() => Product)
    @JoinColumn({ name: "product_id" })
    product: Product;

    @Column("int")
    quantity: number;

    @Column("decimal", { precision: 10, scale: 2 })
    unit_price: number;

    @Column("decimal", { precision: 12, scale: 4, nullable: true })
    unit_cost: number | null;

    @Column("decimal", { precision: 12, scale: 2, nullable: true })
    cogs_total: number | null;

    @Column("bigint", { nullable: true })
    net_revenue_cents: string | null;

    @Column("bigint", { nullable: true })
    vat_cents: string | null;

    @Column("bigint", { nullable: true })
    unit_cost_cents: string | null;

    @Column("bigint", { nullable: true })
    unit_cost_basis_cents: string | null;

    @Column("bigint", { nullable: true })
    unit_cost_basis_quantity: string | null;

    @Column("bigint", { nullable: true })
    cogs_total_cents: string | null;

    @Column("bigint", { nullable: true })
    line_total_cents: string | null;

    @Column("bigint", { nullable: true })
    discount_cents: string | null;

    @Column({ type: "uuid", nullable: true })
    promotion_id: string | null;

    @Column({ type: "uuid", nullable: true })
    promotion_item_id: string | null;

    @Column("jsonb", { nullable: true })
    etims_item_snapshot: EtimsItemMappingSnapshot | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    promotion_name: string | null;

    @Column("bigint", { nullable: true })
    original_unit_price_cents: string | null;

    @Column("bigint", { nullable: true })
    promotion_discount_per_unit_cents: string | null;

    @Column("int", { nullable: true })
    promotion_quantity: number | null;

    @Column("decimal", { precision: 5, scale: 2 })
    tax_rate: number;

    @Column("decimal", { precision: 10, scale: 2 })
    line_total: number;

    @CreateDateColumn()
    created_at: Date;
}
