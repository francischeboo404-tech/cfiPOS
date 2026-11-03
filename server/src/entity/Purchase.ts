import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import { Vendor } from "./Vendor";
import { User } from "./User";
import { Warehouse } from "./Warehouse";
import { PurchaseItem } from "./PurchaseItem";

@Entity("purchases")
export class Purchase {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid", nullable: true })
    vendor_id: string | null;

    @ManyToOne(() => Vendor, { nullable: true })
    @JoinColumn({ name: "vendor_id" })
    vendor: Vendor | null;

    @Column({ type: "uuid" })
    warehouse_id: string;

    @ManyToOne(() => Warehouse)
    @JoinColumn({ name: "warehouse_id" })
    warehouse: Warehouse;

    @Column({ type: "uuid", nullable: true })
    delivery_note_id: string | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    reference: string | null;

    @Column({ type: "varchar", length: 24, default: "receipt" })
    purchase_kind: "receipt" | "opening_stock" | "import";

    @Column({ type: "timestamptz" })
    purchased_at: Date;

    @Column({ type: "uuid" })
    created_by: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "created_by" })
    creator: User;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;

    @OneToMany(() => PurchaseItem, (item) => item.purchase)
    items: PurchaseItem[];
}
