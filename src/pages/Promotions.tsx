import { FormEvent, useCallback, useEffect, useState } from "react";
import { ApiService } from "@/lib/api";
import { parseKesToCents, formatKesCents } from "@/lib/exactMoney";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pencil, Plus, X } from "lucide-react";

type DiscountType = "percent" | "fixed_discount" | "fixed_price";

interface ProductOption {
  id: string;
  name: string;
  sku: string;
  retail_price: string | number;
  unit_of_measure: string;
}

interface PromotionItem {
  id: string;
  product_id: string;
  product_name: string;
  unit_of_measure: string;
  discount_type: DiscountType;
  discount_value: string;
  min_qty: number;
  max_qty_per_sale: number | null;
  total_quota_qty: number | null;
  used_qty: number;
  loss_override_reason: string | null;
  is_active: boolean;
}

interface Promotion {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  status: "scheduled" | "active" | "expired" | "cancelled";
  status_override: string | null;
  items: PromotionItem[];
}

interface PromotionReportRow {
  promotion_id: string;
  promotion_name: string;
  product_id: string;
  product_name: string;
  units_sold: number;
  promotion_discount: string;
  net_revenue: string;
  vat: string;
  cogs: string;
  sale_count: number;
}

interface PromotionAuditRecord {
  id: string;
  action: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown>;
  reason: string | null;
  actor_id: string;
  created_at: string;
}

interface ItemDraft {
  product_id: string;
  discount_type: DiscountType;
  discount_value: string;
  min_qty: string;
  max_qty_per_sale: string;
  total_quota_qty: string;
  loss_override_reason: string;
}

const emptyItem = (): ItemDraft => ({
  product_id: "",
  discount_type: "percent",
  discount_value: "",
  min_qty: "1",
  max_qty_per_sale: "",
  total_quota_qty: "",
  loss_override_reason: "",
});

const toNairobiInput = (value: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
};

const fromNairobiInput = (value: string) => {
  const parsed = new Date(`${value}:00+03:00`);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Enter a valid EAT date and time");
  return parsed.toISOString();
};

const toDraftItem = (item: PromotionItem): ItemDraft => ({
  product_id: item.product_id,
  discount_type: item.discount_type,
  discount_value: item.discount_value,
  min_qty: String(item.min_qty),
  max_qty_per_sale: item.max_qty_per_sale === null ? "" : String(item.max_qty_per_sale),
  total_quota_qty: item.total_quota_qty === null ? "" : String(item.total_quota_qty),
  loss_override_reason: item.loss_override_reason || "",
});

