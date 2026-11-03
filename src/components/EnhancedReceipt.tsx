import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Printer, Download } from 'lucide-react';
import cfiLogo from '@/assets/cfi-pos-techiez-logo.png';
import { getEtimsReceiptNotice, isTestEtimsReceipt } from '@/lib/etimsReceipt';
import { EtimsQrCode } from '@/components/EtimsQrCode';

interface ReceiptItem {
  name: string;
  quantity: number;
  price: number;
  total: number;
}

interface EnhancedReceiptProps {
  saleId: string;
  date: string;
  items: ReceiptItem[];
  subtotal: number;
  discount?: number;
  tax: number;
  total: number;
  paymentMethod: string;
  customerName?: string;
  cashierName: string;
  etims_status?: string | null;
  etims_receipt_no?: string | null;
  etims_qr_code?: string | null;
  etims_signature?: string | null;
}

export function EnhancedReceipt({
  saleId,
  date,
  items,
  subtotal,
  discount = 0,
  tax,
  total,
  paymentMethod,
  customerName = 'Walk-in Customer',
  cashierName,
  etims_status,
  etims_receipt_no,
  etims_qr_code,
  etims_signature,
}: EnhancedReceiptProps) {
  const receiptRef = useRef<HTMLDivElement>(null);
  const isTestFiscalReceipt = isTestEtimsReceipt(etims_receipt_no);
  const etimsNotice = getEtimsReceiptNotice(etims_status, etims_receipt_no);

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = () => {
    // Simple download as text - can be enhanced to PDF
    const receiptContent = receiptRef.current?.innerText || '';
    const blob = new Blob([receiptContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `receipt-${saleId}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Card className="max-w-md mx-auto print:shadow-none" ref={receiptRef}>
        <CardContent className="p-6 font-mono text-sm">
          {/* Header */}
          <div className="text-center border-b-2 border-dashed pb-4 mb-4">
            <img
              src={cfiLogo}
              alt="CFI-POS Techiez Limited Company"
              className="mx-auto mb-2 h-auto w-full max-w-[18rem] object-contain"
            />
            <p className="text-xs text-muted-foreground">Wholesale Point of Sale</p>
            <p className="text-xs text-muted-foreground mt-1">CFI-POS Techiez Limited Company</p>
          </div>

          {/* Sale Info */}
          <div className="space-y-1 mb-4 text-xs">
            <div className="flex justify-between">
              <span>Receipt #:</span>
              <span className="font-semibold">{saleId.slice(0, 8).toUpperCase()}</span>
            </div>
            <div className="flex justify-between">
              <span>Date:</span>
              <span>{new Date(date).toLocaleString('en-KE')}</span>
            </div>
            <div className="flex justify-between">
              <span>Customer:</span>
              <span>{customerName}</span>
            </div>
            <div className="flex justify-between">
              <span>Cashier:</span>
              <span>{cashierName}</span>
            </div>
            <div className="flex justify-between">
              <span>Payment:</span>
              <span className="uppercase">{paymentMethod}</span>
            </div>
          </div>

          {/* Items */}
          <div className="border-y-2 border-dashed py-4 mb-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-dashed">
                  <th className="text-left pb-2">Item</th>
                  <th className="text-center pb-2">Qty</th>
                  <th className="text-right pb-2">Price</th>
                  <th className="text-right pb-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={index} className="border-b border-dotted">
                    <td className="py-2">{item.name}</td>
                    <td className="text-center py-2">{item.quantity}</td>
                    <td className="text-right py-2">
                      {item.price.toLocaleString('en-KE', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-2 font-semibold">
                      {item.total.toLocaleString('en-KE', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="space-y-1 text-xs mb-4">
            <div className="flex justify-between">
              <span>Subtotal:</span>
              <span>KSh {subtotal.toLocaleString('en-KE', { minimumFractionDigits: 2 })}</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-green-600 dark:text-green-400">
                <span>Discount:</span>
                <span>- KSh {discount.toLocaleString('en-KE', { minimumFractionDigits: 2 })}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Tax (16%):</span>
              <span>KSh {tax.toLocaleString('en-KE', { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between text-lg font-bold border-t-2 border-dashed pt-2 mt-2">
              <span>TOTAL:</span>
              <span>KSh {total.toLocaleString('en-KE', { minimumFractionDigits: 2 })}</span>
            </div>
          </div>

          {/* eTIMS Fiscal Section */}
          <div className="border-t-2 border-dashed pt-3 text-center text-xs space-y-1">
            {etims_status === "submitted" && etims_receipt_no ? (
              <div className="space-y-1">
                <div className="font-semibold text-primary">
                  {isTestFiscalReceipt
                    ? "TEST eTIMS SIMULATION - NOT A TAX INVOICE"
                    : "eTIMS Submission Recorded - Verification Required"}
                </div>
                <div className="font-mono text-[11px]">
                  {isTestFiscalReceipt ? "Test reference" : "Receipt reference"}: {etims_receipt_no}
                </div>
                {etims_signature && (
                  <div className="font-mono text-[10px] text-muted-foreground break-all">
                    {isTestFiscalReceipt ? "Test signature (simulation)" : "Sig"}: {etims_signature}
                  </div>
                )}
                {etims_qr_code && (
                  <div className="py-2 flex flex-col items-center justify-center">
                    <EtimsQrCode
                      value={etims_qr_code}
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
            ) : etims_status === "pending" ? (
              <div className="text-amber-600 dark:text-amber-400 font-medium py-1">
                Fiscal receipt pending - do not treat this as a KRA tax invoice
              </div>
            ) : etims_status === "failed" ? (
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
          <div className="text-center text-xs text-muted-foreground border-t-2 border-dashed pt-4 mt-4">
            {etimsNotice ? (
              <p className="mb-1 font-semibold text-amber-700 dark:text-amber-400">
                {etimsNotice}
              </p>
            ) : null}
            <p className="mb-1">Thank you for your business!</p>
            <p className="mb-1">Goods once sold cannot be returned</p>
            <p className="text-[10px] mt-2">Powered by CFI-POS Techiez</p>
          </div>
        </CardContent>
      </Card>

      {/* Print/Download Buttons */}
      <div className="flex gap-2 justify-center print:hidden">
        <Button onClick={handlePrint} variant="default" className="gap-2">
          <Printer className="h-4 w-4" />
          Print Receipt
        </Button>
        <Button onClick={handleDownload} variant="outline" className="gap-2">
          <Download className="h-4 w-4" />
          Download
        </Button>
      </div>

      {/* Print Styles */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #root, #root * {
            visibility: hidden;
          }
          ${receiptRef.current ? `
            .print\\:shadow-none,
            .print\\:shadow-none * {
              visibility: visible;
            }
            .print\\:shadow-none {
              position: absolute;
              left: 0;
              top: 0;
              width: 80mm;
              box-shadow: none !important;
            }
          ` : ''}
        }
      `}</style>
    </div>
  );
}
