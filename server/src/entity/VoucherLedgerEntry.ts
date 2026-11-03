import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { CustomerVoucher } from "./CustomerVoucher";
import { Sale } from "./Sale";
import { User } from "./User";

export type VoucherEntryType = "earn" | "redeem" | "reversal" | "adjustment";

@Entity("voucher_ledger")
@Check("CHK_voucher_ledger_points_nonzero", '"points" <> 0')
@Check("CHK_voucher_ledger_type", '"type" IN (\'earn\', \'redeem\', \'reversal\', \'adjustment\')')
@Check(
    "CHK_voucher_ledger_earn_redeem_sign",
    '("type" = \'earn\' AND "points" > 0) OR ("type" = \'redeem\' AND "points" < 0) OR "type" IN (\'reversal\', \'adjustment\')',
)
export class VoucherLedgerEntry {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    voucher_id: string;

    @ManyToOne(() => CustomerVoucher)
    @JoinColumn({ name: "voucher_id" })
    voucher: CustomerVoucher;

    @Column({ type: "varchar", length: 16 })
    type: VoucherEntryType;

    @Column("bigint")
    points: string;

    @Column({ type: "uuid", nullable: true })
    sale_id: string | null;

    @ManyToOne(() => Sale, { nullable: true })
    @JoinColumn({ name: "sale_id" })
    sale: Sale | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    reference: string | null;

    @Column("text", { nullable: true })
    reason: string | null;

    @Column({ type: "uuid" })
    created_by: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "created_by" })
    creator: User;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}
