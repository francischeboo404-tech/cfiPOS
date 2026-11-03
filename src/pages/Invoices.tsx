import { useCallback, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Plus, FileText, Search, Eye, CreditCard, Printer } from "lucide-react";
import { toast } from "sonner";
import { ApiService } from "@/lib/api";
import {
  centsToKesString,
  formatKesCents,
  parseKesToCents,
} from "@/lib/exactMoney";
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
import { Label } from "@/components/ui/label";
import { useCompanyBranding } from "@/hooks/useCompanyBranding";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";

interface Invoice {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  sale_id: string | null;
  subtotal: number | string;
  tax_amount: number | string;
  discount_amount: number | string;
  total_amount: number | string;
  paid_amount: number | string;
  balance_due: number | string;
  status: string;
  due_date: string | null;
  issued_at: string | null;
  created_at: string;
  customer?: { name: string; phone: string } | null;
  customers?: { name: string; phone: string } | null;
}

interface InvoicePayment {
  id: string;
  amount: number | string;
  payment_method: string;
  reference_number: string | null;
  created_at: string;
}

const normalizeInvoice = (invoice: Invoice): Invoice => ({
  ...invoice,
  customers: invoice.customer ?? invoice.customers ?? null,
});

export default function Invoices() {
  const { company_name } = useCompanyBranding();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    payment_method: "cash",
    reference_number: "",
  });

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const statusQuery =
        statusFilter === "all"
          ? ""
          : `?status=${encodeURIComponent(statusFilter)}`;
      const data = await ApiService.get<Invoice[]>(`/invoices${statusQuery}`);
      if (!Array.isArray(data)) {
        throw new Error("The server returned an invalid invoice list");
      }
      setInvoices(data.map(normalizeInvoice));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load invoices";
      setLoadError(message);
      toast.error(`Failed to load invoices: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  const loadPayments = async (invoiceId: string) => {
    try {
      const data = await ApiService.get<InvoicePayment[]>(
        `/invoices/${invoiceId}/payments`,
      );
      setPayments(data || []);
    } catch (error) {
      toast.error("Failed to load invoice payments");
    }
  };

  const handleViewInvoice = async (invoice: Invoice) => {
    setSelectedInvoice(invoice);
    await loadPayments(invoice.id);
  };

  const handleRecordPayment = async () => {
    if (!selectedInvoice) return;

    let amountCents: number;
    try {
      amountCents = parseKesToCents(paymentForm.amount);
    } catch {
      toast.error("Enter a positive KES amount with at most two decimal places");
      return;
    }
    if (amountCents <= 0) {
      toast.error("Payment amount must be greater than zero");
      return;
    }

    if (amountCents > parseKesToCents(String(selectedInvoice.balance_due))) {
      toast.error("Payment amount exceeds balance due");
      return;
    }

    try {
      await ApiService.post(`/invoices/${selectedInvoice.id}/payments`, {
        amount: centsToKesString(amountCents),
        payment_method: paymentForm.payment_method,
        reference_number: paymentForm.reference_number || null,
      });
      toast.success("Payment recorded successfully");
      setPaymentDialogOpen(false);
      setPaymentForm({
        amount: "",
        payment_method: "cash",
        reference_number: "",
      });
      await loadInvoices();
      await loadPayments(selectedInvoice.id);
      const refreshed = await ApiService.get<Invoice[]>(`/invoices`);
      const updated = refreshed.find(
        (invoice) => invoice.id === selectedInvoice.id,
      );
      if (updated) setSelectedInvoice(normalizeInvoice(updated));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "An unknown error occurred";
      toast.error("Failed to record payment: " + message);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "draft":
        return "secondary";
      case "issued":
        return "default";
      case "partially_paid":
        return "outline";
      case "paid":
        return "default";
      case "cancelled":
        return "destructive";
      case "void":
        return "destructive";
      default:
        return "default";
    }
  };

  const filteredInvoices = invoices.filter(
    (inv) =>
      inv.invoice_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inv.customers?.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <>
    <div className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <FileText className="h-8 w-8 text-primary" />
            Invoices
          </h1>
          <p className="text-muted-foreground">
            Manage sales invoices and payments
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by invoice number or customer..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="issued">Issued</SelectItem>
                <SelectItem value="partially_paid">Partially Paid</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loadError && !loading && (
            <div
              role="alert"
              className="mb-4 flex flex-col gap-3 rounded-md border border-destructive/40 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <p className="text-sm text-destructive">
                Could not retrieve invoices. {loadError}
              </p>
              <Button type="button" variant="outline" onClick={() => void loadInvoices()}>
                Retry
              </Button>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Paid</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8">
                    Loading invoices...
                  </TableCell>
                </TableRow>
              ) : loadError ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-destructive">
                    Invoice data is unavailable. Use Retry to try again.
                  </TableCell>
                </TableRow>
              ) : filteredInvoices.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No invoices found
                  </TableCell>
                </TableRow>
              ) : (
                filteredInvoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-mono font-medium">
                      {invoice.invoice_number}
                    </TableCell>
                    <TableCell>
                      {invoice.customers?.name || "Walk-in"}
                    </TableCell>
                    <TableCell>
                      {formatKesCents(
                        parseKesToCents(String(invoice.total_amount)),
                      )}
                    </TableCell>
                    <TableCell className="text-green-600">
                      {formatKesCents(
                        parseKesToCents(String(invoice.paid_amount)),
                      )}
                    </TableCell>
                    <TableCell
                      className={
                        parseKesToCents(String(invoice.balance_due)) > 0
                          ? "text-destructive font-medium"
                          : ""
                      }
                    >
                      {formatKesCents(
                        parseKesToCents(String(invoice.balance_due)),
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={getStatusColor(invoice.status)}
                        className="capitalize"
                      >
                        {invoice.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {format(new Date(invoice.created_at), "dd/MM/yyyy")}
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleViewInvoice(invoice)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {parseKesToCents(String(invoice.balance_due)) > 0 &&
                        invoice.status !== "cancelled" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelectedInvoice(invoice);
                              setPaymentDialogOpen(true);
                            }}
                          >
                            <CreditCard className="h-4 w-4 mr-1" />
                            Pay
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

      {/* Invoice Detail Dialog */}
      <Dialog
        open={!!selectedInvoice && !paymentDialogOpen}
        onOpenChange={() => setSelectedInvoice(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Invoice {selectedInvoice?.invoice_number}
            </DialogTitle>
          </DialogHeader>
          {selectedInvoice && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Customer</p>
                  <p className="font-medium">
                    {selectedInvoice.customers?.name || "Walk-in"}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge
                    variant={getStatusColor(selectedInvoice.status)}
                    className="capitalize"
                  >
                    {selectedInvoice.status.replace("_", " ")}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className="font-bold text-lg">
                    {formatKesCents(
                      parseKesToCents(String(selectedInvoice.total_amount)),
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Balance Due</p>
                  <p
                    className={`font-bold text-lg ${parseKesToCents(String(selectedInvoice.balance_due)) > 0 ? "text-destructive" : "text-green-600"}`}
                  >
                    {formatKesCents(
                      parseKesToCents(String(selectedInvoice.balance_due)),
                    )}
                  </p>
                </div>
              </div>

              <div>
                <h4 className="font-semibold mb-2">Payment History</h4>
                {payments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No payments recorded
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead>Reference</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((payment) => (
                        <TableRow key={payment.id}>
                          <TableCell>
                            {format(
                              new Date(payment.created_at),
                              "dd/MM/yyyy HH:mm",
                            )}
                          </TableCell>
                          <TableCell className="text-green-600 font-medium">
                            {formatKesCents(parseKesToCents(String(payment.amount)))}
                          </TableCell>
                          <TableCell className="capitalize">
                            {payment.payment_method}
                          </TableCell>
                          <TableCell>
                            {payment.reference_number || "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => window.print()}>
                  <Printer className="h-4 w-4 mr-2" />
                  Print
                </Button>
                {parseKesToCents(String(selectedInvoice.balance_due)) > 0 &&
                  selectedInvoice.status !== "cancelled" && (
                    <Button onClick={() => setPaymentDialogOpen(true)}>
                      <CreditCard className="h-4 w-4 mr-2" />
                      Record Payment
                    </Button>
                  )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Payment Dialog */}
      <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          {selectedInvoice && (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">Balance Due</p>
                <p className="text-2xl font-bold text-primary">
                  {formatKesCents(
                    parseKesToCents(String(selectedInvoice.balance_due)),
                  )}
                </p>
              </div>

              <div>
                <Label htmlFor="amount">Payment Amount (KSh)</Label>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  value={paymentForm.amount}
                  onChange={(e) =>
                    setPaymentForm({ ...paymentForm, amount: e.target.value })
                  }
                  placeholder="Enter amount"
                />
              </div>

              <div>
                <Label htmlFor="method">Payment Method</Label>
                <Select
                  value={paymentForm.payment_method}
                  onValueChange={(val) =>
                    setPaymentForm({ ...paymentForm, payment_method: val })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="mpesa">M-Pesa</SelectItem>
                    <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    <SelectItem value="cheque">Cheque</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="reference">Reference Number</Label>
                <Input
                  id="reference"
                  value={paymentForm.reference_number}
                  onChange={(e) =>
                    setPaymentForm({
                      ...paymentForm,
                      reference_number: e.target.value,
                    })
                  }
                  placeholder="M-Pesa code, cheque #, etc."
                />
              </div>

              <div className="flex gap-2 pt-4">
                <Button
                  variant="outline"
                  onClick={() => setPaymentDialogOpen(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button onClick={handleRecordPayment} className="flex-1">
                  Record Payment
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <section id="invoice-print-area" aria-hidden="true">
        <style>{`
          #invoice-print-area { display: none; }
          @page { size: A4 portrait; margin: 14mm; }
          @media print {
            body * { visibility: hidden !important; }
            #invoice-print-area, #invoice-print-area * { visibility: visible !important; }
            #invoice-print-area {
              display: block !important;
              position: fixed;
              inset: 0;
              box-sizing: border-box;
              width: 100%;
              padding: 0;
              color: #111;
              background: #fff;
              font-family: Arial, sans-serif;
              font-size: 12px;
              line-height: 1.45;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
            #invoice-print-area h1, #invoice-print-area h2, #invoice-print-area p { margin: 0; }
            #invoice-print-area .invoice-print-header {
              display: flex;
              justify-content: space-between;
              gap: 24px;
              padding-bottom: 18px;
              border-bottom: 2px solid #222;
            }
            #invoice-print-area .invoice-print-title { font-size: 26px; font-weight: 700; }
            #invoice-print-area .invoice-print-company { font-size: 18px; font-weight: 700; }
            #invoice-print-area .invoice-print-number { margin-top: 6px; font-family: monospace; overflow-wrap: anywhere; }
            #invoice-print-area .invoice-print-meta {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 18px;
              margin: 24px 0;
            }
            #invoice-print-area .invoice-print-label { color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
            #invoice-print-area .invoice-print-value { margin-top: 4px; font-weight: 600; overflow-wrap: anywhere; }
            #invoice-print-area table { width: 100%; border-collapse: collapse; margin-top: 12px; }
            #invoice-print-area th, #invoice-print-area td { padding: 8px 6px; border-bottom: 1px solid #ccc; text-align: left; }
            #invoice-print-area th:last-child, #invoice-print-area td:last-child { text-align: right; }
            #invoice-print-area .invoice-print-totals { width: min(100%, 320px); margin: 16px 0 0 auto; }
            #invoice-print-area .invoice-print-totals td { border: 0; }
            #invoice-print-area .invoice-print-total { border-top: 2px solid #222 !important; font-size: 15px; font-weight: 700; }
            #invoice-print-area .invoice-print-section { margin-top: 28px; break-inside: avoid; }
            #invoice-print-area .invoice-print-footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #ccc; color: #555; }
          }
        `}</style>
        {selectedInvoice && (
          <article>
            <header className="invoice-print-header">
              <div>
                <p className="invoice-print-company">{company_name || "Store"}</p>
                <p>Invoice</p>
              </div>
              <div>
                <h1 className="invoice-print-title">INVOICE</h1>
                <p className="invoice-print-number">{selectedInvoice.invoice_number}</p>
              </div>
            </header>

            <section className="invoice-print-meta">
              <div>
                <p className="invoice-print-label">Bill to</p>
                <p className="invoice-print-value">
                  {selectedInvoice.customers?.name || "Walk-in customer"}
                </p>
                {selectedInvoice.customers?.phone && (
                  <p>{selectedInvoice.customers.phone}</p>
                )}
              </div>
              <div>
                <p className="invoice-print-label">Invoice details</p>
                <p className="invoice-print-value">
                  Issued: {format(new Date(selectedInvoice.issued_at || selectedInvoice.created_at), "dd/MM/yyyy")}
                </p>
                {selectedInvoice.due_date && (
                  <p>Due: {format(new Date(selectedInvoice.due_date), "dd/MM/yyyy")}</p>
                )}
                <p>Status: {selectedInvoice.status.replace("_", " ")}</p>
              </div>
            </section>

            <section className="invoice-print-section">
              <h2>Invoice summary</h2>
              <table>
                <thead>
                  <tr><th>Description</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Subtotal</td>
                    <td>{formatKesCents(parseKesToCents(String(selectedInvoice.subtotal)))}</td>
                  </tr>
                  <tr>
                    <td>Discount</td>
                    <td>{formatKesCents(parseKesToCents(String(selectedInvoice.discount_amount)))}</td>
                  </tr>
                  <tr>
                    <td>Tax</td>
                    <td>{formatKesCents(parseKesToCents(String(selectedInvoice.tax_amount)))}</td>
                  </tr>
                </tbody>
              </table>
              <table className="invoice-print-totals">
                <tbody>
                  <tr className="invoice-print-total">
                    <td>Total</td>
                    <td>{formatKesCents(parseKesToCents(String(selectedInvoice.total_amount)))}</td>
                  </tr>
                  <tr>
                    <td>Paid</td>
                    <td>{formatKesCents(parseKesToCents(String(selectedInvoice.paid_amount)))}</td>
                  </tr>
                  <tr>
                    <td>Balance due</td>
                    <td>{formatKesCents(parseKesToCents(String(selectedInvoice.balance_due)))}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="invoice-print-section">
              <h2>Payment history</h2>
              {payments.length > 0 ? (
                <table>
                  <thead>
                    <tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr>
                  </thead>
                  <tbody>
                    {payments.map((payment) => (
                      <tr key={payment.id}>
                        <td>{format(new Date(payment.created_at), "dd/MM/yyyy HH:mm")}</td>
                        <td>{payment.payment_method.replace("_", " ")}</td>
                        <td>{payment.reference_number || "-"}</td>
                        <td>{formatKesCents(parseKesToCents(String(payment.amount)))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p>No payments recorded.</p>
              )}
            </section>

            <footer className="invoice-print-footer">
              Thank you for your business.
            </footer>
          </article>
        )}
      </section>
    </div>
    </>
  );
}
