import { Request, Response } from "express";
import { AppDataSource } from "../data-source";
import {
    InstallmentAuditEvent,
    InstallmentPlan,
} from "../entity/InstallmentEntities";
import { Setting } from "../entity/Setting";
import { AuthenticatedRequest } from "../middleware/auth";
import {
    INSTALLMENT_LIFECYCLE_READY,
    isInstallmentUuid,
    kesFromCents,
    parseStoredInstallmentCents,
    percentFromBasisPoints,
    sanitizeInstallmentPlanPayload,
    sanitizeInstallmentSettingsPayload,
} from "../lib/installmentRules";

const SETTINGS_SUBJECT_ID = "00000000-0000-0000-0000-000000000001";
const INSTALLMENT_SETTING_KEYS = [
    "installments_enabled",
    "installment_max_open_credit_cents",
    "installment_cancellation_fee_percent_bps",
    "installment_charge_vat_on_interest",
    "installment_retention_years",
] as const;

const VALIDATION_ERRORS = new Set([
    "Installment plan must be an object",
    "Installment settings must be an object",
    "At least one installment setting is required",
]);

const toPlanResponse = (plan: InstallmentPlan) => ({
    id: plan.id,
    name: plan.name,
    active: plan.active,
    number_of_installments: plan.number_of_installments,
    frequency: plan.frequency,
    min_deposit_percent: percentFromBasisPoints(plan.min_deposit_percent_bps),
    interest_type: plan.interest_type,
    interest_rate_percent: percentFromBasisPoints(plan.interest_rate_bps),
    release_mode: plan.release_mode,
    min_financed_amount: kesFromCents(plan.min_financed_cents),
    max_financed_amount: kesFromCents(plan.max_financed_cents),
    created_at: plan.created_at,
    updated_at: plan.updated_at,
});

const auditPlan = async (
    manager: typeof AppDataSource.manager,
    actorId: string,
    action: string,
    plan: InstallmentPlan,
    beforeState: Record<string, unknown> | null,
) => {
    await manager.save(InstallmentAuditEvent, manager.create(InstallmentAuditEvent, {
        subject_type: "plan",
        subject_id: plan.id,
        action,
        before_state: beforeState,
        after_state: toPlanResponse(plan) as unknown as Record<string, unknown>,
        reason: null,
        actor_id: actorId,
    }));
};

const planValues = (input: unknown) => {
    const payload = sanitizeInstallmentPlanPayload(input);
    return {
        ...payload,
        min_financed_cents: payload.min_financed_cents,
        max_financed_cents: payload.max_financed_cents,
    };
};

