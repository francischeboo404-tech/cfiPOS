import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from "typeorm";

@Entity("installment_plans")
export class InstallmentPlan {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "varchar", length: 100 })
    name: string;

    @Column({ type: "boolean", default: true })
    active: boolean;

    @Column({ type: "integer" })
    number_of_installments: number;

    @Column({ type: "varchar", length: 20 })
    frequency: string;

    @Column({ type: "integer" })
    min_deposit_percent_bps: number;

    @Column({ type: "varchar", length: 20 })
    interest_type: string;

    @Column({ type: "integer" })
    interest_rate_bps: number;

    @Column({ type: "varchar", length: 30 })
    release_mode: string;

    @Column({ type: "bigint", nullable: true })
    min_financed_cents: string | null;

    @Column({ type: "bigint", nullable: true })
    max_financed_cents: string | null;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;

    @UpdateDateColumn({ type: "timestamptz" })
    updated_at: Date;
}

@Entity("installment_agreements")
@Index("UQ_installment_agreements_number", ["agreement_number"], { unique: true })
@Index("UQ_installment_agreements_idempotency", ["idempotency_key"], { unique: true })
export class InstallmentAgreement {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "varchar", length: 20 })
    agreement_number: string;

    @Column({ type: "uuid" })
    idempotency_key: string;

    @Column({ type: "uuid" })
    customer_id: string;

    @Column({ type: "uuid", nullable: true })
    plan_id: string | null;

    @Column({ type: "jsonb" })
    terms_snapshot: Record<string, unknown>;

    @Column({ type: "varchar", length: 100 })
    customer_name_snapshot: string;

    @Column({ type: "varchar", length: 32 })
    customer_phone_snapshot: string;

    @Column({ type: "varchar", length: 64 })
    customer_national_id_snapshot: string;

    @Column({ type: "uuid", nullable: true })
    warehouse_id: string | null;

    @Column({ type: "date" })
    agreement_date: string;

    @Column({ type: "bigint" })
    price_total_cents: string;

    @Column({ type: "bigint" })
    deposit_cents: string;

    @Column({ type: "bigint" })
    financed_cents: string;

    @Column({ type: "bigint" })
    interest_cents: string;

    @Column({ type: "bigint" })
    total_payable_cents: string;

    @Column({ type: "varchar", length: 30 })
    release_mode: string;

    @Column({ type: "uuid" })
    created_by: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}

@Entity("installment_agreement_items")
export class InstallmentAgreementItem {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "uuid" })
    product_id: string;

    @Column({ type: "varchar", length: 200 })
    product_name_snapshot: string;

    @Column({ type: "varchar", length: 100 })
    sku_snapshot: string;

    @Column({ type: "varchar", length: 64 })
    unit_of_measure_snapshot: string;

    @Column({ type: "integer" })
    quantity: number;

    @Column({ type: "bigint" })
    unit_price_cents: string;

    @Column({ type: "bigint" })
    line_total_cents: string;

    @Column({ type: "integer" })
    tax_rate_bps: number;

    @Column({ type: "jsonb" })
    price_snapshot: Record<string, unknown>;
}

@Entity("installment_schedules")
@Index("UQ_installment_schedules_number", ["agreement_id", "installment_number"], { unique: true })
export class InstallmentSchedule {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "integer" })
    installment_number: number;

    @Column({ type: "date" })
    due_date: string;

    @Column({ type: "bigint" })
    principal_cents: string;

    @Column({ type: "bigint" })
    interest_cents: string;
}

@Entity("installment_payments")
@Index("UQ_installment_payments_idempotency", ["idempotency_key"], { unique: true })
export class InstallmentPayment {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "date" })
    payment_date: string;

    @Column({ type: "bigint" })
    amount_cents: string;

    @Column({ type: "varchar", length: 20 })
    payment_method: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    reference_number: string | null;

    @Column({ type: "uuid" })
    recorded_by: string;

    @Column({ type: "uuid" })
    idempotency_key: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}