export default function Promotions() {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [report, setReport] = useState<PromotionReportRow[]>([]);
  const [auditPromotionId, setAuditPromotionId] = useState<string | null>(null);
  const [auditRecords, setAuditRecords] = useState<PromotionAuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [reason, setReason] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [productRows, promotionRows, reportRows] = await Promise.all([
        ApiService.get<ProductOption[]>("/products"),
        ApiService.get<Promotion[]>("/promotions"),
        ApiService.get<PromotionReportRow[]>("/reports/promotions"),
      ]);
      setProducts(Array.isArray(productRows) ? productRows : []);
      setPromotions(Array.isArray(promotionRows) ? promotionRows : []);
      setReport(Array.isArray(reportRows) ? reportRows : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load promotions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setStartsAt("");
    setEndsAt("");
    setItems([emptyItem()]);
    setReason("");
  };

  const startEditing = (promotion: Promotion) => {
    setEditingId(promotion.id);
    setName(promotion.name);
    setStartsAt(toNairobiInput(promotion.starts_at));
    setEndsAt(toNairobiInput(promotion.ends_at));
    setItems(promotion.items.filter((item) => item.is_active).map(toDraftItem));
    setReason("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const updateItem = (index: number, patch: Partial<ItemDraft>) => {
    setItems((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...patch } : item));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name,
        starts_at: fromNairobiInput(startsAt),
        ends_at: fromNairobiInput(endsAt),
        reason: reason || undefined,
        items: items.map((item) => {
          const product = products.find((candidate) => candidate.id === item.product_id);
          if (!product) throw new Error("Select a product for each promotion line");
          return {
            product_id: product.id,
            unit_of_measure: product.unit_of_measure,
            discount_type: item.discount_type,
            discount_value: item.discount_value,
            min_qty: Number(item.min_qty),
            max_qty_per_sale: item.max_qty_per_sale ? Number(item.max_qty_per_sale) : null,
            total_quota_qty: item.total_quota_qty ? Number(item.total_quota_qty) : null,
            loss_override_reason: item.loss_override_reason || null,
          };
        }),
      };
      if (editingId) {
        await ApiService.put(`/promotions/${editingId}`, payload);
        toast.success("Promotion updated");
      } else {
        await ApiService.post("/promotions", payload);
        toast.success("Promotion created");
      }
      resetForm();
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save promotion");
    } finally {
      setSaving(false);
    }
  };

  const cancelPromotion = async (promotion: Promotion) => {
    const cancellationReason = window.prompt(`Reason for cancelling "${promotion.name}"?`);
    if (!cancellationReason?.trim()) return;
    try {
      await ApiService.post(`/promotions/${promotion.id}/cancel`, {
        reason: cancellationReason.trim(),
      });
      toast.success("Promotion cancelled");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not cancel promotion");
    }
  };

  const showAudit = async (promotionId: string) => {
    try {
      const events = await ApiService.get<PromotionAuditRecord[]>(`/promotions/${promotionId}/audit`);
      setAuditPromotionId(promotionId);
      setAuditRecords(Array.isArray(events) ? events : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load promotion audit history");
    }
  };

  const reportTotalDiscountCents = report.reduce(
    (sum, row) => sum + parseKesToCents(row.promotion_discount),
    0,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Timed promotions</h1>
        <p className="text-muted-foreground">
          Schedule product offers using Kenya time (EAT). Promotion periods use an inclusive start and exclusive end.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{editingId ? "Edit promotion" : "Create promotion"}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-1">
                <Label htmlFor="promotion-name">Promotion name</Label>
                <Input id="promotion-name" value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="promotion-start">Starts (EAT)</Label>
                <Input id="promotion-start" type="datetime-local" value={startsAt} required onChange={(event) => setStartsAt(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="promotion-end">Ends (EAT, exclusive)</Label>
                <Input id="promotion-end" type="datetime-local" value={endsAt} required onChange={(event) => setEndsAt(event.target.value)} />
              </div>
            </div>

            <div className="space-y-4">
              {items.map((item, index) => (
                <div key={`${editingId || "new"}-${index}`} className="grid gap-3 rounded-lg border p-4 md:grid-cols-4">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Product</Label>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={item.product_id}
                      required
                      onChange={(event) => updateItem(index, { product_id: event.target.value })}
                    >
                      <option value="">Select product</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} · {product.sku} · {product.unit_of_measure}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>Offer type</Label>
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={item.discount_type}
                      onChange={(event) => updateItem(index, { discount_type: event.target.value as DiscountType })}
                    >
                      <option value="percent">Percentage off</option>
                      <option value="fixed_discount">KES off per unit</option>
                      <option value="fixed_price">Fixed unit price</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>Value {item.discount_type === "percent" ? "(%)" : "(KES)"}</Label>
                    <Input value={item.discount_value} required inputMode="decimal" placeholder="e.g. 10.00" onChange={(event) => updateItem(index, { discount_value: event.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Minimum quantity</Label>
                    <Input type="number" min={1} step={1} value={item.min_qty} required onChange={(event) => updateItem(index, { min_qty: event.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Maximum per sale (optional)</Label>
                    <Input type="number" min={1} step={1} value={item.max_qty_per_sale} onChange={(event) => updateItem(index, { max_qty_per_sale: event.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Total quota (optional)</Label>
                    <Input type="number" min={1} step={1} value={item.total_quota_qty} onChange={(event) => updateItem(index, { total_quota_qty: event.target.value })} />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Below-cost override reason (if required)</Label>
                    <Input value={item.loss_override_reason} maxLength={500} onChange={(event) => updateItem(index, { loss_override_reason: event.target.value })} />
                  </div>
                  <div className="flex items-end">
                    <Button type="button" variant="outline" disabled={items.length === 1} onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                      <X className="mr-2 h-4 w-4" /> Remove line
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" onClick={() => setItems((current) => [...current, emptyItem()])}>
                <Plus className="mr-2 h-4 w-4" /> Add product
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="promotion-reason">Change reason (for audit)</Label>
              <Input id="promotion-reason" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : editingId ? "Save changes" : "Create promotion"}
              </Button>
              {editingId && <Button type="button" variant="outline" onClick={resetForm}>Stop editing</Button>}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Promotions</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {loading ? <p className="text-sm text-muted-foreground">Loading promotions...</p> : promotions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No promotions have been created.</p>
          ) : promotions.map((promotion) => (
            <div key={promotion.id} className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{promotion.name}</span>
                  <Badge variant={promotion.status === "active" ? "default" : "secondary"}>{promotion.status}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {new Date(promotion.starts_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })} – {new Date(promotion.ends_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })} EAT
                </p>
                <ul className="text-sm">
                  {promotion.items.filter((item) => item.is_active).map((item) => (
                    <li key={item.id}>
                      {item.product_name}: {item.discount_type === "percent"
                        ? `${item.discount_value}% off`
                        : item.discount_type === "fixed_discount"
                          ? `KES ${item.discount_value} off per ${item.unit_of_measure}`
                          : `KES ${item.discount_value} per ${item.unit_of_measure}`}
                      {" · "}min {item.min_qty}
                      {item.total_quota_qty !== null && ` · ${item.used_qty}/${item.total_quota_qty} used`}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => void showAudit(promotion.id)}>
                  Audit history
                </Button>
                <Button type="button" variant="outline" disabled={promotion.status === "cancelled"} onClick={() => startEditing(promotion)}>
                  <Pencil className="mr-2 h-4 w-4" /> Edit
                </Button>
                <Button type="button" variant="destructive" disabled={promotion.status === "cancelled"} onClick={() => void cancelPromotion(promotion)}>
                  Cancel
                </Button>
              </div>
              {auditPromotionId === promotion.id && (
                <div className="basis-full rounded-md bg-muted/50 p-3 text-xs">
                  <div className="mb-2 flex items-center justify-between font-medium">
                    <span>Immutable audit history</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setAuditPromotionId(null)}>Close</Button>
                  </div>
                  {auditRecords.length === 0 ? <p>No audit events recorded.</p> : (
                    <ol className="space-y-2">
                      {auditRecords.map((event) => (
                        <li key={event.id} className="border-t pt-2">
                          <div>{event.action} · {new Date(event.created_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })} EAT · actor {event.actor_id}</div>
                          {event.reason && <div>Reason: {event.reason}</div>}
                          <details className="mt-1">
                            <summary className="cursor-pointer">Before / after</summary>
                            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{JSON.stringify({ before: event.before_state, after: event.after_state }, null, 2)}</pre>
                          </details>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Promotion performance</CardTitle>
          <p className="text-sm text-muted-foreground">
            Recorded promotional discount: {formatKesCents(reportTotalDiscountCents)}
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead><tr className="border-b text-muted-foreground">
              <th className="p-2">Promotion / product</th><th className="p-2">Units</th>
              <th className="p-2">Promo discount</th><th className="p-2">Net revenue</th>
              <th className="p-2">VAT</th><th className="p-2">COGS</th><th className="p-2">Sales</th>
            </tr></thead>
            <tbody>
              {report.map((row) => (
                <tr key={`${row.promotion_id}-${row.product_id}`} className="border-b">
                  <td className="p-2">{row.promotion_name} · {row.product_name}</td>
                  <td className="p-2">{row.units_sold}</td>
                  <td className="p-2">{formatKesCents(parseKesToCents(row.promotion_discount))}</td>
                  <td className="p-2">{formatKesCents(parseKesToCents(row.net_revenue))}</td>
                  <td className="p-2">{formatKesCents(parseKesToCents(row.vat))}</td>
                  <td className="p-2">{formatKesCents(parseKesToCents(row.cogs))}</td>
                  <td className="p-2">{row.sale_count}</td>
                </tr>
              ))}
              {report.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">No promotion sales recorded.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
