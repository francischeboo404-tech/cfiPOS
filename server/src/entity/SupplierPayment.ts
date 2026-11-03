import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { SupplierInvoice } from "./SupplierInvoice";
import { Vendor } from "./Vendor";
import { User } from "./User";

export enum SupplierPaymentMethod {
    BANK_TRANSFER = "bank_transfer",
    CASH = "cash",
    MPESA = "mpesa",
    CHEQUE = "cheque",
}

@Entity("supplier_payments")
@Index("UQ_supplier_payments_idempotency_key", ["idempotency_key"], {
    unique: true,
    where: '"idempotency_key" IS NOT NULL',
})
export class SupplierPayment {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    supplier_invoice_id: string;

    @ManyToOne(() => SupplierInvoice)
    @JoinColumn({ name: "supplier_invoice_id" })
    supplier_invoice: SupplierInvoice;

    @Column()
    vendor_id: string;

    @ManyToOne(() => Vendor)
    @JoinColumn({ name: "vendor_id" })
    vendor: Vendor;

    @Column("decimal", { precision: 12, scale: 2 })
    amount: string;

    @Column({ default: "bank_transfer" })
    payment_method: SupplierPaymentMethod;

    @Column({ type: "varchar", nullable: true })
    reference_number: string | null;

    @Column({ type: "date" })
    payment_date: Date;

    @Column({ nullable: true, type: "text" })
    notes: string | null;

    @Column()
    paid_by: string;

    @Column({ type: "uuid", nullable: true })
    idempotency_key: string | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: "paid_by" })
    payer: User;

    @CreateDateColumn()
    created_at: Date;
}
