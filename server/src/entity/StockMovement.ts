import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Product } from "./Product";

@Entity("stock_movements")
export class StockMovement {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    product_id: string;

    @ManyToOne(() => Product)
    @JoinColumn({ name: "product_id" })
    product: Product;

    @Column({ type: "varchar" })
    movement_type: string;

    @Column("int")
    quantity: number;

    @Column("int")
    quantity_before: number;

    @Column("int")
    quantity_after: number;

    @Column("decimal", { precision: 12, scale: 2, nullable: true })
    unit_cost: number | null;

    @Column("bigint", { nullable: true })
    value_change_cents: string | null;

    @Column({ type: "varchar" })
    reference_type: string;

    @Column({ type: "uuid", nullable: true })
    reference_id: string | null;

    @Column({ type: "uuid", nullable: true })
    location_id: string | null;

    @Column("text", { nullable: true })
    notes: string | null;

    @Column({ type: "uuid" })
    created_by: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}
