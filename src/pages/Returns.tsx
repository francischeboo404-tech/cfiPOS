import { useState, useEffect } from "react";
import { ApiService } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  RefreshCw,
  Plus,
  Search,
  RotateCcw,
  Package,
  AlertTriangle,
  Eye,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuthContext";
import { Checkbox } from "@/components/ui/checkbox";
import {
  formatKesCents,
  parseKesToCents,
} from "@/lib/exactMoney";

interface ReturnItem {
  id: string;
  quantity: number;
  condition: string;
  sale_item: {
    id: string;
    quantity: number;
    unit_price: number | string;
    tax_rate: number | string;
    line_total?: number | string;
    line_total_cents?: string | null;
    discount_cents?: string | null;
    net_revenue_cents?: string | null;
    vat_cents?: string | null;
    returnable_quantity?: number;
    approved_returned_quantity?: number;
    product: { name: string };
  };
}

interface Return {
  id: string;
  sale_id?: string;
  invoice_number?: string | null;
  reason: string;
  status: string;
  refund_method: string;
  created_at: string;
  rejection_reason: string | null;
  mpesa_refund_status: "not_required" | "pending" | "completed";
  mpesa_refund_amount: number | string;
  mpesa_refund_receipt: string | null;
  mpesa_refund_completed_at: string | null;
  pesapal_refund_logged: boolean;
  pesapal_refund_notes: string | null;
  store_credit_voucher?: {
    barcode: string;
    current_balance: number | string;
    status: string;
    expires_at: string | null;
  } | null;
  sale?: Sale;
  requested_by?: { id: string; email?: string; profile?: { full_name?: string } | null } | null;
  approved_by?: { id: string; email?: string; profile?: { full_name?: string } | null } | null;
  items?: ReturnItem[];
}

interface SaleItem {
  id: string;
  quantity: number;
  unit_price: number | string;
  tax_rate: number | string;
  line_total?: number | string;
  line_total_cents?: string | null;
  discount_cents?: string | null;
  net_revenue_cents?: string | null;
  vat_cents?: string | null;
  returnable_quantity: number;
  approved_returned_quantity: number;
  product: { name: string } | null;
}

interface Sale {
  id: string;
  invoice_number: string;
  status: string;
  payment_status: string;
  total_amount: number | string;
  created_at: string;
  payment_method: string;
  items: SaleItem[];
}

