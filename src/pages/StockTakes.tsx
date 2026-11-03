import { useState, useEffect } from "react";
import { ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuthContext";
import { Plus, Play, CheckCircle } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

interface Warehouse {
  id: string;
  name: string;
}

interface StockTakeItem {
  id: string;
  product: { id: string; name: string; sku: string };
  expected_quantity: number;
  counted_quantity: number | null;
  discrepancy: number | null;
}

interface StockTake {
  id: string;
  warehouse: { name: string; id: string };
  status: string;
  notes: string;
  created_at: string;
  completed_at?: string | null;
  creator: { name: string };
  completer?: { name: string };
  items: StockTakeItem[];
}

export default function StockTakes() {
  const { role } = useAuth();
  const [stockTakes, setStockTakes] = useState<StockTake[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTake, setActiveTake] = useState<StockTake | null>(null);
  const [savingCounts, setSavingCounts] = useState(false);

  const [formData, setFormData] = useState({
    warehouse_id: "",
    notes: "",
  });

  // For counting view
  const [countItems, setCountItems] = useState<
    { id: string; counted_quantity: number | null }[]
  >([]);

  const canManageStockTakes = role === "admin" || role === "manager" || role === "supervisor";

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [stRes, whRes] = await Promise.all([
        ApiService.get<StockTake[]>("/inventory/stock-takes"),
        ApiService.get<Warehouse[]>("/warehouses"),
      ]);
      setStockTakes(stRes || []);
      setWarehouses(whRes || []);
    } catch (error) {
      toast.error(error.message || "Failed to load stock takes");
    }
  };

  const handleInitiate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await ApiService.post("/inventory/stock-takes", formData);
      toast.success("Stock Take initiated");
      setDialogOpen(false);
      setFormData({ warehouse_id: "", notes: "" });
      loadData();
    } catch (error) {
      toast.error(error.message || "Failed to initiate stock take");
    }
  };

  const openCountSheet = (take: StockTake) => {
    setActiveTake(take);
    setCountItems(
      take.items.map((i) => ({
        id: i.id,
        counted_quantity: i.counted_quantity,
      })),
    );
  };

  const updateCount = (itemId: string, val: string) => {
    if (activeTake?.status === "completed" || savingCounts) return;
    if (val !== "" && (!/^\d+$/.test(val) || !Number.isSafeInteger(Number(val)))) {
      toast.error("Count must be a non-negative whole number");
      return;
    }
    const qty = val === "" ? null : Number(val);
    setCountItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, counted_quantity: qty } : i)),
    );
  };

  const saveProgress = async () => {
    if (!activeTake || activeTake.status === "completed" || savingCounts) return;
    setSavingCounts(true);
    try {
      await ApiService.put(`/inventory/stock-takes/${activeTake.id}/items`, {
        items: countItems,
        status: "in_progress",
      });
      toast.success("Progress saved");
      loadData();
    } catch (error) {
      toast.error(error.message || "Failed to save progress");
    } finally {
      setSavingCounts(false);
    }
  };

  const saveAndClose = async () => {
    if (!activeTake || activeTake.status === "completed") {
      setActiveTake(null);
      return;
    }
    setSavingCounts(true);
    try {
      await ApiService.put(`/inventory/stock-takes/${activeTake.id}/items`, {
        items: countItems,
        status: "in_progress",
      });
      toast.success("Progress saved");
      setActiveTake(null);
      await loadData();
    } catch (error) {
      toast.error(error.message || "Failed to save progress");
    } finally {
      setSavingCounts(false);
    }
  };

  const completeStockTake = async () => {
    if (!activeTake || activeTake.status === "completed" || savingCounts) return;
    if (countItems.some((item) => item.counted_quantity === null)) {
      toast.error("Count every item before finalizing this stock take");
      return;
    }
    if (
      !confirm(
        "Are you sure you want to complete this stock take? This will automatically generate adjustments for discrepancies and update stock levels.",
      )
    )
      return;

    setSavingCounts(true);
    try {
      // First save current counts
      await ApiService.put(`/inventory/stock-takes/${activeTake.id}/items`, {
        items: countItems,
      });
      // Then complete
      await ApiService.post(
        `/inventory/stock-takes/${activeTake.id}/complete`,
        {},
      );
      toast.success("Stock Take completed and stock adjusted");
      setActiveTake(null);
      loadData();
    } catch (error) {
      toast.error(error.message || "Failed to complete stock take");
    } finally {
      setSavingCounts(false);
    }
  };

  const getStatusBadge = (status: string): React.ComponentProps<typeof Badge>["variant"] => {
    switch (status) {
      case "completed":
        return "default";
      case "in_progress":
        return "secondary";
      case "cancelled":
        return "destructive";
      case "pending":
        return "outline";
      default:
        return "outline";
    }
  };

  if (activeTake) {
    const readOnly = activeTake.status === "completed";
    return (
      <div className="min-w-0 space-y-4 p-2 sm:space-y-6 sm:p-6">
        <div className="sticky top-0 z-30 flex flex-col gap-3 border-b bg-background/95 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold sm:text-3xl">
              {readOnly ? "Completed Stock Take" : "Count Sheet"}: {activeTake.warehouse.name}
            </h1>
            <p className="text-muted-foreground">
              {readOnly
                ? "Finalized counts are read-only for audit purposes. Start a new stock take to recount."
                : "Enter counted quantities below"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!readOnly && (
              <>
                <Button
                  variant="outline"
                  onClick={saveAndClose}
                  disabled={savingCounts}
                >
                  {savingCounts ? "Saving..." : "Save & Close"}
                </Button>
                <Button
                  onClick={completeStockTake}
                  disabled={
                    savingCounts ||
                    countItems.some((item) => item.counted_quantity === null)
                  }
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {savingCounts ? "Finalizing..." : "Finalize Count"}
                </Button>
              </>
            )}
            {readOnly && (
              <Button variant="outline" onClick={() => setActiveTake(null)}>
                Close details
              </Button>
            )}
          </div>
        </div>

        <Card>
          <CardContent className="min-w-0 pt-4 sm:pt-6">
            {readOnly && activeTake.completed_at && (
              <p className="mb-4 text-sm text-muted-foreground">
                Completed {new Date(activeTake.completed_at).toLocaleString()}
                {activeTake.completer?.name
                  ? ` by ${activeTake.completer.name}`
                  : ""}
              </p>
            )}
            <Table className="min-w-[680px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">System Expected</TableHead>
                  <TableHead className="text-right">Physical Count</TableHead>
                  <TableHead className="text-right">Discrepancy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeTake.items.map((item) => {
                  const currentCount = countItems.find(
                    (c) => c.id === item.id,
                  )?.counted_quantity;
                  const discrepancy =
                    currentCount !== null && currentCount !== undefined
                      ? currentCount - item.expected_quantity
                      : null;

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">
                        {item.product.name}
                      </TableCell>
                      <TableCell>{item.product.sku}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {item.expected_quantity}
                      </TableCell>
                      <TableCell className="min-w-[170px] text-right">
                        <Input
                          type="number"
                          className="w-24 ml-auto text-right"
                          value={currentCount ?? ""}
                          onChange={(e) => updateCount(item.id, e.target.value)}
                          disabled={readOnly || savingCounts}
                          min="0"
                          step="1"
                          aria-label={`Physical count for ${item.product.name}`}
                        />
                      </TableCell>
                      <TableCell
                        className={`text-right font-bold ${discrepancy && discrepancy < 0 ? "text-destructive" : discrepancy && discrepancy > 0 ? "text-green-600" : ""}`}
                      >
                        {discrepancy !== null
                          ? discrepancy > 0
                            ? `+${discrepancy}`
                            : discrepancy
                          : "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Stock Takes</h1>
          <p className="text-muted-foreground">
            Manage cycle counting and physical inventory reconciliation
          </p>
        </div>
        {canManageStockTakes && (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Initiate Stock Take
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Start New Stock Take</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleInitiate} className="space-y-4">
                <div>
                  <Label>Warehouse *</Label>
                  <Select
                    value={formData.warehouse_id}
                    onValueChange={(val) =>
                      setFormData({ ...formData, warehouse_id: val })
                    }
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select Warehouse to count" />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Notes / Reference</Label>
                  <Textarea
                    value={formData.notes}
                    onChange={(e) =>
                      setFormData({ ...formData, notes: e.target.value })
                    }
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit">Start Count</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stock Take History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date Started</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Items Counted</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stockTakes.map((take) => {
                const countedItems = take.items.filter(
                  (i) => i.counted_quantity !== null,
                ).length;
                return (
                  <TableRow key={take.id}>
                    <TableCell>
                      {new Date(take.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-medium">
                      {take.warehouse?.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusBadge(take.status)}>
                        {take.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {countedItems} / {take.items.length}
                    </TableCell>
                    <TableCell className="max-w-xs truncate">
                      {take.notes}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManageStockTakes &&
                        (take.status === "pending" ||
                          take.status === "in_progress") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openCountSheet(take)}
                          >
                            <Play className="h-4 w-4 mr-1" /> Resume
                          </Button>
                        )}
                      {take.status === "completed" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`View completed stock take for ${take.warehouse?.name || "warehouse"}`}
                          onClick={() => openCountSheet(take)}
                        >
                          View Details
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
