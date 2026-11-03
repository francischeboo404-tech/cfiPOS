import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Save, Ban } from "lucide-react";
import { ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuthContext";

type Frequency = "WEEKLY" | "EVERY_2_WEEKS" | "MONTHLY";
type InterestType = "FLAT_TOTAL" | "FLAT_PER_MONTH";
type ReleaseMode = "HOLD_UNTIL_PAID" | "RELEASE_AFTER_DEPOSIT";

interface InstallmentPlan {
  id: string;
  name: string;
  active: boolean;
  number_of_installments: number;
  frequency: Frequency;
  min_deposit_percent: string;
  interest_type: InterestType;
  interest_rate_percent: string;
  release_mode: ReleaseMode;
  min_financed_amount: string | null;
  max_financed_amount: string | null;
}

interface InstallmentSettings {
  installments_enabled: boolean;
  installment_max_open_credit_amount: string;
  installment_cancellation_fee_percent: string;
  installment_charge_vat_on_interest: boolean;
  installment_retention_years: number;
}

const emptyPlan = (): Omit<InstallmentPlan, "id"> => ({
  name: "",
  active: true,
  number_of_installments: 5,
  frequency: "MONTHLY",
  min_deposit_percent: "10.00",
  interest_type: "FLAT_TOTAL",
  interest_rate_percent: "0.00",
  release_mode: "HOLD_UNTIL_PAID",
  min_financed_amount: null,
  max_financed_amount: null,
});

const defaultSettings: InstallmentSettings = {
  installments_enabled: false,
  installment_max_open_credit_amount: "0.00",
  installment_cancellation_fee_percent: "0.00",
  installment_charge_vat_on_interest: false,
  installment_retention_years: 7,
};

export default function InstallmentPlans() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const [plans, setPlans] = useState<InstallmentPlan[]>([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [draft, setDraft] = useState<Omit<InstallmentPlan, "id">>(emptyPlan());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingPlan, setSavingPlan] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [loadedPlans, loadedSettings] = await Promise.all([
        ApiService.get<InstallmentPlan[]>("/installments/plans"),
        ApiService.get<InstallmentSettings>("/installments/settings"),
      ]);
      if (!Array.isArray(loadedPlans) || !loadedSettings || typeof loadedSettings !== "object") {
        throw new Error("The server returned invalid installment plan data");
      }
      setPlans(loadedPlans);
      setSettings({ ...loadedSettings, installments_enabled: false });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load installment plans");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const savePlan = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingPlan(true);
    try {
      if (editingId) {
        await ApiService.put(`/installments/plans/${editingId}`, draft);
        toast.success("Installment plan updated");
      } else {
        await ApiService.post("/installments/plans", draft);
        toast.success("Installment plan created");
      }
      setDraft(emptyPlan());
      setEditingId(null);
      await loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save installment plan");
    } finally {
      setSavingPlan(false);
    }
  };

  const editPlan = (plan: InstallmentPlan) => {
    setEditingId(plan.id);
    setDraft({
      name: plan.name,
      active: plan.active,
      number_of_installments: plan.number_of_installments,
      frequency: plan.frequency,
      min_deposit_percent: plan.min_deposit_percent,
      interest_type: plan.interest_type,
      interest_rate_percent: plan.interest_rate_percent,
      release_mode: plan.release_mode,
      min_financed_amount: plan.min_financed_amount,
      max_financed_amount: plan.max_financed_amount,
    });
  };

  const deactivatePlan = async (plan: InstallmentPlan) => {
    try {
      await ApiService.delete(`/installments/plans/${plan.id}`);
      toast.success("Installment plan deactivated");
      if (editingId === plan.id) {
        setDraft(emptyPlan());
        setEditingId(null);
      }
      await loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to deactivate plan");
    }
  };

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAdmin) {
      toast.error("Only administrators can update global installment settings");
      return;
    }
    setSavingSettings(true);
    try {
      const saved = await ApiService.put<InstallmentSettings>("/installments/settings", settings);
      setSettings(saved);
      toast.success("Installment settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save installment settings");
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Installment Plans</h1>
        <p className="text-sm text-muted-foreground">
          Configure new agreements. Existing agreements keep their original terms.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Global settings</CardTitle>
          <CardDescription>These settings apply only when creating new agreements.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveSettings} className="grid gap-4 md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={false}
                disabled
              />
              Installment selling is locked until agreement, payment, and handover controls are complete
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.installment_charge_vat_on_interest}
                disabled={!isAdmin}
                onChange={(event) => setSettings({
                  ...settings,
                  installment_charge_vat_on_interest: event.target.checked,
                })}
              />
              Charge VAT on interest (confirm with accountant)
            </label>
            <div className="space-y-2">
              <Label htmlFor="max-open-credit">Maximum open credit per customer (KES; 0 = no limit)</Label>
              <Input
                id="max-open-credit"
                inputMode="decimal"
                value={settings.installment_max_open_credit_amount}
                disabled={!isAdmin}
                onChange={(event) => setSettings({
                  ...settings,
                  installment_max_open_credit_amount: event.target.value,
                })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cancellation-fee">Cancellation fee for held agreements (%)</Label>
              <Input
                id="cancellation-fee"
                inputMode="decimal"
                value={settings.installment_cancellation_fee_percent}
                disabled={!isAdmin}
                onChange={(event) => setSettings({
                  ...settings,
                  installment_cancellation_fee_percent: event.target.value,
                })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="retention-years">Record retention years (minimum 7)</Label>
              <Input
                id="retention-years"
                type="number"
                min={7}
                max={100}
                step={1}
                value={settings.installment_retention_years}
                disabled={!isAdmin}
                onChange={(event) => setSettings({
                  ...settings,
                  installment_retention_years: Number(event.target.value),
                })}
              />
            </div>
            <div className="md:col-span-2">
              {isAdmin ? (
                <Button type="submit" disabled={savingSettings}>
                  <Save className="mr-2 h-4 w-4" />
                  {savingSettings ? "Saving..." : "Save settings"}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only administrators can update global installment settings.
                </p>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Plans</CardTitle>
            <CardDescription>Plans can be deactivated but never deleted.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? <p className="text-sm text-muted-foreground">Loading plans...</p> : null}
            {!loading && plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">No installment plans configured.</p>
            ) : null}
            {plans.map((plan) => (
              <div key={plan.id} className="flex flex-col justify-between gap-3 rounded-md border p-4 sm:flex-row">
                <div>
                  <p className="font-semibold">{plan.name} {!plan.active && "(Inactive)"}</p>
                  <p className="text-sm text-muted-foreground">
                    {plan.number_of_installments} × {plan.frequency.replace(/_/g, " ").toLowerCase()} ·
                    {" "}{plan.interest_type.replace(/_/g, " ").toLowerCase()} {plan.interest_rate_percent}% ·
                    {" "}{plan.release_mode.replace(/_/g, " ").toLowerCase()}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Minimum deposit {plan.min_deposit_percent}% · financing range{" "}
                    {plan.min_financed_amount || "no minimum"} to {plan.max_financed_amount || "no maximum"} KES
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" type="button" onClick={() => editPlan(plan)}>Edit</Button>
                  {plan.active ? (
                    <Button variant="outline" type="button" onClick={() => void deactivatePlan(plan)}>
                      <Ban className="mr-2 h-4 w-4" />
                      Deactivate
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{editingId ? "Edit plan" : "Create plan"}</CardTitle>
            <CardDescription>Rates and terms are snapshotted when an agreement is confirmed.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={savePlan} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="plan-name">Plan name</Label>
                <Input id="plan-name" maxLength={100} required value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="installments-count">Number of installments (1–120)</Label>
                <Input id="installments-count" type="number" min={1} max={120} step={1} required
                  value={draft.number_of_installments}
                  onChange={(event) => setDraft({ ...draft, number_of_installments: Number(event.target.value) })} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="frequency">Frequency</Label>
                  <select id="frequency" className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={draft.frequency}
                    onChange={(event) => setDraft({ ...draft, frequency: event.target.value as Frequency })}>
                    <option value="WEEKLY">Weekly</option>
                    <option value="EVERY_2_WEEKS">Every 2 weeks</option>
                    <option value="MONTHLY">Monthly</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="deposit-percent">Minimum deposit (%)</Label>
                  <Input id="deposit-percent" inputMode="decimal" required value={draft.min_deposit_percent}
                    onChange={(event) => setDraft({ ...draft, min_deposit_percent: event.target.value })} />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="interest-type">Interest type</Label>
                  <select id="interest-type" className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={draft.interest_type}
                    onChange={(event) => setDraft({ ...draft, interest_type: event.target.value as InterestType })}>
                    <option value="FLAT_TOTAL">Flat total</option>
                    <option value="FLAT_PER_MONTH">Flat per month</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="interest-rate">Interest rate (%)</Label>
                  <Input id="interest-rate" inputMode="decimal" required value={draft.interest_rate_percent}
                    onChange={(event) => setDraft({ ...draft, interest_rate_percent: event.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="release-mode">Goods release</Label>
                <select id="release-mode" className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={draft.release_mode}
                  onChange={(event) => setDraft({ ...draft, release_mode: event.target.value as ReleaseMode })}>
                  <option value="HOLD_UNTIL_PAID">Hold until fully paid</option>
                  <option value="RELEASE_AFTER_DEPOSIT">Release after deposit</option>
                </select>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="min-financed">Minimum financed amount (KES)</Label>
                  <Input id="min-financed" inputMode="decimal" value={draft.min_financed_amount || ""}
                    onChange={(event) => setDraft({ ...draft, min_financed_amount: event.target.value || null })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max-financed">Maximum financed amount (KES)</Label>
                  <Input id="max-financed" inputMode="decimal" value={draft.max_financed_amount || ""}
                    onChange={(event) => setDraft({ ...draft, max_financed_amount: event.target.value || null })} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.active}
                  onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />
                Active for new agreements
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={savingPlan}>
                  <Save className="mr-2 h-4 w-4" />
                  {savingPlan ? "Saving..." : editingId ? "Update plan" : "Create plan"}
                </Button>
                <Button type="button" variant="outline" onClick={() => {
                  setDraft(emptyPlan());
                  setEditingId(null);
                }}>
                  <Plus className="mr-2 h-4 w-4" />
                  New plan
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
