import { Check, Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from "typeorm";
import { Customer } from "./Customer";

@Entity("customer_vouchers")
@Check("CHK_customer_vouchers_number_format", '"voucher_number" ~ \'^[0-9]{10}$\'')
export class CustomerVoucher {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid", unique: true })
    customer_id: string;

    @OneToOne(() => Customer)
    @JoinColumn({ name: "customer_id" })
    customer: Customer;

    @Column({ type: "varchar", length: 10, unique: true })
    voucher_number: string;

    @Column({ type: "date" })
    issue_date: string;

    @Column({ type: "date" })
    expiry_date: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}
