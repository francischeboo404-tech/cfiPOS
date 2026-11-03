import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, Index } from "typeorm";
import { Sale } from "./Sale";

@Entity("customers")
@Index("UQ_customers_phone_installment", ["phone"], { unique: true })
export class Customer {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    name: string;

    @Column()
    phone: string;

    @Column({ nullable: true })
    email: string;

    @Column({ type: "varchar", length: 64, nullable: true })
    national_id: string | null;

    @Column({ type: "varchar", length: 32, nullable: true })
    alternative_phone: string | null;

    @Column({ type: "text", nullable: true })
    address: string | null;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    total_purchases: number;

    @Column("int", { default: 0 })
    purchase_count: number;

    @Column({ default: false })
    is_frequent: boolean;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    credit_limit: number;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    credit_balance: number;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    store_credit_balance: number;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;

    @OneToMany(() => Sale, sale => sale.customer)
    sales: Sale[];
}
