import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { CustomerVoucher } from "./CustomerVoucher";
import { User } from "./User";

@Entity("voucher_card_print_logs")
export class VoucherCardPrintLog {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    voucher_id: string;

    @ManyToOne(() => CustomerVoucher)
    @JoinColumn({ name: "voucher_id" })
    voucher: CustomerVoucher;

    @Column({ type: "uuid" })
    printed_by: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "printed_by" })
    user: User;

    @CreateDateColumn({ type: "timestamptz" })
    printed_at: Date;
}
