import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from "typeorm";
import { User } from "./User";
import { PromotionItem } from "./PromotionItem";

export type PromotionOverrideStatus = "cancelled" | null;

@Entity("promotions")
export class Promotion {
    @PrimaryGeneratedColumn("uuid")
    id: string;

    @Column({ type: "varchar", length: 120 })
    name: string;

    @Column({ type: "timestamptz" })
    starts_at: Date;

    @Column({ type: "timestamptz" })
    ends_at: Date;

    @Column({ type: "varchar", length: 20, nullable: true })
    status_override: PromotionOverrideStatus;

    @ManyToOne(() => User, { nullable: false })
    @JoinColumn({ name: "created_by" })
    created_by: User;

    @ManyToOne(() => User, { nullable: false })
    @JoinColumn({ name: "updated_by" })
    updated_by: User;

    @OneToMany(() => PromotionItem, (item) => item.promotion)
    items: PromotionItem[];

    @CreateDateColumn({ type: "timestamptz" })
    created_at: Date;

    @UpdateDateColumn({ type: "timestamptz" })
    updated_at: Date;
}
