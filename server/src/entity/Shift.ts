import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from "typeorm";
import { User } from "./User";

export enum ShiftStatus {
    OPEN = "open",
    CLOSED = "closed"
}

@Entity("shifts")
@Index("IDX_shifts_one_open_per_cashier", ["cashier_id"], { unique: true, where: `"status" = 'open'` })
export class Shift {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "cashier_id" })
    cashier: User;

    @Column()
    cashier_id: string;

    @Column("timestamp", { default: () => "CURRENT_TIMESTAMP" })
    start_time: Date;

    @Column("timestamp", { nullable: true })
    end_time: Date | null;

    @Column({
        type: "enum",
        enum: ShiftStatus,
        default: ShiftStatus.OPEN
    })
    status: ShiftStatus;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    opening_float: string;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    expected_cash: string;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    actual_cash: string;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    mpesa_total: string;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    total_sales: string;

    @Column("text", { nullable: true })
    notes: string;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;
}
