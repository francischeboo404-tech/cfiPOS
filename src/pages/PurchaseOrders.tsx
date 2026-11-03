import { useState, useEffect } from "react";
import { ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Package, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuthContext";
import { useNavigate } from "react-router-dom";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";

interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor_id: string;
  status: string;
  total_amount: number | string;
  created_at: string;
  warehouse?: { name: string } | null;
  vendors?: { name: string } | null;
  vendor?: { name: string } | null;
}

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown error";

export default function PurchaseOrders() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await ApiService.get<PurchaseOrder[]>("/purchase-orders");
      setOrders(data || []);
    } catch (error: unknown) {
      const message =
        "Failed to load purchase orders: " + getErrorMessage(error);
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "draft":
        return "secondary";
      case "sent":
        return "default";
      case "partially_received":
        return "outline";
      case "received":
        return "default";
      case "cancelled":
        return "destructive";
      default:
        return "default";
    }
  };

  const updateStatus = async (id: string, newStatus: string) => {
    try {
      await ApiService.put(`/purchase-orders/${id}/status`, {
        status: newStatus,
      });
      toast.success(`PO ${newStatus}`);

      if (newStatus === "sent") {
        try {
          await ApiService.post(`/purchase-orders/${id}/email`, {});
          toast.success("Purchase order sent to vendor via email");
        } catch (error: unknown) {
          toast.error(
            `PO status updated, but email failed: ${getErrorMessage(error)}`,
          );
        }
      }
      loadOrders();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error) || "Error updating status");
    }
  };

  const isAdmin = role === "admin";

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Purchase Orders</h1>
          <p className="text-muted-foreground">Manage inventory procurement</p>
        </div>
        {isAdmin && (
          <Button onClick={() => navigate("/purchase-orders/new")}>
            <Plus className="h-4 w-4 mr-2" />
            New PO
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Purchase Orders</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO Number</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Receiving Warehouse</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Total Amount</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    Loading purchase orders...
                  </TableCell>
                </TableRow>
              ) : loadError ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <p className="text-destructive">{loadError}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void loadOrders()}
                      >
                        Retry
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : orders.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    No purchase orders found
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium">
                      {order.po_number}
                    </TableCell>
                    <TableCell>
                      {order.vendor?.name || order.vendors?.name || "N/A"}
                    </TableCell>
                    <TableCell>
                      {order.warehouse?.name || "Main warehouse (legacy PO)"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusColor(order.status)}>
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {formatKesCents(
                        parseKesToCents(String(order.total_amount)),
                      )}
                    </TableCell>
                    <TableCell>
                      {new Date(order.created_at).toLocaleDateString("en-KE")}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {isAdmin && order.status === "draft" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateStatus(order.id, "sent")}
                        >
                          Send
                        </Button>
                      )}
                      {isAdmin && order.status === "sent" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              navigate(`/purchase-orders/${order.id}/receive`)
                            }
                          >
                            <CheckCircle2 className="h-4 w-4 mr-1" />
                            Receive
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => updateStatus(order.id, "cancelled")}
                          >
                            <XCircle className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      {isAdmin && order.status === "partially_received" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            navigate(`/purchase-orders/${order.id}/receive`)
                          }
                        >
                          <CheckCircle2 className="h-4 w-4 mr-1" />
                          Receive More
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
