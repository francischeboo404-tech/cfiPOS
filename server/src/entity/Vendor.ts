import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from "typeorm";
import { PurchaseOrder } from "./PurchaseOrder";

@Entity("vendors")
export class Vendor {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    name: string;

    @Column({ type: "varchar", nullable: true })
    contact_person: string | null;

    @Column({ type: "varchar", nullable: true })
    phone: string | null;

    @Column({ type: "varchar", nullable: true })
    email: string | null;

    @Column({ nullable: true, type: "text" })
    address: string | null;

    @Column({ type: "varchar", nullable: true })
    payment_terms: string | null;

    @Column({ type: "boolean", default: false })
    needs_review: boolean;

    @Column({ type: "timestamptz", nullable: true })
    reviewed_at: Date | null;

    @Column({ type: "uuid", nullable: true })
    reviewed_by: string | null;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;

    @OneToMany(() => PurchaseOrder, po => po.vendor)
    purchase_orders: PurchaseOrder[];
}