export default function Returns() {
  const { user, role } = useAuth();
  const [returns, setReturns] = useState<Return[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [viewingReturn, setViewingReturn] = useState<Return | null>(null);

  // Request Modal State
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [saleSearchTerm, setSaleSearchTerm] = useState("");
  const [salesSearchResults, setSalesSearchResults] = useState<Sale[]>([]);
  const [searchingSales, setSearchingSales] = useState(false);

  // selectedItems: { sale_item_id: quantity_to_return }
  const [selectedReturnItems, setSelectedReturnItems] = useState<
    Record<string, number>
  >({});

  // Approval Modal State
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [approvingReturn, setApprovingReturn] = useState<Return | null>(null);
  const [itemConditions, setItemConditions] = useState<Record<string, string>>(
    {},
  );
  const [refundMethod, setRefundMethod] = useState<string>("cash");
  const [payoutDialogOpen, setPayoutDialogOpen] = useState(false);
  const [payoutReturn, setPayoutReturn] = useState<Return | null>(null);
  const [mpesaReceipt, setMpesaReceipt] = useState("");
  const [recordingPayout, setRecordingPayout] = useState(false);

  const [formData, setFormData] = useState({
    reason: "",
    refund_method: "cash",
  });

  useEffect(() => {
    loadReturns();
  }, []);

  const loadReturns = async () => {
    setLoading(true);
    try {
      const data = await ApiService.get<Return[]>("/returns");
      if (!Array.isArray(data)) {
        throw new Error("The returns service returned an invalid response");
      }
      setReturns(data);
    } catch (error: unknown) {
      toast.error(
        "Error loading returns: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    } finally {
      setLoading(false);
    }
  };

  const searchSales = async () => {
    const invoiceNumber = saleSearchTerm.trim();
    if (!invoiceNumber) {
      toast.error("Enter an invoice number to search");
      return;
    }

    setSearchingSales(true);
    try {
      const results = await ApiService.get<Sale[]>(
        `/returns/search?invoice_number=${encodeURIComponent(invoiceNumber)}`,
      );
      setSalesSearchResults(results);
      setSelectedSale(null);
      setSelectedReturnItems({});
      if (results.length === 0) {
        toast.info("No returnable sale found for that invoice number");
      }
    } catch (error) {
      toast.error("Error searching invoice: " + error.message);
    } finally {
      setSearchingSales(false);
    }
  };

  const handleSelectSale = (sale: Sale) => {
    setSelectedSale(sale);
    setSelectedReturnItems({});
  };

  const handleToggleItem = (
    itemId: string,
    maxQty: number,
    checked: boolean,
  ) => {
    const newItems = { ...selectedReturnItems };
    if (checked) {
      newItems[itemId] = maxQty;
    } else {
      delete newItems[itemId];
    }
    setSelectedReturnItems(newItems);
  };

  const handleUpdateItemQuantity = (
    itemId: string,
    maxQty: number,
    value: string,
  ) => {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= maxQty) {
      setSelectedReturnItems({ ...selectedReturnItems, [itemId]: parsed });
    }
  };

  const calculateReturnAmountCents = () => {
    if (!selectedSale) return 0n;
    let totalCents = 0n;
    for (const itemId in selectedReturnItems) {
      const saleItem = selectedSale.items.find((i) => i.id === itemId);
      if (saleItem) {
        const qty = selectedReturnItems[itemId];
        const lineGrossCents = saleItem.line_total_cents !== null &&
            saleItem.line_total_cents !== undefined
          ? BigInt(saleItem.line_total_cents)
          : saleItem.line_total !== undefined
            ? BigInt(parseKesToCents(String(saleItem.line_total)))
            : BigInt(parseKesToCents(String(saleItem.unit_price))) *
              BigInt(saleItem.quantity);
        const lineDiscountCents = BigInt(saleItem.discount_cents || "0");
        const netRevenueCents = saleItem.net_revenue_cents !== null &&
            saleItem.net_revenue_cents !== undefined
          ? BigInt(saleItem.net_revenue_cents)
          : lineGrossCents - lineDiscountCents;
        let vatCents: bigint;
        if (saleItem.vat_cents !== null && saleItem.vat_cents !== undefined) {
          vatCents = BigInt(saleItem.vat_cents);
        } else {
          const rateMatch = /^(\d+)(?:\.(\d{1,2}))?$/.exec(
            String(saleItem.tax_rate).trim(),
          );
          if (!rateMatch) {
            throw new Error("Tax rate must have at most two decimal places");
          }
          const rateBasisPoints = BigInt(rateMatch[1]) * 100n +
            BigInt((rateMatch[2] || "").padEnd(2, "0") || "0");
          const vatNumerator = lineGrossCents * rateBasisPoints;
          vatCents = (vatNumerator + 5_000n) / 10_000n;
        }
        const returnedBefore = saleItem.approved_returned_quantity;
        const returnedAfter = returnedBefore + qty;
        const quantity = BigInt(saleItem.quantity);
        const allocateShare = (amount: bigint) =>
          amount * BigInt(returnedAfter) / quantity -
          amount * BigInt(returnedBefore) / quantity;
        totalCents += allocateShare(netRevenueCents) + allocateShare(vatCents);
      }
    }
    return totalCents;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedSale) {
      toast.error("Please select a sale to return");
      return;
    }

    const itemsPayload = Object.keys(selectedReturnItems).map((id) => ({
      sale_item_id: id,
      quantity: selectedReturnItems[id],
    }));

    if (itemsPayload.length === 0) {
      toast.error("Please select at least one item to return");
      return;
    }

    try {
      await ApiService.post<Return>("/returns/request", {
        sale_id: selectedSale.id,
        reason: formData.reason,
        items: itemsPayload,
      });

      toast.success("Return request created successfully");
      setDialogOpen(false);
      setSelectedSale(null);
      setSalesSearchResults([]);
      setSaleSearchTerm("");
      setSelectedReturnItems({});
      setFormData({
        reason: "",
        refund_method: "cash",
      });
      loadReturns();
    } catch (error) {
      toast.error(error.message || "Error creating return request");
    }
  };

  const openApproveDialog = (ret: Return) => {
    setApprovingReturn(ret);
    const initialConditions: Record<string, string> = {};
    ret.items?.forEach((item) => {
      initialConditions[item.id] = "sellable";
    });
    setItemConditions(initialConditions);
    setApprovalDialogOpen(true);
  };

  const submitApproveReturn = async () => {
    if (!approvingReturn) return;
    try {
      const conditionsPayload = Object.keys(itemConditions).map((id) => ({
        return_item_id: id,
        condition: itemConditions[id],
      }));

      const response: { storeCreditBarcode?: string; message?: string; mpesaRefundPending?: boolean } = await ApiService.post(
        "/admin/returns/approve/" + approvingReturn.id,
        {
          items_conditions: conditionsPayload,
          refund_method: refundMethod,
        },
      );

      toast.success(
        response.storeCreditBarcode
          ? `Return approved. Walk-in store credit voucher: ${response.storeCreditBarcode}`
          : response.message || "Return approved successfully",
        { duration: 10000 },
      );
      if (response.mpesaRefundPending) {
        toast.info("Return approved. Complete the M-Pesa payout, then record its Safaricom receipt.");
      }
      setApprovalDialogOpen(false);
      setApprovingReturn(null);
      loadReturns();
    } catch (error) {
      toast.error(error.message || "Error approving return");
    }
  };

  const openPayoutDialog = (ret: Return) => {
    setPayoutReturn(ret);
    setMpesaReceipt("");
    setPayoutDialogOpen(true);
  };

  const submitMpesaPayout = async () => {
    if (!payoutReturn || !mpesaReceipt.trim()) {
      toast.error("Enter the Safaricom receipt for the completed payout");
      return;
    }

    setRecordingPayout(true);
    try {
      await ApiService.post(
        `/admin/returns/${payoutReturn.id}/mpesa-payout`,
        { receipt_number: mpesaReceipt.trim() },
      );
      toast.success("M-Pesa payout recorded and reconciled");
      setPayoutDialogOpen(false);
      setPayoutReturn(null);
      setMpesaReceipt("");
      await loadReturns();
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Error recording M-Pesa payout",
      );
    } finally {
      setRecordingPayout(false);
    }
  };

  const rejectReturn = async (id: string) => {
    const reason = prompt("Enter rejection reason (optional):");
    try {
      await ApiService.post("/admin/returns/reject/" + id, {
        rejection_reason: reason,
      });
      toast.success("Return rejected");
      loadReturns();
    } catch (error) {
      toast.error(error.message || "Error rejecting return");
    }
  };

  const filteredReturns = returns.filter(
    (ret) => {
      const saleId = ret.sale_id || ret.sale?.id || "";
      const search = searchTerm.toLowerCase();
      return (
        saleId.toLowerCase().includes(search) ||
        ret.reason.toLowerCase().includes(search)
      );
    },
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case "approved":
        return "default";
      case "pending":
        return "secondary";
      case "rejected":
        return "destructive";
      default:
        return "secondary";
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
            <RotateCcw className="h-7 w-7" />
            Returns & Refunds
          </h1>
          <p className="text-muted-foreground">
            Manage product returns and authorize refunds
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Request Return
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Create Partial/Full Return Request</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label>Search Original Sale Invoice</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Enter invoice number..."
                    value={saleSearchTerm}
                    onChange={(e) => {
                      setSaleSearchTerm(e.target.value);
                      setSalesSearchResults([]);
                      setSelectedSale(null);
                      setSelectedReturnItems({});
                    }}
                    onKeyDown={(e) =>
                      e.key === "Enter" && (e.preventDefault(), searchSales())
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={searchSales}
                    disabled={searchingSales}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {salesSearchResults.length > 0 && (
                <div className="border rounded-lg max-h-48 overflow-y-auto">
                  {salesSearchResults.map((sale) => (
                    <div
                      key={sale.id}
                      onClick={() => handleSelectSale(sale)}
                      className={`p-3 cursor-pointer hover:bg-muted transition-colors border-b last:border-b-0 ${
                        selectedSale?.id === sale.id
                          ? "bg-primary/10 border-primary"
                          : ""
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-mono text-sm">
                            {sale.invoice_number}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(sale.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <p className="font-semibold">
                          {formatKesCents(parseKesToCents(String(sale.total_amount)))}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {selectedSale && (
                <div className="space-y-4">
                  <div className="p-3 bg-muted rounded-lg border">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4" />
                        <span className="font-semibold">
                          Select Items to Return
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
                      {selectedSale.items?.map((item) => {
                        const isSelected = Object.prototype.hasOwnProperty.call(
                          selectedReturnItems,
                          item.id,
                        );
                        return (
                          <div
                            key={item.id}
                            className="flex items-center justify-between p-2 bg-background border rounded-md"
                          >
                            <div className="flex items-center gap-3">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={(checked) =>
                                  handleToggleItem(
                                    item.id,
                                    item.returnable_quantity,
                                    checked as boolean,
                                  )
                                }
                                disabled={item.returnable_quantity === 0}
                              />
                              <div>
                                <p className="text-sm font-medium">
                                  {item.product?.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  Purchased: {item.quantity} | Remaining:{" "}
                                  {item.returnable_quantity} |{" "}
                                  {formatKesCents(
                                    parseKesToCents(String(item.unit_price)),
                                  )}{" "}
                                  each
                                </p>
                              </div>
                            </div>
                            {isSelected && (
                              <div className="flex items-center gap-2">
                                <Label className="text-xs">Return Qty:</Label>
                                <Input
                                  type="number"
                                  className="w-20 h-8"
                                  min="1"
                                  max={item.returnable_quantity}
                                  value={selectedReturnItems[item.id]}
                                  onChange={(e) =>
                                    handleUpdateItemQuantity(
                                      item.id,
                                      item.returnable_quantity,
                                      e.target.value,
                                    )
                                  }
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-3 flex justify-between items-center text-sm font-bold pt-2 border-t">
                      <span>Estimated Refund:</span>
                      <span className="text-primary text-lg">
                        {formatKesCents(calculateReturnAmountCents())}
                      </span>
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="reason">Cashier Note / Reason</Label>
                    <Textarea
                      id="reason"
                      required
                      value={formData.reason}
                      onChange={(e) =>
                        setFormData({ ...formData, reason: e.target.value })
                      }
                      placeholder="Explain exactly why the customer is returning these specific items..."
                      rows={2}
                    />
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !selectedSale ||
                    Object.keys(selectedReturnItems).length === 0
                  }
                >
                  Submit Request to Manager
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <CardTitle>Requested Returns</CardTitle>
            <div className="flex gap-2">
              <div className="relative flex-1 sm:w-64">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Button variant="outline" size="icon" onClick={loadReturns}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table className="min-w-[1000px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Requested By</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8">
                      Loading returns...
                    </TableCell>
                  </TableRow>
                ) : filteredReturns.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center py-8 text-muted-foreground"
                    >
                      No returns found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredReturns.map((ret: Return) => (
                    <TableRow key={ret.id}>
                      <TableCell className="font-mono text-xs">
                        {ret.invoice_number || "Invoice unavailable"}
                      </TableCell>
                      <TableCell className="capitalize">
                        {ret.requested_by?.profile?.full_name ||
                          ret.requested_by?.email ||
                          "System"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {ret.items?.length || 0} Items
                        </Badge>
                        {ret.items?.map((item) => (
                          <span key={item.id} className="block text-xs mt-1">
                            {item.sale_item.product?.name || "Unknown item"} × {item.quantity}
                          </span>
                        ))}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-sm">
                        {ret.reason}
                        {ret.rejection_reason && (
                          <span className="text-xs text-red-500 block mt-1">
                            Rejected: {ret.rejection_reason}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={getStatusColor(ret.status)}
                          className="capitalize"
                        >
                          {ret.status}
                        </Badge>
                        {ret.refund_method === "mpesa" &&
                          ret.mpesa_refund_status === "pending" && (
                            <span className="block text-xs text-amber-600 mt-1">
                              M-Pesa payout pending
                            </span>
                          )}
                        {ret.mpesa_refund_receipt && (
                          <span className="block text-xs text-muted-foreground mt-1">
                            Receipt: {ret.mpesa_refund_receipt}
                          </span>
                        )}
                        {ret.store_credit_voucher && (
                          <span className="block text-xs mt-1">
                            Voucher: <strong>{ret.store_credit_voucher.barcode}</strong>
                            <br />
                            Balance:{" "}
                            {formatKesCents(
                              parseKesToCents(
                                String(ret.store_credit_voucher.current_balance),
                              ),
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(ret.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="min-w-[260px]">
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`View return for invoice ${ret.invoice_number || "unavailable"}`}
                            onClick={() => setViewingReturn(ret)}
                          >
                            <Eye className="mr-1 h-4 w-4" />
                            View
                          </Button>
                          {ret.status === "pending" &&
                            (role === "admin" ||
                              role === "supervisor" ||
                              role === "manager") && (
                            <>
                              <Button
                                size="sm"
                                onClick={() => openApproveDialog(ret)}
                              >
                                Review
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => rejectReturn(ret.id)}
                              >
                                Reject
                              </Button>
                            </>
                          )}
                          {ret.status === "pending" && role === "cashier" && (
                            <span className="text-xs text-muted-foreground italic">
                              Awaiting Mgmt
                            </span>
                          )}
                          {ret.status === "approved" &&
                            ret.refund_method === "mpesa" &&
                            ret.mpesa_refund_status === "pending" &&
                            (role === "admin" ||
                              role === "supervisor" ||
                              role === "manager") && (
                            <Button
                              size="sm"
                              onClick={() => openPayoutDialog(ret)}
                            >
                              Record payout
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={!!viewingReturn}
        onOpenChange={(open) => !open && setViewingReturn(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Return details
              {viewingReturn?.invoice_number
                ? ` - ${viewingReturn.invoice_number}`
                : ""}
            </DialogTitle>
            <DialogDescription>
              Review the original sale, returned items, decision, and refund details.
            </DialogDescription>
          </DialogHeader>
          {viewingReturn && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge
                    variant={getStatusColor(viewingReturn.status)}
                    className="mt-1 capitalize"
                  >
                    {viewingReturn.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Requested</p>
                  <p className="font-medium">
                    {new Date(viewingReturn.created_at).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Requested by</p>
                  <p className="font-medium">
                    {viewingReturn.requested_by?.profile?.full_name ||
                      viewingReturn.requested_by?.email ||
                      "System"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Refund method</p>
                  <p className="font-medium capitalize">
                    {(viewingReturn.refund_method || "pending").replace("_", " ")}
                  </p>
                </div>
                {viewingReturn.approved_by && (
                  <div>
                    <p className="text-sm text-muted-foreground">Reviewed by</p>
                    <p className="font-medium">
                      {viewingReturn.approved_by?.profile?.full_name ||
                        viewingReturn.approved_by?.email ||
                        "Management"}
                    </p>
                  </div>
                )}
              </div>

              <section>
                <h3 className="mb-2 font-semibold">Returned goods</h3>
                <div className="overflow-x-auto rounded-md border">
                  <Table className="min-w-[440px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Condition</TableHead>
                        <TableHead className="text-right">Unit price</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {viewingReturn.items?.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            {item.sale_item.product?.name || "Unknown item"}
                          </TableCell>
                          <TableCell>{item.quantity}</TableCell>
                          <TableCell className="capitalize">
                            {item.condition.replace("_", " ")}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatKesCents(
                              parseKesToCents(String(item.sale_item.unit_price)),
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>

              <div>
                <p className="text-sm text-muted-foreground">Reason</p>
                <p className="whitespace-pre-wrap">{viewingReturn.reason}</p>
                {viewingReturn.rejection_reason && (
                  <p className="mt-1 text-sm text-destructive">
                    Rejection reason: {viewingReturn.rejection_reason}
                  </p>
                )}
              </div>

              {viewingReturn.store_credit_voucher && (
                <section className="rounded-md border border-primary/30 bg-primary/5 p-4">
                  <h3 className="font-semibold">Walk-in store credit voucher</h3>
                  <p className="mt-2 font-mono text-lg font-bold">
                    {viewingReturn.store_credit_voucher.barcode}
                  </p>
                  <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                    <p>
                      Remaining balance:{" "}
                      {formatKesCents(
                        parseKesToCents(
                          String(viewingReturn.store_credit_voucher.current_balance),
                        ),
                      )}
                    </p>
                    <p className="capitalize">
                      Voucher status: {viewingReturn.store_credit_voucher.status}
                    </p>
                    {viewingReturn.store_credit_voucher.expires_at && (
                      <p>
                        Expires:{" "}
                        {new Date(
                          viewingReturn.store_credit_voucher.expires_at,
                        ).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Give this barcode to the walk-in customer. Enter it in Store
                    Credit at checkout to redeem the remaining balance.
                  </p>
                </section>
              )}

              {viewingReturn.refund_method === "mpesa" &&
                parseKesToCents(String(viewingReturn.mpesa_refund_amount)) > 0 && (
                  <section className="rounded-md border p-4">
                    <h3 className="font-semibold">M-Pesa refund settlement</h3>
                    <p>
                      Amount:{" "}
                      {formatKesCents(
                        parseKesToCents(String(viewingReturn.mpesa_refund_amount)),
                      )}
                    </p>
                    <p className="capitalize">
                      Status:{" "}
                      {(viewingReturn.mpesa_refund_status || "pending").replace(
                        "_",
                        " ",
                      )}
                    </p>
                    {viewingReturn.mpesa_refund_receipt && (
                      <p>
                        Safaricom receipt: {viewingReturn.mpesa_refund_receipt}
                      </p>
                    )}
                  </section>
                )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Admin Approval & Condition Triage Modal */}
      <Dialog open={approvalDialogOpen} onOpenChange={setApprovalDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Management Return Approval</DialogTitle>
          </DialogHeader>
          {approvingReturn && (
            <div className="space-y-4">
              <div className="bg-amber-50 dark:bg-amber-950/20 p-4 rounded-md border border-amber-200 dark:border-amber-900 flex gap-3 items-start">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-400">
                    Inventory Triage Required
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-500 mt-1">
                    You must classify the returning physical condition of each
                    item.
                    <br />- <b>Sellable:</b> Returns to warehouse stock
                    automatically.
                    <br />- <b>Damaged:</b> Writes off as inventory shrinkage
                    financially.
                  </p>
                </div>
              </div>

              <div className="space-y-3 max-h-64 overflow-y-auto">
                {approvingReturn.items?.map((it) => (
                  <div
                    key={it.id}
                    className="p-3 border rounded-lg bg-card flex items-center justify-between"
                  >
                    <div>
                      <p className="font-medium text-sm">
                        {it.sale_item?.product?.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Qty: {it.quantity} returned
                      </p>
                    </div>
                    <div className="w-40">
                      <Label className="text-xs mb-1 block">
                        Condition Flag
                      </Label>
                      <Select
                        value={itemConditions[it.id] || "sellable"}
                        onValueChange={(val) =>
                          setItemConditions({ ...itemConditions, [it.id]: val })
                        }
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sellable">
                            ✅ Sellable Stock
                          </SelectItem>
                          <SelectItem value="damaged">
                            💥 Damaged / Spoilage
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-muted p-3 rounded-md border mt-2">
                <Label className="text-sm font-semibold mb-2 block">
                  Refund Method
                </Label>
                <Select value={refundMethod} onValueChange={setRefundMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">💵 Cash (From Drawer)</SelectItem>
                    <SelectItem value="mpesa">
                      📱 M-Pesa (receipt required after payout)
                    </SelectItem>
                    <SelectItem value="store_credit">
                      💳 Issue Store Credit
                    </SelectItem>
                    <SelectItem value="exchange">
                      🔄 Exchange value as Store Credit
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-2">
                  Store Credit and Exchange value are added to the customer
                  balance. For a walk-in, provide the generated voucher
                  barcode.
                </p>
              </div>

              <div className="bg-muted p-3 rounded-md text-sm mt-2">
                <strong>Cashier Note:</strong> {approvingReturn.reason}
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setApprovalDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={submitApproveReturn}>Approve return</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={payoutDialogOpen} onOpenChange={setPayoutDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record M-Pesa refund payout</DialogTitle>
          </DialogHeader>
          {payoutReturn && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                First complete the refund through Safaricom. Then enter the
                receipt shown for the successful payout. The{" "}
                {formatKesCents(
                  parseKesToCents(String(payoutReturn.mpesa_refund_amount)),
                )}{" "}
                ledger and shift totals will update only after this confirmation.
              </p>
              <div className="space-y-2">
                <Label htmlFor="mpesa-refund-receipt">Safaricom receipt number</Label>
                <Input
                  id="mpesa-refund-receipt"
                  value={mpesaReceipt}
                  onChange={(event) => setMpesaReceipt(event.target.value)}
                  placeholder="e.g. QWE1234567"
                  autoComplete="off"
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setPayoutDialogOpen(false)}
                  disabled={recordingPayout}
                >
                  Cancel
                </Button>
                <Button
                  onClick={submitMpesaPayout}
                  disabled={recordingPayout || !mpesaReceipt.trim()}
                >
                  {recordingPayout ? "Recording..." : "Confirm payout"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
