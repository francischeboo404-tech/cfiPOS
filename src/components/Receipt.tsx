import { useCallback, useEffect, useState } from "react";
import { ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Printer, Usb } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoyaltyPointsDisplay } from "./LoyaltyPointsDisplay";
import { printerService } from "@/lib/hardware/escpos";
import { resolveCompanyLogoUrl } from "@/hooks/useCompanyBranding";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";
import { getEtimsReceiptNotice, isTestEtimsReceipt } from "@/lib/etimsReceipt";
import { EtimsQrCode } from "@/components/EtimsQrCode";

interface ReceiptProps {
  saleId: string;
  onClose: () => void;
}

interface Sale {
  id: string;
  created_at: string;
  total_amount: string;
  subtotal: string;
  tax_amount: string;
  payment_method: string;
  payment_status: string;
  cash_amount: string | null;
  mpesa_amount: string | null;
  change_amount: string | null;
  mpesa_receipt_number: string | null;
  cashier_id: string;
  customer_id: string | null;
  loyalty_discount: string | null;
  loyalty_points_redeemed: number | null;
  loyalty_points_earned: number | null;
  voucher_number: string | null;
  voucher_points_redeemed: number;
  voucher_points_earned: number;
  voucher_balance_after: number | null;
  voucher_expiry_date: string | null;
  etims_status?: string | null;
  etims_receipt_no?: string | null;
  etims_qr_code?: string | null;
  etims_signature?: string | null;
  sale_items: {
    quantity: number;
    unit_price: string;
    line_total: string;
    promotion_name?: string | null;
    promotion_discount_per_unit_cents?: string | null;
    products: {
      name: string;
      sku: string;
    };
  }[];
  customers: {
    name: string;
    phone: string;
  } | null;
  profiles: {
    full_name: string;
  };
}

interface MpesaTransaction {
  mpesa_receipt_number: string | null;
  phone_number: string;
  amount: number | string;
}

const formatMoney = (amount: string | number | null | undefined) =>
  formatKesCents(parseKesToCents(String(amount ?? 0)));

interface ServerSaleItem {
  quantity: number | string;
  unit_price: number | string;
  line_total: number | string;
  promotion_name?: string | null;
  promotion_discount_per_unit_cents?: string | null;
  product: { name: string; sku: string };
}

interface ServerSale {
  id: string;
  created_at: string;
  total_amount: number | string;
  subtotal: number | string;
  tax_amount: number | string;
  payment_method: string;
  payment_status: string;
  cash_amount: number | string | null;
  mpesa_amount: number | string | null;
  change_amount: number | string | null;
  loyalty_discount: number | string | null;
  voucher_id: string | null;
  voucher_points_redeemed: string;
  voucher_points_earned: string;
  voucher_balance_after: string | null;
  voucher_expiry_date: string | null;
  voucher_number?: string | null;
  etims_status?: string | null;
  etims_receipt_no?: string | null;
  etims_qr_code?: string | null;
  etims_signature?: string | null;
  items: ServerSaleItem[];
  customer: {
    id: string;
    name: string;
    phone: string;
    email?: string | null;
  } | null;
  cashier: {
    id: string;
    email: string;
    profile?: { full_name: string } | null;
  };
}

