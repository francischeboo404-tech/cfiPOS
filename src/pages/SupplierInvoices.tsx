import { useState, useEffect, useRef } from "react";
import { ApiNetworkError, ApiRequestError, ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Receipt, Search, Plus, CreditCard, Eye, ScanText } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuthContext";
import Tesseract from "tesseract.js";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format, addDays } from "date-fns";
import { centsToKesString, formatKesCents, parseKesToCents } from "@/lib/exactMoney";
import { parseSupplierInvoiceOcrText, type SupplierInvoiceOcrFields } from "@/lib/supplierInvoiceOcr";

interface SupplierInvoice {
  id: string;
  invoice_number: string;
  vendor_id: string;
  po_id: string | null;
  delivery_note_id: string | null;
  invoice_date: string;
  due_date: string;
  subtotal: number | string;
  tax_amount: number | string;
  total_amount: number | string;
  paid_amount: number | string;
  balance_due: number | string;
  status: string;
  payment_terms: string | null;
  notes: string | null;
  manual_reviewed_at: string | null;
  accounting_recognized: boolean;
  created_at: string;
  vendors: { name: string; needs_review?: boolean } | null;
  purchase_orders: { po_number: string } | null;
}

interface SupplierInvoiceAccount {
  id: string;
  code: string;
  name: string;
  type: "asset" | "expense";
}

interface Vendor {
  id: string;
  name: string;
  payment_terms: string | null;
  needs_review?: boolean;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  total_amount: number | string;
  vendor_id: string;
}

interface DeliveryNote {
  id: string;
  grn_number: string;
  po_id: string;
  vendor_id: string;
  total_value: number | string;
  status: string;
}

interface SupplierPayment {
  id: string;
  amount: number | string;
  payment_method: "bank_transfer" | "cash" | "mpesa" | "cheque";
  reference_number: string | null;
  payment_date: string;
  notes: string | null;
  payer?: { id: string; full_name: string | null } | null;
}