@Entity("installment_payment_allocations")
export class InstallmentPaymentAllocation {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    payment_id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "integer" })
    installment_number: number;

    @Column({ type: "bigint" })
    principal_cents: string;

    @Column({ type: "bigint" })
    interest_cents: string;
}

@Entity("installment_payment_reversals")
@Index("UQ_installment_payment_reversals_payment", ["payment_id"], { unique: true })
export class InstallmentPaymentReversal {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    payment_id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "bigint" })
    amount_cents: string;

    @Column({ type: "text" })
    reason: string;

    @Column({ type: "uuid" })
    reversed_by: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}

@Entity("installment_reversal_allocations")
export class InstallmentReversalAllocation {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    reversal_id: string;

    @Column({ type: "uuid" })
    payment_allocation_id: string;

    @Column({ type: "integer" })
    installment_number: number;

    @Column({ type: "bigint" })
    principal_cents: string;

    @Column({ type: "bigint" })
    interest_cents: string;
}

@Entity("installment_stock_events")
export class InstallmentStockEvent {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "uuid" })
    agreement_item_id: string;

    @Column({ type: "uuid" })
    product_id: string;

    @Column({ type: "uuid", nullable: true })
    warehouse_id: string | null;

    @Column({ type: "integer" })
    quantity_delta: number;

    @Column({ type: "varchar", length: 20 })
    event_type: string;

    @Column({ type: "uuid" })
    actor_id: string;

    @Column({ type: "text", nullable: true })
    reason: string | null;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}

@Entity("installment_handover_events")
@Index("UQ_installment_handovers_agreement", ["agreement_id"], { unique: true })
export class InstallmentHandoverEvent {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "uuid", unique: true })
    sale_id: string;

    @Column({ type: "uuid" })
    actor_id: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}

@Entity("installment_cancellation_events")
@Index("UQ_installment_cancellations_agreement", ["agreement_id"], { unique: true })
export class InstallmentCancellationEvent {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "bigint" })
    fee_cents: string;

    @Column({ type: "bigint" })
    refund_cents: string;

    @Column({ type: "varchar", length: 20, nullable: true })
    refund_method: "CASH" | "MPESA" | "BANK_TRANSFER" | null;

    @Column({ type: "varchar", length: 100, nullable: true })
    refund_reference_number: string | null;

    @Column({ type: "text" })
    reason: string;

    @Column({ type: "uuid" })
    cancelled_by: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}

@Entity("installment_write_off_events")
export class InstallmentWriteOffEvent {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid" })
    agreement_id: string;

    @Column({ type: "bigint" })
    amount_cents: string;

    @Column({ type: "text" })
    reason: string;

    @Column({ type: "uuid" })
    written_off_by: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}

@Entity("installment_audit_events")
export class InstallmentAuditEvent {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "varchar", length: 30 })
    subject_type: string;

    @Column({ type: "uuid" })
    subject_id: string;

    @Column({ type: "varchar", length: 40 })
    action: string;

    @Column({ type: "jsonb", nullable: true })
    before_state: Record<string, unknown> | null;

    @Column({ type: "jsonb" })
    after_state: Record<string, unknown>;

    @Column({ type: "text", nullable: true })
    reason: string | null;

    @Column({ type: "uuid" })
    actor_id: string;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}

@Entity("loyalty_enrolments")
@Index("UQ_loyalty_enrolments_voucher", ["voucher_id"], { unique: true })
export class LoyaltyEnrolment {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "uuid", unique: true })
    customer_id: string;

    @Column({ type: "uuid", unique: true })
    voucher_id: string;

    @CreateDateColumn({ type: "timestamptz" })
    enrolled_at: Date;

    @Column({ type: "uuid", nullable: true })
    enrolled_by: string | null;

    @Column({ type: "varchar", length: 30 })
    source: string;
}
