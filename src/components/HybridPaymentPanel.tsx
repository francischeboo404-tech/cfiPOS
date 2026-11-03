import { useEffect, useState } from "react";
import { ApiService } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Banknote,
  Smartphone,
  Loader2,
  Check,
  X,
  AlertCircle,
} from "lucide-react";
import { PaymentStatus } from "@/hooks/useHybridPayment";
import { centsToKesString, formatKesCents, parseKesToCents } from "@/lib/exactMoney";

interface HybridPaymentPanelProps {
  totalAmountCents: number;
  promotionSavingsCents?: number;
  cashAmountCents: number;
  mpesaAmountCents: number;
  storeCreditAmountCents: number;
  storeCreditAccountBalanceCents: number;
  remainingAmountCents: number;
  changeAmountCents: number;
  status: PaymentStatus;
  mpesaPending: boolean;
  checkoutReserved: boolean;
  recoveringCheckout?: boolean;
  canCancelCheckout: boolean;
  paybillNumber: string | null;
  paybillEnabled: boolean;
  stkPushEnabled?: boolean;
  stkPushIssues?: string[];
  paybillReference: string | null;
  paybillAmount: number | null;
  onCashAmountChange: (amountCents: number) => Promise<boolean> | void;
  onMpesaPayment: (phone: string, amountShillings: number) => Promise<boolean>;
  onPaybillPayment: (phone: string, amountShillings: number) => Promise<boolean>;
  onStoreCreditPayment: (
    amountCents: number,
    barcode: string | null,
  ) => Promise<boolean | void> | void;
  onCompleteSale: () => void;
  onCancelCheckout: () => Promise<boolean>;
  isFullyPaid: boolean;
  disabled?: boolean;
}

