import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OfflineSaleRecord } from "@/lib/offlineStore";
import { centsToKesString, formatKesCents, parseKesToCents } from "@/lib/exactMoney";
import { Printer } from "lucide-react";

interface OfflineSaleReceiptProps {
  sale: OfflineSaleRecord | null;
  onClose: () => void;
  onViewServerSale: (saleId: string) => void;
}

const formatCurrency = (amount: number | string) =>
  formatKesCents(parseKesToCents(String(amount)));

export function OfflineSaleReceipt({
  sale,
  onClose,
  onViewServerSale,
}: OfflineSaleReceiptProps) {
  const syncStatus = sale?.status;
  const syncStatusLabel = syncStatus === "synced"
    ? "SERVER ACCEPTED · FISCAL STATUS UNCONFIRMED"
    : syncStatus === "syncing"
      ? "SYNCING"
      : syncStatus === "conflict"
        ? "SYNC FAILED · REVIEW REQUIRED"
        : "NOT YET SYNCED";
  const syncDescription = syncStatus === "synced"
    ? "The server accepted this sale, but this provisional document does not confirm eTIMS submission. Check the server receipt for its fiscal status."
    : syncStatus === "syncing"
      ? "This offline capture is being sent to the server. Sale acceptance and any fiscal status are not yet confirmed."
      : syncStatus === "conflict"
        ? "The server could not accept this sale automatically. Review the reported issue; this document is not a confirmed sale or official invoice."
        : "This records the cashier's offline capture only. It is not a confirmed sale or official invoice until the server accepts it.";
  const serverSaleId = syncStatus === "synced" ? sale?.serverSaleId : undefined;

  return (
    <Dialog open={Boolean(sale)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Provisional cash receipt</DialogTitle>
            <Badge variant={syncStatus === "synced" || syncStatus === "syncing" ? "secondary" : "destructive"}>
              {syncStatusLabel}
            </Badge>
          </div>
          <DialogDescription>
            {syncDescription}
          </DialogDescription>
        </DialogHeader>
        {sale && (
          <div className="space-y-4" data-testid="offline-sale-receipt">
            <div className="rounded-md border p-3 text-sm">
              <div>Reference: OFF-{sale.id.slice(0, 8).toUpperCase()}</div>
              <div>Captured: {new Date(sale.capturedAt).toLocaleString()}</div>
              <div>Status: {sale.status === "conflict"
                ? "Needs review"
                : sale.status === "synced"
                  ? "Accepted by server; fiscal status unconfirmed"
                  : sale.status === "syncing"
                    ? "Syncing; awaiting server confirmation"
                    : "Awaiting server confirmation"}</div>
            </div>
            <div className="max-h-60 space-y-2 overflow-y-auto">
              {sale.items.map((item) => (
                <div key={item.productId} className="flex justify-between gap-3 text-sm">
                  <span>{item.name} × {item.quantity}</span>
                  <span>
                    {formatCurrency(
                      centsToKesString(
                        BigInt(parseKesToCents(String(item.unitPrice))) *
                          BigInt(item.quantity),
                      ),
                    )}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-between border-t pt-3 font-semibold">
              <span>Provisional total</span>
              <span>{formatCurrency(sale.expectedTotal)}</span>
            </div>
            <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950 p-2 text-center text-xs text-amber-800 dark:text-amber-200">
              <p className="font-semibold">This offline capture is not fiscalized.</p>
              <p className="text-[11px] mt-0.5">
                Syncing does not guarantee eTIMS submission. Check the server receipt for fiscal status after sync.
              </p>
              <p className="text-[11px] mt-0.5">Non-fiscal provisional document (No KRA QR issued)</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Keep this reference for reconciliation. The server will recheck price, tax, stock, and cashier shift before recording the sale.
            </p>
          </div>
        )}
        <DialogFooter>
          {serverSaleId && (
            <Button
              variant="outline"
              onClick={() => onViewServerSale(serverSaleId)}
            >
              View server receipt &amp; fiscal status
            </Button>
          )}
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="mr-2 h-4 w-4" />
            Print
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
