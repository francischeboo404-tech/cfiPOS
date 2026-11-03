import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { ReturnRequest } from "./ReturnRequest";
import { SaleItem } from "./SaleItem";

export enum ReturnItemCondition {
    UNKNOWN = "unknown",
    SELLABLE = "sellable",
    DAMAGED = "damaged"
}

@Entity("return_items")
export class ReturnItem {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @ManyToOne(() => ReturnRequest, return_request => return_request.items, { onDelete: "CASCADE" })
    @JoinColumn({ name: "return_request_id" })
    return_request: ReturnRequest;

    @ManyToOne(() => SaleItem)
    @JoinColumn({ name: "sale_item_id" })
    sale_item: SaleItem;

    @Column("int")
    quantity: number;

    @Column("bigint", { nullable: true })
    net_revenue_cents: string | null;

    @Column("bigint", { nullable: true })
    vat_cents: string | null;

    @Column("bigint", { nullable: true })
    cogs_total_cents: string | null;

    @Column({
        type: "enum",
        enum: ReturnItemCondition,
        default: ReturnItemCondition.UNKNOWN
    })
    condition: ReturnItemCondition;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;
}
