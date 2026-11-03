import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { User } from "./User";

@Entity("inventory_period_closes")
export class InventoryPeriodClose {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "date", unique: true })
    period_end_date: string;

    @Column("bigint")
    opening_value_cents: string;

    @Column("bigint")
    purchase_value_cents: string;

    @Column("bigint")
    cogs_cents: string;

    @Column("bigint")
    write_offs_cents: string;

    @Column("bigint")
    adjustments_cents: string;

    @Column("bigint")
    closing_value_cents: string;

    @Column("uuid")
    closed_by: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "closed_by" })
    closer: User;

    @CreateDateColumn({ type: "timestamptz" })
    closed_at: Date;
}
