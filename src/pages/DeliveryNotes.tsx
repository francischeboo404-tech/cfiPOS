import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ClipboardCheck, Search, Eye, Package } from "lucide-react";
import { toast } from "sonner";
import { ApiService } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { format } from "date-fns";
import { GRNInvoiceDownload } from "@/components/GRNInvoiceDownload";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";

interface DeliveryNote {
  id: string;
  grn_number: string;
  po_id: string;
  vendor_id: string;
  delivery_date: string;
  status: string;
  total_items: number;
  total_value: number | string;
  notes: string | null;
  created_at: string;
  vendors: { name: string } | null;
  purchase_orders: { po_number: string } | null;
}

interface DeliveryNoteItem {
  id: string;
  product_id: string;
  ordered_quantity: number;
  received_quantity: number;
  rejected_quantity: number;
  rejection_reason: string | null;
  unit_cost: number | string;
  line_total: number | string;
  products: { name: string; sku: string } | null;
}

interface DeliveryNoteResponse extends Omit<DeliveryNote, "delivery_date" | "vendors" | "purchase_orders"> {
  vendor: DeliveryNote["vendors"];
  purchase_order: DeliveryNote["purchase_orders"];
}

interface DeliveryNoteDetailResponse extends DeliveryNoteResponse {
  items: Array<Omit<DeliveryNoteItem, "products"> & { product: DeliveryNoteItem["products"] }>;
}

export default function DeliveryNotes() {
  const [deliveryNotes, setDeliveryNotes] = useState<DeliveryNote[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedNote, setSelectedNote] = useState<DeliveryNote | null>(null);
  const [noteItems, setNoteItems] = useState<DeliveryNoteItem[]>([]);

  useEffect(() => {
    loadDeliveryNotes();
  }, []);

  const loadDeliveryNotes = async () => {
    setLoading(true);
    try {
      const data = await ApiService.get<DeliveryNoteResponse[]>("/delivery-notes");
      setDeliveryNotes(
        (data || []).map((note) => ({
          ...note,
          delivery_date: note.created_at,
          vendors: note.vendor,
          purchase_orders: note.purchase_order,
        })),
      );
    } catch (error) {
      toast.error("Failed to load delivery notes");
    }
    setLoading(false);
  };

  const loadNoteItems = async (noteId: string) => {
    try {
      const note = await ApiService.get<DeliveryNoteDetailResponse>(`/delivery-notes/${noteId}`);
      setNoteItems(
        (note.items || []).map((item) => ({
          ...item,
          products: item.product,
        })),
      );
    } catch (error) {
      toast.error("Failed to load delivery note items");
    }
  };

  const handleViewNote = async (note: DeliveryNote) => {
    setSelectedNote(note);
    await loadNoteItems(note.id);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "secondary";
      case "verified":
        return "default";
      case "completed":
        return "default";
      case "disputed":
        return "destructive";
      default:
        return "default";
    }
  };

  const filteredNotes = deliveryNotes.filter(
    (note) =>
      note.grn_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      note.vendors?.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      note.purchase_orders?.po_number
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <ClipboardCheck className="h-8 w-8 text-primary" />
            Goods Received Notes
          </h1>
          <p className="text-muted-foreground">
            Track deliveries from suppliers
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by GRN number, vendor, or PO..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>GRN #</TableHead>
                <TableHead>PO #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : filteredNotes.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No delivery notes found
                  </TableCell>
                </TableRow>
              ) : (
                filteredNotes.map((note) => (
                  <TableRow key={note.id}>
                    <TableCell className="font-mono font-medium">
                      {note.grn_number}
                    </TableCell>
                    <TableCell className="font-mono">
                      {note.purchase_orders?.po_number || "-"}
                    </TableCell>
                    <TableCell>{note.vendors?.name || "N/A"}</TableCell>
                    <TableCell>{note.total_items}</TableCell>
                    <TableCell>
                      {formatKesCents(parseKesToCents(String(note.total_value)))}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={getStatusColor(note.status)}
                        className="capitalize"
                      >
                        {note.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {format(new Date(note.delivery_date), "dd/MM/yyyy")}
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`View GRN ${note.grn_number}`}
                        onClick={() => handleViewNote(note)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <Dialog open={!!selectedNote} onOpenChange={() => setSelectedNote(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              GRN: {selectedNote?.grn_number}
            </DialogTitle>
          </DialogHeader>
          {selectedNote && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Vendor</p>
                  <p className="font-medium">{selectedNote.vendors?.name}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">PO Number</p>
                  <p className="font-medium">
                    {selectedNote.purchase_orders?.po_number}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge
                    variant={getStatusColor(selectedNote.status)}
                    className="capitalize"
                  >
                    {selectedNote.status}
                  </Badge>
                </div>
              </div>

              <div>
                <h4 className="font-semibold mb-2">Received Items</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Ordered</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead className="text-right">Rejected</TableHead>
                      <TableHead className="text-right">Unit Cost</TableHead>
                      <TableHead className="text-right">Line Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {noteItems.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.products?.name}</TableCell>
                        <TableCell className="font-mono">
                          {item.products?.sku}
                        </TableCell>
                        <TableCell className="text-right">
                          {item.ordered_quantity}
                        </TableCell>
                        <TableCell className="text-right text-green-600 font-medium">
                          {item.received_quantity}
                        </TableCell>
                        <TableCell className="text-right text-destructive">
                          {item.rejected_quantity > 0
                            ? item.rejected_quantity
                            : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatKesCents(
                            parseKesToCents(String(item.unit_cost)),
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatKesCents(
                            parseKesToCents(String(item.line_total)),
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex justify-between items-center pt-4 border-t">
                <div>
                  <p className="text-sm text-muted-foreground">Total Value</p>
                  <p className="text-2xl font-bold">
                    {formatKesCents(
                      parseKesToCents(String(selectedNote.total_value)),
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  <GRNInvoiceDownload
                    data={{
                      grn_number: selectedNote.grn_number,
                      po_number: selectedNote.purchase_orders?.po_number || "",
                      vendor_name: selectedNote.vendors?.name || "",
                      delivery_date: selectedNote.delivery_date,
                      total_value: selectedNote.total_value,
                      total_items: selectedNote.total_items,
                      notes: selectedNote.notes || undefined,
                      items: noteItems.map((item) => ({
                        product_name: item.products?.name || "",
                        sku: item.products?.sku || "",
                        ordered_quantity: item.ordered_quantity,
                        received_quantity: item.received_quantity,
                        rejected_quantity: item.rejected_quantity,
                        unit_cost: item.unit_cost,
                        line_total: item.line_total,
                      })),
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
