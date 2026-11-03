import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Product } from "./Product";
import { Purchase } from "./Purchase";

@Entity("purchase_items")
@Check("CHK_purchase_items_quantity_positive", '"quantity" > 0')
@Check("CHK_purchase_items_unit_cost_nonnegative", '"unit_cost_cents" >= 0')
@Check("CHK_purchase_items_total_cost_nonnegative", '"total_cost_cents" >= 0')
export class PurchaseItem {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    purchase_id: string;

    @ManyToOne(() => Purchase, (purchase) => purchase.items)
    @JoinColumn({ name: "purchase_id" })
    purchase: Purchase;

    @Column({ type: "uuid" })
    product_id: string;

    @ManyToOne(() => Product)
    @JoinColumn({ name: "product_id" })
    product: Product;

    @Column("int")
    quantity: number;

    @Column("bigint")
    unit_cost_cents: string;

    @Column("bigint")
    total_cost_cents: string;
}
