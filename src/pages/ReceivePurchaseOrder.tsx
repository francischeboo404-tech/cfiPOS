import { useCallback, useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { ArrowLeft, Package, AlertTriangle } from "lucide-react";
import { useAuth } from "@/hooks/useAuthContext";
import { Badge } from "@/components/ui/badge";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";

interface POItem {
  id: string;
  product_id: string;
  quantity: number;
  received_quantity: number;
  unit_cost: number;
  products: { id: string; name: string; stock_on_hand: number } | null;
}

interface ReceiveItem extends POItem {
  receiving_quantity: number;
  batch_number: string;
  expiry_date: string;
  manufacturing_date: string;
  supplier_batch_reference: string;
  environmental_conditions: string;
  rejection_reason: string;
  rejected_quantity: number;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor_id: string;
  warehouse_id: string | null;
  warehouse: { name: string } | null;
  total_amount: number;
  vendors: { name: string } | null;
  vendor?: { name: string } | null;
}

interface PurchaseOrderItemResponse extends Omit<POItem, "products"> {
  product: NonNullable<POItem["products"]>;
}

interface PurchaseOrderDetail extends PurchaseOrder {
  items: PurchaseOrderItemResponse[];
}

export default function ReceivePurchaseOrder() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, role } = useAuth();
  const [loading, setLoading] = useState(false);
  const [po, setPO] = useState<PurchaseOrder | null>(null);
  const [items, setItems] = useState<ReceiveItem[]>([]);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const loadPO = useCallback(async () => {
    if (!id) return;

    try {
      const data = await ApiService.get<PurchaseOrderDetail>(
        `/purchase-orders/${id}`,
      );
      if (data) {
        setPO(data);
        setReference((current) => current || data.po_number);

        const receiveItems: ReceiveItem[] = data.items.map((item) => ({
          id: item.id,
          quantity: item.quantity,
          received_quantity: item.received_quantity,
          unit_cost: item.unit_cost,
          product_id: item.product.id,
          products: item.product,
          receiving_quantity: item.quantity - (item.received_quantity || 0),
          batch_number: "",
          expiry_date: "",
          manufacturing_date: "",
          supplier_batch_reference: "",
          environmental_conditions: "",
          rejection_reason: "",
          rejected_quantity: 0,
        }));

        setItems(receiveItems);
      }
    } catch (error) {
      console.error(error);
      toast.error("Failed to load purchase order details");
    }
  }, [id]);

  useEffect(() => {
    if (role !== "admin") {
      toast.error("Access denied");
      navigate("/purchase-orders");
      return;
    }
    void loadPO();
  }, [loadPO, navigate, role]);

  const updateReceivingQuantity = (itemId: string, value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      toast.error("Receiving quantity must be a non-negative whole number");
      return;
    }
    setItems(
      items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              receiving_quantity: Math.min(
                value,
                item.quantity - (item.received_quantity || 0),
              ),
              rejected_quantity: Math.max(
                0,
                item.quantity - (item.received_quantity || 0) - value,
              ),
            }
          : item,
      ),
    );
  };

  const calculateReceivingLineCents = (item: ReceiveItem): bigint | null => {
    try {
      return BigInt(item.receiving_quantity) *
        BigInt(parseKesToCents(String(item.unit_cost)));
    } catch {
      return null;
    }
  };

  const calculateReceivingTotalCents = (): bigint | null => {
    const lineValues = items.map(calculateReceivingLineCents);
    if (lineValues.some((value) => value === null)) return null;
    return lineValues.reduce((sum, value) => sum + (value ?? 0n), 0n);
  };

  const updateItemField = <K extends keyof ReceiveItem,>(
    itemId: string,
    field: K,
    value: ReceiveItem[K],
  ) => {
    setItems(
      items.map((item) =>
        item.id === itemId ? { ...item, [field]: value } : item,
      ),
    );
  };

  const handleReceive = async () => {
    if (!po || !user?.id) return;

    const hasItemsToReceive = items.some((item) => item.receiving_quantity > 0);
    if (!hasItemsToReceive) {
      toast.error("No items to receive");
      return;
    }

    setLoading(true);

    try {
      const payload = {
        user_id: user.id,
        reference,
        notes: notes,
        items: items.map((item) => ({
          po_item_id: item.id,
          product_id: item.product_id,
          ordered_quantity: item.quantity,
          receiving_quantity: item.receiving_quantity,
          rejected_quantity: item.rejected_quantity,
          rejection_reason: item.rejection_reason,
          unit_cost: item.unit_cost,
          batch_number: item.batch_number,
          expiry_date: item.expiry_date,
          manufacturing_date: item.manufacturing_date,
          supplier_batch_reference: item.supplier_batch_reference,
          environmental_conditions: item.environmental_conditions,
        })),
      };

      const response = await ApiService.post<{ grn: string }>(
        `/purchase-orders/${po.id}/receive`,
        payload,
      );

      toast.success(`Goods received successfully. GRN: ${response.grn}`);
      navigate("/purchase-orders"); // or delivery-notes if that exists in frontend
    } catch (error) {
      console.error("Error receiving goods:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Server error while receiving goods",
      );
    } finally {
      setLoading(false);
    }
  };

  if (!po) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Package className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">Loading purchase order...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="ghost" onClick={() => navigate("/purchase-orders")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div>
          <h1 className="text-3xl font-bold">Receive Goods</h1>
          <p className="text-muted-foreground">
            PO #{po.po_number} - {po.vendor?.name || po.vendors?.name}{" "}
            · Receiving at {po.warehouse?.name || "Main warehouse"}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Items to Receive
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {items.map((item) => {
            const remainingToReceive =
              item.quantity - (item.received_quantity || 0);
            const isPartiallyReceived = (item.received_quantity || 0) > 0;

            return (
              <div key={item.id} className="p-4 border rounded-lg space-y-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-semibold text-lg">
                      {item.products?.name}
                    </h3>
                    <div className="flex gap-2 mt-1">
                      <Badge variant="outline">
                        Current Stock: {item.products?.stock_on_hand || 0}
                      </Badge>
                      {isPartiallyReceived && (
                        <Badge variant="secondary">
                          Previously Received: {item.received_quantity}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">
                      Ordered / Remaining
                    </p>
                    <p className="text-2xl font-bold">
                      {item.quantity} / {remainingToReceive}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-4">
                  <div className="space-y-2">
                    <Label htmlFor={`receiving-${item.id}`}>
                      Receiving Quantity
                    </Label>
                    <Input
                      id={`receiving-${item.id}`}
                      type="number"
                      min="0"
                      max={remainingToReceive}
                      value={item.receiving_quantity}
                      onChange={(e) =>
                        updateReceivingQuantity(
                          item.id,
                          e.target.value === "" ? 0 : Number(e.target.value),
                        )
                      }
                      className="text-lg font-semibold"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`batch-${item.id}`}>Batch Number</Label>
                    <Input
                      id={`batch-${item.id}`}
                      value={item.batch_number}
                      onChange={(e) =>
                        updateItemField(item.id, "batch_number", e.target.value)
                      }
                      placeholder="Optional"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`supplier-ref-${item.id}`}>
                      Supplier Batch Ref
                    </Label>
                    <Input
                      id={`supplier-ref-${item.id}`}
                      value={item.supplier_batch_reference}
                      onChange={(e) =>
                        updateItemField(
                          item.id,
                          "supplier_batch_reference",
                          e.target.value,
                        )
                      }
                      placeholder="Optional"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`env-cond-${item.id}`}>
                      Env Conditions
                    </Label>
                    <Input
                      id={`env-cond-${item.id}`}
                      value={item.environmental_conditions}
                      onChange={(e) =>
                        updateItemField(
                          item.id,
                          "environmental_conditions",
                          e.target.value,
                        )
                      }
                      placeholder="e.g. Keep frozen"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`mfg-${item.id}`}>Mfg Date</Label>
                    <Input
                      id={`mfg-${item.id}`}
                      type="date"
                      value={item.manufacturing_date}
                      onChange={(e) =>
                        updateItemField(
                          item.id,
                          "manufacturing_date",
                          e.target.value,
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`expiry-${item.id}`}>Expiry Date</Label>
                    <Input
                      id={`expiry-${item.id}`}
                      type="date"
                      value={item.expiry_date}
                      onChange={(e) =>
                        updateItemField(item.id, "expiry_date", e.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2 md:col-span-1 lg:col-span-2">
                    <Label>Line Total</Label>
                    <Input
                      value={
                        calculateReceivingLineCents(item) === null
                          ? "Invalid amount"
                          : formatKesCents(
                              calculateReceivingLineCents(item) ?? 0n,
                            )
                      }
                      disabled
                    />
                  </div>
                </div>

                {item.receiving_quantity < remainingToReceive && (
                  <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md p-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 space-y-2">
                        <p className="text-sm text-amber-800 dark:text-amber-200">
                          Partial receipt: {item.receiving_quantity} of{" "}
                          {remainingToReceive} remaining
                        </p>
                        <div className="space-y-1">
                          <Label
                            htmlFor={`rejection-${item.id}`}
                            className="text-xs"
                          >
                            Rejection Reason (if applicable)
                          </Label>
                          <Input
                            id={`rejection-${item.id}`}
                            value={item.rejection_reason}
                            onChange={(e) =>
                              updateItemField(
                                item.id,
                                "rejection_reason",
                                e.target.value,
                              )
                            }
                            placeholder="e.g., Damaged, Wrong item, Quality issue"
                            className="bg-white dark:bg-background"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div className="space-y-2">
            <Label htmlFor="purchase-reference">Supplier Invoice / Reference</Label>
            <Input
              id="purchase-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              maxLength={120}
              placeholder={`Default: ${po.po_number}`}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Delivery Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional notes about this delivery..."
              rows={3}
            />
          </div>

          <div className="flex justify-between items-center pt-4 border-t">
            <div>
              <p className="text-sm text-muted-foreground">
                Total Receiving Value
              </p>
              <p className="text-2xl font-bold">
                {calculateReceivingTotalCents() === null
                  ? "Invalid amount"
                  : formatKesCents(calculateReceivingTotalCents() ?? 0n)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => navigate("/purchase-orders")}
              >
                Cancel
              </Button>
              <Button onClick={handleReceive} disabled={loading}>
                {loading ? "Processing..." : "Confirm Receipt & Create GRN"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
