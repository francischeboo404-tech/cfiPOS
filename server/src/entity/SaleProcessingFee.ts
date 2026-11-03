import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Sale } from "./Sale";
import { User } from "./User";

@Entity("sale_processing_fees")
export class SaleProcessingFee {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid", unique: true })
    sale_id: string;

    @ManyToOne(() => Sale)
    @JoinColumn({ name: "sale_id" })
    sale: Sale;

    @Column({ type: "bigint" })
    fee_cents: string;

    @Column({ type: "bigint" })
    recoverable_vat_cents: string;

    @Column({ type: "date" })
    incurred_date: string;

    @Column({ type: "varchar", length: 120 })
    statement_reference: string;

    @Column({ type: "varchar", length: 120, nullable: true })
    transaction_reference: string | null;

    @Column({ type: "uuid" })
    recorded_by: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "recorded_by" })
    recorder: User;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}
