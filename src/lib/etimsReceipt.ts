export const isTestEtimsReceipt = (receiptNumber: string | null | undefined): boolean =>
  receiptNumber?.startsWith("TEST-ETIMS-") ?? false;

export const getEtimsReceiptNotice = (
  status: string | null | undefined,
  receiptNumber: string | null | undefined,
): string | null => {
  if (status === "submitted" && receiptNumber) {
    return isTestEtimsReceipt(receiptNumber)
      ? "*** TEST RECEIPT - NOT A VALID TAX INVOICE ***"
      : "FISCAL SUBMISSION RECORDED - VERIFY WITH KRA BEFORE TREATING AS A TAX INVOICE";
  }
  if (status === "pending") {
    return "FISCAL RECEIPT PENDING - NOT A KRA TAX INVOICE";
  }
  if (status === "failed" || status === "submitted") {
    return "FISCAL RECEIPT NOT CONFIRMED - RECONCILIATION REQUIRED";
  }
  return "CUSTOMER RECEIPT - NOT A KRA TAX INVOICE";
};