export default function SupplierInvoices() {
  const { user, role } = useAuth();
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [deliveryNotes, setDeliveryNotes] = useState<DeliveryNote[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savingInvoice, setSavingInvoice] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] =
    useState<SupplierInvoice | null>(null);
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [uncertainPaymentInvoiceId, setUncertainPaymentInvoiceId] = useState<string | null>(null);
  const [reviewInvoice, setReviewInvoice] = useState<SupplierInvoice | null>(null);
  const [reviewAccounts, setReviewAccounts] = useState<SupplierInvoiceAccount[]>([]);
  const [reviewSubtotalAccountId, setReviewSubtotalAccountId] = useState("");
  const [reviewTaxAccountId, setReviewTaxAccountId] = useState("");
  const [savingReview, setSavingReview] = useState(false);

  const [formData, setFormData] = useState({
    invoice_number: "",
    vendor_id: "",
    po_id: "",
    delivery_note_id: "",
    supplier_name: "",
    supplier_contact_person: "",
    supplier_phone: "",
    supplier_email: "",
    supplier_address: "",
    notes: "",
    invoice_date: format(new Date(), "yyyy-MM-dd"),
    due_date: format(addDays(new Date(), 30), "yyyy-MM-dd"),
    subtotal: "",
    tax_amount: "",
  });
  const [entryMode, setEntryMode] = useState<"matched" | "manual">("matched");
  const [supplierMode, setSupplierMode] = useState<"existing" | "new">("existing");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrFields, setOcrFields] = useState<SupplierInvoiceOcrFields | null>(null);
  const [ocrVerified, setOcrVerified] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [invoiceImageUrl, setInvoiceImageUrl] = useState("");
  const ocrWorkerRef = useRef<Awaited<ReturnType<typeof Tesseract.createWorker>> | null>(null);
  const ocrRequestRef = useRef(0);

  const [paymentForm, setPaymentForm] = useState({
    amount: "",
    payment_method: "bank_transfer",
    reference_number: "",
    payment_date: format(new Date(), "yyyy-MM-dd"),
    notes: "",
  });
  const [paymentRequestId, setPaymentRequestId] = useState<string>(() => crypto.randomUUID());
  const paymentRequestIdsRef = useRef(new Map<string, string>());
  const paymentFormsRef = useRef(new Map<string, typeof paymentForm>());

  const updatePaymentForm = (updates: Partial<typeof paymentForm>) => {
    const updated = { ...paymentForm, ...updates };
    setPaymentForm(updated);
    if (selectedInvoice) paymentFormsRef.current.set(selectedInvoice.id, updated);
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    setOcrVerified(false);
  }, [formData]);

  useEffect(() => {
    return () => {
      if (invoiceImageUrl) URL.revokeObjectURL(invoiceImageUrl);
    };
  }, [invoiceImageUrl]);

  const resetOcr = () => {
    ocrRequestRef.current += 1;
    if (ocrWorkerRef.current) {
      void ocrWorkerRef.current.terminate();
      ocrWorkerRef.current = null;
    }
    setOcrBusy(false);
    setOcrProgress("");
    setOcrConfidence(null);
    setOcrFields(null);
    setOcrVerified(false);
    setOcrText("");
    setInvoiceImageUrl("");
  };

  const handleInvoiceImage = async (file?: File) => {
    if (!file) return;
    resetOcr();
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Choose a JPEG, PNG, or WebP invoice image");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Invoice images must be 10 MB or smaller");
      return;
    }

    const requestId = ++ocrRequestRef.current;
    setOcrBusy(true);
    setOcrProgress("Preparing image…");
    setOcrConfidence(null);
    setOcrFields(null);
    setOcrVerified(false);
    setOcrText("");
    setInvoiceImageUrl(URL.createObjectURL(file));

    let bitmap: ImageBitmap | null = null;
    let worker: Awaited<ReturnType<typeof Tesseract.createWorker>> | null = null;
    try {
      bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 32_000_000) {
        throw new Error("Image dimensions are too large. Use an image smaller than 32 megapixels.");
      }
      const scale = Math.min(1, 2600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Your browser could not prepare this image for text recognition.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      bitmap = null;

      worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
        logger: (message) => {
          if (requestId !== ocrRequestRef.current) return;
          const percent = typeof message.progress === "number"
            ? ` ${Math.round(message.progress * 100)}%`
            : "";
          setOcrProgress(`${message.status || "Recognizing text"}${percent}`);
        },
      });
      if (requestId !== ocrRequestRef.current) {
        await worker.terminate();
        worker = null;
        return;
      }
      ocrWorkerRef.current = worker;
      const { data } = await worker.recognize(canvas);
      if (requestId !== ocrRequestRef.current) return;

      const fields = parseSupplierInvoiceOcrText(data.text);
      setOcrFields(fields);
      setOcrText(data.text);
      setOcrConfidence(data.confidence);
      setOcrVerified(false);
      if (data.confidence >= 70) {
        setFormData((current) => ({
          ...current,
          ...(fields.invoice_number ? { invoice_number: fields.invoice_number } : {}),
          ...(fields.invoice_date ? { invoice_date: fields.invoice_date } : {}),
          ...(fields.due_date ? { due_date: fields.due_date } : {}),
          ...(fields.subtotal ? { subtotal: fields.subtotal } : {}),
          ...(fields.tax_amount ? { tax_amount: fields.tax_amount } : {}),
        }));
        if (fields.supplier_name) {
          const normalizedName = fields.supplier_name.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
          const exactVendor = vendors.find(
            (vendor) => vendor.name.toLocaleLowerCase().replace(/[^a-z0-9]/g, "") === normalizedName,
          );
          if (exactVendor) {
            setSupplierMode("existing");
            setFormData((current) => ({ ...current, vendor_id: exactVendor.id }));
          } else {
            setSupplierMode("new");
            setFormData((current) => ({ ...current, vendor_id: "", supplier_name: fields.supplier_name! }));
          }
        }
      }

      setOcrProgress("Recognition complete");
      toast.success(data.confidence >= 70
        ? "OCR suggestions filled matching fields. Verify every value against the original invoice before saving."
        : "OCR confidence was low; no fields were filled. Review the image and recognized text manually.");
    } catch (error) {
      if (requestId === ocrRequestRef.current) {
        const message = error instanceof Error ? error.message : "Could not read the invoice image";
        setOcrProgress("");
        toast.error(message);
      }
    } finally {
      bitmap?.close();
      if (worker && ocrWorkerRef.current === worker) {
        ocrWorkerRef.current = null;
        await worker.terminate();
      }
      if (requestId === ocrRequestRef.current) setOcrBusy(false);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [invoicesData, vendorsData, posData, deliveryNotesData] =
        await Promise.all([
          ApiService.get<
            Array<
              SupplierInvoice & {
                vendor?: { name: string };
                purchase_order?: { po_number: string };
              }
            >
          >("/procurement/supplier-invoices"),
          ApiService.get<Array<Vendor>>("/vendors"),
          ApiService.get<Array<PurchaseOrder>>("/purchase-orders"),
          ApiService.get<Array<DeliveryNote>>("/delivery-notes"),
        ]);

      setInvoices(
        (invoicesData || []).map((invoice) => ({
          ...invoice,
          vendors: invoice.vendor ?? invoice.vendors ?? null,
          purchase_orders:
            invoice.purchase_order ?? invoice.purchase_orders ?? null,
        })) as SupplierInvoice[],
      );
      setVendors((vendorsData || []) as Vendor[]);
      setPurchaseOrders((posData || []) as PurchaseOrder[]);
      setDeliveryNotes((deliveryNotesData || []) as DeliveryNote[]);
    } catch (error) {
      toast.error(error.message || "Failed to load supplier invoice data");
    } finally {
      setLoading(false);
    }
  };

  const loadPayments = async (invoiceId: string) => {
    setPaymentsLoading(true);
    try {
      const data = await ApiService.get<SupplierPayment[]>(
        `/procurement/supplier-invoices/${invoiceId}/payments`,
      );
      setPayments(data || []);
    } catch (error) {
      toast.error(error.message || "Failed to load supplier payment history");
      setPayments([]);
    } finally {
      setPaymentsLoading(false);
    }
  };

  const handleCreateInvoice = async () => {
    if (!user?.id || savingInvoice) return;
    if (ocrFields && !ocrVerified) {
      toast.error("Confirm that you checked the invoice values and suggestions against the physical invoice");
      return;
    }
    if (!formData.invoice_number.trim()) {
      toast.error("Enter the supplier invoice number");
      return;
    }
    if (entryMode === "matched" &&
      (!formData.vendor_id || !formData.po_id || !formData.delivery_note_id)) {
      toast.error("Select a supplier, purchase order, and completed goods receipt");
      return;
    }
    if (entryMode === "manual" &&
      ((supplierMode === "existing" && !formData.vendor_id) ||
        (supplierMode === "new" && !formData.supplier_name.trim()))) {
      toast.error("Select a supplier or enter the unregistered supplier's name");
      return;
    }
    if (!formData.invoice_date || !formData.due_date) {
      toast.error("Enter the invoice date and due date");
      return;
    }

    let subtotalCents: number;
    let taxAmountCents: number;
    try {
      subtotalCents = parseKesToCents(formData.subtotal || "0");
      taxAmountCents = parseKesToCents(formData.tax_amount || "0");
    } catch {
      toast.error("Invoice amounts must be non-negative KES values with at most two decimal places");
      return;
    }
    const totalAmountCents = subtotalCents + taxAmountCents;
    if (totalAmountCents <= 0) {
      toast.error("Invoice total must be greater than zero");
      return;
    }

    setSavingInvoice(true);
    try {
      await ApiService.post("/procurement/supplier-invoices", {
        invoice_number: formData.invoice_number,
        ...(entryMode === "matched" || supplierMode === "existing"
          ? { vendor_id: formData.vendor_id }
          : {
              supplier_name: formData.supplier_name,
              supplier_contact_person: formData.supplier_contact_person || null,
              supplier_phone: formData.supplier_phone || null,
              supplier_email: formData.supplier_email || null,
              supplier_address: formData.supplier_address || null,
            }),
        po_id: entryMode === "matched" ? formData.po_id : null,
        delivery_note_id: entryMode === "matched" ? formData.delivery_note_id : null,
        invoice_date: formData.invoice_date,
        due_date: formData.due_date,
        subtotal: centsToKesString(subtotalCents),
        tax_amount: centsToKesString(taxAmountCents),
        total_amount: centsToKesString(totalAmountCents),
        notes: formData.notes || null,
        created_by: user.id,
      });

      toast.success(entryMode === "manual"
        ? "Manual supplier invoice saved for review"
        : "Supplier invoice created");
      setDialogOpen(false);
      setFormData({
        invoice_number: "",
        vendor_id: "",
        po_id: "",
        delivery_note_id: "",
        supplier_name: "",
        supplier_contact_person: "",
        supplier_phone: "",
        supplier_email: "",
        supplier_address: "",
        notes: "",
        invoice_date: format(new Date(), "yyyy-MM-dd"),
        due_date: format(addDays(new Date(), 30), "yyyy-MM-dd"),
        subtotal: "",
        tax_amount: "",
      });
      setEntryMode("matched");
      setSupplierMode("existing");
      await loadData();
    } catch (error) {
      toast.error(error.message || "Failed to create invoice");
    } finally {
      setSavingInvoice(false);
    }
  };

  const handleRecordPayment = async () => {
    if (!selectedInvoice || !user?.id || savingPayment) return;

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
      toast.error("Payment exceeds balance due");
      return;
    }
    if (!paymentForm.payment_date) {
      toast.error("Select a payment date");
      return;
    }

    setSavingPayment(true);
    try {
      await ApiService.post(
        `/procurement/supplier-invoices/${selectedInvoice.id}/payments`,
        {
          amount: centsToKesString(amountCents),
          payment_method: paymentForm.payment_method,
          reference_number: paymentForm.reference_number || null,
          payment_date: paymentForm.payment_date,
          notes: paymentForm.notes || null,
          idempotency_key: paymentRequestId,
        },
      );

      toast.success("Payment recorded");
      setPaymentDialogOpen(false);
      setPaymentForm({
        amount: "",
        payment_method: "bank_transfer",
        reference_number: "",
        payment_date: format(new Date(), "yyyy-MM-dd"),
        notes: "",
      });
      paymentRequestIdsRef.current.delete(selectedInvoice.id);
      paymentFormsRef.current.delete(selectedInvoice.id);
      setUncertainPaymentInvoiceId(null);
      setPaymentRequestId(crypto.randomUUID());
      await loadData();
      await loadPayments(selectedInvoice.id);
    } catch (error) {
      if (error instanceof ApiNetworkError ||
        (error instanceof ApiRequestError && error.status >= 500)) {
        setUncertainPaymentInvoiceId(selectedInvoice.id);
      }
      toast.error(error.message || "Failed to record payment");
    } finally {
      setSavingPayment(false);
    }
  };

  const handleViewInvoice = async (invoice: SupplierInvoice) => {
    setSelectedInvoice(invoice);
    await loadPayments(invoice.id);
  };

  const handleOpenInvoiceReview = async (invoice: SupplierInvoice) => {
    try {
      const accounts = await ApiService.get<SupplierInvoiceAccount[]>(
        "/procurement/supplier-invoice-accounts",
      );
      setReviewAccounts(accounts);
      setReviewSubtotalAccountId("");
      setReviewTaxAccountId("");
      setReviewInvoice(invoice);
    } catch (error) {
      toast.error(error.message || "Failed to load eligible accounting accounts");
    }
  };

  const handleReviewInvoice = async () => {
    if (!reviewInvoice) return;
    const taxCents = parseKesToCents(String(reviewInvoice.tax_amount));
    if (!reviewSubtotalAccountId) {
      toast.error("Select the debit account for the invoice subtotal");
      return;
    }
    if (taxCents > 0n && !reviewTaxAccountId) {
      toast.error("Select the debit account for the invoice tax");
      return;
    }

    setSavingReview(true);
    try {
      await ApiService.post(
        `/procurement/supplier-invoices/${reviewInvoice.id}/review`,
        {
          subtotal_account_id: reviewSubtotalAccountId,
          tax_account_id: taxCents > 0n ? reviewTaxAccountId : null,
        },
      );
      toast.success("Invoice accounting recorded and review completed");
      setReviewInvoice(null);
      await loadData();
    } catch (error) {
      toast.error(error.message || "Failed to record invoice accounting");
    } finally {
      setSavingReview(false);
    }
  };

  const isManualReviewPending = (invoice: SupplierInvoice) =>
    !invoice.po_id && !invoice.manual_reviewed_at && invoice.status === "pending";

  const isManualInvoice = (invoice: SupplierInvoice) =>
    !invoice.po_id && !invoice.delivery_note_id;

  const isManualAccountingPending = (invoice: SupplierInvoice) =>
    isManualInvoice(invoice) && !invoice.accounting_recognized;

  const canReviewInvoice = (invoice: SupplierInvoice) =>
    canManageInvoices &&
    isManualAccountingPending(invoice) &&
    invoice.status !== "discrepancy";

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pending":
      case "unpaid":
        return "secondary";
      case "matched":
      case "partially_paid":
        return "outline";
      case "paid":
        return "default";
      case "review_required":
      case "supplier_review_required":
      case "accounting_required":
        return "secondary";
      case "discrepancy":
      case "overdue":
        return "destructive";
      case "disputed":
        return "destructive";
      default:
        return "default";
    }
  };

  const getInvoiceDisplayStatus = (invoice: SupplierInvoice) => {
    if (invoice.status === "discrepancy") return "discrepancy";
    if (isManualReviewPending(invoice)) return "review_required";
    if (isManualAccountingPending(invoice)) return "accounting_required";
    if (invoice.vendors?.needs_review) return "supplier_review_required";
    const balanceCents = parseKesToCents(String(invoice.balance_due));
    if (balanceCents > 0 &&
      invoice.due_date.slice(0, 10) < format(new Date(), "yyyy-MM-dd")) {
      return "overdue";
    }
    if (balanceCents > 0 && parseKesToCents(String(invoice.paid_amount)) > 0) {
      return "partially_paid";
    }
    return invoice.status;
  };

  const isPaymentEligible = (invoice: SupplierInvoice) =>
    (invoice.status === "matched" || invoice.status === "pending") &&
    (Boolean(invoice.po_id) || Boolean(invoice.manual_reviewed_at)) &&
    (!isManualInvoice(invoice) || invoice.accounting_recognized) &&
    invoice.vendors?.needs_review !== true &&
    parseKesToCents(String(invoice.balance_due)) > 0;

  const filteredInvoices = invoices.filter(
    (inv) =>
      inv.invoice_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inv.vendors?.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const canManageInvoices = role === "admin" || role === "manager";
  const canRecordPayment = role === "admin" || role === "manager";

  // Calculate totals
  const totalPayablesCents = invoices.reduce(
    (sum, invoice) =>
      isPaymentEligible(invoice)
        ? sum + BigInt(parseKesToCents(String(invoice.balance_due)))
        : sum,
    0n,
  );
  const overdueAmountCents = invoices
    .filter(
      (invoice) =>
        isPaymentEligible(invoice) &&
        invoice.due_date.slice(0, 10) < format(new Date(), "yyyy-MM-dd"),
    )
    .reduce(
      (sum, invoice) =>
        sum + BigInt(parseKesToCents(String(invoice.balance_due))),
      0n,
    );
  const reviewPendingInvoices = invoices.filter(isManualReviewPending);
  const reviewPendingAmountCents = reviewPendingInvoices.reduce(
    (sum, invoice) => sum + BigInt(parseKesToCents(String(invoice.balance_due))),
    0n,
  );
  const ocrTotalDisagrees = (() => {
    if (!ocrFields?.total_amount) return false;
    try {
      const formTotal = parseKesToCents(formData.subtotal || "0") +
        parseKesToCents(formData.tax_amount || "0");
      return Math.abs(parseKesToCents(ocrFields.total_amount) - formTotal) > 1;
    } catch {
      return true;
    }
  })();

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Receipt className="h-8 w-8 text-primary" />
            Supplier Invoices
          </h1>
          <p className="text-muted-foreground">Manage accounts payable</p>
        </div>
        {canManageInvoices && (
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              resetOcr();
              if (open) {
                setFormData({
                  invoice_number: "",
                  vendor_id: "",
                  po_id: "",
                  delivery_note_id: "",
                  supplier_name: "",
                  supplier_contact_person: "",
                  supplier_phone: "",
                  supplier_email: "",
                  supplier_address: "",
                  notes: "",
                  invoice_date: format(new Date(), "yyyy-MM-dd"),
                  due_date: format(addDays(new Date(), 30), "yyyy-MM-dd"),
                  subtotal: "",
                  tax_amount: "",
                });
                setEntryMode("matched");
                setSupplierMode("existing");
              }
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Invoice
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Create Supplier Invoice</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Invoice Entry Type</Label>
                  <Select
                    value={entryMode}
                    onValueChange={(value: "matched" | "manual") => {
                      setEntryMode(value);
                      setFormData((current) => ({
                        ...current,
                        po_id: "",
                        delivery_note_id: "",
                      }));
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="matched">Purchase order + goods receipt</SelectItem>
                      <SelectItem value="manual">Manual entry from physical invoice</SelectItem>
                    </SelectContent>
                  </Select>
                  {entryMode === "manual" && (
                    <div className="mt-2 space-y-2">
                      <p className="text-sm text-muted-foreground">
                        This invoice will remain pending and cannot be paid until reviewed by a manager or admin.
                      </p>
                      <div className="rounded-md border p-3 space-y-2">
                        <Label htmlFor="supplier-invoice-image" className="flex items-center gap-2">
                          <ScanText className="h-4 w-4" />
                          Autofill from invoice image (optional)
                        </Label>
                        <Input
                          id="supplier-invoice-image"
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          disabled={ocrBusy}
                          onChange={(event) => {
                            void handleInvoiceImage(event.target.files?.[0]);
                            event.currentTarget.value = "";
                          }}
                        />
                        <p className="text-xs text-muted-foreground">
                          JPEG, PNG, or WebP up to 10 MB. Recognition runs in this browser; the image is not uploaded or saved. English OCR support files are downloaded from jsDelivr and may be cached by your browser.
                        </p>
                        {invoiceImageUrl && (
                          <img
                            src={invoiceImageUrl}
                            alt="Temporary preview of the supplier invoice image"
                            className="max-h-48 max-w-full rounded border object-contain"
                          />
                        )}
                        {ocrBusy && <p className="text-sm" role="status">{ocrProgress || "Preparing OCR…"}</p>}
                        {ocrFields && (
                          <div className="space-y-2 text-sm">
                            <p role="status">
                              {ocrConfidence !== null && ocrConfidence >= 70
                                ? "OCR suggestions filled the matching fields."
                                : "Recognition confidence was low; no form fields were filled."}
                              {ocrConfidence !== null
                                ? ` Overall recognition confidence: ${Math.round(ocrConfidence)}%.`
                                : ""} Confidence is not a guarantee of field accuracy.
                            </p>
                            {Object.keys(ocrFields).length > 0 && (
                              <ul className="list-inside list-disc text-xs">
                                {Object.entries(ocrFields).map(([field, value]) => (
                                  <li key={field}><span className="font-medium">{field.replace(/_/g, " ")}:</span> {value}</li>
                                ))}
                              </ul>
                            )}
                            {ocrFields.total_amount && (
                              <p>
                                Image total: KSh {ocrFields.total_amount}; form total: KSh{" "}
                                {(() => {
                                  try {
                                    return formatKesCents(
                                      parseKesToCents(formData.subtotal || "0") +
                                      parseKesToCents(formData.tax_amount || "0"),
                                    );
                                  } catch {
                                    return "invalid";
                                  }
                                })()}
                              </p>
                            )}
                            {ocrTotalDisagrees && (
                              <p className="font-medium text-destructive">
                                The image total does not match the subtotal plus tax currently in the form. Resolve the difference against the physical invoice before saving.
                              </p>
                            )}
                            {ocrText && (
                              <details>
                                <summary className="cursor-pointer">Review recognized text</summary>
                                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                                  {ocrText}
                                </pre>
                              </details>
                            )}
                            <p className="font-medium text-amber-700 dark:text-amber-400">
                              Check all extracted and manually entered values against the physical invoice. OCR does not approve the invoice or authorize payment.
                            </p>
                            <label className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                checked={ocrVerified}
                                onChange={(event) => setOcrVerified(event.target.checked)}
                                className="mt-1"
                              />
                              <span>I have checked the current invoice form values and OCR suggestions against the physical invoice.</span>
                            </label>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Invoice Number *</Label>
                    <Input
                      value={formData.invoice_number}
                      maxLength={100}
                      required
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          invoice_number: e.target.value,
                        })
                      }
                      placeholder="INV-001"
                    />
                  </div>
                  <div className="col-span-2">
                    <Label>Supplier *</Label>
                    {entryMode === "manual" && (
                      <Select
                        value={supplierMode}
                        onValueChange={(value: "existing" | "new") => {
                          setSupplierMode(value);
                          setFormData((current) => ({ ...current, vendor_id: "" }));
                        }}
                      >
                        <SelectTrigger className="mt-2"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="existing">Supplier already registered</SelectItem>
                          <SelectItem value="new">Unregistered supplier — add from invoice</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {entryMode === "manual" && supplierMode === "new" ? (
                      <div className="mt-3 space-y-3">
                        <Input
                          value={formData.supplier_name}
                          onChange={(e) => setFormData({ ...formData, supplier_name: e.target.value })}
                          placeholder="Supplier / company name *"
                          maxLength={200}
                        />
                        <Input
                          value={formData.supplier_contact_person}
                          onChange={(e) => setFormData({ ...formData, supplier_contact_person: e.target.value })}
                          placeholder="Contact person"
                          maxLength={200}
                        />
                        <div className="grid grid-cols-2 gap-3">
                          <Input
                            value={formData.supplier_phone}
                            onChange={(e) => setFormData({ ...formData, supplier_phone: e.target.value })}
                            placeholder="Phone"
                            maxLength={50}
                          />
                          <Input
                            type="email"
                            value={formData.supplier_email}
                            onChange={(e) => setFormData({ ...formData, supplier_email: e.target.value })}
                            placeholder="Email"
                            maxLength={254}
                          />
                        </div>
                        <Input
                          value={formData.supplier_address}
                          onChange={(e) => setFormData({ ...formData, supplier_address: e.target.value })}
                          placeholder="Supplier address"
                          maxLength={500}
                        />
                        <p className="text-sm text-muted-foreground">
                          A supplier record will be created and flagged for later review.
                        </p>
                      </div>
                    ) : (
                    <Select
                      value={formData.vendor_id}
                      onValueChange={(val) =>
                        setFormData({ ...formData, vendor_id: val })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        {vendors.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    )}
                  </div>
                </div>

                {entryMode === "matched" && <div>
                  <Label>Link to Purchase Order</Label>
                  <Select
                    value={formData.po_id}
                    onValueChange={(val) => {
                      const po = purchaseOrders.find((p) => p.id === val);
                      const availableNotes = deliveryNotes.filter(
                        (note) =>
                          note.po_id === val && note.status === "completed",
                      );
                      setFormData({
                        ...formData,
                        po_id: val,
                        delivery_note_id:
                          availableNotes.length === 1
                            ? availableNotes[0].id
                            : "",
                        subtotal:
                          availableNotes.length === 1
                            ? String(availableNotes[0].total_value)
                            : "",
                        vendor_id: po ? po.vendor_id : formData.vendor_id,
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select PO (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      {purchaseOrders.map((po) => (
                        <SelectItem key={po.id} value={po.id}>
                          {po.po_number} - KSh{" "}
                          {formatKesCents(
                            parseKesToCents(String(po.total_amount)),
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>}

                {entryMode === "matched" && <div>
                  <Label>Completed Goods Receipt *</Label>
                  <Select
                    value={formData.delivery_note_id}
                    onValueChange={(value) => {
                      const deliveryNote = deliveryNotes.find(
                        (note) => note.id === value,
                      );
                      setFormData({
                        ...formData,
                        delivery_note_id: value,
                        subtotal: deliveryNote
                          ? String(deliveryNote.total_value)
                          : formData.subtotal,
                      });
                    }}
                    disabled={!formData.po_id}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select completed GRN" />
                    </SelectTrigger>
                    <SelectContent>
                      {deliveryNotes
                        .filter(
                          (note) =>
                            note.po_id === formData.po_id &&
                            note.status === "completed",
                        )
                        .map((note) => (
                          <SelectItem key={note.id} value={note.id}>
                            {note.grn_number} · KSh{" "}
                            {formatKesCents(
                              parseKesToCents(String(note.total_value)),
                            )}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Invoice Date</Label>
                    <Input
                      type="date"
                      required
                      value={formData.invoice_date}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          invoice_date: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label>Due Date</Label>
                    <Input
                      type="date"
                      required
                      value={formData.due_date}
                      onChange={(e) =>
                        setFormData({ ...formData, due_date: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Subtotal (KSh)</Label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={formData.subtotal}
                      onChange={(e) =>
                        setFormData({ ...formData, subtotal: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <Label>VAT Amount (KSh)</Label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={formData.tax_amount}
                      onChange={(e) =>
                        setFormData({ ...formData, tax_amount: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div>
                  <Label>Invoice Notes</Label>
                  <Input
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    maxLength={1000}
                    placeholder="Optional invoice details or internal notes"
                  />
                </div>

                <div className="pt-2 border-t">
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className="text-2xl font-bold">
                    {(() => {
                      try {
                        return formatKesCents(
                          parseKesToCents(formData.subtotal || "0") +
                          parseKesToCents(formData.tax_amount || "0"),
                        );
                      } catch {
                        return "Invalid amount";
                      }
                    })()}
                  </p>
                </div>

                <Button
                  onClick={handleCreateInvoice}
                  className="w-full"
                  disabled={savingInvoice || (entryMode === "matched"
                    ? !formData.delivery_note_id
                    : supplierMode === "existing" ? !formData.vendor_id : !formData.supplier_name.trim())}
                >
                  {savingInvoice ? "Saving…" : entryMode === "manual" ? "Save for Review" : "Create Invoice"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Payables
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {formatKesCents(totalPayablesCents)}
            </p>
          </CardContent>
        </Card>
        <Card className={overdueAmountCents > 0n ? "border-destructive" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Overdue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={`text-2xl font-bold ${overdueAmountCents > 0n ? "text-destructive" : ""}`}
            >
              {formatKesCents(overdueAmountCents)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Open Invoices
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {invoices.filter(isPaymentEligible).length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Invoices Awaiting Review
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{reviewPendingInvoices.length}</p>
            <p className="text-sm text-muted-foreground">
              {formatKesCents(reviewPendingAmountCents)} held from payment
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by invoice number or vendor..."
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
                <TableHead>Invoice #</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Paid</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead>Status</TableHead>
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
                    <TableCell className="font-mono">
                      {invoice.invoice_number}
                    </TableCell>
                    <TableCell>{invoice.vendors?.name}                    </TableCell>
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
                    <TableCell
                      className={
                        new Date(invoice.due_date) < new Date() &&
                        parseKesToCents(String(invoice.balance_due)) > 0
                          ? "text-destructive"
                          : ""
                      }
                    >
                      {format(new Date(invoice.due_date), "dd/MM/yyyy")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={getStatusColor(getInvoiceDisplayStatus(invoice))}
                        className="capitalize"
                      >
                        {getInvoiceDisplayStatus(invoice).replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      {canReviewInvoice(invoice) && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleOpenInvoiceReview(invoice)}
                        >
                          {invoice.manual_reviewed_at ? "Complete accounting" : "Review"}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleViewInvoice(invoice)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {canRecordPayment && isPaymentEligible(invoice) && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const existingForm = paymentFormsRef.current.get(invoice.id);
                            const nextForm = existingForm ?? {
                              amount: "",
                              payment_method: "bank_transfer",
                              reference_number: "",
                              payment_date: format(new Date(), "yyyy-MM-dd"),
                              notes: "",
                            };
                            paymentFormsRef.current.set(invoice.id, nextForm);
                            setPaymentForm(nextForm);
                            setSelectedInvoice(invoice);
                            let requestId = paymentRequestIdsRef.current.get(invoice.id);
                            if (!requestId) {
                              requestId = crypto.randomUUID();
                              paymentRequestIdsRef.current.set(invoice.id, requestId);
                            }
                            setPaymentRequestId(requestId);
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

      <Dialog
        open={!!reviewInvoice}
        onOpenChange={(open) => {
          if (!open && !savingReview) setReviewInvoice(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewInvoice?.manual_reviewed_at
                ? "Complete invoice accounting"
                : "Review manual supplier invoice"}
            </DialogTitle>
            <DialogDescription>
              Choose where the invoice subtotal and tax should be debited. The
              system will credit Accounts Payable for the invoice total.
            </DialogDescription>
          </DialogHeader>
          {reviewInvoice && (
            <div className="space-y-4">
              <div className="rounded-md border p-3 text-sm">
                <p className="font-medium">
                  {reviewInvoice.invoice_number} · {reviewInvoice.vendors?.name}
                </p>
                <p className="text-muted-foreground">
                  Subtotal {formatKesCents(parseKesToCents(String(reviewInvoice.subtotal)))}
                  {" · "}Tax {formatKesCents(parseKesToCents(String(reviewInvoice.tax_amount)))}
                  {" · "}Total {formatKesCents(parseKesToCents(String(reviewInvoice.total_amount)))}
                </p>
              </div>
              <div>
                <Label>Subtotal debit account *</Label>
                <Select
                  value={reviewSubtotalAccountId}
                  onValueChange={setReviewSubtotalAccountId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an asset or expense account" />
                  </SelectTrigger>
                  <SelectContent>
                    {reviewAccounts
                      .filter((account) => account.code !== "1400")
                      .map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.code} · {account.name} ({account.type})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {parseKesToCents(String(reviewInvoice.tax_amount)) > 0n && (
                <div>
                  <Label>Tax debit account *</Label>
                  <Select
                    value={reviewTaxAccountId}
                    onValueChange={setReviewTaxAccountId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select an asset or expense account" />
                    </SelectTrigger>
                    <SelectContent>
                      {reviewAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.code} · {account.name} ({account.type})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={() => void handleReviewInvoice()}
              disabled={savingReview || !reviewSubtotalAccountId}
            >
              {savingReview ? "Saving..." : "Record accounting and review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog
        open={!!selectedInvoice && !paymentDialogOpen}
        onOpenChange={() => setSelectedInvoice(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Invoice: {selectedInvoice?.invoice_number}
            </DialogTitle>
          </DialogHeader>
          {selectedInvoice && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Vendor</p>
                  <p className="font-medium">{selectedInvoice.vendors?.name}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge variant={getStatusColor(getInvoiceDisplayStatus(selectedInvoice))}>
                    {getInvoiceDisplayStatus(selectedInvoice).replace("_", " ")}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total</p>
                  <p className="font-bold">
                    {formatKesCents(parseKesToCents(String(selectedInvoice.total_amount)))}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Balance Due</p>
                  <p
                    className={`font-bold ${parseKesToCents(String(selectedInvoice.balance_due)) > 0 ? "text-destructive" : "text-green-600"}`}
                  >
                    {formatKesCents(parseKesToCents(String(selectedInvoice.balance_due)))}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Invoice Date</p>
                  <p>{format(new Date(selectedInvoice.invoice_date), "dd/MM/yyyy")}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Due Date</p>
                  <p>{format(new Date(selectedInvoice.due_date), "dd/MM/yyyy")}</p>
                </div>
              </div>
              {!selectedInvoice.po_id && (
                <div className="rounded-md border p-3 text-sm">
                  <p className="font-medium">Manually entered physical invoice</p>
                  <p className="text-muted-foreground">
                    {selectedInvoice.manual_reviewed_at
                      ? `Reviewed ${format(new Date(selectedInvoice.manual_reviewed_at), "dd/MM/yyyy HH:mm")}${selectedInvoice.accounting_recognized ? "; accounting recorded" : "; accounting classification required"}`
                      : "Awaiting manager/admin review; payment is blocked."}
                  </p>
                  {selectedInvoice.vendors?.needs_review && (
                    <p className="mt-1 text-muted-foreground">
                      Supplier verification is separate and must be completed before payment.
                    </p>
                  )}
                </div>
              )}
              {selectedInvoice.notes && (
                <div>
                  <p className="text-sm text-muted-foreground">Invoice Notes</p>
                  <p>{selectedInvoice.notes}</p>
                </div>
              )}

              <div>
                <h4 className="font-semibold mb-2">Payment History</h4>
                {paymentsLoading ? (
                  <p className="text-sm text-muted-foreground">Loading payment history…</p>
                ) : payments.length === 0 ? (
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
                        <TableHead>Recorded By</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell>
                            {format(new Date(p.payment_date), "dd/MM/yyyy")}
                          </TableCell>
                          <TableCell className="text-green-600 font-medium">
                            {formatKesCents(parseKesToCents(String(p.amount)))}
                          </TableCell>
                          <TableCell className="capitalize">
                            {p.payment_method.replace("_", " ")}
                          </TableCell>
                          <TableCell>{p.reference_number || "-"}</TableCell>
                          <TableCell>{p.payer?.full_name || "-"}</TableCell>
                          <TableCell>{p.notes || "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Payment Dialog */}
      <Dialog
        open={paymentDialogOpen}
        onOpenChange={(open) => {
          if (!open && savingPayment) return;
          setPaymentDialogOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          {selectedInvoice && (
            <div className="space-y-4">
              {uncertainPaymentInvoiceId === selectedInvoice.id && (
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400" role="alert">
                  The server response was not confirmed. Retry these same payment details to safely check whether the payment was recorded. Editing them could create a second payment.
                </p>
              )}
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">Balance Due</p>
                <p className="text-2xl font-bold text-primary">
                  {formatKesCents(parseKesToCents(String(selectedInvoice.balance_due)))}
                </p>
              </div>

              <div>
                <Label>Amount (KSh)</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={paymentForm.amount}
                  disabled={savingPayment || uncertainPaymentInvoiceId === selectedInvoice.id}
                  onChange={(e) =>
                    updatePaymentForm({ amount: e.target.value })
                  }
                />
              </div>

              <div>
                <Label>Payment Method</Label>
                <Select
                  value={paymentForm.payment_method}
                  disabled={savingPayment || uncertainPaymentInvoiceId === selectedInvoice.id}
                  onValueChange={(val) =>
                    updatePaymentForm({ payment_method: val })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="mpesa">M-Pesa</SelectItem>
                    <SelectItem value="cheque">Cheque</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Reference Number</Label>
                <Input
                  value={paymentForm.reference_number}
                  disabled={savingPayment || uncertainPaymentInvoiceId === selectedInvoice.id}
                  onChange={(e) =>
                    updatePaymentForm({ reference_number: e.target.value })
                  }
                />
              </div>

              <div>
                <Label>Payment Date</Label>
                <Input
                  type="date"
                  value={paymentForm.payment_date}
                  disabled={savingPayment || uncertainPaymentInvoiceId === selectedInvoice.id}
                  onChange={(e) =>
                    updatePaymentForm({ payment_date: e.target.value })
                  }
                />
              </div>

              <div>
                <Label>Notes</Label>
                <Input
                  value={paymentForm.notes}
                  maxLength={500}
                  disabled={savingPayment || uncertainPaymentInvoiceId === selectedInvoice.id}
                  onChange={(e) =>
                    updatePaymentForm({ notes: e.target.value })
                  }
                />
              </div>

              <Button onClick={handleRecordPayment} className="w-full" disabled={savingPayment}>
                {savingPayment
                  ? "Recording…"
                  : uncertainPaymentInvoiceId === selectedInvoice.id
                    ? "Retry Payment Safely"
                    : "Record Payment"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