export function HybridPaymentPanel({
  totalAmountCents,
  promotionSavingsCents = 0,
  cashAmountCents,
  mpesaAmountCents,
  storeCreditAmountCents,
  storeCreditAccountBalanceCents,
  remainingAmountCents,
  changeAmountCents,
  status,
  mpesaPending,
  checkoutReserved,
  recoveringCheckout = false,
  canCancelCheckout,
  paybillNumber,
  paybillEnabled,
  stkPushEnabled,
  stkPushIssues = [],
  paybillReference,
  paybillAmount,
  onCashAmountChange,
  onMpesaPayment,
  onPaybillPayment,
  onStoreCreditPayment,
  onCompleteSale,
  onCancelCheckout,
  isFullyPaid,
  disabled = false,
}: HybridPaymentPanelProps) {
  const [cashInput, setCashInput] = useState("");
  const [mpesaPhone, setMpesaPhone] = useState("");
  const [mpesaAmountInput, setMpesaAmountInput] = useState("");

  const [scInput, setScInput] = useState("");
  const [scBarcode, setScBarcode] = useState("");
  const [barcodeBalanceCents, setBarcodeBalanceCents] = useState<number | null>(null);
  const [cashInputError, setCashInputError] = useState("");
  const [mpesaAmountError, setMpesaAmountError] = useState("");
  const [barcodeLookupState, setBarcodeLookupState] = useState<
    "idle" | "loading" | "valid" | "invalid"
  >("idle");
  const [storeCreditInputError, setStoreCreditInputError] = useState("");

  useEffect(() => {
    const barcode = scBarcode.trim();
    if (!barcode) {
      setBarcodeBalanceCents(null);
      setBarcodeLookupState("idle");
      return;
    }

    let cancelled = false;
    setBarcodeBalanceCents(null);
    setBarcodeLookupState("loading");
    const timeoutId = window.setTimeout(() => {
      ApiService.get<{ barcode: string; current_balance: number }>(
        `/store-credits/${encodeURIComponent(barcode)}`,
      )
        .then((credit) => {
          if (cancelled) return;
          setBarcodeBalanceCents(parseKesToCents(String(credit.current_balance)));
          setBarcodeLookupState("valid");
        })
        .catch(() => {
          if (cancelled) return;
          setBarcodeBalanceCents(null);
          setBarcodeLookupState("invalid");
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [scBarcode]);

  const availableStoreCreditCents = scBarcode.trim()
    ? barcodeBalanceCents ?? 0
    : storeCreditAccountBalanceCents;
  const maximumStoreCreditPaymentCents = Math.min(
    availableStoreCreditCents,
    remainingAmountCents,
  );
  const parsedStoreCreditCents = (() => {
    if (!scInput) return null;
    try {
      return parseKesToCents(scInput);
    } catch {
      return null;
    }
  })();
  const storeCreditAmountExceedsBalance = parsedStoreCreditCents !== null &&
    parsedStoreCreditCents > maximumStoreCreditPaymentCents;

  const handleCashSubmit = async () => {
    setCashInputError("");
    try {
      const amountCents = parseKesToCents(cashInput);
      if (amountCents > 0) {
        await onCashAmountChange(amountCents);
        setCashInput("");
      }
    } catch {
      setCashInputError("Enter a KES amount with at most two decimal places.");
    }
  };

  const handleQuickCash = async (amountCents: number) => {
    await onCashAmountChange(amountCents);
  };

  const handleMpesaSubmit = async () => {
    const amountInputIsWholeShillings = /^\d+(?:\.0{1,2})?$/.test(mpesaAmountInput);
    const amount = mpesaAmountInput === ""
      ? Math.floor(remainingAmountCents / 100)
      : amountInputIsWholeShillings ? Number(mpesaAmountInput) : NaN;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setMpesaAmountError("Enter a positive whole-shilling M-Pesa amount.");
      return;
    }
    if (Number.isSafeInteger(amount) && amount > 0 && mpesaPhone) {
      setMpesaAmountError("");
      const success = await onMpesaPayment(mpesaPhone, amount);
      if (success) {
        setMpesaAmountInput("");
      }
    }
  };

  const handlePaybillSubmit = async () => {
    const amountInputIsWholeShillings = /^\d+(?:\.0{1,2})?$/.test(mpesaAmountInput);
    const amount = mpesaAmountInput === ""
      ? Math.floor(remainingAmountCents / 100)
      : amountInputIsWholeShillings ? Number(mpesaAmountInput) : NaN;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setMpesaAmountError("Enter a positive whole-shilling M-Pesa amount.");
      return;
    }
    if (Number.isSafeInteger(amount) && amount > 0 && mpesaPhone) {
      setMpesaAmountError("");
      await onPaybillPayment(mpesaPhone, amount);
    }
  };

  const handleStoreCreditSubmit = async () => {
    if (parsedStoreCreditCents !== null && parsedStoreCreditCents > 0 &&
        parsedStoreCreditCents <= maximumStoreCreditPaymentCents) {
      await onStoreCreditPayment(parsedStoreCreditCents, scBarcode.trim() || null);
      setScInput("");
      setScBarcode("");
      setStoreCreditInputError("");
    }
  };

  const getStatusBadge = () => {
    switch (status) {
      case "pending":
        return (
          <Badge variant="secondary" className="gap-1">
            <AlertCircle className="h-3 w-3" /> Awaiting Payment
          </Badge>
        );
      case "partially_paid":
        return (
          <Badge
            variant="outline"
            className="gap-1 border-amber-500 text-amber-600"
          >
            <AlertCircle className="h-3 w-3" /> Partial Payment
          </Badge>
        );
      case "paid":
        return (
          <Badge className="gap-1 bg-green-600">
            <Check className="h-3 w-3" /> Fully Paid
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive" className="gap-1">
            <X className="h-3 w-3" /> Payment Failed
          </Badge>
        );
    }
  };

  return (
    <Card className="border-2">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Payment</CardTitle>
          {getStatusBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {checkoutReserved && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            {recoveringCheckout
              ? "Checking the saved checkout reservation. Cart changes are temporarily disabled."
              : "Stock and tender amounts are reserved for this checkout. Finish or release this checkout before changing its items."}
            {canCancelCheckout && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full"
                onClick={() => void onCancelCheckout()}
                disabled={disabled}
              >
                Release Reserved Stock
              </Button>
            )}
          </div>
        )}
        {/* Amount Summary */}
        <div className="rounded-lg bg-muted p-4 space-y-2">
          {promotionSavingsCents > 0 && (
            <div className="flex justify-between text-sm font-medium text-green-700">
              <span>Promotion savings:</span>
              <span>-{formatKesCents(promotionSavingsCents)}</span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span>Total Amount:</span>
            <span className="font-bold">
              {formatKesCents(totalAmountCents)}
            </span>
          </div>
          {cashAmountCents > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>Cash Paid:</span>
              <span>{formatKesCents(cashAmountCents)}</span>
            </div>
          )}
          {mpesaAmountCents > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>M-Pesa Paid:</span>
              <span>{formatKesCents(mpesaAmountCents)}</span>
            </div>
          )}
          {storeCreditAmountCents > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>Store Credit:</span>
              <span>{formatKesCents(storeCreditAmountCents)}</span>
            </div>
          )}
          <Separator />
          <div className="flex justify-between font-bold">
            <span>{remainingAmountCents > 0 ? "Remaining:" : "Change:"}</span>
            <span
              className={
                remainingAmountCents > 0 ? "text-destructive" : "text-green-600"
              }
            >
              {formatKesCents(remainingAmountCents > 0
                ? remainingAmountCents
                : changeAmountCents)}
            </span>
          </div>
        </div>

        {/* Cash Payment */}
        {!isFullyPaid && (
          <div className="space-y-3">
            <Label className="flex items-center gap-2">
              <Banknote className="h-4 w-4" />
              Cash Payment
            </Label>
            <div className="flex gap-2">
              <Input
                type="text"
                inputMode="decimal"
                placeholder="Enter cash amount"
                value={cashInput}
                onChange={(e) => {
                  setCashInput(e.target.value);
                  setCashInputError("");
                }}
                disabled={disabled || mpesaPending || checkoutReserved}
                min="0"
              />
              <Button
                onClick={handleCashSubmit}
                disabled={disabled || mpesaPending || checkoutReserved || !cashInput}
                variant="secondary"
              >
                Add
              </Button>
            </div>
            {cashInputError && <p className="text-sm text-destructive" role="alert">{cashInputError}</p>}
            {/* Quick amounts */}
            <div className="flex flex-wrap gap-2">
              {[100, 200, 500, 1000].map((amount) => (
                <Button
                  key={amount}
                  variant="outline"
                  size="sm"
                  onClick={() => handleQuickCash(cashAmountCents + amount * 100)}
                  disabled={disabled || mpesaPending || checkoutReserved}
                >
                  +{amount}
                </Button>
              ))}
              {remainingAmountCents > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleQuickCash(totalAmountCents - mpesaAmountCents - storeCreditAmountCents)
                  }
                  disabled={disabled || mpesaPending || checkoutReserved}
                >
                  Exact ({formatKesCents(remainingAmountCents)})
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Store Credit Payment */}
        {!isFullyPaid && (
          <>
            <Separator />
            <div className="space-y-3">
              <Label className="flex items-center gap-2">
                <Banknote className="h-4 w-4" />
                Store Credit
              </Label>
              <div className="flex flex-col gap-2">
                <Input
                  type="text"
                  placeholder="Voucher barcode (leave blank for customer account credit)"
                  value={scBarcode}
                  onChange={(e) => {
                    const value = e.target.value;
                    setScBarcode(value);
                    setBarcodeBalanceCents(null);
                    setBarcodeLookupState(value.trim() ? "loading" : "idle");
                    setStoreCreditInputError("");
                  }}
                  disabled={disabled || mpesaPending || checkoutReserved}
                />
                {scBarcode.trim() && (
                  <p
                    className={`text-sm ${
                      barcodeLookupState === "invalid"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                    role={barcodeLookupState === "invalid" ? "alert" : undefined}
                  >
                    {barcodeLookupState === "loading"
                      ? "Checking voucher balance..."
                      : barcodeLookupState === "invalid"
                        ? "This barcode is invalid, expired, inactive, or has no balance."
                        : barcodeBalanceCents !== null
                          ? `Voucher balance: ${formatKesCents(barcodeBalanceCents)}`
                          : ""}
                  </p>
                )}
                <div className="flex gap-2">
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder={
                      maximumStoreCreditPaymentCents > 0
                        ? `Amount to deduct (max ${formatKesCents(maximumStoreCreditPaymentCents)})`
                        : "Amount to deduct"
                    }
                    value={scInput}
                    onChange={(e) => {
                      const value = e.target.value;
                      setStoreCreditInputError("");
                      setScInput(value);
                      if (!value) return;
                      let valueCents: number;
                      try {
                        valueCents = parseKesToCents(value);
                      } catch {
                        setStoreCreditInputError("Enter a KES amount with at most two decimal places.");
                        return;
                      }
                      if (valueCents > maximumStoreCreditPaymentCents) {
                        setStoreCreditInputError(
                          `Amount cannot exceed the available store credit of ${formatKesCents(maximumStoreCreditPaymentCents)}.`,
                        );
                      }
                    }}
                    disabled={
                      disabled ||
                      mpesaPending ||
                      checkoutReserved ||
                      (scBarcode.trim() !== "" && barcodeLookupState !== "valid")
                    }
                    min="0"
                    max={centsToKesString(maximumStoreCreditPaymentCents)}
                    aria-label="Amount of store credit to use"
                    aria-invalid={storeCreditAmountExceedsBalance}
                  />
                  <Button
                    onClick={handleStoreCreditSubmit}
                    disabled={
                      disabled ||
                      mpesaPending ||
                      checkoutReserved ||
                      !scInput ||
                      parsedStoreCreditCents === null ||
                      maximumStoreCreditPaymentCents <= 0 ||
                      storeCreditAmountExceedsBalance ||
                      (scBarcode.trim() !== "" && barcodeLookupState !== "valid")
                    }
                    variant="secondary"
                  >
                    Apply
                  </Button>
                </div>
                {(storeCreditInputError || storeCreditAmountExceedsBalance) && (
                  <p className="text-sm text-destructive" role="alert">
                    {storeCreditInputError ||
                      `Amount cannot exceed the available store credit of ${formatKesCents(maximumStoreCreditPaymentCents)}.`}
                  </p>
                )}
                {!scBarcode.trim() && storeCreditAccountBalanceCents > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Customer account credit: {formatKesCents(storeCreditAccountBalanceCents)}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {/* M-Pesa Payment */}
        {!isFullyPaid && (
          <>
            <Separator />
            <div className="space-y-3">
              <Label className="flex items-center gap-2">
                <Smartphone className="h-4 w-4" />
                M-Pesa Payment
              </Label>
              {stkPushEnabled !== true && (
                <div
                  role="alert"
                  className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
                >
                  <p className="font-semibold">STK Push setup is incomplete</p>
                  {stkPushIssues.length > 0 ? (
                    <>
                      <p className="mt-1">
                        The Till Number alone is not enough. An administrator must configure:
                      </p>
                      <ul className="mt-1 list-inside list-disc">
                        {stkPushIssues.map((issue) => <li key={issue}>{issue}</li>)}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-1">
                      Refresh the payment screen or ask an administrator to check M-Pesa configuration.
                    </p>
                  )}
                  {paybillEnabled && paybillNumber && (
                    <p className="mt-2">You can still use the Paybill option below.</p>
                  )}
                </div>
              )}
              <div className="space-y-2">
                <Input
                  type="tel"
                  placeholder="Phone number (e.g., 0712345678 or 254712345678)"
                  value={mpesaPhone}
                  onChange={(e) => setMpesaPhone(e.target.value)}
                  disabled={disabled || mpesaPending}
                />
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder={`Amount (default: ${Math.floor(remainingAmountCents / 100).toLocaleString()})`}
                    value={mpesaAmountInput}
                    onChange={(e) => {
                      setMpesaAmountInput(e.target.value);
                      setMpesaAmountError("");
                    }}
                    disabled={disabled || mpesaPending}
                    min="1"
                    step="1"
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={handleMpesaSubmit}
                      disabled={disabled || mpesaPending || !mpesaPhone || stkPushEnabled !== true}
                      className="min-w-[100px]"
                    >
                      {mpesaPending && !paybillReference ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          Waiting...
                        </>
                      ) : (
                        "Send STK"
                      )}
                    </Button>
                    {paybillEnabled && paybillNumber && (
                      <Button
                        variant="outline"
                        onClick={handlePaybillSubmit}
                        disabled={disabled || mpesaPending || !mpesaPhone}
                      >
                        Paybill
                      </Button>
                    )}
                  </div>
                  {mpesaAmountError && <p className="text-sm text-destructive" role="alert">{mpesaAmountError}</p>}
                </div>
              </div>
              {paybillReference && paybillNumber && (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm space-y-1">
                  <p className="font-semibold">Customer pays using M-Pesa Paybill</p>
                  <p>Paybill: <strong>{paybillNumber}</strong></p>
                  <p>Account number: <strong className="select-all">{paybillReference}</strong></p>
                  <p>Amount: <strong>KES {(paybillAmount ?? Math.floor(remainingAmountCents / 100)).toLocaleString()}</strong></p>
                  <p className="text-muted-foreground">Keep this checkout open while Safaricom confirms payment.</p>
                </div>
              )}
              {mpesaPending && (
                <p className="text-sm text-muted-foreground animate-pulse">
                  {paybillReference
                    ? "Waiting for Safaricom to confirm the Paybill payment..."
                    : "Waiting for customer to confirm payment on their phone..."}
                </p>
              )}
            </div>
          </>
        )}

        {/* Complete Sale Button */}
        <Separator />
        <Button
          className="w-full h-12 text-lg"
          onClick={onCompleteSale}
          disabled={disabled || !isFullyPaid}
        >
          {isFullyPaid ? (
            <>
              <Check className="h-5 w-5 mr-2" />
              Complete Sale & Print Receipt
            </>
          ) : (
            `Awaiting ${formatKesCents(remainingAmountCents)}`
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