export function Receipt({ saleId, onClose }: ReceiptProps) {
  const [sale, setSale] = useState<Sale | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [mpesaTransaction, setMpesaTransaction] =
    useState<MpesaTransaction | null>(null);

  const loadData = useCallback(async () => {
    try {
      const response = await ApiService.get<{
        sale: ServerSale;
        mpesaTransaction: MpesaTransaction | null;
      }>(`/sales/${saleId}`);
      const saleData = response.sale;
      if (saleData) {
        setSale({
          id: saleData.id,
          created_at: saleData.created_at,
          total_amount: String(saleData.total_amount),
          subtotal: String(saleData.subtotal),
          tax_amount: String(saleData.tax_amount),
          payment_method: saleData.payment_method,
          payment_status: saleData.payment_status,
          cash_amount: saleData.cash_amount === null ? null : String(saleData.cash_amount),
          mpesa_amount: saleData.mpesa_amount === null ? null : String(saleData.mpesa_amount),
          change_amount: saleData.change_amount === null ? null : String(saleData.change_amount),
          mpesa_receipt_number:
            response.mpesaTransaction?.mpesa_receipt_number || null,
          cashier_id: saleData.cashier.id,
          customer_id: saleData.customer?.id || null,
          loyalty_discount: saleData.loyalty_discount === null
            ? null
            : String(saleData.loyalty_discount),
          loyalty_points_redeemed: null,
          loyalty_points_earned: null,
          voucher_number: saleData.voucher_number || null,
          voucher_points_redeemed: Number(saleData.voucher_points_redeemed || 0),
          voucher_points_earned: Number(saleData.voucher_points_earned || 0),
          voucher_balance_after: saleData.voucher_balance_after === null
            ? null
            : Number(saleData.voucher_balance_after),
          voucher_expiry_date: saleData.voucher_expiry_date || null,
          etims_status: saleData.etims_status || "not_applicable",
          etims_receipt_no: saleData.etims_receipt_no || null,
          etims_qr_code: saleData.etims_qr_code || null,
          etims_signature: saleData.etims_signature || null,
          sale_items: saleData.items.map((item) => ({
            quantity: Number(item.quantity),
            unit_price: String(item.unit_price),
            line_total: String(item.line_total),
            promotion_name: item.promotion_name || null,
            promotion_discount_per_unit_cents: item.promotion_discount_per_unit_cents || null,
            products: item.product,
          })),
          customers: saleData.customer,
          profiles: {
            full_name:
              saleData.cashier?.profile?.full_name ||
              saleData.cashier?.email ||
              "Unknown",
          },
        });
        if (response.mpesaTransaction) {
          setMpesaTransaction({
            ...response.mpesaTransaction,
            amount: String(response.mpesaTransaction.amount),
          });
        }
      }
    } catch (error) {
      console.error("Error loading receipt data:", error);
    }

    try {
      const settingsData =
        await ApiService.get<Record<string, string>>("/receipt-settings");
      setSettings({
        ...(settingsData || {}),
        company_logo: resolveCompanyLogoUrl(settingsData?.company_logo) || "",
      });
    } catch (error) {
      console.error("Error loading receipt settings:", error);
    }
  }, [saleId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePrint = () => {
    window.print();
  };

  const handleThermalPrint = async () => {
    // Basic text generation for the receipt
    const lines = [];
    lines.push(settings.company_name || "Wholesale POS");
    lines.push(settings.company_address || "Nairobi, Kenya");
    lines.push("--------------------------------");
    lines.push(`Receipt #: ${sale.id.substring(0, 8).toUpperCase()}`);
    lines.push(`Date: ${new Date(sale.created_at).toLocaleString("en-KE")}`);
    lines.push(`Cashier: ${sale.profiles.full_name}`);
    lines.push("--------------------------------");
    sale.sale_items.forEach((item) => {
      lines.push(`${item.products.name}`);
      lines.push(`${item.quantity} x ${formatMoney(item.unit_price)} = ${formatMoney(item.line_total)}`);
      if (item.promotion_name) {
        lines.push(`Promotion: ${item.promotion_name}`);
      }
    });
    lines.push("--------------------------------");
    lines.push(`TOTAL: ${formatMoney(sale.total_amount)}`);
    const etimsNotice = getEtimsReceiptNotice(sale.etims_status, sale.etims_receipt_no);
    if (sale.etims_status === "submitted" && sale.etims_receipt_no) {
      if (isTestEtimsReceipt(sale.etims_receipt_no)) {
        lines.push(`Test eTIMS reference: ${sale.etims_receipt_no}`);
      } else {
        lines.push("eTIMS submission recorded - verification required");
        lines.push(`Receipt reference: ${sale.etims_receipt_no}`);
        if (sale.etims_signature) lines.push(`Sig: ${sale.etims_signature}`);
      }
    }
    if (etimsNotice) lines.push(etimsNotice);
    lines.push("--------------------------------");
    lines.push(settings.receipt_footer || "Thank you!");

    const textToPrint = lines.join("\n");
    await printerService.printReceipt(textToPrint);
  };

  if (!sale) return null;

  const cashAmount = sale.cash_amount || "0";
  const mpesaAmount = sale.mpesa_amount || "0";
  const changeAmount = sale.change_amount || "0";
  const cashAmountCents = parseKesToCents(cashAmount);
  const mpesaAmountCents = parseKesToCents(mpesaAmount);
  const changeAmountCents = parseKesToCents(changeAmount);
  const isHybridPayment =
    sale.payment_method === "hybrid" || (cashAmountCents > 0 && mpesaAmountCents > 0);
  const etimsNotice = getEtimsReceiptNotice(sale.etims_status, sale.etims_receipt_no);
  const isTestFiscalReceipt = isTestEtimsReceipt(sale.etims_receipt_no);

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex justify-between items-center">
            <span>Receipt</span>
            <div className="flex gap-2">
              <Button onClick={handleThermalPrint} size="sm" variant="outline">
                <Usb className="h-4 w-4 mr-2" />
                Thermal
              </Button>
              <Button onClick={handlePrint} size="sm">
                <Printer className="h-4 w-4 mr-2" />
                Print
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          Receipt details for the completed sale.
        </DialogDescription>

        <div id="receipt-content" className="space-y-4 text-sm">
          {/* Company Header */}
          <div className="text-center border-b pb-4">
            {settings.company_logo && (
              <img
                src={settings.company_logo}
                alt={`${settings.company_name || "Company"} logo`}
                className="mx-auto mb-2 max-h-16 max-w-full object-contain"
                onError={(event) => {
                  event.currentTarget.hidden = true;
                }}
              />
            )}
            <h2 className="font-bold text-lg">
              {settings.company_name || "Wholesale POS"}
            </h2>
            <p>{settings.company_address || "Nairobi, Kenya"}</p>
            <p>{settings.company_phone || "+254 700 000000"}</p>
            {settings.tax_pin && <p>PIN: {settings.tax_pin}</p>}
          </div>

          {etimsNotice && (
            <div className="my-2 border-2 border-dashed border-amber-500 bg-amber-50 p-2 text-center text-xs font-bold uppercase tracking-wider text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {etimsNotice}
            </div>
          )}

          {/* Sale Info */}
          <div className="space-y-1">
            <div className="flex justify-between">
              <span>Receipt #:</span>
              <span className="font-mono">
                {sale.id.substring(0, 8).toUpperCase()}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Date:</span>
              <span>{new Date(sale.created_at).toLocaleString("en-KE")}</span>
            </div>
            <div className="flex justify-between">
              <span>Cashier:</span>
              <span>{sale.profiles.full_name}</span>
            </div>
            {sale.customers && (
              <>
                <div className="flex justify-between">
                  <span>Customer:</span>
                  <span>{sale.customers.name}</span>
                </div>
                <div className="flex justify-between">
                  <span>Phone:</span>
                  <span>{sale.customers.phone}</span>
                </div>
              </>
            )}
          </div>

          {/* Items */}
          <div className="border-t border-b py-2 space-y-2">
            {sale.sale_items.map((item, idx) => (
              <div key={idx} className="space-y-1">
                <div className="flex justify-between font-medium">
                  <span>{item.products.name}</span>
                  <span>
                    {formatMoney(item.line_total)}
                  </span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground pl-2">
                  <span>
                    {item.quantity} x {formatMoney(item.unit_price)}
                  </span>
                  <span>SKU: {item.products.sku}</span>
                </div>
                {item.promotion_name && (
                  <div className="pl-2 text-xs text-green-700">
                    {item.promotion_name}
                    {item.promotion_discount_per_unit_cents
                      ? ` · saved ${formatKesCents(Number(item.promotion_discount_per_unit_cents))} per unit`
                      : ""}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="space-y-1">
            <div className="flex justify-between">
              <span>Subtotal:</span>
              <span>
                {formatMoney(sale.subtotal)}
              </span>
            </div>
            {sale.loyalty_discount !== null && parseKesToCents(sale.loyalty_discount) > 0 && (
              <div className="flex justify-between text-green-600 dark:text-green-400">
                <span>Discount:</span>
                <span className="font-medium">
                  -{formatMoney(sale.loyalty_discount)}
                </span>
              </div>

            )}
            <div className="flex justify-between">
              <span>VAT (16%):</span>
              <span>
                {formatMoney(sale.tax_amount)}
              </span>
            </div>
            <div className="flex justify-between font-bold text-lg border-t pt-2">
              <span>TOTAL:</span>
              <span>
                {formatMoney(sale.total_amount)}
              </span>
            </div>
          </div>

          {sale.voucher_number && (
            <div className="border-t pt-2 text-sm space-y-1">
              <div>Voucher: {sale.voucher_number}</div>
              <div>Points earned: {sale.voucher_points_earned}</div>
              <div>Points redeemed: {sale.voucher_points_redeemed}</div>
              <div>New balance: {sale.voucher_balance_after ?? "—"}</div>
              <div>Valid until: {sale.voucher_expiry_date || "—"}</div>
            </div>
          )}

          {/* Payment Breakdown */}
          <div className="border-t border-b py-3 space-y-2 bg-muted/30 rounded px-2">
            <div className="font-semibold text-center border-b pb-1 mb-2">
              Payment Details
            </div>

            {cashAmountCents > 0 && (
              <div className="flex justify-between">
                <span>💵 Cash Paid:</span>
                <span className="font-medium">
                  {formatMoney(cashAmount)}
                </span>
              </div>
            )}

            {mpesaAmountCents > 0 && (
              <>
                <div className="flex justify-between">
                  <span>📱 M-Pesa Paid:</span>
                  <span className="font-medium">
                    {formatMoney(mpesaAmount)}
                  </span>
                </div>
                {mpesaTransaction?.mpesa_receipt_number && (
                  <div className="flex justify-between text-xs">
                    <span>M-Pesa Ref:</span>
                    <span className="font-mono font-semibold text-primary">
                      {mpesaTransaction.mpesa_receipt_number}
                    </span>
                  </div>
                )}
                {mpesaTransaction?.phone_number && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Phone:</span>
                    <span>{mpesaTransaction.phone_number}</span>
                  </div>
                )}
              </>
            )}

            {changeAmountCents > 0 && (
              <div className="flex justify-between text-green-600 dark:text-green-400 font-medium border-t pt-1">
                <span>Change Given:</span>
                <span>
                  {formatMoney(changeAmount)}
                </span>
              </div>
            )}

            <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t">
              <span>Payment Method:</span>
              <span className="uppercase font-medium">
                {isHybridPayment
                  ? "CASH + M-PESA"
                  : sale.payment_method.toUpperCase()}
              </span>
            </div>

            <div className="flex justify-between text-xs">
              <span>Payment Status:</span>
              <span
                className={`font-medium uppercase ${sale.payment_status === "paid" ? "text-green-600" : "text-amber-600"}`}
              >
                {sale.payment_status}
              </span>
            </div>
          </div>

          {/* MPESA Info for manual payments */}
          {settings.mpesa_paybill && sale.payment_method === "cash" && (
            <div className="text-center text-xs bg-muted p-2 rounded">
              <p>Pay via M-PESA</p>
              <p>Paybill: {settings.mpesa_paybill}</p>
              {settings.mpesa_till_number && (
                <p>Till: {settings.mpesa_till_number}</p>
              )}
            </div>
          )}

          {/* Loyalty Points Section - Customer Facing Display */}
          {sale.customer_id && (
            <LoyaltyPointsDisplay
              customerId={sale.customer_id}
              pointsEarned={sale.loyalty_points_earned ?? 0}
            />
          )}

          {/* eTIMS Fiscal Section */}
          <div className="border-t pt-3 text-center text-xs space-y-1">
            {sale.etims_status === "submitted" && sale.etims_receipt_no ? (
              <div className="space-y-1">
                <div className="font-semibold text-primary">
                  {isTestFiscalReceipt
                    ? "TEST eTIMS SIMULATION - NOT A TAX INVOICE"
                    : "eTIMS Submission Recorded - Verification Required"}
                </div>
                <div className="font-mono text-[11px]">
                  {isTestFiscalReceipt ? "Test reference" : "Receipt reference"}: {sale.etims_receipt_no}
                </div>
                {sale.etims_signature && (
                  <div className="font-mono text-[10px] text-muted-foreground break-all">
                    {isTestFiscalReceipt ? "Test signature (simulation)" : "Sig"}: {sale.etims_signature}
                  </div>
                )}
                {sale.etims_qr_code && (
                  <div className="py-2 flex flex-col items-center justify-center">
                    <EtimsQrCode
                      value={sale.etims_qr_code}
                      label={
                        isTestFiscalReceipt
                          ? "Test eTIMS QR code - not valid for KRA verification"
                          : "eTIMS QR code - submission not independently verified"
                      }
                    />
                    {isTestFiscalReceipt && (
                      <span className="text-[10px] text-muted-foreground mt-1">
                        Test QR only - not valid for KRA verification
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : sale.etims_status === "pending" ? (
              <div className="text-amber-600 dark:text-amber-400 font-medium py-1">
                Fiscal receipt pending - do not treat this as a KRA tax invoice
              </div>
            ) : sale.etims_status === "failed" ? (
              <div className="text-destructive font-medium py-1">
                Fiscal receipt not confirmed - reconcile before treating as a tax invoice
              </div>
            ) : (
              <div className="text-muted-foreground italic py-1">
                CUSTOMER RECEIPT - NOT A KRA TAX INVOICE
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="text-center text-xs border-t pt-4 space-y-1">
            <p>{settings.receipt_footer || "Thank you for your business!"}</p>
            <p className="mt-2 text-muted-foreground">
              Powered by CFI-POS Techiez
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Print styles
const style = document.createElement("style");
style.textContent = `
  @media print {
    body * {
      visibility: hidden;
    }
    #receipt-content, #receipt-content * {
      visibility: visible;
    }
    #receipt-content {
      position: absolute;
      left: 0;
      top: 0;
      width: 80mm;
      font-size: 12px;
    }
  }
`;
document.head.appendChild(style);