const serializeSettings = (settings: Setting[]) => {
    const values = new Map(settings.map((setting) => [setting.key, setting.value]));
    const parseIntegerSetting = (key: string, fallback: number): number => {
        const raw = values.get(key);
        if (raw === undefined || raw === null) return fallback;
        if (!/^\d+$/.test(raw)) throw new Error(`Invalid stored installment setting: ${key}`);
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid stored installment setting: ${key}`);
        return parsed;
    };
    const getBoolean = (key: string, fallback: boolean): boolean => {
        const raw = values.get(key);
        if (raw === undefined || raw === null) return fallback;
        if (raw !== "true" && raw !== "false") throw new Error(`Invalid stored installment setting: ${key}`);
        return raw === "true";
    };
    const installmentsEnabled = getBoolean("installments_enabled", false);
    return {
        installments_enabled: INSTALLMENT_LIFECYCLE_READY && installmentsEnabled,
        installment_max_open_credit_amount: kesFromCents(
            parseStoredInstallmentCents(
                values.get("installment_max_open_credit_cents"),
                "installment_max_open_credit_cents",
            ),
        ),
        installment_cancellation_fee_percent: percentFromBasisPoints(
            parseIntegerSetting("installment_cancellation_fee_percent_bps", 0),
        ),
        installment_charge_vat_on_interest: getBoolean("installment_charge_vat_on_interest", false),
        installment_retention_years: parseIntegerSetting("installment_retention_years", 7),
    };
};

const isValidationError = (error: unknown): error is Error =>
    error instanceof Error && (
        VALIDATION_ERRORS.has(error.message) ||
        error.message.startsWith("Plan name") ||
        error.message.startsWith("Unknown installment setting:") ||
        /^(name|number_of_installments|active|frequency|interest_type|release_mode|min_deposit_percent|interest_rate_percent|min_financed_amount|max_financed_amount|installments_enabled|installment_charge_vat_on_interest|installment_max_open_credit_amount|installment_cancellation_fee_percent|installment_retention_years|Unknown installment (plan field|setting:))/.test(error.message)
    );

export class InstallmentPlanController {
    static async listPlans(_req: Request, res: Response) {
        try {
            const plans = await AppDataSource.getRepository(InstallmentPlan).find({
                order: { active: "DESC", name: "ASC" },
            });
            return res.json(plans.map(toPlanResponse));
        } catch (error) {
            console.error("Error listing installment plans:", error);
            return res.status(500).json({ message: "Error listing installment plans" });
        }
    }

    static async createPlan(req: AuthenticatedRequest, res: Response) {
        try {
            if (!req.user?.id) return res.status(401).json({ message: "Authenticated user is required" });
            const values = planValues(req.body);
            const plan = await AppDataSource.transaction(async (manager) => {
                const created = await manager.save(InstallmentPlan, manager.create(InstallmentPlan, values));
                await auditPlan(manager, req.user!.id, "plan_created", created, null);
                return created;
            });
            return res.status(201).json(toPlanResponse(plan));
        } catch (error) {
            if (isValidationError(error)) return res.status(400).json({ message: error.message });
            if ((error as { code?: string })?.code === "23505") {
                return res.status(409).json({ message: "An installment plan with this name already exists" });
            }
            console.error("Error creating installment plan:", error);
            return res.status(500).json({ message: "Error creating installment plan" });
        }
    }

    static async updatePlan(req: AuthenticatedRequest, res: Response) {
        try {
            if (!req.user?.id) return res.status(401).json({ message: "Authenticated user is required" });
            if (!isInstallmentUuid(req.params.id)) {
                return res.status(400).json({ message: "Plan id must be a valid UUID" });
            }
            const values = planValues(req.body);
            const result = await AppDataSource.transaction(async (manager) => {
                const existing = await manager.findOne(InstallmentPlan, {
                    where: { id: req.params.id },
                    lock: { mode: "pessimistic_write" },
                });
                if (!existing) return null;
                const beforeState = toPlanResponse(existing) as unknown as Record<string, unknown>;
                manager.merge(InstallmentPlan, existing, values);
                const saved = await manager.save(existing);
                await auditPlan(manager, req.user!.id, "plan_updated", saved, beforeState);
                return saved;
            });
            if (!result) return res.status(404).json({ message: "Installment plan not found" });
            return res.json(toPlanResponse(result));
        } catch (error) {
            if (isValidationError(error)) return res.status(400).json({ message: error.message });
            if ((error as { code?: string })?.code === "23505") {
                return res.status(409).json({ message: "An installment plan with this name already exists" });
            }
            console.error("Error updating installment plan:", error);
            return res.status(500).json({ message: "Error updating installment plan" });
        }
    }

    static async deactivatePlan(req: AuthenticatedRequest, res: Response) {
        try {
            if (!req.user?.id) return res.status(401).json({ message: "Authenticated user is required" });
            if (!isInstallmentUuid(req.params.id)) {
                return res.status(400).json({ message: "Plan id must be a valid UUID" });
            }
            const result = await AppDataSource.transaction(async (manager) => {
                const existing = await manager.findOne(InstallmentPlan, {
                    where: { id: req.params.id },
                    lock: { mode: "pessimistic_write" },
                });
                if (!existing) return null;
                if (!existing.active) return existing;
                const beforeState = toPlanResponse(existing) as unknown as Record<string, unknown>;
                existing.active = false;
                const saved = await manager.save(existing);
                await auditPlan(manager, req.user!.id, "plan_deactivated", saved, beforeState);
                return saved;
            });
            if (!result) return res.status(404).json({ message: "Installment plan not found" });
            return res.json(toPlanResponse(result));
        } catch (error) {
            console.error("Error deactivating installment plan:", error);
            return res.status(500).json({ message: "Error deactivating installment plan" });
        }
    }

    static async getSettings(_req: Request, res: Response) {
        try {
            const settings = await AppDataSource.getRepository(Setting).findBy(
                INSTALLMENT_SETTING_KEYS.map((key) => ({ key })),
            );
            return res.json(serializeSettings(settings));
        } catch (error) {
            console.error("Error fetching installment settings:", error);
            return res.status(500).json({ message: "Error fetching installment settings" });
        }
    }

    static async saveSettings(req: AuthenticatedRequest, res: Response) {
        try {
            if (!req.user?.id) return res.status(401).json({ message: "Authenticated user is required" });
            const updates = sanitizeInstallmentSettingsPayload(req.body);
            if (updates.installments_enabled === "true" && !INSTALLMENT_LIFECYCLE_READY) {
                return res.status(409).json({
                    message: "Installment selling cannot be enabled until agreement, payment, and stock handover controls are complete",
                });
            }
            const updated = await AppDataSource.transaction(async (manager) => {
                const keys = Object.keys(updates);
                const current = await manager.find(Setting, { where: keys.map((key) => ({ key })) });
                const beforeState = Object.fromEntries(
                    current.map((setting) => [setting.key, setting.value]),
                ) as Record<string, unknown>;
                const saved = await Promise.all(Object.entries(updates).map(([key, value]) =>
                    manager.save(Setting, manager.create(Setting, { key, value })),
                ));
                const afterState = Object.fromEntries(saved.map((setting) => [setting.key, setting.value]));
                await manager.save(InstallmentAuditEvent, manager.create(InstallmentAuditEvent, {
                    subject_type: "settings",
                    subject_id: SETTINGS_SUBJECT_ID,
                    action: "settings_updated",
                    before_state: beforeState,
                    after_state: afterState,
                    reason: null,
                    actor_id: req.user!.id,
                }));
                return manager.find(Setting, { where: INSTALLMENT_SETTING_KEYS.map((key) => ({ key })) });
            });
            return res.json(serializeSettings(updated));
        } catch (error) {
            if (isValidationError(error)) return res.status(400).json({ message: error.message });
            console.error("Error saving installment settings:", error);
            return res.status(500).json({ message: "Error saving installment settings" });
        }
    }
}
