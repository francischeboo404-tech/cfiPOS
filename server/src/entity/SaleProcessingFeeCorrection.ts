import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { JournalEntry } from "./JournalEntry";
import { SaleProcessingFee } from "./SaleProcessingFee";
import { User } from "./User";

@Entity("sale_processing_fee_corrections")
export class SaleProcessingFeeCorrection {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    fee_id: string;

    @ManyToOne(() => SaleProcessingFee)
    @JoinColumn({ name: "fee_id" })
    fee: SaleProcessingFee;

    @Column({ type: "integer" })
    revision: number;

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

    @Column({ type: "text" })
    reason: string;

    @Column({ type: "uuid", nullable: true })
    reversal_journal_entry_id: string | null;

    @ManyToOne(() => JournalEntry, { nullable: true })
    @JoinColumn({ name: "reversal_journal_entry_id" })
    reversalJournalEntry: JournalEntry | null;

    @Column({ type: "uuid", nullable: true })
    corrected_journal_entry_id: string | null;

    @ManyToOne(() => JournalEntry, { nullable: true })
    @JoinColumn({ name: "corrected_journal_entry_id" })
    correctedJournalEntry: JournalEntry | null;

    @Column({ type: "uuid" })
    recorded_by: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "recorded_by" })
    recorder: User;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}
