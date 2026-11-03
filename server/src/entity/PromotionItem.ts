import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from "typeorm";
import { Product } from "./Product";
import { Promotion } from "./Promotion";

export type PromotionDiscountType = "percent" | "fixed_discount" | "fixed_price";

@Entity("promotion_items")
export class PromotionItem {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @ManyToOne(() => Promotion, (promotion) => promotion.items, { onDelete: "RESTRICT" })
    @JoinColumn({ name: "promotion_id" })
    promotion: Promotion;

    @ManyToOne(() => Product, { onDelete: "RESTRICT" })
    @JoinColumn({ name: "product_id" })
    product: Product;

    @Column({ type: "varchar", length: 80 })
    unit_of_measure: string;

    @Column({ type: "varchar", length: 20 })
    discount_type: PromotionDiscountType;

    @Column("bigint")
    discount_value: string;

    @Column("int")
    min_qty: number;

    @Column("int", { nullable: true })
    max_qty_per_sale: number | null;

    @Column("int", { nullable: true })
    total_quota_qty: number | null;

    @Column("int", { default: 0 })
    used_qty: number;

    @Column({ type: "text", nullable: true })
    loss_override_reason: string | null;

    @Column({ type: "boolean", default: true })
    is_active: boolean;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;

    @UpdateDateColumn({ type: "timestamptz" })
    updated_at: Date;
}
