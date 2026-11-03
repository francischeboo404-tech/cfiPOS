import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, OneToMany } from "typeorm";
import { User } from "./User";
import { SaleItem } from "./SaleItem";
import { Customer } from "./Customer";
import { Warehouse } from "./Warehouse";

export enum PaymentMethod {
    CASH = "cash",
    MPESA = "mpesa",
    HYBRID = "hybrid",
    STORE_CREDIT = "store_credit"
}

export enum SaleStatus {
    COMPLETED = "completed",
    PENDING = "pending",
    VOIDED = "voided",
    PARTIALLY_REFUNDED = "partially_refunded",
    PARKED = "parked"
}

export enum EtimsStatus {
    NOT_APPLICABLE = "not_applicable",
    PENDING = "pending",
    SUBMITTED = "submitted",
    FAILED = "failed",
}

@Entity("sales")
export class Sale {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "cashier_id" })
    cashier: User;

    @ManyToOne(() => Warehouse, { nullable: true })
    @JoinColumn({ name: "warehouse_id" })
    warehouse: Warehouse | null;

    @ManyToOne(() => Customer, customer => customer.sales, { nullable: true })
    @JoinColumn({ name: "customer_id" })
    customer: Customer | null;

    @Column("decimal", { precision: 10, scale: 2 })
    subtotal: number;

    @Column("decimal", { precision: 10, scale: 2 })
    tax_amount: number;

    @Column("decimal", { precision: 10, scale: 2 })
    total_amount: number;

    @Column({
        type: "enum",
        enum: PaymentMethod
    })
    payment_method: PaymentMethod;

    @Column({
        type: "enum",
        enum: SaleStatus,
        default: SaleStatus.COMPLETED
    })
    status: SaleStatus;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    cash_amount: number;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    mpesa_amount: number;

    @Column({ type: "varchar", default: "pending" })
    payment_status: string;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    change_amount: number;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    store_credit_amount: number;

    @Column({ type: "varchar", length: 20, nullable: true })
    store_credit_barcode: string | null;

    @Column("decimal", { precision: 10, scale: 2, default: 0 })
    loyalty_discount: number;

    @Column({ type: "uuid", nullable: true })
    voucher_id: string | null;

    @Column("bigint", { default: 0 })
    voucher_points_earned: string;

    @Column("bigint", { default: 0 })
    voucher_points_redeemed: string;

    @Column("bigint", { nullable: true })
    voucher_balance_after: string | null;

    @Column({ type: "date", nullable: true })
    voucher_expiry_date: string | null;

    @Column({ type: "varchar", nullable: true })
    idempotency_key: string | null;

    // Pesapal Integration fields
    @Column({ nullable: true })
    pesapal_tracking_id: string;

    @Column({ nullable: true })
    pesapal_status: string; // 'pending', 'completed', 'failed'

    // ETIMS Compliance fields
    @Column("bigint", { nullable: true })
    etims_invoice_number: string | null;

    @Column({ type: "varchar", length: 32, default: "not_applicable" })
    etims_status: EtimsStatus;

    @Column("int", { default: 0 })
    etims_attempts: number;

    @Column("text", { nullable: true })
    etims_last_error: string | null;

    @Column({ type: "timestamptz", nullable: true })
    etims_submitted_at: Date | null;

    @Column({ type: "varchar", nullable: true })
    etims_receipt_no: string | null;

    @Column("text", { nullable: true })
    etims_qr_code: string | null;

    @Column("text", { nullable: true })
    etims_signature: string | null;

    @CreateDateColumn()
    created_at: Date;

    @Column({ type: "timestamptz", nullable: true })
    offline_created_at: Date | null;

    @OneToMany(() => SaleItem, saleItem => saleItem.sale)
    items: SaleItem[];
}
