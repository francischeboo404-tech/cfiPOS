import {
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    Column,
} from "typeorm";
import { Promotion } from "./Promotion";
import { User } from "./User";

@Entity("promotion_audit_events")
export class PromotionAuditEvent {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @ManyToOne(() => Promotion, { onDelete: "RESTRICT" })
    @JoinColumn({ name: "promotion_id" })
    promotion: Promotion;

    @ManyToOne(() => User, { onDelete: "RESTRICT" })
    @JoinColumn({ name: "actor_id" })
    actor: User;

    @Column({ type: "varchar", length: 30 })
    action: string;

    @Column({ type: "jsonb", nullable: true })
    before_state: Record<string, unknown> | null;

    @Column({ type: "jsonb" })
    after_state: Record<string, unknown>;

    @Column({ type: "text", nullable: true })
    reason: string | null;

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;
}
