import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Unique, UpdateDateColumn } from "typeorm";
import { Product } from "./Product";
import { Warehouse } from "./Warehouse";
import { Bin } from "./Bin";

@Entity("warehouse_stocks")
@Unique(["warehouse_id", "product_id"])
export class WarehouseStock {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    warehouse_id: string;

    @Column()
    product_id: string;

    @ManyToOne(() => Warehouse, w => w.stocks)
    @JoinColumn({ name: "warehouse_id" })
    warehouse: Warehouse;

    @ManyToOne(() => Product)
    @JoinColumn({ name: "product_id" })
    product: Product;

    @ManyToOne(() => Bin, { nullable: true })
    @JoinColumn({ name: "bin_id" })
    bin: Bin | null;

    @Column({ nullable: true })
    bin_id: string;

    @Column("int", { default: 0 })
    stock_on_hand: number;

    @Column("bigint", { nullable: true })
    stock_value_cents: string | null;

    @UpdateDateColumn()
    updated_at: Date;
}
