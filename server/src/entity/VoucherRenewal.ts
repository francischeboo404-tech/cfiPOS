import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { CustomerVoucher } from "./CustomerVoucher";
import { User } from "./User";

@Entity("voucher_renewals")
@Check("CHK_voucher_renewals_fee_nonnegative", '"fee_cents" >= 0')
export class VoucherRenewal {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    voucher_id: string;

    @ManyToOne(() => CustomerVoucher)
    @JoinColumn({ name: "voucher_id" })
    voucher: CustomerVoucher;

    @Column({ type: "date" })
    previous_expiry_date: string;

    @Column({ type: "date" })
    new_expiry_date: string;

    @Column("bigint")
    fee_cents: string;

    @Column({ type: "uuid", nullable: true })
    checkout_session_id: string | null;

    @Column("bigint", { nullable: true })
    cash_paid_cents: string | null;

    @Column("bigint", { nullable: true })
    mpesa_paid_cents: string | null;

    @Column({ type: "text", nullable: true })
    payment_reference: string | null;

    @Column({ type: "uuid" })
    renewed_by: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "renewed_by" })
    user: User;

    @CreateDateColumn({ type: "timestamptz" })
    renewed_at: Date;
}
