import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from "typeorm";
import { PurchaseOrder } from "./PurchaseOrder";
import { DeliveryNote } from "./DeliveryNote";
import { Vendor } from "./Vendor";

export enum InvoiceStatus {
    PENDING = "pending",
    MATCHED = "matched",
    DISCREPANCY = "discrepancy",
    PAID = "paid"
}

@Entity("supplier_invoices")
@Index("IDX_supplier_invoice_vendor_number", ["vendor_id", "invoice_number"], { unique: true })
export class SupplierInvoice {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column()
    invoice_number: string;

    @ManyToOne(() => Vendor)
    @JoinColumn({ name: "vendor_id" })
    vendor: Vendor;

    @Column()
    vendor_id: string;

    @ManyToOne(() => PurchaseOrder, { nullable: true })
    @JoinColumn({ name: "po_id" })
    purchase_order: PurchaseOrder | null;

    @Column({ nullable: true, type: "uuid" })
    po_id: string | null;

    @ManyToOne(() => DeliveryNote, { nullable: true })
    @JoinColumn({ name: "delivery_note_id" })
    delivery_note: DeliveryNote | null;

    @Column({ type: "uuid", nullable: true })
    delivery_note_id: string | null;

    @Column("date")
    invoice_date: Date;

    @Column("decimal", { precision: 12, scale: 2, default: 0 })
    subtotal: number;

    @Column("decimal", { precision: 12, scale: 2 })
    total_amount: number;

    @Column("decimal", { precision: 12, scale: 2, default: 0 })
    tax_amount: number;

    @Column("decimal", { precision: 12, scale: 2, default: 0 })
    paid_amount: number;

    @Column("decimal", { precision: 12, scale: 2, default: 0 })
    balance_due: number;

    @Column({ nullable: true, type: "text" })
    notes: string | null;

    @Column({ type: "varchar", nullable: true })
    payment_terms: string | null;

    @Column({ type: "uuid", nullable: true })
    created_by: string | null;

    @Column({ type: "timestamptz", nullable: true })
    manual_reviewed_at: Date | null;

    @Column({ type: "uuid", nullable: true })
    manual_reviewed_by: string | null;

    @Column({
        type: "enum",
        enum: InvoiceStatus,
        default: InvoiceStatus.PENDING
    })
    status: InvoiceStatus;

    @Column("date")
    due_date: Date;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;
}
